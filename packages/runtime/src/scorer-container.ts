/**
 * Scorer Container - manages a separate container for all scoring.
 *
 * All scorers (code-based, LLM-judge, agentic, visual, report) run in an
 * isolated scorer container with:
 * - Extracted workspace mounted read-write at /workspace
 * - Run context at /bunsen/run (read-only)
 * - Verifiers directory at /bunsen/verifiers (read-only, if exists)
 * - Scorer output at /bunsen/scorer-output (read-write)
 * - Scorer binary at /bunsen/lib/scorer.cjs (read-only, if LLM scoring)
 * - bunsen-score helper at /bunsen/bin/bunsen-score
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  SCORER_KEY_FILE_ENV,
  type ScorerConfig,
  type ScorerOutput,
  type ScriptResultArtifact,
  type RunPlatform,
} from '@bunsen-dev/types';
import {
  createPersistentContainer,
  execShellInContainer,
  inspectImageEnvPath,
  writeFileInContainer,
  stopContainer,
  ExecTimeoutError,
  type PersistentContainer,
} from './container.js';
import { pgidRecordPrefix, reapProcessGroupCommand } from './process-group.js';

// =============================================================================
// Types
// =============================================================================

export interface ScorerContainerInfo {
  container: PersistentContainer;
  /** Host temp dir for scorer output */
  outputDir: string;
  /** Optional user to run scorers as inside the container */
  execUser?: string;
  /** Optional environment to inject for scorer execs */
  execEnv?: Record<string, string>;
}

export interface CodeScorerOptions {
  /** Shell command to run */
  code: string;
  /** Criterion name (for log file naming) */
  criterion: string;
  /** Run directory (for saving logs) */
  runDir: string;
  /** Timeout in seconds (default: 60) */
  timeout?: number;
}

export function buildScorerExecOptions(
  scorerContainer: ScorerContainerInfo,
  env: Record<string, string> = {}
): { user?: string; env: Record<string, string> } {
  return {
    user: scorerContainer.execUser,
    env: {
      ...(scorerContainer.execEnv || {}),
      ...env,
    },
  };
}

// =============================================================================
// Script scorer runtime contract — env vars + bunsen-score helper.
// See `docs/SCORERS.md`.
// =============================================================================

/**
 * Reserved env vars Bunsen injects into every `type: script` criterion run.
 *
 * Setting these at container creation time (createScorerContainer) makes them
 * visible to subshells / nested processes the script may spawn; the per-exec
 * `runCodeScorer` injection covers the agent-container scoring path where the
 * agent container's base env does not pre-set them.
 */
/**
 * PATH used when the image declares none of its own. Mirrors Docker's default
 * PATH with `/bunsen/bin` (the `bunsen-score` helper + Node symlink) first.
 */
export const SCORER_FALLBACK_PATH =
  '/bunsen/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * Resolve the PATH the dedicated scorer container is created with.
 *
 * The only ordering Bunsen itself depends on is `/bunsen/bin` winning, so the
 * image's own PATH is preserved (prepended-to, never replaced) whenever the
 * image declares one. Replacing it wholesale silently dropped toolchains that
 * live outside `/usr/{local/,}{bin,sbin}` — `go`, `cargo`, conda, nvm — which
 * the agent container (no PATH override) still saw; a script criterion would
 * then fail to find a compiler the agent had just used.
 */
export function resolveScorerPath(imageEnvPath: string | undefined): string {
  if (!imageEnvPath) return SCORER_FALLBACK_PATH;
  const alreadyPresent = imageEnvPath.split(':').includes('/bunsen/bin');
  return alreadyPresent ? imageEnvPath : `/bunsen/bin:${imageEnvPath}`;
}

export const SCRIPT_SCORER_ENV: Readonly<Record<string, string>> = Object.freeze({
  BUNSEN_SCORE_FILE: '/bunsen/scorer-output/score',
  BUNSEN_SUMMARY_FILE: '/bunsen/scorer-output/summary',
  BUNSEN_SCORER_OUTPUT: '/bunsen/scorer-output',
  BUNSEN_EVAL_RESULT: '/bunsen/scorer-output/result.json',
  BUNSEN_WORKSPACE_DIR: '/workspace',
  BUNSEN_WORKSPACE_SOURCE_DIR: '/workspace-source',
});

/**
 * The base environment the dedicated scorer container is created with.
 *
 * Deliberately key-free: creation-time env is visible to every exec in the
 * container, including `type: script` criteria and anything they spawn, so a
 * provider API key placed here would be readable by user-authored verifier
 * scripts. LLM scorers get their one provider key per exec instead
 * (`runLLMScorer`), in both container modes.
 */
export function buildScorerContainerEnv(options: {
  /** Reserved `BUNSEN_*` run/suite context, from `buildReservedEnv()`. */
  reservedEnv?: Record<string, string>;
  /** The image's own `PATH`, from `inspectImageEnvPath()`. */
  imageEnvPath?: string;
}): Record<string, string> {
  return {
    ...SCRIPT_SCORER_ENV,
    ...(options.reservedEnv ?? {}),
    // Create-time Env wins over the image's Config.Env per key, so setting
    // PATH here replaces the image's — preserve it via prepend (see
    // resolveScorerPath). The agent container never overrides PATH; the
    // scorer must see the same toolchain the agent built with.
    PATH: resolveScorerPath(options.imageEnvPath),
  };
}

export const BUNSEN_SCORE_SCRIPT = `#!/bin/sh
# bunsen-score: Helper for code-based scorers
# Usage: bunsen-score <score> [summary]
#   score: float 0-1
#   summary: optional string description

if [ $# -lt 1 ]; then
  echo "Usage: bunsen-score <score> [summary]" >&2
  exit 1
fi

SCORE="$1"
shift
SUMMARY="$*"

echo "$SCORE" > "$BUNSEN_SCORE_FILE"

if [ -n "$SUMMARY" ]; then
  echo "$SUMMARY" > "$BUNSEN_SUMMARY_FILE"
fi
`;

// =============================================================================
// Pure functions for score/summary resolution (unit-testable)
// =============================================================================

/**
 * Parsed `result.json` payload (subset that the runtime uses).
 *
 * `summary` is optional; the resolver applies the same default-message
 * fallbacks as the file/exit-code paths when it is missing.
 */
export interface ParsedScriptResult {
  score: number;
  summary?: string;
  artifacts: ScriptResultArtifact[];
}

/**
 * Parse the optional `result.json` payload.
 *
 * Returns `null` when the file is absent. Throws a descriptive error when the
 * payload is present but malformed (invalid JSON, missing/invalid `score`,
 * non-array artifacts, etc.) so the caller can surface it as the criterion's
 * summary.
 */
export function parseResultJson(content: string): ParsedScriptResult {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid result.json: not valid JSON (${msg})`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid result.json: expected a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  const scoreValue = obj.score;
  if (typeof scoreValue !== 'number' || Number.isNaN(scoreValue)) {
    throw new Error('Invalid result.json: "score" must be a number');
  }
  if (scoreValue < 0 || scoreValue > 1) {
    throw new Error(`Invalid result.json: "score" out of range: ${scoreValue} (must be 0-1)`);
  }

  let summary: string | undefined;
  if (obj.summary !== undefined) {
    if (typeof obj.summary !== 'string') {
      throw new Error('Invalid result.json: "summary" must be a string');
    }
    const trimmed = obj.summary.trim();
    summary = trimmed.length > 0 ? trimmed : undefined;
  }

  const artifacts: ScriptResultArtifact[] = [];
  if (obj.artifacts !== undefined) {
    if (!Array.isArray(obj.artifacts)) {
      throw new Error('Invalid result.json: "artifacts" must be an array');
    }
    obj.artifacts.forEach((entry, idx) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`Invalid result.json: artifacts[${idx}] must be an object`);
      }
      const artifactObj = entry as Record<string, unknown>;
      const pathValue = artifactObj.path;
      if (typeof pathValue !== 'string' || pathValue.length === 0) {
        throw new Error(`Invalid result.json: artifacts[${idx}].path must be a non-empty string`);
      }
      const mediaType = artifactObj.mediaType;
      if (mediaType !== undefined && typeof mediaType !== 'string') {
        throw new Error(`Invalid result.json: artifacts[${idx}].mediaType must be a string`);
      }
      artifacts.push({
        path: pathValue,
        ...(typeof mediaType === 'string' ? { mediaType } : {}),
      });
    });
  }

  return { score: scoreValue, summary, artifacts };
}

/**
 * Resolve score from scorer output.
 *
 * Priority:
 * 1. If score file written -> parse float 0-1
 * 2. If no score file -> exit 0 = 1.0, non-zero = 0.0
 * 3. Invalid score file -> error (score 0, error summary)
 */
export function resolveScore(
  scoreFileContent: string | null,
  exitCode: number
): { score: number; error?: string } {
  if (scoreFileContent !== null) {
    const trimmed = scoreFileContent.trim();
    const parsed = parseFloat(trimmed);

    if (isNaN(parsed)) {
      return {
        score: 0,
        error: `Invalid score file content: "${trimmed}" (must be a float 0-1)`,
      };
    }

    if (parsed < 0 || parsed > 1) {
      return {
        score: 0,
        error: `Score out of range: ${parsed} (must be 0-1)`,
      };
    }

    return { score: parsed };
  }

  // No score file: use exit code
  return { score: exitCode === 0 ? 1.0 : 0.0 };
}

/**
 * Resolve summary from scorer output.
 *
 * Priority:
 * 1. Summary file written -> use content
 * 2. Score file present -> "Score: {value}"
 * 3. Exit 0 -> "Passed"
 * 4. Non-zero -> "Failed (exit code {code})"
 */
export function resolveSummary(
  summaryFileContent: string | null,
  scoreFileContent: string | null,
  exitCode: number
): string {
  if (summaryFileContent !== null) {
    const trimmed = summaryFileContent.trim();
    if (trimmed) return trimmed;
  }

  if (scoreFileContent !== null) {
    return `Score: ${scoreFileContent.trim()}`;
  }

  return exitCode === 0 ? 'Passed' : `Failed (exit code ${exitCode})`;
}

/**
 * Resolve a timed-out script criterion from whatever output files the script
 * managed to write before it was killed.
 *
 * A script that reports incrementally (rewriting `result.json` / the score
 * file as tests pass) keeps the credit it earned; the timeout is always
 * surfaced in the summary. Resolution: valid `result.json` → valid score
 * file → 0. A torn/invalid `result.json` (killed mid-write) falls through to
 * the score file instead of erroring the criterion.
 */
export function resolveTimeoutOutput(
  resultJsonContent: string | null,
  scoreFileContent: string | null,
  timeoutSeconds: number
): { score: number; summary: string; parsed?: ParsedScriptResult } {
  const timeoutNote = `Timed out after ${timeoutSeconds}s`;

  if (resultJsonContent !== null) {
    try {
      const parsed = parseResultJson(resultJsonContent);
      const detail = parsed.summary ? `: ${parsed.summary}` : '';
      return {
        score: parsed.score,
        summary: `${timeoutNote}; scored from last written result.json${detail}`,
        parsed,
      };
    } catch {
      // Torn write — fall through to the score file.
    }
  }

  if (scoreFileContent !== null) {
    const resolved = resolveScore(scoreFileContent, 1);
    if (!resolved.error) {
      return {
        score: resolved.score,
        summary: `${timeoutNote}; scored from last written score file (${resolved.score})`,
      };
    }
  }

  return { score: 0, summary: timeoutNote };
}

/**
 * Convert criterion name to a filesystem-safe slug
 */
export function slugifyCriterion(criterion: string): string {
  return criterion
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// =============================================================================
// Container lifecycle
// =============================================================================

/**
 * Create a scorer container for all evaluation (code-based and LLM-based).
 *
 * Mounts:
 * - workspace -> /workspace (rw) — extracted copy, safe to modify
 * - workspaceSourceDir -> /workspace-source (ro) — immutable initial snapshot
 * - runDir -> /bunsen/run (ro)
 * - verifiersPath -> /bunsen/verifiers (ro, if exists)
 * - temp output dir -> /bunsen/scorer-output (rw)
 * - scorerBundlePath -> /bunsen/lib/scorer.cjs (ro, if LLM scoring)
 * - nodeRuntimePath -> /bunsen/runtime/node (ro, if custom image)
 * - proxyCertsDir -> /mitmproxy-certs (ro, if tracing)
 */
export interface ScorerContainerMountSpec {
  source: string;
  target: string;
  readonly: boolean;
}

export interface ScorerContainerMountOptions {
  workspaceDir: string;
  workspaceSourceDir?: string;
  runDir: string;
  outputDir: string;
  verifiersPath?: string;
  scorerBundlePath?: string;
  nodeRuntimePath?: string;
  proxyCertsDir?: string;
  proxyBootstrapBundlePath?: string;
}

/**
 * Build the mount list the dedicated scorer container is created with.
 *
 * `/workspace-source` is mounted readonly whenever `workspaceSourceDir` is
 * provided — the executor extracts that directory from the agent container
 * unconditionally (even when zero `workspace.sources[]` were declared), so
 * the mount is always present in the dedicated-scorer path.
 */
export function buildScorerContainerMounts(
  options: ScorerContainerMountOptions
): ScorerContainerMountSpec[] {
  const {
    workspaceDir, workspaceSourceDir, runDir, outputDir,
    verifiersPath, scorerBundlePath, nodeRuntimePath, proxyCertsDir,
    proxyBootstrapBundlePath,
  } = options;

  const mounts: ScorerContainerMountSpec[] = [
    { source: workspaceDir, target: '/workspace', readonly: false },
    { source: runDir, target: '/bunsen/run', readonly: true },
    { source: outputDir, target: '/bunsen/scorer-output', readonly: false },
  ];

  if (workspaceSourceDir) {
    mounts.push({ source: workspaceSourceDir, target: '/workspace-source', readonly: true });
  }
  if (verifiersPath) {
    mounts.push({ source: verifiersPath, target: '/bunsen/verifiers', readonly: true });
  }
  if (scorerBundlePath) {
    mounts.push({ source: scorerBundlePath, target: '/bunsen/lib/scorer.cjs', readonly: true });
  }
  if (nodeRuntimePath) {
    mounts.push({ source: nodeRuntimePath, target: '/bunsen/runtime/node', readonly: true });
  }
  if (proxyCertsDir) {
    mounts.push({ source: proxyCertsDir, target: '/mitmproxy-certs', readonly: true });
  }
  if (proxyBootstrapBundlePath) {
    mounts.push({
      source: proxyBootstrapBundlePath,
      target: '/bunsen/runtime/proxy-bootstrap.cjs',
      readonly: true,
    });
  }

  return mounts;
}

export async function createScorerContainer(options: {
  image: string;
  workspaceDir: string;
  workspaceSourceDir?: string;
  runDir: string;
  verifiersPath?: string;
  runId: string;
  platform?: RunPlatform;
  /** Path to scorer.cjs bundle (for LLM-based scoring) */
  scorerBundlePath?: string;
  /** Path to Node.js runtime binary (for custom images) */
  nodeRuntimePath?: string;
  /** Path to proxy certs dir (for tracing scorer API calls) */
  proxyCertsDir?: string;
  /**
   * Path to the proxy-bootstrap CJS bundle. Mounted alongside the proxy
   * certs so the scorer's Node process honors `HTTPS_PROXY` for native
   * fetch. Should be set whenever `proxyCertsDir` is set.
   */
  proxyBootstrapBundlePath?: string;
  /**
   * Reserved `BUNSEN_*` env vars to seed at container creation time so
   * script criteria (and the `bunsen-score` helper) see the same run/suite
   * context the agent did. Built via `buildReservedEnv()`.
   */
  reservedEnv?: Record<string, string>;
}): Promise<ScorerContainerInfo> {
  const {
    image, workspaceDir, workspaceSourceDir, runDir, verifiersPath, runId, platform,
    scorerBundlePath, nodeRuntimePath, proxyCertsDir,
    proxyBootstrapBundlePath, reservedEnv,
  } = options;

  // Create temp output directory
  const outputDir = path.join(os.tmpdir(), `bunsen-scorer-${runId}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const mounts = buildScorerContainerMounts({
    workspaceDir,
    workspaceSourceDir,
    runDir,
    outputDir,
    verifiersPath,
    scorerBundlePath,
    nodeRuntimePath,
    proxyCertsDir,
    proxyBootstrapBundlePath,
  });

  const env = buildScorerContainerEnv({
    reservedEnv,
    imageEnvPath: await inspectImageEnvPath(image),
  });

  const container = await createPersistentContainer(
    {
      image,
      mounts,
      env,
      workdir: '/workspace',
      platform,
    },
    { runId, name: `bunsen-scorer-${runId}` }
  );

  // Write bunsen-score helper into the container (base64-encoded to avoid shell escaping issues)
  await writeFileInContainer(container, '/bunsen/bin/bunsen-score', BUNSEN_SCORE_SCRIPT, { mode: '755' });

  // Symlink Node.js runtime onto PATH for custom images
  if (nodeRuntimePath) {
    await execShellInContainer(
      container,
      'ln -sf /bunsen/runtime/node /usr/local/bin/node',
      { timeout: 10000 }
    );
  }

  return { container, outputDir };
}

/**
 * Run a code-based scorer in the scorer container.
 *
 * Score resolution order (see `docs/SCORERS.md`):
 *   1. `BUNSEN_EVAL_RESULT` (`result.json`) — takes precedence; supplies
 *      score, optional summary, and optional artifact metadata.
 *   2. `BUNSEN_SCORE_FILE` — float in `[0, 1]`.
 *   3. Exit code — `0` → 1.0, non-zero → 0.0.
 *   4. Summary falls back to "Passed" / "Failed (exit code N)".
 */
export async function runCodeScorer(
  scorerContainer: ScorerContainerInfo,
  options: CodeScorerOptions
): Promise<ScorerOutput> {
  const { container, outputDir } = scorerContainer;
  const { code, criterion, runDir, timeout = 60 } = options;
  const slug = slugifyCriterion(criterion);
  const timeoutMs = timeout * 1000;

  // Clean output files from previous run
  const scoreFile = path.join(outputDir, 'score');
  const summaryFile = path.join(outputDir, 'summary');
  const resultFile = path.join(outputDir, 'result.json');
  if (fs.existsSync(scoreFile)) fs.unlinkSync(scoreFile);
  if (fs.existsSync(summaryFile)) fs.unlinkSync(summaryFile);
  if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile);

  let exitCode: number;
  let stdout = '';
  let stderr = '';

  try {
    const execOptions = buildScorerExecOptions(scorerContainer, SCRIPT_SCORER_ENV);
    const result = await execShellInContainer(
      container,
      `${pgidRecordPrefix(SCORER_PGID_FILE)}${code}`,
      {
        workdir: '/workspace',
        timeout: timeoutMs,
        user: execOptions.user,
        env: execOptions.env,
      }
    );

    exitCode = result.exitCode;
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    // Timeout or other execution error
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof ExecTimeoutError;
    // A timed-out script keeps running otherwise (Docker only abandons the
    // exec) — kill its process group before the next criterion.
    if (isTimeout) await reapTimedOutScorer(scorerContainer, criterion);

    const logAbs = path.join(runDir, 'evaluation', 'criteria', `${slug}.log`);
    fs.mkdirSync(path.dirname(logAbs), { recursive: true });

    if (isTimeout) {
      // Honor whatever the script already wrote (see docs/SCORERS.md,
      // "Score resolution on timeout"). Output files live on the host side
      // of the /bunsen/scorer-output mount, so they are readable even
      // though the exec was killed.
      const resultContent = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf-8') : null;
      const scoreContent = fs.existsSync(scoreFile) ? fs.readFileSync(scoreFile, 'utf-8') : null;
      const resolved = resolveTimeoutOutput(resultContent, scoreContent, timeout);

      fs.writeFileSync(logAbs, `[TIMEOUT] Command timed out after ${timeout}s\n${resolved.summary}\n`);

      if (resolved.parsed) {
        const collected = collectScriptResultArtifacts(resolved.parsed.artifacts, {
          scorerOutputDir: outputDir,
          runDir,
          criterionSlug: slug,
        });
        return {
          score: resolved.score,
          summary: resolved.summary,
          ...(collected.attached.length > 0 ? { artifacts: collected.attached } : {}),
        };
      }
      return { score: resolved.score, summary: resolved.summary };
    }

    fs.writeFileSync(logAbs, `[ERROR] ${message}\n`);
    return { score: 0, summary: `Error: ${message}` };
  }

  // Save log file
  const logAbs = path.join(runDir, 'evaluation', 'criteria', `${slug}.log`);
  fs.mkdirSync(path.dirname(logAbs), { recursive: true });
  const logContent = stdout + (stderr ? `\n--- STDERR ---\n${stderr}` : '');
  fs.writeFileSync(logAbs, logContent);

  // Priority 1: structured result.json (overrides score file + exit code).
  if (fs.existsSync(resultFile)) {
    const content = fs.readFileSync(resultFile, 'utf-8');
    let parsed: ParsedScriptResult;
    try {
      parsed = parseResultJson(content);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { score: 0, summary: message };
    }

    const collected = collectScriptResultArtifacts(parsed.artifacts, {
      scorerOutputDir: outputDir,
      runDir,
      criterionSlug: slug,
    });

    const summary =
      parsed.summary ?? (exitCode === 0 ? 'Passed' : `Failed (exit code ${exitCode})`);

    return {
      score: parsed.score,
      summary,
      ...(collected.attached.length > 0 ? { artifacts: collected.attached } : {}),
    };
  }

  // Priority 2/3: score file or exit code.
  const scoreFileContent = fs.existsSync(scoreFile)
    ? fs.readFileSync(scoreFile, 'utf-8')
    : null;
  const summaryFileContent = fs.existsSync(summaryFile)
    ? fs.readFileSync(summaryFile, 'utf-8')
    : null;

  const { score, error: scoreError } = resolveScore(scoreFileContent, exitCode);
  let summary = resolveSummary(summaryFileContent, scoreFileContent, exitCode);

  if (scoreError) {
    summary = scoreError;
  }

  return { score, summary };
}

/**
 * Copy `result.json` artifacts out of the scorer-output dir into a per-criterion
 * subdirectory of the run dir, returning manifest-friendly relative paths.
 *
 * Skips entries that escape `scorerOutputDir` or are missing on disk; those
 * cases are noted in the returned `warnings` so callers can include them in
 * the criterion log.
 */
export function collectScriptResultArtifacts(
  artifacts: ScriptResultArtifact[],
  options: { scorerOutputDir: string; runDir: string; criterionSlug: string }
): {
  attached: ScriptResultArtifact[];
  warnings: string[];
} {
  const { scorerOutputDir, runDir, criterionSlug } = options;
  const attached: ScriptResultArtifact[] = [];
  const warnings: string[] = [];

  if (artifacts.length === 0) {
    return { attached, warnings };
  }

  const destBaseRel = path.posix.join('evaluation', 'criteria', criterionSlug, 'artifacts');
  const destBaseAbs = path.join(runDir, destBaseRel);

  for (const artifact of artifacts) {
    const relPath = artifact.path.replace(/^\/+/, '');
    const sourceAbs = path.resolve(scorerOutputDir, relPath);
    const sourceRel = path.relative(scorerOutputDir, sourceAbs);
    if (sourceRel.startsWith('..') || path.isAbsolute(sourceRel)) {
      warnings.push(`Artifact path escapes scorer-output: ${artifact.path}`);
      continue;
    }
    if (!fs.existsSync(sourceAbs)) {
      warnings.push(`Artifact missing on disk: ${artifact.path}`);
      continue;
    }

    const destAbs = path.join(destBaseAbs, relPath);
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.copyFileSync(sourceAbs, destAbs);

    attached.push({
      path: path.posix.join(destBaseRel, relPath.split(path.sep).join('/')),
      ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}),
    });
  }

  return { attached, warnings };
}

// =============================================================================
// LLM scorers (judge / agent / browser-agent / report)
// =============================================================================

/**
 * Outcome of one LLM-scorer exec.
 *
 * There is no third state: a scorer that crashed, timed out, or produced no
 * parseable verdict is `ok: false` and the criterion records `score: null` +
 * `status: 'error'` (DESIGN.md D6). It is never a `0` — a `0` means the agent
 * failed the criterion, which is a claim the platform has no evidence for
 * when its own scorer fell over.
 */
export type LLMScorerRun =
  | { ok: true; output: ScorerOutput }
  | { ok: false; error: string; timedOut: boolean };

/** Tail of a stderr stream to quote in an error message. */
const SCORER_STDERR_TAIL_CHARS = 500;

function tail(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

/**
 * The human-readable reason a scorer exited non-zero. The bundle's contract is
 * one `Scoring failed: <message>` line on stderr (followed by a stack only for
 * unexpected crashes), so that line is the reason; without it, the last
 * non-empty line stands in. The full stderr still lands in the criterion log.
 */
export function scorerFailureReason(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const failed = lines.filter((l) => l.startsWith('Scoring failed:')).pop();
  const reason = failed ?? lines.filter((l) => !l.startsWith('at ')).pop() ?? '';
  return reason.length > SCORER_STDERR_TAIL_CHARS ? `${reason.slice(0, SCORER_STDERR_TAIL_CHARS)}…` : reason;
}

/**
 * Map a raw scorer exec outcome onto {@link LLMScorerRun}. Pure: the caller
 * supplies whatever the exec produced (a thrown error, or exit code + streams)
 * and gets back the verdict or the reason there isn't one.
 */
export function interpretScorerExec(outcome: {
  /** The error `execInContainer` threw, if it threw. */
  error?: unknown;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** The exec's timeout, for the timed-out message. */
  timeoutMs: number;
}): LLMScorerRun {
  const { error, exitCode, stdout = '', stderr = '', timeoutMs } = outcome;

  if (error !== undefined) {
    if (error instanceof ExecTimeoutError) {
      return {
        ok: false,
        timedOut: true,
        error: `Scorer timed out after ${Math.round(timeoutMs / 1000)}s`,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, timedOut: false, error: message };
  }

  if (exitCode !== 0) {
    const detail = scorerFailureReason(stderr);
    return {
      ok: false,
      timedOut: false,
      error: `Scorer exited ${exitCode}${detail ? `: ${detail}` : ''}`,
    };
  }

  const raw = stdout.trim();
  if (!raw) {
    return { ok: false, timedOut: false, error: 'Scorer produced no verdict (no output)' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      timedOut: false,
      error: `Scorer produced no verdict (unparseable output: ${tail(raw, SCORER_STDERR_TAIL_CHARS)})`,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      timedOut: false,
      error: `Scorer produced no verdict (expected a JSON object, got ${tail(raw, SCORER_STDERR_TAIL_CHARS)})`,
    };
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.summary !== 'string') {
    return {
      ok: false,
      timedOut: false,
      error: 'Scorer produced no verdict (output has no "summary")',
    };
  }
  if (obj.score !== undefined && obj.score !== null && typeof obj.score !== 'number') {
    return {
      ok: false,
      timedOut: false,
      error: `Scorer produced no verdict (invalid "score": ${JSON.stringify(obj.score)})`,
    };
  }

  const output: ScorerOutput = {
    score: (obj.score ?? null) as number | null,
    summary: obj.summary,
  };
  if (typeof obj.report === 'string') output.report = obj.report;
  if (Array.isArray(obj.screenshots)) {
    output.screenshots = obj.screenshots.filter((s): s is string => typeof s === 'string');
  }
  if (Array.isArray(obj.artifacts)) {
    output.artifacts = obj.artifacts as ScriptResultArtifact[];
  }
  return { ok: true, output };
}

/**
 * Run an LLM-based scorer (judge / agent / browser-agent / report) in the
 * scorer container.
 *
 * Writes the resolved {@link ScorerConfig} to the writable output dir, then
 * invokes the scorer binary (`scorer.cjs`) with exactly one provider API key
 * in the exec env — never in the container's base env, so `type: script`
 * criteria never see it. The scorer's stderr is streamed to `onLog` and always
 * persisted to `evaluation/criteria/<slug>.log` under `runDir`, so a failed
 * criterion leaves the same forensic trail a script criterion does.
 */
/**
 * Replace every occurrence of a known secret value with `[redacted]`.
 *
 * The scorer's stderr is persisted as the criterion log, and an agentic scorer
 * can legitimately read files that hold live keys (e.g. the run's
 * `agent-script.sh` exports the agent's provider keys). The host knows every
 * secret it handed out — the platform keys and the agent's env — so it scrubs
 * them from the log before anything is written or echoed. Values shorter than
 * 8 characters are ignored: they are not keys, and blanking them would mangle
 * ordinary text.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

/**
 * Scrub secrets from a stream whose chunk boundaries are arbitrary. A secret
 * split across two chunks matches in neither, so `push` holds back any tail
 * that is a prefix of a secret until the next chunk (or `flush`) decides.
 */
export function createStreamScrubber(secrets: readonly string[]): {
  push(chunk: string): string;
  flush(): string;
} {
  const live = secrets.filter((s) => s.length >= 8);
  let pending = '';
  return {
    push(chunk) {
      pending += chunk;
      // Earliest point from which the remaining text could still be the start
      // of a secret — everything before it is safe to emit once scrubbed.
      const longest = Math.max(0, ...live.map((s) => s.length));
      let hold = pending.length;
      for (let i = Math.max(0, pending.length - longest + 1); i < pending.length; i++) {
        const tail = pending.slice(i);
        if (live.some((s) => s.startsWith(tail))) {
          hold = i;
          break;
        }
      }
      const out = redactSecrets(pending.slice(0, hold), live);
      pending = pending.slice(hold);
      return out;
    },
    flush() {
      const out = redactSecrets(pending, live);
      pending = '';
      return out;
    },
  };
}

/** Where a scorer exec records its process group, so a timed-out one can be reaped. */
export const SCORER_PGID_FILE = '/bunsen/scorer-output/scorer.pgid';

/** The shell line that runs the scorer bundle after recording its process group. */
export function scorerExecScript(nodeCmd: string, configContainerPath: string): string {
  return `${pgidRecordPrefix(SCORER_PGID_FILE)}exec '${nodeCmd}' /bunsen/lib/scorer.cjs --config '${configContainerPath}'`;
}

/**
 * SIGKILL a timed-out scorer's process group before the next criterion runs —
 * Docker only abandons the exec, so without this the scorer keeps making paid
 * requests and writing into the shared workspace and screenshot dir.
 */
async function reapTimedOutScorer(
  scorerContainer: ScorerContainerInfo,
  label: string,
  onLog?: (msg: string) => void,
): Promise<void> {
  try {
    const result = await execShellInContainer(
      scorerContainer.container,
      reapProcessGroupCommand(SCORER_PGID_FILE, label),
      { timeout: 10_000, user: scorerContainer.execUser },
    );
    onLog?.(`[scorer:${label}] ${result.stdout.trim() || 'reaped timed-out scorer'}`);
  } catch (err) {
    onLog?.(
      `[scorer:${label}] Warning: failed to reap the timed-out scorer: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function runLLMScorer(
  scorerContainer: ScorerContainerInfo,
  options: {
    /** Fully resolved scorer config (model already `<provider>/<model>`). */
    config: ScorerConfig;
    /** The provider key this criterion's model needs (delivered as a one-time file). */
    apiKey: string;
    /** Node command path ('node' or '/bunsen/runtime/node') */
    nodeCmd: string;
    /** Timeout in milliseconds */
    timeout: number;
    /** Proxy env vars (from getProxyEnv()) for trace capture */
    proxyEnv?: Record<string, string>;
    /** Run directory (for the criterion log file) */
    runDir: string;
    /**
     * Secret values to scrub from the scorer's stderr before it is echoed or
     * written to the criterion log (see {@link redactSecrets}). The exec's own
     * provider key is always included.
     */
    redact?: readonly string[];
    /** Log callback */
    onLog?: (msg: string) => void;
  }
): Promise<LLMScorerRun> {
  const { container } = scorerContainer;
  const { config, apiKey, nodeCmd, timeout, proxyEnv, runDir, onLog } = options;
  const secrets = [apiKey, ...(options.redact ?? [])];
  const scrub = (text: string) => redactSecrets(text, secrets);
  const criterion = config.id;
  const slug = slugifyCriterion(criterion);

  // Deliver the config through `docker exec` (base64), not by writing to the
  // bind-mounted output dir from the host: on Docker Desktop the container can
  // observe a host write before it has fully synced and read a truncated file
  // (seen live as `Unterminated string in JSON` on a multi-KB report config).
  const configContainerPath = '/bunsen/scorer-output/scorer-config.json';
  await writeFileInContainer(container, configContainerPath, JSON.stringify(config, null, 2), {
    mode: '644',
  });

  // The key goes in as a one-time file owned by the exec user (mode 600),
  // never an env var: `/proc/<pid>/environ` keeps the initial environment for
  // the life of the process, where any `read_file` or model-authored
  // Playwright code could find it. The bundle reads and unlinks the file
  // before anything else runs; the host removes it after the exec regardless.
  const keyFile = `/tmp/bunsen-scorer-${randomUUID()}.key`;
  await writeFileInContainer(container, keyFile, `${apiKey}\n`, {
    mode: '600',
    user: scorerContainer.execUser,
  });
  const removeKeyFile = () =>
    execShellInContainer(container, `rm -f '${keyFile}'`, {
      timeout: 5_000,
      user: scorerContainer.execUser,
    }).catch(() => undefined);

  // Exec-scoped env: trace attribution + the key file's path + proxy vars.
  const env: Record<string, string> = {
    BUNSEN_TRACE_SOURCE: `scorer:${criterion}`,
    [SCORER_KEY_FILE_ENV]: keyFile,
    ...(proxyEnv || {}),
  };
  const execOptions = buildScorerExecOptions(scorerContainer, env);

  // Raw chunks are kept and scrubbed once over the assembled text: a secret
  // split across two chunks would survive a per-chunk scrub. The live echo is
  // scrubbed per chunk (best effort) because it cannot wait for the end.
  const stderrChunks: string[] = [];
  // The live echo cannot wait for the end, so it is scrubbed through a
  // boundary-aware scrubber (a secret split across two chunks is held back).
  const echo = createStreamScrubber(secrets);
  const emitEcho = (text: string) => {
    const line = text.trim();
    if (line) onLog?.(`[scorer:${criterion}] ${line}`);
  };
  let fullStderr = '';
  let run: LLMScorerRun;
  try {
    const result = await execShellInContainer(
      container,
      scorerExecScript(nodeCmd, configContainerPath),
      {
        env: execOptions.env,
        user: execOptions.user,
        timeout,
        onOutput: (chunk, stream) => {
          if (stream === 'stderr') {
            stderrChunks.push(chunk);
            emitEcho(echo.push(chunk));
          }
        },
      }
    );
    emitEcho(echo.flush());
    fullStderr = result.stderr || stderrChunks.join('');
    run = interpretScorerExec({
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: scrub(fullStderr),
      timeoutMs: timeout,
    });
  } catch (error) {
    emitEcho(echo.flush());
    // ExecTimeoutError.stderr is the same accumulation the chunks hold — use
    // one or the other, never both.
    fullStderr = error instanceof ExecTimeoutError && error.stderr ? error.stderr : stderrChunks.join('');
    run = interpretScorerExec({ error, timeoutMs: timeout });
    if (error instanceof ExecTimeoutError) await reapTimedOutScorer(scorerContainer, criterion, onLog);
  } finally {
    await removeKeyFile();
  }
  if (!run.ok) run = { ...run, error: scrub(run.error) };
  // The verdict text is persisted to evaluation.json and the manifest, and an
  // agentic scorer can quote a file that holds a key — scrub it too.
  if (run.ok) {
    run = {
      ok: true,
      output: {
        ...run.output,
        summary: scrub(run.output.summary),
        ...(run.output.report !== undefined ? { report: scrub(run.output.report) } : {}),
      },
    };
  }

  if (!run.ok) {
    onLog?.(`[scorer:${criterion}] ${run.timedOut ? 'Timed out' : 'Failed'}: ${run.error}`);
  }

  // Always leave a criterion log — the reason a scorer produced no verdict is
  // the only thing a user can act on.
  const logAbs = path.join(runDir, 'evaluation', 'criteria', `${slug}.log`);
  try {
    fs.mkdirSync(path.dirname(logAbs), { recursive: true });
    const body = scrub(fullStderr);
    const trailer = run.ok ? '' : `${run.timedOut ? '[TIMEOUT]' : '[ERROR]'} ${run.error}\n`;
    fs.writeFileSync(logAbs, body.endsWith('\n') || body === '' ? body + trailer : `${body}\n${trailer}`);
  } catch (err) {
    onLog?.(
      `[scorer:${criterion}] Warning: could not write criterion log: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return run;
}

/**
 * Stop the scorer container and clean up temp directory.
 */
export async function stopScorerContainer(
  scorerContainer: ScorerContainerInfo
): Promise<void> {
  await stopContainer(scorerContainer.container);

  // Clean up temp output directory
  try {
    fs.rmSync(scorerContainer.outputDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}
