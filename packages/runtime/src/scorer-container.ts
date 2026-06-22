// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
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
import type {
  ScorerOutput,
  ScriptResultArtifact,
  RunPlatform,
} from '@bunsen-dev/types';
import {
  createPersistentContainer,
  execInContainer,
  execShellInContainer,
  writeFileInContainer,
  stopContainer,
  ExecTimeoutError,
  type PersistentContainer,
} from './container.js';

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
export const SCRIPT_SCORER_ENV: Readonly<Record<string, string>> = Object.freeze({
  BUNSEN_SCORE_FILE: '/bunsen/scorer-output/score',
  BUNSEN_SUMMARY_FILE: '/bunsen/scorer-output/summary',
  BUNSEN_SCORER_OUTPUT: '/bunsen/scorer-output',
  BUNSEN_EVAL_RESULT: '/bunsen/scorer-output/result.json',
  BUNSEN_WORKSPACE_DIR: '/workspace',
  BUNSEN_WORKSPACE_SOURCE_DIR: '/workspace-source',
});

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
  /** API key for platform agents */
  apiKey?: string;
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
    scorerBundlePath, nodeRuntimePath, apiKey, proxyCertsDir,
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

  const env: Record<string, string> = {
    ...SCRIPT_SCORER_ENV,
    ...(reservedEnv ?? {}),
    PATH: '/bunsen/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  };

  if (apiKey) {
    env.BUNSEN_ANTHROPIC_API_KEY = apiKey;
  }

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
      code,
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

    // Save log
    const logAbs = path.join(runDir, 'evaluation', 'criteria', `${slug}.log`);
    fs.mkdirSync(path.dirname(logAbs), { recursive: true });
    const logContent = isTimeout
      ? `[TIMEOUT] Command timed out after ${timeout}s\n`
      : `[ERROR] ${message}\n`;
    fs.writeFileSync(logAbs, logContent);

    return {
      score: 0,
      summary: isTimeout
        ? `Timed out after ${timeout}s`
        : `Error: ${message}`,
    };
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

/**
 * Run an LLM-based scorer in the scorer container.
 *
 * Writes the scorer config to the writable output dir, then invokes the
 * scorer binary (scorer.cjs) in the container. Parses JSON from stdout.
 */
export async function runLLMScorer(
  scorerContainer: ScorerContainerInfo,
  options: {
    /** Serialized ScorerConfig JSON */
    configJson: string;
    /** Criterion name (for logging) */
    criterion: string;
    /** Node command path ('node' or '/bunsen/runtime/node') */
    nodeCmd: string;
    /** Timeout in milliseconds */
    timeout: number;
    /** Proxy env vars (from getProxyEnv()) for trace capture */
    proxyEnv?: Record<string, string>;
    /** Log callback */
    onLog?: (msg: string) => void;
  }
): Promise<ScorerOutput> {
  const { container, outputDir } = scorerContainer;
  const { configJson, criterion, nodeCmd, timeout, proxyEnv, onLog } = options;

  // Write config to the writable scorer-output dir (accessible inside container)
  const configHostPath = path.join(outputDir, 'scorer-config.json');
  fs.writeFileSync(configHostPath, configJson);

  // Build env vars for the scorer process
  const env: Record<string, string> = {
    BUNSEN_TRACE_SOURCE: `scorer:${criterion}`,
    ...(proxyEnv || {}),
  };
  const execOptions = buildScorerExecOptions(scorerContainer, env);

  // Run scorer binary in container
  let scorerResult;
  try {
    scorerResult = await execInContainer(
      container,
      [nodeCmd, '/bunsen/lib/scorer.cjs', '--config', '/bunsen/scorer-output/scorer-config.json'],
      {
        env: execOptions.env,
        user: execOptions.user,
        timeout,
        onOutput: (chunk, stream) => {
          if (stream === 'stderr') {
            onLog?.(`[scorer:${criterion}] ${chunk.trim()}`);
          }
        },
      }
    );
  } catch (error) {
    // Handle timeout or other execution errors gracefully
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof ExecTimeoutError;
    const timeoutSecs = Math.round(timeout / 1000);

    onLog?.(`[scorer:${criterion}] ${isTimeout ? 'Timed out' : 'Failed'}: ${message}`);

    return {
      score: 0,
      summary: isTimeout
        ? `Scorer timed out after ${timeoutSecs}s. The evaluation could not complete in the allotted time.`
        : `Scorer error: ${message}`,
    };
  }

  if (scorerResult.exitCode !== 0) {
    throw new Error(
      `Scorer failed for "${criterion}" (exit ${scorerResult.exitCode}): ${scorerResult.stderr}`
    );
  }

  // Parse JSON output from stdout
  try {
    return JSON.parse(scorerResult.stdout);
  } catch {
    throw new Error(
      `Failed to parse scorer output for "${criterion}": ${scorerResult.stdout}`
    );
  }
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
