/**
 * The scorer's tools.
 *
 * Four exploration tools (`run_command`, `read_file`, `list_threads`,
 * `read_thread_turns`), two browser tools (in `browser-tools.ts`), and the two
 * verdict tools. Conventions that hold across all of them:
 *
 * - **No `.default()` on the wire.** Optional fields say their default in
 *   `.describe()` and apply it in `execute` — Google's schema converter drops
 *   `default`, `minimum`/`maximum` and turns numeric enums into strings, so a
 *   schema-level default is a lie on one of the three providers.
 * - **Never return an error where data was available.** Oversized results are
 *   truncated head+tail with a notice instead of being replaced by an
 *   instruction to try again.
 * - **Durations are `*_ms`** everywhere.
 */

import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ScorerConfig, ScorerToolName } from '@bunsen-dev/types';
import {
  COMMAND_MAX_BUFFER_BYTES,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_LINES_WITHOUT_RANGE,
  MAX_THREAD_TURN_CHARS,
  MAX_TOOL_RESULT_CHARS,
  MAX_TURNS_PER_READ,
} from './config.js';
import { truncateHeadTail } from './evidence.js';
import { allowedScoreValues, scoreScaleText } from './prompts.js';
import { loadThreadTurns, loadThreadsIndex, renderThreadTurns } from './traces.js';
import { createRunPlaywrightScriptTool, createScreenshotTool } from './browser-tools.js';

// ============================================================================
// State + context
// ============================================================================

/** What the model committed to. The runner reads this, never `toolResults`. */
export type ScorerVerdict = { score: number; summary: string } | { report: string };

export interface ScorerState {
  /** Set once a verdict tool validated its input. `null` until then. */
  verdict: ScorerVerdict | null;
  /** Filenames of screenshots saved under `<SCORER_OUTPUT_DIR>/screenshots/`. */
  screenshots: string[];
  /** The lazily-launched browser, kept so every browser call reuses one process. */
  browser: import('playwright').Browser | null;
}

export function createScorerState(): ScorerState {
  return { verdict: null, screenshots: [], browser: null };
}

/** One tool as `generateText` sees it, named so the emitted types do not reach into the SDK's internals. */
export type ScorerTool = ToolSet[string];

export interface ScorerContext {
  config: ScorerConfig;
  contextDir: string;
  workspacePath: string;
  /** One line of scorer stderr — the run log is assembled from these. */
  log: (line: string) => void;
  /** Names background log files `/tmp/bg-1.log`, `/tmp/bg-2.log`, … */
  backgroundCount: number;
}

export function createScorerContext(
  config: ScorerConfig,
  log: (line: string) => void,
): ScorerContext {
  return {
    config,
    contextDir: config.contextDir,
    workspacePath: config.workspacePath,
    log,
    backgroundCount: 0,
  };
}

// ============================================================================
// Shared helpers
// ============================================================================

/**
 * The environment a scorer subprocess inherits: everything except the platform
 * provider keys. A `run_command` the criterion asks for must never be able to
 * read the key that is paying for the scorer itself.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const name of Object.keys(copy)) {
    if (name.startsWith('BUNSEN_') && name.endsWith('_API_KEY')) delete copy[name];
  }
  return copy;
}

function clip(text: string, label: string): string {
  return truncateHeadTail(text, MAX_TOOL_RESULT_CHARS, label);
}

/** Relative paths resolve against the workspace; absolute paths are used as given. */
function resolvePath(ctx: ScorerContext, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(ctx.workspacePath, filePath);
}

// ============================================================================
// run_command
// ============================================================================

interface CommandOutcome {
  error: (Error & { code?: number | string | null; killed?: boolean; signal?: string | null }) | null;
  stdout: string;
  stderr: string;
}

function execCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    execFile(
      'sh',
      ['-c', command],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: COMMAND_MAX_BUFFER_BYTES,
        encoding: 'utf-8',
        env: childEnv(),
      },
      (error, stdout, stderr) => resolve({ error, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

function formatCommandOutcome(outcome: CommandOutcome, timeoutMs: number): string {
  const { error, stdout, stderr } = outcome;
  const body: string[] = [];
  if (error) {
    if (error.killed || error.signal === 'SIGTERM') {
      body.push(`Command timed out after ${timeoutMs}ms and was killed.`);
    } else if (typeof error.code === 'number') {
      body.push(`Exit code: ${error.code}`);
    } else if (error.code) {
      body.push(`Failed to run: ${error.code}`);
    } else {
      body.push(`Failed to run: ${error.message}`);
    }
  }
  if (stdout) body.push(`stdout:\n${stdout}`);
  if (stderr) body.push(`stderr:\n${stderr}`);
  if (body.length === 0) return '(the command produced no output)';
  return clip(body.join('\n\n'), 'command output');
}

export function createRunCommandTool(ctx: ScorerContext): ScorerTool {
  return tool({
    description:
      'Run a shell command in the workspace and return its output (exit code included on failure). ' +
      'Set background: true only for processes that do not exit, such as dev servers; their output goes ' +
      'to a log file whose path is returned.',
    inputSchema: z.object({
      command: z.string().describe('The shell command to run.'),
      timeout_ms: z
        .number()
        .optional()
        .describe(`How long to wait before killing the command. Defaults to ${DEFAULT_COMMAND_TIMEOUT_MS}.`),
      background: z
        .boolean()
        .optional()
        .describe('Run detached and return a log path instead of waiting. Defaults to false.'),
    }),
    execute: async (input) => {
      const timeoutMs = input.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS;
      if (input.background) {
        const logPath = `/tmp/bg-${++ctx.backgroundCount}.log`;
        try {
          const child = spawn('sh', ['-c', `${input.command} > ${logPath} 2>&1`], {
            cwd: ctx.workspacePath,
            detached: true,
            stdio: 'ignore',
            env: childEnv(),
          });
          child.unref();
          ctx.log(`[run_command] background pid=${child.pid} log=${logPath}`);
          return (
            `Started in the background (pid ${child.pid}). Output is going to ${logPath} — ` +
            `read it with read_file (start_line: -50 for the tail).`
          );
        } catch (error) {
          return `Could not start the background process: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const outcome = await execCommand(input.command, ctx.workspacePath, timeoutMs);
      return formatCommandOutcome(outcome, timeoutMs);
    },
  });
}

// ============================================================================
// read_file
// ============================================================================

function listDirectory(fullPath: string): string {
  const entries = fs.readdirSync(fullPath, { withFileTypes: true });
  if (entries.length === 0) return '(empty directory)';
  const names = entries
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort((a, b) => a.localeCompare(b));
  return clip(`${fullPath} contains ${entries.length} entries:\n${names.join('\n')}`, 'directory listing');
}

export function createReadFileTool(ctx: ScorerContext): ScorerTool {
  return tool({
    description:
      'Read a file, or a range of its lines; a directory path lists its entries instead. ' +
      'Relative paths resolve from the workspace root.',
    inputSchema: z.object({
      path: z.string().describe('File or directory path.'),
      start_line: z
        .number()
        .optional()
        .describe(
          'First line to read, 1-indexed and inclusive. Negative counts from the end: -100 reads the last 100 lines. Defaults to the start of the file.',
        ),
      end_line: z
        .number()
        .optional()
        .describe('Last line to read, 1-indexed and inclusive. Defaults to the end of the file.'),
    }),
    execute: async (input) => {
      const fullPath = resolvePath(ctx, input.path);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        return `No such file or directory: ${fullPath}`;
      }
      try {
        if (stat.isDirectory()) return listDirectory(fullPath);

        const content = fs.readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        const total = lines.length;

        if (input.start_line === undefined && input.end_line === undefined) {
          if (total <= MAX_LINES_WITHOUT_RANGE) return clip(content, 'file');
          const head = lines.slice(0, MAX_LINES_WITHOUT_RANGE).join('\n');
          return clip(
            `[Lines 1-${MAX_LINES_WITHOUT_RANGE} of ${total}; pass start_line/end_line for the rest, ` +
              `or start_line: -200 for the tail]\n${head}`,
            'file',
          );
        }

        let start = 0;
        if (input.start_line !== undefined) {
          start =
            input.start_line < 0
              ? Math.max(0, total + input.start_line)
              : Math.max(0, input.start_line - 1);
        }
        const end = input.end_line !== undefined ? Math.min(total, input.end_line) : total;
        if (end <= start) {
          return `Empty range: lines ${start + 1}-${end} of ${total}. start_line and end_line are 1-indexed and inclusive.`;
        }
        const body = lines.slice(start, end).join('\n');
        return clip(`[Lines ${start + 1}-${end} of ${total}]\n${body}`, 'file');
      } catch (error) {
        return `Could not read ${fullPath}: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}

// ============================================================================
// Trace navigation
// ============================================================================

const NO_THREADS =
  "No agent model conversations are available for this run (none were captured, or the agent's " +
  'provider is not yet supported for thread reconstruction).';

export function createListThreadsTool(ctx: ScorerContext): ScorerTool {
  return tool({
    description:
      "List the agent-under-test's captured conversation threads, with model, turn count and cost. " +
      'Call this before read_thread_turns.',
    inputSchema: z.object({}),
    execute: async () => {
      const index = loadThreadsIndex(ctx.contextDir);
      if (!index || index.threads.length === 0) return NO_THREADS;
      const lines: string[] = [
        `${index.summary.totalCalls} calls across ${index.summary.threadCount} thread(s), ` +
          `${index.summary.totalInputTokens} in / ${index.summary.totalOutputTokens} out tokens, ` +
          `$${index.summary.estimatedCostUsd.toFixed(4)}.`,
        '',
      ];
      for (const thread of index.threads) {
        lines.push(
          `- ${thread.threadId} — ${thread.context.provider}/${thread.context.model}, ` +
            `${thread.turnCount} turns, $${thread.stats.estimatedCostUsd.toFixed(4)}`,
        );
        if (thread.context.systemPrompt) {
          const preview = thread.context.systemPrompt.replace(/\s+/g, ' ').slice(0, 200);
          lines.push(`    system: ${preview}${thread.context.systemPrompt.length > 200 ? '…' : ''}`);
        }
      }
      return clip(lines.join('\n'), 'thread list');
    },
  });
}

export function createReadThreadTurnsTool(ctx: ScorerContext): ScorerTool {
  return tool({
    description:
      'Read a slice of one thread. Each turn holds only the messages new since the previous turn. ' +
      'Long slices are clamped, so read forward in ranges.',
    inputSchema: z.object({
      thread_id: z.string().describe('Thread id from list_threads.'),
      start: z.number().optional().describe('First turn index, 0-indexed. Defaults to 0.'),
      end: z
        .number()
        .optional()
        .describe(
          `One past the last turn index (exclusive). Defaults to the end of the thread; at most ${MAX_TURNS_PER_READ} turns are returned per call.`,
        ),
    }),
    execute: async (input) => {
      const index = loadThreadsIndex(ctx.contextDir);
      const entry = index?.threads.find((thread) => thread.threadId === input.thread_id);
      if (!entry) {
        return `No thread "${input.thread_id}" in this run. Call list_threads to see which threads exist.`;
      }
      const start = Math.max(0, input.start ?? 0);
      const requestedEnd = Math.min(input.end ?? entry.turnCount, entry.turnCount);
      const end = Math.min(requestedEnd, start + MAX_TURNS_PER_READ);
      const header: string[] = [
        `Thread ${entry.threadId} — turns ${start}–${end} of ${entry.turnCount}.`,
      ];
      if (end < requestedEnd) {
        header.push(
          `(Clamped to ${MAX_TURNS_PER_READ} turns per call; call again with start: ${end} for the rest.)`,
        );
      }
      const turns = loadThreadTurns(ctx.contextDir, input.thread_id, start, end);
      if (turns.length === 0) return `${header.join('\n')}\n\n(no turns in that range)`;
      return clip(
        `${header.join('\n')}\n\n${renderThreadTurns(turns, MAX_THREAD_TURN_CHARS)}`,
        'thread turns',
      );
    },
  });
}

// ============================================================================
// Verdict tools
// ============================================================================

/** The tool that ends this scorer's loop. */
export function verdictToolName(type: ScorerConfig['type']): 'submit_score' | 'submit_report' {
  return type === 'report' ? 'submit_report' : 'submit_score';
}

export function createSubmitScoreTool(config: ScorerConfig, state: ScorerState): ScorerTool {
  const allowed = allowedScoreValues(config.scores);
  const scale = scoreScaleText(config.scores);
  return tool({
    description:
      'Submit your verdict on this criterion. Write the summary first: 2–4 sentences naming the ' +
      'specific evidence you checked — the file, the command, what its output showed; it is shown to ' +
      'the person reading the results. Then the score.',
    inputSchema: z.object({
      summary: z
        .string()
        .describe('What you checked and what it showed, in 2–4 sentences. Written before the score.'),
      score: z.number().describe(`The score for this criterion. Allowed scores: ${scale}.`),
    }),
    execute: async (input) => {
      if (input.summary.trim() === '') {
        return 'The summary is empty. Name the evidence you checked in 2–4 sentences, then submit again.';
      }
      if (!Number.isFinite(input.score)) {
        return `${input.score} is not a number; the score for this criterion must be ${scale}.`;
      }
      if (allowed.length > 0) {
        if (!allowed.includes(input.score)) {
          return `${input.score} is not an allowed score for this criterion; choose one of ${allowed.join(', ')}`;
        }
      } else if (input.score < 0 || input.score > 1) {
        return `${input.score} is not an allowed score for this criterion; choose ${scale}`;
      }
      state.verdict = { score: input.score, summary: input.summary };
      return 'Verdict recorded.';
    },
  });
}

export function createSubmitReportTool(state: ScorerState): ScorerTool {
  return tool({
    description: 'Submit the evaluation report as markdown. This ends the evaluation.',
    inputSchema: z.object({
      report: z.string().describe('The full evaluation report, as markdown.'),
    }),
    execute: async (input) => {
      if (input.report.trim() === '') {
        return 'The report is empty. Write the report, then submit again.';
      }
      state.verdict = { report: input.report };
      return 'Report recorded.';
    },
  });
}

// ============================================================================
// Tool set assembly
// ============================================================================

/** The exploration tools each criterion type may use, before the allowlist. */
function explorationTools(config: ScorerConfig, state: ScorerState, ctx: ScorerContext): ToolSet {
  if (config.type === 'judge') return {};
  const tools: ToolSet = {
    run_command: createRunCommandTool(ctx),
    read_file: createReadFileTool(ctx),
    list_threads: createListThreadsTool(ctx),
    read_thread_turns: createReadThreadTurnsTool(ctx),
  };
  if (config.type === 'browser-agent') {
    tools.screenshot = createScreenshotTool(ctx, state);
    tools.run_playwright_script = createRunPlaywrightScriptTool(ctx, state);
  }
  return tools;
}

/**
 * The tool set for this criterion: the verdict tool (always) plus the
 * exploration tools its type allows, narrowed by `config.tools` when the
 * experiment set an allowlist.
 */
export function buildTools(config: ScorerConfig, state: ScorerState, ctx: ScorerContext): ToolSet {
  const available = explorationTools(config, state, ctx);
  const allowlist = config.tools;
  const enabled: ToolSet = {};
  for (const name of Object.keys(available)) {
    if (allowlist && !allowlist.includes(name as ScorerToolName)) continue;
    enabled[name] = available[name];
  }
  const verdict: ToolSet =
    config.type === 'report'
      ? { submit_report: createSubmitReportTool(state) }
      : { submit_score: createSubmitScoreTool(config, state) };
  return { ...enabled, ...verdict };
}

/** The exploration tools actually enabled, for the "Where the evidence is" block. */
export function explorationToolNames(tools: ToolSet): ScorerToolName[] {
  return Object.keys(tools).filter(
    (name) => name !== 'submit_score' && name !== 'submit_report',
  ) as ScorerToolName[];
}
