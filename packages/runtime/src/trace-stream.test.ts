// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for the streaming trace processor. Verifies that the file-to-file
 * pipeline produces the same logical output as the in-memory algorithm and
 * that it operates without slurping the input into memory.
 *
 * The run-aware loaders (`loadThreadsIndex`, `loadThreadTurns`,
 * `loadThreadHeadTail`) live in `storage.ts` and are tested in
 * `storage.test.ts`. This file reads the streamer's on-disk output via raw
 * `fs` to keep concerns separate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AITrace } from '@bunsen-dev/types';
import { streamProcessTraces } from './trace-stream.js';
import type { ThreadsIndex, ThreadTurn } from './trace-filter.js';

function readIndex(threadsDir: string): ThreadsIndex | null {
  const p = path.join(threadsDir, 'index.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as ThreadsIndex;
}

function readTurns(threadsDir: string, threadId: string): ThreadTurn[] {
  const p = path.join(threadsDir, `${threadId}.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ThreadTurn);
}

function trace(overrides: Partial<AITrace> & { messages?: unknown[]; responseContent?: unknown }): AITrace {
  const { messages, responseContent, ...rest } = overrides;
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    endpoint: '/v1/messages',
    timestamp: new Date().toISOString(),
    latencyMs: 100,
    request: {
      messages: messages ?? [{ role: 'user', content: 'hi' }],
      system: 'sys',
    },
    response: {
      content: responseContent ?? 'ok',
      usage: { inputTokens: 10, outputTokens: 5 },
    },
    estimatedCostUsd: 0.0001,
    ...rest,
  };
}

function writeJsonl(filePath: string, traces: AITrace[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, traces.map((t) => JSON.stringify(t)).join('\n') + '\n');
}

describe('streamProcessTraces', () => {
  let tmpDir: string;
  let inputPath: string;
  let threadsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-stream-'));
    inputPath = path.join(tmpDir, 'agent.jsonl');
    threadsDir = path.join(tmpDir, 'threads');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty result when the input is missing', async () => {
    const result = await streamProcessTraces({ inputPath, threadsDir });
    expect(result.summary.totalCalls).toBe(0);
    expect(result.index.threads).toHaveLength(0);
  });

  it('produces an index file and per-thread .jsonl files', async () => {
    writeJsonl(inputPath, [
      trace({ timestamp: '2024-01-15T12:00:00Z', messages: [{ role: 'user', content: 'A1' }] }),
      trace({
        timestamp: '2024-01-15T12:00:01Z',
        messages: [
          { role: 'user', content: 'A1' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'A2' },
        ],
      }),
      trace({ timestamp: '2024-01-15T12:00:02Z', messages: [{ role: 'user', content: 'B1' }] }),
    ]);

    await streamProcessTraces({ inputPath, threadsDir });

    const index = readIndex(threadsDir);
    expect(index).not.toBeNull();
    expect(index!.summary.totalCalls).toBe(3);
    expect(index!.summary.threadCount).toBe(2);
    expect(index!.threads).toHaveLength(2);

    const t1 = readTurns(threadsDir, 'thread-1');
    expect(t1).toHaveLength(2);
    expect(t1[0].turnIndex).toBe(0);
    expect(t1[1].turnIndex).toBe(1);
    expect(fs.existsSync(path.join(threadsDir, 'thread-2.jsonl'))).toBe(true);
  });

  it('splits agent vs platform traces when output paths are given', async () => {
    writeJsonl(inputPath, [
      trace({ source: 'agent', timestamp: '2024-01-15T12:00:00Z', messages: [{ role: 'user', content: 'Agent' }] }),
      trace({ source: 'orchestrator', timestamp: '2024-01-15T12:00:01Z', messages: [{ role: 'user', content: 'Orch' }] }),
      trace({ source: 'scorer:tests-pass', timestamp: '2024-01-15T12:00:02Z', messages: [{ role: 'user', content: 'Score' }] }),
    ]);

    const agentOut = path.join(tmpDir, 'agent.out.jsonl');
    const platformOut = path.join(tmpDir, 'platform.jsonl');

    const result = await streamProcessTraces({
      inputPath,
      threadsDir,
      agentOutputPath: agentOut,
      platformOutputPath: platformOut,
    });

    expect(result.agentCallCount).toBe(1);
    expect(result.platformCallCount).toBe(2);

    const agentLines = fs.readFileSync(agentOut, 'utf-8').trim().split('\n');
    const platformLines = fs.readFileSync(platformOut, 'utf-8').trim().split('\n');
    expect(agentLines).toHaveLength(1);
    expect(platformLines).toHaveLength(2);

    expect(result.summary.bySource?.platform.calls).toBe(2);
    expect(result.summary.bySource?.scorers?.['tests-pass'].calls).toBe(1);

    const index = readIndex(threadsDir)!;
    expect(index.summary.threadCount).toBe(1);
  });

  it('aggregates cache-read / cache-creation tokens per source and run-wide', async () => {
    writeJsonl(inputPath, [
      trace({
        source: 'agent',
        timestamp: '2024-01-15T12:00:00Z',
        messages: [{ role: 'user', content: 'Agent' }],
        response: {
          content: 'ok',
          usage: {
            inputTokens: 100,
            outputTokens: 10,
            cacheReadInputTokens: 5000,
            cacheCreationInputTokens: 200,
          },
        },
      }),
      trace({
        source: 'orchestrator',
        timestamp: '2024-01-15T12:00:01Z',
        messages: [{ role: 'user', content: 'Orch' }],
        response: {
          content: 'ok',
          usage: {
            inputTokens: 20,
            outputTokens: 4,
            cacheReadInputTokens: 1000,
            cacheCreationInputTokens: 0,
          },
        },
      }),
    ]);

    const result = await streamProcessTraces({ inputPath, threadsDir });

    // Run-wide totals sum across every source (fresh input stays disjoint).
    expect(result.summary.totalCacheReadInputTokens).toBe(6000);
    expect(result.summary.totalCacheCreationInputTokens).toBe(200);
    // Per-source breakdown keeps each bucket's cache tokens separate.
    expect(result.summary.bySource?.agent.cacheReadInputTokens).toBe(5000);
    expect(result.summary.bySource?.agent.cacheCreationInputTokens).toBe(200);
    expect(result.summary.bySource?.platform.cacheReadInputTokens).toBe(1000);
    expect(result.summary.bySource?.orchestrator?.cacheReadInputTokens).toBe(1000);
    expect(result.agentBreakdown.cacheReadInputTokens).toBe(5000);
  });

  it('counts pricing-fallback calls and collects the unrecognized models', async () => {
    writeJsonl(inputPath, [
      trace({ model: 'claude-sonnet-4-6' }), // priced — no flag
      trace({ model: 'mystery-1.0', pricingFallback: true, estimatedCostUsd: 0.5 }),
      trace({ model: 'mystery-1.0', pricingFallback: true, estimatedCostUsd: 0.3 }),
      trace({ model: 'other-pruned-2', pricingFallback: true, estimatedCostUsd: 0.2 }),
    ]);

    const result = await streamProcessTraces({ inputPath, threadsDir });

    expect(result.summary.pricingFallbackCalls).toBe(3);
    // Distinct models, sorted; the priced call is not listed.
    expect(result.summary.unpricedModels).toEqual(['mystery-1.0', 'other-pruned-2']);
  });

  it('omits pricing-fallback fields when every model is priced', async () => {
    writeJsonl(inputPath, [
      trace({ model: 'claude-sonnet-4-6' }),
      trace({ model: 'gpt-5.5' }),
    ]);

    const result = await streamProcessTraces({ inputPath, threadsDir });

    expect(result.summary.pricingFallbackCalls).toBeUndefined();
    expect(result.summary.unpricedModels).toBeUndefined();
  });

  it('skips malformed JSONL lines', async () => {
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(
      inputPath,
      [
        JSON.stringify(trace({ timestamp: '2024-01-15T12:00:00Z' })),
        'not json',
        '',
        JSON.stringify({ no: 'provider' }),
        JSON.stringify(trace({ timestamp: '2024-01-15T12:00:01Z', messages: [{ role: 'user', content: 'B' }] })),
      ].join('\n'),
    );

    const result = await streamProcessTraces({ inputPath, threadsDir });
    expect(result.summary.totalCalls).toBe(2);
  });

  it('builds the agent model breakdown highest-cost first and ignores platform models', async () => {
    writeJsonl(inputPath, [
      // Background model: more calls, but each one cheap (Claude Code fires
      // many of these for titles/summaries/classifications).
      trace({ source: 'agent', model: 'claude-haiku-4-5', estimatedCostUsd: 0.0001, timestamp: '2024-01-15T12:00:00Z', messages: [{ role: 'user', content: 'A1' }] }),
      trace({ source: 'agent', model: 'claude-haiku-4-5', estimatedCostUsd: 0.0001, timestamp: '2024-01-15T12:00:01Z', messages: [{ role: 'user', content: 'A2' }] }),
      // Reasoning model: a single call that cost more than the background calls
      // combined — it carried the run's compute, so it must headline.
      trace({ source: 'agent', model: 'claude-opus-4-8', estimatedCostUsd: 0.02, timestamp: '2024-01-15T12:00:02Z', messages: [{ role: 'user', content: 'A3' }] }),
      // Platform calls on a different model must not appear in the breakdown,
      // even though they are the most expensive thing captured.
      trace({ source: 'orchestrator', model: 'claude-sonnet-4-6', estimatedCostUsd: 0.1, timestamp: '2024-01-15T12:00:03Z', messages: [{ role: 'user', content: 'O1' }] }),
      trace({ source: 'scorer:tests-pass', model: 'claude-sonnet-4-6', estimatedCostUsd: 0.1, timestamp: '2024-01-15T12:00:04Z', messages: [{ role: 'user', content: 'S1' }] }),
    ]);

    const result = await streamProcessTraces({ inputPath, threadsDir });
    expect(result.agentModels).toEqual([
      { model: 'claude-opus-4-8', calls: 1, input_tokens: 10, output_tokens: 5, cost_usd: 0.02 },
      { model: 'claude-haiku-4-5', calls: 2, input_tokens: 20, output_tokens: 10, cost_usd: 0.0002 },
    ]);
  });

  it('leaves agentModels undefined when agent traces only report "unknown"', async () => {
    writeJsonl(inputPath, [
      trace({ source: 'agent', model: 'unknown', timestamp: '2024-01-15T12:00:00Z', messages: [{ role: 'user', content: 'A1' }] }),
      trace({ source: 'orchestrator', model: 'claude-sonnet-4-6', timestamp: '2024-01-15T12:00:01Z', messages: [{ role: 'user', content: 'O1' }] }),
    ]);

    const result = await streamProcessTraces({ inputPath, threadsDir });
    expect(result.agentModels).toBeUndefined();
  });

  it('excludes errored (non-2xx) calls from the model breakdown', async () => {
    writeJsonl(inputPath, [
      // A dead model alias that only ever 404s — must not appear, let alone
      // headline, despite out-calling the model that actually worked.
      trace({ source: 'agent', model: 'claude-3-5-haiku-latest', statusCode: 404, timestamp: '2024-01-15T12:00:00Z', messages: [{ role: 'user', content: 'A1' }] }),
      trace({ source: 'agent', model: 'claude-3-5-haiku-latest', statusCode: 404, timestamp: '2024-01-15T12:00:01Z', messages: [{ role: 'user', content: 'A2' }] }),
      // The one model that actually responded.
      trace({ source: 'agent', model: 'claude-haiku-4-5', statusCode: 200, timestamp: '2024-01-15T12:00:02Z', messages: [{ role: 'user', content: 'A3' }] }),
    ]);

    const result = await streamProcessTraces({ inputPath, threadsDir });
    expect(result.agentModels).toEqual([
      { model: 'claude-haiku-4-5', calls: 1, input_tokens: 10, output_tokens: 5, cost_usd: 0.0001 },
    ]);
  });

  it('counts traces with no statusCode (treats absence as success)', async () => {
    writeJsonl(inputPath, [
      trace({ source: 'agent', model: 'claude-opus-4-7', timestamp: '2024-01-15T12:00:00Z', messages: [{ role: 'user', content: 'A1' }] }),
    ]);

    const result = await streamProcessTraces({ inputPath, threadsDir });
    expect(result.agentModels).toEqual([
      { model: 'claude-opus-4-7', calls: 1, input_tokens: 10, output_tokens: 5, cost_usd: 0.0001 },
    ]);
  });

  it('cleans pre-existing thread files before writing', async () => {
    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(path.join(threadsDir, 'thread-99.jsonl'), 'stale');
    fs.writeFileSync(path.join(threadsDir, 'index.json'), '{}');

    writeJsonl(inputPath, [trace({ timestamp: '2024-01-15T12:00:00Z' })]);

    await streamProcessTraces({ inputPath, threadsDir });

    expect(fs.existsSync(path.join(threadsDir, 'thread-99.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(threadsDir, 'thread-1.jsonl'))).toBe(true);
  });

  it('respects cleanThreadsDir=false', async () => {
    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(path.join(threadsDir, 'thread-99.jsonl'), 'stale');

    writeJsonl(inputPath, [trace({ timestamp: '2024-01-15T12:00:00Z' })]);

    await streamProcessTraces({ inputPath, threadsDir, cleanThreadsDir: false });

    expect(fs.existsSync(path.join(threadsDir, 'thread-99.jsonl'))).toBe(true);
  });
});

