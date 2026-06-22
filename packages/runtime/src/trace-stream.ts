// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Streaming trace processor.
 *
 * Reads `traces/agent.jsonl` line by line (the file may be hundreds of MB on
 * long agent runs) and produces:
 *
 *   - `traces/threads/index.json`        — small per-thread index + summary
 *   - `traces/threads/<threadId>.jsonl`  — one turn per line, only the
 *                                          new-message delta from the previous
 *                                          turn in the same thread
 *
 * Optionally also splits the input into agent-only / platform-only buckets so
 * the post-finalize layout matches what the legacy `saveTraces` produced.
 *
 * Memory usage at any moment is bounded by:
 *   - one open file handle per active thread
 *   - per-thread message fingerprints (~80 bytes × unique-message count)
 *   - small per-thread stat counters
 *
 * No part of the algorithm holds the full input or output in memory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type {
  AITrace,
  SourceCostBreakdown,
  TracesSummary,
} from '@bunsen-dev/types';
import type { AgentModelUsage } from '@bunsen-dev/types';
import { ThreadDetector, type ThreadsIndex } from './trace-filter.js';
import { buildAgentModels, type AgentModelTally } from './agent-model.js';

// ---------------------------------------------------------------------------
// Source classification
// ---------------------------------------------------------------------------

const isPlatformSource = (source?: string): boolean =>
  !!source &&
  source !== 'agent' &&
  (source === 'orchestrator' || source === 'supervisor' || source.startsWith('scorer'));

const emptyBreakdown = (): SourceCostBreakdown => ({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUsd: 0,
});

const addToBucket = (bucket: SourceCostBreakdown, t: AITrace): void => {
  bucket.calls++;
  bucket.inputTokens += t.response.usage?.inputTokens || 0;
  bucket.outputTokens += t.response.usage?.outputTokens || 0;
  bucket.cacheReadInputTokens += t.response.usage?.cacheReadInputTokens || 0;
  bucket.cacheCreationInputTokens += t.response.usage?.cacheCreationInputTokens || 0;
  bucket.costUsd += t.estimatedCostUsd;
};

// ---------------------------------------------------------------------------
// Streaming processor
// ---------------------------------------------------------------------------

export interface StreamProcessOptions {
  /** Path to the mixed JSONL input (typically `traces/agent.jsonl`). */
  inputPath: string;
  /** Directory for `index.json` and per-thread `.jsonl` files. Created if missing. */
  threadsDir: string;
  /**
   * If set, agent-only traces are written to this path and platform-only to
   * {@link platformOutputPath}. After successful processing, the caller is
   * responsible for renaming `agentOutputPath` over `inputPath` if it wants
   * the input file rewritten in place.
   */
  agentOutputPath?: string;
  platformOutputPath?: string;
  /** Wipe pre-existing per-thread files before writing. Defaults to true. */
  cleanThreadsDir?: boolean;
}

export interface StreamProcessResult {
  index: ThreadsIndex;
  summary: TracesSummary;
  agentBreakdown: SourceCostBreakdown;
  platformBreakdown: SourceCostBreakdown;
  /** Number of agent traces that contributed to the index. */
  agentCallCount: number;
  /** Number of platform traces written to the platform bucket. */
  platformCallCount: number;
  /**
   * Per-model usage breakdown across successful (2xx) agent-under-test
   * traces, sorted most-used first (`agentModels[0]` is the primary model).
   * Omitted when no successful agent trace carried a usable model name. See
   * `buildAgentModels`.
   */
  agentModels?: AgentModelUsage[];
  /** Bytes read from the input. */
  bytesRead: number;
}

/**
 * Stream-process a JSONL trace file. See module docstring for guarantees.
 */
export async function streamProcessTraces(
  options: StreamProcessOptions,
): Promise<StreamProcessResult> {
  const {
    inputPath,
    threadsDir,
    agentOutputPath,
    platformOutputPath,
    cleanThreadsDir = true,
  } = options;

  if (!fs.existsSync(inputPath)) {
    return emptyResult();
  }

  fs.mkdirSync(threadsDir, { recursive: true });
  if (cleanThreadsDir) {
    for (const entry of fs.readdirSync(threadsDir)) {
      if (entry === 'index.json' || entry.endsWith('.jsonl')) {
        try {
          fs.unlinkSync(path.join(threadsDir, entry));
        } catch {
          // ignore
        }
      }
    }
  }

  const detector = new ThreadDetector();
  const threadStreams = new Map<string, fs.WriteStream>();

  const agentStream = agentOutputPath ? fs.createWriteStream(agentOutputPath) : null;
  const platformStream = platformOutputPath ? fs.createWriteStream(platformOutputPath) : null;

  const orchestratorBreakdown = emptyBreakdown();
  const supervisorBreakdown = emptyBreakdown();
  const scorerBreakdown = emptyBreakdown();
  const perScorerBreakdown: Record<string, SourceCostBreakdown> = {};
  const agentBreakdown = emptyBreakdown();
  const platformBreakdown = emptyBreakdown();
  // Per-model agent-call tallies — frozen into the `agent.models` breakdown.
  // Only agent-under-test traces contribute; platform calls (orchestrator/
  // supervisor/scorer) run on their own models and must not leak into the
  // agent's model attribution.
  const agentModelTallies = new Map<string, AgentModelTally>();

  let totalCalls = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadInputTokens = 0;
  let totalCacheCreationInputTokens = 0;
  let estimatedTotalCostUsd = 0;
  let anySourceTagged = false;
  let agentCallCount = 0;
  let platformCallCount = 0;
  // Calls the proxy couldn't price from the snapshot (coarse-default cost), and
  // the distinct models behind them — surfaced by `bn runs cost` so a guessed
  // cost isn't read as accurate.
  let pricingFallbackCalls = 0;
  const unpricedModels = new Set<string>();

  const inputStream = fs.createReadStream(inputPath, { encoding: 'utf-8' });
  let bytesRead = 0;
  inputStream.on('data', (chunk) => {
    bytesRead += Buffer.byteLength(chunk as string, 'utf-8');
  });
  const rl = readline.createInterface({ input: inputStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let trace: AITrace;
    try {
      const parsed = JSON.parse(line);
      if (!parsed.provider || !parsed.model || !parsed.timestamp) continue;
      trace = parsed as AITrace;
    } catch {
      continue;
    }

    totalCalls++;
    totalInputTokens += trace.response.usage?.inputTokens || 0;
    totalOutputTokens += trace.response.usage?.outputTokens || 0;
    totalCacheReadInputTokens += trace.response.usage?.cacheReadInputTokens || 0;
    totalCacheCreationInputTokens += trace.response.usage?.cacheCreationInputTokens || 0;
    estimatedTotalCostUsd += trace.estimatedCostUsd;
    if (trace.pricingFallback) {
      pricingFallbackCalls++;
      if (trace.model) unpricedModels.add(trace.model);
    }
    if (trace.source) anySourceTagged = true;

    if (trace.source === 'orchestrator') {
      addToBucket(orchestratorBreakdown, trace);
      addToBucket(platformBreakdown, trace);
    } else if (trace.source === 'supervisor') {
      addToBucket(supervisorBreakdown, trace);
      addToBucket(platformBreakdown, trace);
    } else if (trace.source?.startsWith('scorer')) {
      addToBucket(scorerBreakdown, trace);
      addToBucket(platformBreakdown, trace);
      const criterionName = trace.source.includes(':')
        ? trace.source.slice(trace.source.indexOf(':') + 1)
        : 'unknown';
      if (!perScorerBreakdown[criterionName]) {
        perScorerBreakdown[criterionName] = emptyBreakdown();
      }
      addToBucket(perScorerBreakdown[criterionName], trace);
    } else {
      addToBucket(agentBreakdown, trace);
      tallyAgentModel(agentModelTallies, trace);
    }

    const platform = isPlatformSource(trace.source);
    if (platform) {
      platformCallCount++;
      if (platformStream) platformStream.write(line + '\n');
    } else {
      agentCallCount++;
      if (agentStream) agentStream.write(line + '\n');

      const { threadId, turn } = detector.processTrace(trace);
      const stream = getOrCreateThreadStream(threadStreams, threadsDir, threadId);
      stream.write(JSON.stringify(turn) + '\n');
    }
  }

  await Promise.all([
    closeStream(agentStream),
    closeStream(platformStream),
    ...Array.from(threadStreams.values()).map(closeStream),
  ]);

  const index = detector.finalize();
  fs.writeFileSync(path.join(threadsDir, 'index.json'), JSON.stringify(index, null, 2));

  const summary: TracesSummary = {
    totalCalls,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadInputTokens,
    totalCacheCreationInputTokens,
    estimatedTotalCostUsd,
  };
  if (pricingFallbackCalls > 0) {
    summary.pricingFallbackCalls = pricingFallbackCalls;
    summary.unpricedModels = [...unpricedModels].sort();
  }
  if (anySourceTagged) {
    summary.bySource = {
      agent: agentBreakdown,
      platform: platformBreakdown,
      ...(orchestratorBreakdown.calls > 0 && { orchestrator: orchestratorBreakdown }),
      ...(supervisorBreakdown.calls > 0 && { supervisor: supervisorBreakdown }),
      ...(scorerBreakdown.calls > 0 && { scorer: scorerBreakdown }),
      ...(Object.keys(perScorerBreakdown).length > 0 && { scorers: perScorerBreakdown }),
    };
  }

  const agentModels = buildAgentModels(agentModelTallies);

  return {
    index,
    summary,
    agentBreakdown,
    platformBreakdown,
    agentCallCount,
    platformCallCount,
    ...(agentModels.length ? { agentModels } : {}),
    bytesRead,
  };
}

/**
 * Fold one agent trace into the per-model tally. Skips the proxy's
 * `"unknown"` sentinel and empty model names so they never appear in the
 * breakdown, and skips non-2xx responses: a call that errored (e.g. a 404 for
 * an unavailable model) ran no inference, so it must not appear in — let alone
 * headline — the run's model attribution. The proxy stamps `statusCode` on
 * every capture; a missing value (hand-authored / pre-statusCode traces) is
 * treated as success so it still counts.
 */
function tallyAgentModel(tallies: Map<string, AgentModelTally>, trace: AITrace): void {
  const model = trace.model;
  if (!model || model === 'unknown') return;
  const status = trace.statusCode;
  if (status !== undefined && (status < 200 || status >= 300)) return;
  const t = tallies.get(model) ?? { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  t.calls++;
  t.input_tokens += trace.response.usage?.inputTokens || 0;
  t.output_tokens += trace.response.usage?.outputTokens || 0;
  t.cost_usd += trace.estimatedCostUsd || 0;
  tallies.set(model, t);
}

function emptyResult(): StreamProcessResult {
  return {
    index: {
      summary: {
        totalCalls: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        estimatedCostUsd: 0,
        durationMs: 0,
        threadCount: 0,
      },
      threads: [],
      timeline: [],
    },
    summary: {
      totalCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadInputTokens: 0,
      totalCacheCreationInputTokens: 0,
      estimatedTotalCostUsd: 0,
    },
    agentBreakdown: emptyBreakdown(),
    platformBreakdown: emptyBreakdown(),
    agentCallCount: 0,
    platformCallCount: 0,
    bytesRead: 0,
  };
}

function getOrCreateThreadStream(
  cache: Map<string, fs.WriteStream>,
  threadsDir: string,
  threadId: string,
): fs.WriteStream {
  let stream = cache.get(threadId);
  if (!stream) {
    stream = fs.createWriteStream(path.join(threadsDir, `${threadId}.jsonl`));
    cache.set(threadId, stream);
  }
  return stream;
}

function closeStream(stream: fs.WriteStream | null): Promise<void> {
  if (!stream) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
}
