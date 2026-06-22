// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Local storage management for runs.
 *
 * `manifest.json` is the canonical, on-disk source of truth for every run.
 * Every state transition (status change, traces capture, evaluation result,
 * human scoring) loads the manifest, mutates it, and writes it back atomically.
 * Readers consume `RunManifestV1` (snake_case) directly — there is no legacy
 * camelCase projection layer.
 *
 * Run dirs follow the v1 nested layout (see `RunManifestV1` in
 * `@bunsen-dev/types/src/manifest.ts` and `docs/RUN_MANIFEST.md`):
 *
 *   .bunsen/runs/<id>/
 *     manifest.json
 *     events.jsonl                       # task 13c
 *     logs.txt
 *     orchestration/result.json
 *     task/prompt.md
 *     workspace/diff.patch
 *     workspace/export.tar.gz
 *     traces/agent.jsonl
 *     traces/platform.jsonl
 *     traces/threads/index.json          # small per-thread index + run summary
 *     traces/threads/thread-1.jsonl      # one turn per line, dedup'd messages
 *     traces/threads/thread-2.jsonl
 *     traces/summary.json
 *     evaluation/result.json
 *     evaluation/report.md
 *     evaluation/human.json
 *     evaluation/criteria/<slug>.json
 *     evaluation/criteria/<slug>.log
 *     artifacts/output/...
 *     artifacts/screenshots/...
 *     artifacts/recording.cast
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ulid } from 'ulid';
import type {
  AITrace,
  TracesSummary,
  EvaluationResult,
  HumanScores,
  RunManifestV1,
  RunStatus,
} from '@bunsen-dev/types';
import type { ThreadsIndex, ThreadTurn } from './trace-filter.js';
import { streamProcessTraces } from './trace-stream.js';
import { upsertManifestSafely } from './run-index.js';
import {
  buildEvaluationProjection,
  buildHumanScoringProjection,
  projectUsageBreakdown,
} from './manifest-projections.js';

const BUNSEN_DIR = '.bunsen';
const RUNS_DIR = 'runs';
export const RUN_MANIFEST_FILENAME = 'manifest.json';
export const RUN_MANIFEST_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// V1 layout path helpers
// ---------------------------------------------------------------------------

export const RUN_PATHS = {
  manifest: RUN_MANIFEST_FILENAME,
  events: 'events.jsonl',
  logs: 'logs.txt',
  taskPrompt: 'task/prompt.md',
  orchestrationResult: 'orchestration/result.json',
  workspaceDiff: 'workspace/diff.patch',
  workspaceTar: 'workspace/export.tar.gz',
  tracesAgent: 'traces/agent.jsonl',
  tracesPlatform: 'traces/platform.jsonl',
  tracesThreadsDir: 'traces/threads',
  tracesThreadsIndex: 'traces/threads/index.json',
  tracesSummary: 'traces/summary.json',
  evaluationResult: 'evaluation/result.json',
  evaluationReport: 'evaluation/report.md',
  evaluationHuman: 'evaluation/human.json',
  evaluationCriteriaDir: 'evaluation/criteria',
  artifactsOutput: 'artifacts/output',
  artifactsScreenshots: 'artifacts/screenshots',
  artifactsRecording: 'artifacts/recording.cast',
} as const;

export function getBunsenDir(baseDir: string = process.cwd()): string {
  return path.join(baseDir, BUNSEN_DIR);
}

export function getRunsDir(baseDir: string = process.cwd()): string {
  return path.join(getBunsenDir(baseDir), RUNS_DIR);
}

export function ensureStorageDir(baseDir: string = process.cwd()): void {
  fs.mkdirSync(getRunsDir(baseDir), { recursive: true });
}

export function getRunDir(runId: string, baseDir: string = process.cwd()): string {
  return path.join(getRunsDir(baseDir), runId);
}

export function getRunManifestPath(runId: string, baseDir: string = process.cwd()): string {
  return path.join(getRunDir(runId, baseDir), RUN_MANIFEST_FILENAME);
}

/**
 * Generate a new run ID. ULID: 26-char Crockford base32, lexicographically
 * sortable by creation time — directory listing order matches `started_at`
 * order, which the manifest spec relies on.
 */
export function generateRunId(): string {
  return ulid();
}

// ---------------------------------------------------------------------------
// Manifest atomic IO
// ---------------------------------------------------------------------------

/**
 * Atomically write `manifest.json` into the run directory.
 *
 * Writes to a sibling temp file, fsyncs the file descriptor, then renames
 * over the canonical path. Readers either see the previous manifest or the
 * new one; never a half-written one.
 *
 * Side effect: best-effort SQLite index upsert. Index failures are
 * swallowed — `bn rebuild-index` recovers later.
 */
export function saveRunManifest(
  runId: string,
  manifest: RunManifestV1,
  baseDir: string = process.cwd()
): void {
  const target = getRunManifestPath(runId, baseDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(manifest, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  // Synchronous SQLite upsert so the index never lags the manifest. The
  // safely variant swallows index failures — `bn rebuild-index` recovers.
  // The cycle with run-index.ts is benign: both files export only
  // functions; neither side touches the other at module-init time.
  upsertManifestSafely(manifest, baseDir);
}

export function loadRunManifest(
  runId: string,
  baseDir: string = process.cwd()
): RunManifestV1 | null {
  const target = getRunManifestPath(runId, baseDir);
  if (!fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, 'utf-8')) as RunManifestV1;
}

function loadRunManifestOrThrow(
  runId: string,
  baseDir: string = process.cwd()
): RunManifestV1 {
  const manifest = loadRunManifest(runId, baseDir);
  if (!manifest) {
    throw new Error(`Run not found: ${runId}`);
  }
  return manifest;
}

/**
 * Load the manifest, apply `mutate`, refresh `updated_at`, and persist.
 *
 * `manifest_revision` is intentionally NOT bumped here. The revision is a
 * per-write-event counter; bumping it on every internal field projection
 * (status flip, traces summary, evaluation result, human scoring) would
 * have a single `bn run` push revision into double digits with no
 * external observer to notice. Revision bumps belong to `refreshRunManifest`
 * (end-of-run) and any out-of-band rewrite that wants to advertise an
 * external update.
 */
/**
 * Load the manifest, apply `mutate`, refresh `updated_at`, and persist.
 * The recommended way for callers (executor, evaluation, human-scoring) to
 * make field-level updates without juggling load/save themselves.
 */
export function mutateRunManifest(
  runId: string,
  baseDir: string,
  mutate: (manifest: RunManifestV1) => void
): RunManifestV1 {
  const manifest = loadRunManifestOrThrow(runId, baseDir);
  mutate(manifest);
  manifest.updated_at = new Date().toISOString();
  saveRunManifest(runId, manifest, baseDir);
  return manifest;
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

/**
 * Suite provenance recorded on a run when the experiment was resolved via a
 * suite (clone or local on-disk). All fields are derived: `id` is the
 * canonical suite id (`<host>/<org>/<repo>` or `local/<dirname>`), `version`
 * is the commit sha of the cloned ref, `source_url` is the git URL.
 */
export interface RunSuiteProvenance {
  id: string;
  version?: string;
  source_url?: string;
}

/** Options for {@link createRun}. */
export interface CreateRunOptions {
  experimentId: string;
  experimentPath: string;
  agentId: string;
  agentPath: string;
  args?: string[];
  /** Project root that owns this run's `.bunsen/` storage. */
  baseDir?: string;
  /** Agent variant when one was selected. */
  variant?: string;
  /** Suite provenance — set only when the experiment was resolved via a suite. */
  suite?: RunSuiteProvenance;
}

/**
 * Create a new run. Writes the initial `manifest.json` so every run is born
 * with the v1 manifest as the source of truth — no synthesizer needed.
 */
export function createRun(options: CreateRunOptions): RunManifestV1 {
  const {
    experimentId,
    experimentPath,
    agentId,
    agentPath,
    args = [],
    baseDir = process.cwd(),
    variant,
    suite,
  } = options;

  ensureStorageDir(baseDir);

  const runId = generateRunId();
  const runDir = getRunDir(runId, baseDir);

  // Pre-create the v1 layout subdirs that downstream writers (proxy,
  // scorer, asciinema) expect to exist before they drop files.
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(runDir, 'traces'), { recursive: true });
  fs.mkdirSync(path.join(runDir, RUN_PATHS.artifactsOutput), { recursive: true });

  const now = new Date().toISOString();
  const manifest: RunManifestV1 = {
    schema_version: RUN_MANIFEST_SCHEMA_VERSION,
    run_id: runId,
    manifest_revision: 1,
    run_source: 'local',
    created_at: now,
    updated_at: now,
    status: 'pending',
    started_at: now,
    duration_ms: 0,
    experiment: {
      id: experimentId,
      ...(experimentPath ? { path: experimentPath } : {}),
      ...(suite ? { suite_id: suite.id } : {}),
      ...(suite?.version ? { suite_version: suite.version } : {}),
      ...(suite?.source_url ? { suite_source_url: suite.source_url } : {}),
    },
    agent: {
      id: agentId,
      args,
      ...(agentPath ? { path: agentPath } : {}),
      ...(variant ? { variant } : {}),
    },
    usage: {
      total_ai_calls: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      estimated_cost_usd: 0,
    },
    provenance: {
      verification_tier: 'self_reported',
      replayable: false,
    },
    artifacts: [],
  };

  saveRunManifest(runId, manifest, baseDir);
  return manifest;
}

/**
 * Update run status (and optionally exit code). Stamps `completed_at` and
 * `duration_ms` for terminal statuses.
 */
export function updateRunStatus(
  runId: string,
  status: RunStatus,
  exitCode?: number,
  baseDir: string = process.cwd()
): void {
  mutateRunManifest(runId, baseDir, (m) => {
    m.status = status;
    if (exitCode !== undefined) m.exit_code = exitCode;
    if (status === 'succeeded' || status === 'failed' || status === 'canceled') {
      const completedAt = new Date().toISOString();
      m.completed_at = completedAt;
      m.duration_ms = new Date(completedAt).getTime() - new Date(m.started_at).getTime();
    }
  });
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export function saveLogs(runId: string, logs: string, baseDir: string = process.cwd()): void {
  fs.writeFileSync(path.join(getRunDir(runId, baseDir), RUN_PATHS.logs), logs);
}

export function appendLogs(runId: string, logs: string, baseDir: string = process.cwd()): void {
  fs.appendFileSync(path.join(getRunDir(runId, baseDir), RUN_PATHS.logs), logs);
}

export function loadLogs(runId: string, baseDir: string = process.cwd()): string | undefined {
  const logsPath = path.join(getRunDir(runId, baseDir), RUN_PATHS.logs);
  if (!fs.existsSync(logsPath)) return undefined;
  return fs.readFileSync(logsPath, 'utf-8');
}

// ---------------------------------------------------------------------------
// Task prompt + orchestration
// ---------------------------------------------------------------------------

/**
 * Save the canonical task prompt as `task/prompt.md`. Records the exact
 * prompt the agent received so it survives the run dir even if the
 * experiment yaml mutates later.
 */
export function saveTaskPrompt(
  runId: string,
  prompt: string,
  baseDir: string = process.cwd()
): void {
  const promptPath = path.join(getRunDir(runId, baseDir), RUN_PATHS.taskPrompt);
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(promptPath, prompt);
}

export function loadTaskPrompt(
  runId: string,
  baseDir: string = process.cwd()
): string | undefined {
  const promptPath = path.join(getRunDir(runId, baseDir), RUN_PATHS.taskPrompt);
  if (!fs.existsSync(promptPath)) return undefined;
  return fs.readFileSync(promptPath, 'utf-8');
}

/**
 * Save the orchestration result as `orchestration/result.json`. The same
 * payload also lives on the manifest's `orchestration` field for quick
 * access; this file is the canonical artifact catalogued in
 * `manifest.json:artifacts[]`.
 */
export function saveOrchestrationResult(
  runId: string,
  result: unknown,
  baseDir: string = process.cwd()
): void {
  const targetPath = path.join(getRunDir(runId, baseDir), RUN_PATHS.orchestrationResult);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(result, null, 2));
}

export function loadOrchestrationResult<T = unknown>(
  runId: string,
  baseDir: string = process.cwd()
): T | undefined {
  const targetPath = path.join(getRunDir(runId, baseDir), RUN_PATHS.orchestrationResult);
  if (!fs.existsSync(targetPath)) return undefined;
  return JSON.parse(fs.readFileSync(targetPath, 'utf-8')) as T;
}

// ---------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------

/**
 * Parse JSONL traces file (one JSON object per line)
 */
export function parseTracesJsonl(tracesFilePath: string): AITrace[] {
  if (!fs.existsSync(tracesFilePath)) {
    return [];
  }

  const traces: AITrace[] = [];
  const content = fs.readFileSync(tracesFilePath, 'utf-8');

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;

    try {
      const trace = JSON.parse(line);
      if (trace.provider && trace.model && trace.timestamp) {
        traces.push(trace as AITrace);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return traces;
}


/**
 * Mark a run as having no proxy-captured trace data despite tracing being
 * enabled. Persists a zero-valued `traces/summary.json` and stamps
 * `usage.accounting_status = 'missing'` on the manifest so consumers can
 * tell "no calls" from "we don't know".
 *
 * Call this after the proxy has been stopped and `traces/agent.jsonl` is
 * confirmed empty.
 */
export function markTraceCaptureMissing(
  runId: string,
  baseDir: string = process.cwd()
): void {
  const runDir = getRunDir(runId, baseDir);
  const tracesDir = path.join(runDir, 'traces');
  fs.mkdirSync(tracesDir, { recursive: true });

  const zeroSummary: TracesSummary = {
    totalCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadInputTokens: 0,
    totalCacheCreationInputTokens: 0,
    estimatedTotalCostUsd: 0,
  };
  fs.writeFileSync(
    path.join(runDir, RUN_PATHS.tracesSummary),
    JSON.stringify(zeroSummary, null, 2),
  );

  mutateRunManifest(runId, baseDir, (m) => {
    m.usage.accounting_status = 'missing';
  });
}

/**
 * Stamp `usage.accounting_status = 'skipped'` for runs that opted out of
 * trace capture (`--skip-traces`). No summary file is written — readers
 * should treat the absence as deliberate.
 */
export function markTraceCaptureSkipped(
  runId: string,
  baseDir: string = process.cwd()
): void {
  mutateRunManifest(runId, baseDir, (m) => {
    m.usage.accounting_status = 'skipped';
  });
}

export function loadTraces(runId: string, baseDir: string = process.cwd()): AITrace[] | undefined {
  const tracesPath = path.join(getRunDir(runId, baseDir), RUN_PATHS.tracesAgent);
  if (!fs.existsSync(tracesPath)) return undefined;
  return parseTracesJsonl(tracesPath);
}

export function loadTracesSummary(
  runId: string,
  baseDir: string = process.cwd()
): TracesSummary | undefined {
  const summaryPath = path.join(getRunDir(runId, baseDir), RUN_PATHS.tracesSummary);
  if (!fs.existsSync(summaryPath)) return undefined;
  return JSON.parse(fs.readFileSync(summaryPath, 'utf-8')) as TracesSummary;
}

export interface LoadThreadTurnsOptions {
  /** First turn index to include (inclusive). Defaults to 0. */
  start?: number;
  /** Last turn index to include (exclusive). Defaults to all turns. */
  end?: number;
}

/**
 * Read the small `traces/threads/index.json`. Returns null if missing.
 */
export function loadThreadsIndex(
  runId: string,
  baseDir: string = process.cwd(),
): ThreadsIndex | null {
  const indexPath = path.join(getRunDir(runId, baseDir), RUN_PATHS.tracesThreadsIndex);
  if (!fs.existsSync(indexPath)) return null;
  return JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as ThreadsIndex;
}

/**
 * Read turns from a per-thread `.jsonl`. Optional slice range — useful for
 * lazy-loading a subset (head, tail, or a specific turn) without reading the
 * full thread body.
 */
export function loadThreadTurns(
  runId: string,
  threadId: string,
  options: LoadThreadTurnsOptions = {},
  baseDir: string = process.cwd(),
): ThreadTurn[] {
  const filePath = path.join(getRunDir(runId, baseDir), RUN_PATHS.tracesThreadsDir, `${threadId}.jsonl`);
  if (!fs.existsSync(filePath)) return [];
  const start = options.start ?? 0;
  const end = options.end;
  const turns: ThreadTurn[] = [];
  let i = 0;
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    if (i < start) {
      i++;
      continue;
    }
    if (end !== undefined && i >= end) break;
    try {
      turns.push(JSON.parse(line) as ThreadTurn);
    } catch {
      // skip malformed
    }
    i++;
  }
  return turns;
}

/**
 * Read a bounded head + tail of a thread for inclusion in an LLM prompt.
 * Returns all turns if `turnCount <= headCount + tailCount`.
 */
export function loadThreadHeadTail(
  runId: string,
  threadId: string,
  turnCount: number,
  headCount: number,
  tailCount: number,
  baseDir: string = process.cwd(),
): ThreadTurn[] {
  if (turnCount <= headCount + tailCount) {
    return loadThreadTurns(runId, threadId, {}, baseDir);
  }
  const head = loadThreadTurns(runId, threadId, { start: 0, end: headCount }, baseDir);
  const tail = loadThreadTurns(
    runId,
    threadId,
    { start: turnCount - tailCount, end: turnCount },
    baseDir,
  );
  return [...head, ...tail];
}

/**
 * Build the streaming threads/ output for scorer context — mid-run snapshot.
 *
 * Reads the proxy's mixed `agent.jsonl` line by line, filters out platform
 * traces, and writes `threads/index.json` + per-thread `.jsonl` files. Does
 * NOT touch `agent.jsonl` itself or write `summary.json` — the proxy may
 * still be writing to `agent.jsonl`, and the run-wide summary is the
 * post-finalize call's job.
 */
export async function buildThreadsForScorer(
  runId: string,
  baseDir: string = process.cwd(),
): Promise<void> {
  const runDir = getRunDir(runId, baseDir);
  const inputPath = path.join(runDir, RUN_PATHS.tracesAgent);
  if (!fs.existsSync(inputPath)) return;
  const threadsDir = path.join(runDir, RUN_PATHS.tracesThreadsDir);
  await streamProcessTraces({ inputPath, threadsDir });
}

/**
 * Final trace processing.
 *
 * Streams the proxy's mixed `agent.jsonl`, splits it into
 * `agent.jsonl` (agent-only, atomic rewrite) and `platform.jsonl`, builds
 * the per-thread layout under `threads/`, writes `summary.json`, and
 * refreshes the manifest's usage projection. Call this AFTER the proxy has
 * been stopped, so the input file is closed.
 */
export async function finalizeTracesStreaming(
  runId: string,
  baseDir: string = process.cwd(),
): Promise<{ agentCallCount: number; platformCallCount: number }> {
  const runDir = getRunDir(runId, baseDir);
  const tracesDir = path.join(runDir, 'traces');
  const inputPath = path.join(runDir, RUN_PATHS.tracesAgent);
  if (!fs.existsSync(inputPath)) {
    return { agentCallCount: 0, platformCallCount: 0 };
  }
  fs.mkdirSync(tracesDir, { recursive: true });

  const agentTmpPath = path.join(tracesDir, 'agent.jsonl.new');
  const platformPath = path.join(runDir, RUN_PATHS.tracesPlatform);
  const threadsDir = path.join(runDir, RUN_PATHS.tracesThreadsDir);

  const result = await streamProcessTraces({
    inputPath,
    threadsDir,
    agentOutputPath: agentTmpPath,
    platformOutputPath: platformPath,
  });

  // Atomic rename: agent.jsonl.new → agent.jsonl. Replaces the proxy's mixed
  // file with the agent-only version. POSIX-only — Bunsen is macOS/Linux only
  // for execution.
  fs.renameSync(agentTmpPath, inputPath);

  // If the platform bucket is empty, drop the empty file the writer created.
  if (result.platformCallCount === 0) {
    try {
      fs.unlinkSync(platformPath);
    } catch {
      // ignore
    }
  }

  fs.writeFileSync(
    path.join(runDir, RUN_PATHS.tracesSummary),
    JSON.stringify(result.summary, null, 2),
  );

  // Refresh the manifest's usage projection.
  //   - total_* counters mirror the run-wide summary.
  //   - estimated_cost_usd stays the agent-only headline cost.
  //   - agent_cost_usd / platform_cost_usd split out when platform calls exist.
  //   - by_source carries the per-source breakdown when any source tag was set.
  //   - accounting_status flips to 'captured' since we have real proxy data.
  mutateRunManifest(runId, baseDir, (m) => {
    m.usage.total_ai_calls = result.summary.totalCalls;
    m.usage.total_input_tokens = result.summary.totalInputTokens;
    m.usage.total_output_tokens = result.summary.totalOutputTokens;
    m.usage.total_cache_read_input_tokens = result.summary.totalCacheReadInputTokens;
    m.usage.total_cache_creation_input_tokens = result.summary.totalCacheCreationInputTokens;
    m.usage.estimated_cost_usd = result.agentBreakdown.costUsd;
    if (result.platformBreakdown.calls > 0) {
      m.usage.agent_cost_usd = result.agentBreakdown.costUsd;
      m.usage.platform_cost_usd = result.platformBreakdown.costUsd;
    }
    const by_source = projectUsageBreakdown(result.summary);
    if (by_source) m.usage.by_source = by_source;
    // Carry the unpriced-model signal onto the newer manifest usage shape so
    // `bn runs show` / `bn runs cost` can flag that part of the cost is a
    // coarse-default estimate rather than a data-driven rate.
    if (result.summary.pricingFallbackCalls) {
      m.usage.pricing_fallback_calls = result.summary.pricingFallbackCalls;
      m.usage.unpriced_models = result.summary.unpricedModels;
    }
    m.usage.accounting_status = 'captured';
    // Record the observed per-model breakdown (most-used first). This is the
    // sole source of the run's model attribution — there is no declared
    // fallback. Absent when every agent trace reported "unknown".
    if (result.agentModels?.length) m.agent.models = result.agentModels;
  });

  return {
    agentCallCount: result.agentCallCount,
    platformCallCount: result.platformCallCount,
  };
}

/**
 * Resolve a run's trace accounting from whatever the proxy captured, on ANY
 * termination path. The executor calls this once per run from its `finally`
 * so a run that burned tokens before timing out or being cancelled still
 * records what it spent instead of reporting $0. Decides between three
 * outcomes:
 *
 *   - `--skip-traces`: stamp `accounting_status = 'skipped'`, write nothing.
 *   - traces captured: fold them into the cost summary + manifest (which
 *     refreshes the SQLite index) via {@link finalizeTracesStreaming}.
 *   - tracing on but no traces: stamp `accounting_status = 'missing'` so a
 *     trustworthy zero stays distinguishable from an unknown.
 *
 * The proxy MUST already be stopped (so `traces/agent.jsonl` is flushed and
 * closed) before calling. Not idempotent — `finalizeTracesStreaming`
 * destructively splits `agent.jsonl` — so the caller guards against re-entry.
 */
export async function finalizeRunTraces(opts: {
  runId: string;
  baseDir?: string;
  skipTraces: boolean;
  log?: (message: string) => void;
}): Promise<void> {
  const { runId, baseDir = process.cwd(), skipTraces, log = () => {} } = opts;

  if (skipTraces) {
    markTraceCaptureSkipped(runId, baseDir);
    return;
  }

  const inputPath = path.join(getRunDir(runId, baseDir), RUN_PATHS.tracesAgent);
  const hasTraces = fs.existsSync(inputPath) && fs.statSync(inputPath).size > 0;
  if (hasTraces) {
    const { agentCallCount, platformCallCount } = await finalizeTracesStreaming(runId, baseDir);
    log(`Final trace summary: ${agentCallCount + platformCallCount} total AI API call(s)`);
    return;
  }

  // The proxy was meant to be active for this run but produced no traces. We
  // don't actually know whether the agent made zero LLM calls or whether its
  // HTTP client bypassed the proxy (e.g., Node native fetch / undici, which
  // doesn't honor HTTPS_PROXY). Flag this honestly so dashboards and cost
  // rollups can distinguish a trustworthy zero from an unknown.
  log(
    'Warning: no AI API traces were captured for this run. ' +
      'Reported totals (calls, tokens, cost) will be 0. This can mean the ' +
      'agent made no LLM calls, or that its HTTP client bypassed the trace ' +
      'proxy (e.g., Node native fetch ignores HTTPS_PROXY).',
  );
  markTraceCaptureMissing(runId, baseDir);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Save evaluation result (0-1 normalized scores) to `evaluation/result.json`.
 *
 * Side effects:
 *   - per-criterion JSON projection at `evaluation/criteria/<slug>.json`
 *   - report mirror at `evaluation/report.md` when present
 *   - manifest's `evaluation` projection + headline `weighted_score`
 *     refreshed to match
 */
export function saveEvaluationResult(
  runId: string,
  result: EvaluationResult,
  baseDir: string = process.cwd()
): void {
  const runDir = getRunDir(runId, baseDir);
  fs.mkdirSync(path.join(runDir, 'evaluation'), { recursive: true });

  fs.writeFileSync(
    path.join(runDir, RUN_PATHS.evaluationResult),
    JSON.stringify(result, null, 2),
  );

  const criteriaDir = path.join(runDir, RUN_PATHS.evaluationCriteriaDir);
  fs.mkdirSync(criteriaDir, { recursive: true });
  for (const criterion of result.criteria) {
    const slug = criterionSlug(criterion.id);
    fs.writeFileSync(path.join(criteriaDir, `${slug}.json`), JSON.stringify(criterion, null, 2));
  }

  if (result.report !== undefined && result.report !== null) {
    fs.writeFileSync(path.join(runDir, RUN_PATHS.evaluationReport), result.report);
  }

  mutateRunManifest(runId, baseDir, (m) => {
    m.evaluation = buildEvaluationProjection(result);
  });
}

export function loadEvaluationResult(
  runId: string,
  baseDir: string = process.cwd()
): EvaluationResult | undefined {
  const resultPath = path.join(getRunDir(runId, baseDir), RUN_PATHS.evaluationResult);
  if (!fs.existsSync(resultPath)) return undefined;
  return JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as EvaluationResult;
}

// ---------------------------------------------------------------------------
// Human scoring
// ---------------------------------------------------------------------------

/**
 * Save human scores to `evaluation/human.json` and refresh the manifest's
 * `human_scoring` projection.
 */
export function saveHumanScores(
  runId: string,
  scores: HumanScores,
  baseDir: string = process.cwd()
): void {
  const scoresPath = path.join(getRunDir(runId, baseDir), RUN_PATHS.evaluationHuman);
  fs.mkdirSync(path.dirname(scoresPath), { recursive: true });
  fs.writeFileSync(scoresPath, JSON.stringify(scores, null, 2));

  mutateRunManifest(runId, baseDir, (m) => {
    m.human_scoring = buildHumanScoringProjection(scores);
  });
}

export function loadHumanScores(
  runId: string,
  baseDir: string = process.cwd()
): HumanScores | undefined {
  const scoresPath = path.join(getRunDir(runId, baseDir), RUN_PATHS.evaluationHuman);
  if (!fs.existsSync(scoresPath)) return undefined;
  return JSON.parse(fs.readFileSync(scoresPath, 'utf-8')) as HumanScores;
}

// ---------------------------------------------------------------------------
// Workspace + artifacts
// ---------------------------------------------------------------------------

export function copyArtifacts(
  runId: string,
  sourceDir: string,
  baseDir: string = process.cwd()
): void {
  const outputDir = path.join(getRunDir(runId, baseDir), RUN_PATHS.artifactsOutput);
  if (!fs.existsSync(sourceDir)) return;
  copyDirRecursive(sourceDir, outputDir);
}

export function saveWorkspaceDiff(
  runId: string,
  diff: string,
  baseDir: string = process.cwd()
): void {
  const diffPath = path.join(getRunDir(runId, baseDir), RUN_PATHS.workspaceDiff);
  fs.mkdirSync(path.dirname(diffPath), { recursive: true });
  fs.writeFileSync(diffPath, diff, 'utf-8');
}

export function loadWorkspaceDiff(
  runId: string,
  baseDir: string = process.cwd()
): string | undefined {
  const diffPath = path.join(getRunDir(runId, baseDir), RUN_PATHS.workspaceDiff);
  if (!fs.existsSync(diffPath)) return undefined;
  return fs.readFileSync(diffPath, 'utf-8');
}

export function getWorkspaceTarPath(
  runId: string,
  baseDir: string = process.cwd()
): string {
  return path.join(getRunDir(runId, baseDir), RUN_PATHS.workspaceTar);
}

export function getRecordingPath(
  runId: string,
  baseDir: string = process.cwd()
): string {
  return path.join(getRunDir(runId, baseDir), RUN_PATHS.artifactsRecording);
}

export function getScreenshotsDir(
  runId: string,
  baseDir: string = process.cwd()
): string {
  return path.join(getRunDir(runId, baseDir), RUN_PATHS.artifactsScreenshots);
}

export function getCriterionLogPath(
  runId: string,
  criterionSlugStr: string,
  baseDir: string = process.cwd()
): string {
  return path.join(getRunDir(runId, baseDir), RUN_PATHS.evaluationCriteriaDir, `${criterionSlugStr}.log`);
}

export function listArtifacts(runId: string, baseDir: string = process.cwd()): string[] {
  const outputDir = path.join(getRunDir(runId, baseDir), RUN_PATHS.artifactsOutput);
  if (!fs.existsSync(outputDir)) return [];
  return listFilesRecursive(outputDir, outputDir);
}

export function readArtifact(
  runId: string,
  artifactPath: string,
  baseDir: string = process.cwd()
): string | undefined {
  const fullPath = path.join(getRunDir(runId, baseDir), RUN_PATHS.artifactsOutput, artifactPath);
  if (!fs.existsSync(fullPath)) return undefined;
  return fs.readFileSync(fullPath, 'utf-8');
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * List manifests for every run dir under `.bunsen/runs/`. Sorted newest first
 * by `started_at`. Run dirs without a readable manifest are silently skipped.
 *
 * Prefer the SQLite index (`listRunSummaries`) for filtered/paginated reads;
 * this is a directory scan suitable for fallback or full-rebuild paths.
 */
export function listRuns(baseDir: string = process.cwd()): RunManifestV1[] {
  const runsDir = getRunsDir(baseDir);
  if (!fs.existsSync(runsDir)) return [];

  const manifests: RunManifestV1[] = [];
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = loadRunManifest(entry.name, baseDir);
    if (manifest) manifests.push(manifest);
  }

  manifests.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
  return manifests;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function listFilesRecursive(dir: string, baseDir: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath, baseDir));
    } else {
      files.push(path.relative(baseDir, fullPath));
    }
  }

  return files;
}

function criterionSlug(criterion: string): string {
  return criterion
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
