/**
 * Scorer bundle constants and config loading.
 *
 * Every limit lives here with the reason it has the value it does, so the
 * budget is readable in one place rather than scattered across the tools.
 */

import * as fs from 'node:fs';
import {
  parseScorerModelRef,
  AGENT_SCORER_TOOLS,
  BROWSER_AGENT_SCORER_TOOLS,
  SCORER_KEY_FILE_ENV,
} from '@bunsen-dev/types';
import type {
  AllowedScores,
  JudgeEvidence,
  ScorerConfig,
  ScorerRunType,
  ScorerToolName,
} from '@bunsen-dev/types';

// ============================================================================
// Container paths
// ============================================================================

/** Writable output directory for scorer artifacts (screenshots). Mounted by the runtime. */
export const SCORER_OUTPUT_DIR = '/bunsen/scorer-output';

/** Read-only mount of the experiment's `verifiers/` dir, present only when the experiment has one. */
export const VERIFIERS_DIR = '/bunsen/verifiers';

// ============================================================================
// Loop + context budget
// ============================================================================

/**
 * Hard cap on tool-calling steps. Fifty steps is well beyond what any criterion
 * has needed; it bounds a runaway scorer without truncating real exploration.
 */
export const MAX_STEPS = 50;

/**
 * Per-tool-result character cap. 50 steps x 12K chars is roughly 150K tokens —
 * inside the smallest context window we support, with headroom for the prompt.
 */
export const MAX_TOOL_RESULT_CHARS = 12_000;

/** Verdict loops emit a summary and a score; 4K output tokens is generous for that. */
export const MAX_OUTPUT_TOKENS = 4096;

/** The report step writes prose rather than a verdict, so it gets a larger output budget. */
export const MAX_REPORT_OUTPUT_TOKENS = 16_384;

/** The inlined task prompt is usually a few KB; this bounds a pathological one without hiding the task. */
export const MAX_TASK_PROMPT_CHARS = 20_000;

/** Per-evidence-block cap (diff / logs / conversations), unchanged from the pre-sweep scorer. */
export const MAX_EVIDENCE_CHARS = 100_000;

/** Preview length for the stderr step log — enough to recognize a result, short enough to skim. */
export const TOOL_RESULT_LOG_PREVIEW_CHARS = 200;

/** The report's `summary` is the first paragraph of the report, clipped for list views. */
export const MAX_REPORT_SUMMARY_CHARS = 300;

// ============================================================================
// Tool budgets
// ============================================================================

/** `run_command` default timeout: long enough for a test suite, short enough that a hang costs one step. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/** stdout+stderr buffer for a foreground command; output above it is truncated by the OS pipe, not lost silently. */
export const COMMAND_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** `read_file` with no range on a large file returns this many lines with a notice instead of an error. */
export const MAX_LINES_WITHOUT_RANGE = 2000;

/** `read_thread_turns` clamps a requested slice to this many turns so one call cannot swallow the context. */
export const MAX_TURNS_PER_READ = 30;

/** Per-turn body cap inside `read_thread_turns` — a single agent turn can be enormous. */
export const MAX_THREAD_TURN_CHARS = 2000;

/** Turns sampled from the head of each thread when conversations are inlined as evidence. */
export const PROMPT_THREAD_HEAD_TURNS = 5;

/** Turns sampled from the tail of each thread when conversations are inlined as evidence. */
export const PROMPT_THREAD_TAIL_TURNS = 10;

// ============================================================================
// Browser tools
// ============================================================================

/** `run_playwright_script` default timeout: interactions plus screenshots take longer than a page load. */
export const DEFAULT_PLAYWRIGHT_TIMEOUT_MS = 60_000;

/** Page navigation timeout for both browser tools. */
export const NAVIGATION_TIMEOUT_MS = 30_000;

/** `screenshot` default settle delay, so client-rendered pages are not captured mid-paint. */
export const DEFAULT_SCREENSHOT_DELAY_MS = 1000;

/** `wait_for_selector` timeout inside `screenshot`. */
export const SELECTOR_TIMEOUT_MS = 10_000;

/** Default viewport for both browser tools. */
export const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;

/** At most this many images ride back on one browser tool result; further screenshots are listed by filename. */
export const MAX_INLINE_IMAGES = 4;

// ============================================================================
// Config loading
// ============================================================================

const SCORER_RUN_TYPES: readonly ScorerRunType[] = ['judge', 'agent', 'browser-agent', 'report'];
const EVIDENCE_KINDS: readonly JudgeEvidence[] = ['diff', 'logs', 'traces'];

/**
 * A config the bundle refuses to run. Expected failure: the host prints the
 * message and marks the criterion errored; there is no stack worth reading.
 */
export class ScorerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScorerConfigError';
  }
}

function fail(configPath: string, message: string): never {
  throw new ScorerConfigError(`Invalid scorer config at ${configPath}: ${message}`);
}

function requireString(configPath: string, value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(configPath, `"${field}" must be a non-empty string`);
  }
  return value;
}

function checkScores(configPath: string, scores: unknown): AllowedScores | undefined {
  if (scores === undefined) return undefined;
  if (Array.isArray(scores)) {
    if (scores.length === 0) fail(configPath, '"scores" must list at least one value');
    for (const value of scores) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail(configPath, '"scores" must be a list of numbers');
      }
    }
    return scores as number[];
  }
  if (typeof scores === 'object' && scores !== null) {
    const entries = Object.entries(scores as Record<string, unknown>);
    if (entries.length === 0) fail(configPath, '"scores" must list at least one value');
    for (const [key, label] of entries) {
      if (!Number.isFinite(Number(key))) fail(configPath, `"scores" key "${key}" is not a number`);
      if (typeof label !== 'string') fail(configPath, `"scores" label for ${key} must be a string`);
    }
    return scores as Record<number, string>;
  }
  return fail(configPath, '"scores" must be a list of numbers or a map of number to label');
}

function checkTools(configPath: string, type: ScorerRunType, tools: unknown): ScorerToolName[] | undefined {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) fail(configPath, '"tools" must be a list of tool names');
  if (tools.length === 0) {
    fail(
      configPath,
      '"tools" must list at least one tool; use type: judge for a scorer with no tools',
    );
  }
  const allowed: readonly ScorerToolName[] =
    type === 'browser-agent' ? BROWSER_AGENT_SCORER_TOOLS : AGENT_SCORER_TOOLS;
  for (const name of tools) {
    if (typeof name !== 'string' || !allowed.includes(name as ScorerToolName)) {
      fail(
        configPath,
        `"tools" entry ${JSON.stringify(name)} is not a ${type} scorer tool (expected one of ${allowed.join(', ')})`,
      );
    }
  }
  return tools as ScorerToolName[];
}

/**
 * Read and validate the config the runtime wrote for this criterion.
 *
 * Everything is already resolved on the host — this is the bundle's own guard
 * against a malformed or stale config, not a second source of defaults. The
 * one thing it will not do is invent a model: `model` must be a parseable
 * `<provider>/<model>` reference.
 */
export function loadScorerConfig(configPath: string): ScorerConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (error) {
    throw new ScorerConfigError(
      `Could not read scorer config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(configPath, 'expected a JSON object');
  }
  const value = raw as Record<string, unknown>;

  const type = value.type;
  if (typeof type !== 'string' || !SCORER_RUN_TYPES.includes(type as ScorerRunType)) {
    fail(configPath, `"type" must be one of ${SCORER_RUN_TYPES.join(', ')} (got ${JSON.stringify(type)})`);
  }

  const config: ScorerConfig = {
    type: type as ScorerRunType,
    id: requireString(configPath, value.id, 'id'),
    title: requireString(configPath, value.title, 'title'),
    instructions: requireString(configPath, value.instructions, 'instructions'),
    model: requireString(configPath, value.model, 'model'),
    contextDir: requireString(configPath, value.contextDir, 'contextDir'),
    workspacePath: requireString(configPath, value.workspacePath, 'workspacePath'),
  };

  try {
    parseScorerModelRef(config.model);
  } catch (error) {
    fail(configPath, `"model" ${error instanceof Error ? error.message : String(error)}`);
  }

  if (value.workspaceSourcePath !== undefined) {
    config.workspaceSourcePath = requireString(
      configPath,
      value.workspaceSourcePath,
      'workspaceSourcePath',
    );
  }
  if (value.systemPrompt !== undefined) {
    config.systemPrompt = requireString(configPath, value.systemPrompt, 'systemPrompt');
  }

  const tools = checkTools(configPath, config.type, value.tools);
  if (tools) config.tools = tools;

  const scores = checkScores(configPath, value.scores);
  if (scores) config.scores = scores;

  if (value.evidence !== undefined) {
    if (!Array.isArray(value.evidence)) fail(configPath, '"evidence" must be a list');
    for (const kind of value.evidence) {
      if (typeof kind !== 'string' || !EVIDENCE_KINDS.includes(kind as JudgeEvidence)) {
        fail(
          configPath,
          `"evidence" entry ${JSON.stringify(kind)} is not one of ${EVIDENCE_KINDS.join(', ')}`,
        );
      }
    }
    config.evidence = value.evidence as JudgeEvidence[];
  }

  if (value.dependencyScores !== undefined) {
    if (
      typeof value.dependencyScores !== 'object' ||
      value.dependencyScores === null ||
      Array.isArray(value.dependencyScores)
    ) {
      fail(configPath, '"dependencyScores" must be an object keyed by criterion id');
    }
    for (const [id, entry] of Object.entries(value.dependencyScores as Record<string, unknown>)) {
      const dep = entry as { score?: unknown; summary?: unknown } | null;
      if (typeof dep !== 'object' || dep === null) {
        fail(configPath, `"dependencyScores.${id}" must be an object`);
      }
      if (dep.score !== null && typeof dep.score !== 'number') {
        fail(configPath, `"dependencyScores.${id}.score" must be a number or null`);
      }
      if (typeof dep.summary !== 'string') {
        fail(configPath, `"dependencyScores.${id}.summary" must be a string`);
      }
    }
    config.dependencyScores = value.dependencyScores as ScorerConfig['dependencyScores'];
  }

  return config;
}

/**
 * Read the provider API key the host delivered for this exec.
 *
 * The host writes the key as a one-time file (mode 600, owned by the exec
 * user) and names it in `BUNSEN_SCORER_KEY_FILE`; it is never an environment
 * variable, so `/proc/<pid>/environ`, `run_command` children, and
 * model-authored `run_playwright_script` code cannot read it. The file is
 * deleted here, before any tool runs; the host removes it again after the
 * exec as a backstop.
 */
export function readScorerApiKey(
  env: Record<string, string | undefined> = process.env,
  io: { readFileSync: (p: string, enc: 'utf-8') => string; unlinkSync: (p: string) => void } = fs,
): string {
  const keyFile = env[SCORER_KEY_FILE_ENV];
  if (!keyFile) {
    throw new ScorerConfigError(`${SCORER_KEY_FILE_ENV} is not set; the host must deliver the provider key file.`);
  }
  let key: string;
  try {
    key = io.readFileSync(keyFile, 'utf-8').trim();
  } catch (error) {
    throw new ScorerConfigError(
      `Could not read the provider key file ${keyFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    io.unlinkSync(keyFile);
  } catch {
    // Best effort: the host deletes it after the exec regardless.
  }
  if (!key) throw new ScorerConfigError(`The provider key file ${keyFile} is empty.`);
  return key;
}
