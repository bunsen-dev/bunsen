// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import type { SourceCostBreakdown, TracesSummary, RunManifestV1 } from '@bunsen-dev/types';

// bun:test's `vi.mock` patches in place (no hoisting), so a plain object works
// where vitest needed `vi.hoisted`.
const coreMocks = {
  loadRunManifest: vi.fn(),
  loadTracesSummary: vi.fn(),
};

vi.mock('@bunsen-dev/runtime', () => coreMocks);

import { costCommand } from './cost.js';

function breakdown(over: Partial<SourceCostBreakdown>): SourceCostBreakdown {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
    ...over,
  };
}

function manifest(usage: Partial<RunManifestV1['usage']>): RunManifestV1 {
  return {
    schema_version: 1,
    run_id: 'RUN1',
    manifest_revision: 1,
    run_source: 'local',
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    status: 'succeeded',
    started_at: '2026-06-01T00:00:00Z',
    duration_ms: 1000,
    experiment: { id: 'hello-world' },
    agent: { id: 'claude-code', args: [] },
    usage: {
      total_ai_calls: 1,
      total_input_tokens: 3447,
      total_output_tokens: 1234,
      estimated_cost_usd: 3.22,
      accounting_status: 'captured',
      ...usage,
    },
    provenance: { verification_tier: 'self_reported', replayable: false },
    artifacts: [],
  };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ANSI, '');

let logs: string[];
let stdout: string[];

beforeEach(() => {
  vi.clearAllMocks();
  logs = [];
  stdout = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => vi.restoreAllMocks());

const text = () => strip(logs.join('\n'));

describe('costCommand — cache tokens', () => {
  it('surfaces per-source and run-wide cache tokens in the text view', async () => {
    coreMocks.loadRunManifest.mockReturnValue(manifest({}));
    const summary: TracesSummary = {
      totalCalls: 2,
      totalInputTokens: 3447,
      totalOutputTokens: 1234,
      totalCacheReadInputTokens: 1_143_571,
      totalCacheCreationInputTokens: 3000,
      estimatedTotalCostUsd: 3.63,
      bySource: {
        agent: breakdown({ calls: 1, inputTokens: 3447, outputTokens: 1234, cacheReadInputTokens: 1_143_571, cacheCreationInputTokens: 3000, costUsd: 3.22 }),
        platform: breakdown({ calls: 1, inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5000, costUsd: 0.41 }),
        orchestrator: breakdown({ calls: 1, inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5000, costUsd: 0.41 }),
      },
    };
    coreMocks.loadTracesSummary.mockReturnValue(summary);

    await costCommand('RUN1', {});

    const out = text();
    // Per-source agent cache line (the ~332× cache-vs-fresh case from the task).
    expect(out).toContain('1,143,571 read · 3,000 created');
    // Platform sub-source cache line.
    expect(out).toContain('5,000 read');
    // Run-wide rollup (labeled to disambiguate from the agent-only section)
    // + the "fresh billed at full rate" caveat.
    expect(out).toMatch(/Run cache:\s+1,143,571 read · 3,000 created/);
    expect(out).toContain('fresh input billed at full rate: 3,447');
  });

  it('omits cache lines entirely when there is no cache activity', async () => {
    coreMocks.loadRunManifest.mockReturnValue(manifest({}));
    coreMocks.loadTracesSummary.mockReturnValue({
      totalCalls: 1,
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalCacheReadInputTokens: 0,
      totalCacheCreationInputTokens: 0,
      estimatedTotalCostUsd: 0.01,
      bySource: {
        agent: breakdown({ calls: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.01 }),
        platform: breakdown({}),
      },
    } satisfies TracesSummary);

    await costCommand('RUN1', {});

    expect(text()).not.toContain('cache');
    expect(text()).not.toMatch(/Cache:/);
  });

  it('tolerates a pre-cache-accounting summary on disk (no cache fields)', async () => {
    coreMocks.loadRunManifest.mockReturnValue(manifest({}));
    // Older summary.json lacks the cache fields entirely.
    coreMocks.loadTracesSummary.mockReturnValue({
      totalCalls: 1,
      totalInputTokens: 100,
      totalOutputTokens: 50,
      estimatedTotalCostUsd: 0.01,
      bySource: { agent: { calls: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.01 }, platform: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } },
    } as unknown as TracesSummary);

    await expect(costCommand('RUN1', {})).resolves.toBeUndefined();
    expect(text()).not.toMatch(/Cache:/);
  });

  it('carries cache tokens through --format json (manifest usage + traces summary)', async () => {
    coreMocks.loadRunManifest.mockReturnValue(
      manifest({
        total_cache_read_input_tokens: 1_143_571,
        total_cache_creation_input_tokens: 3000,
        by_source: {
          agent: { calls: 1, input_tokens: 3447, output_tokens: 1234, cache_read_input_tokens: 1_143_571, cache_creation_input_tokens: 3000, cost_usd: 3.22 },
        },
      }),
    );
    coreMocks.loadTracesSummary.mockReturnValue({
      totalCalls: 1,
      totalInputTokens: 3447,
      totalOutputTokens: 1234,
      totalCacheReadInputTokens: 1_143_571,
      totalCacheCreationInputTokens: 3000,
      estimatedTotalCostUsd: 3.22,
      bySource: { agent: breakdown({ calls: 1, inputTokens: 3447, outputTokens: 1234, cacheReadInputTokens: 1_143_571, cacheCreationInputTokens: 3000, costUsd: 3.22 }), platform: breakdown({}) },
    } satisfies TracesSummary);

    await costCommand('RUN1', { format: 'json' });

    const payload = JSON.parse(stdout.join(''));
    // NB: this verifies cost.ts passes manifest.usage through verbatim, not that
    // the projection PRODUCES these fields — projectUsageBreakdown's cache output
    // is covered end-to-end in runtime/src/storage.test.ts ('projects per-source
    // and run-wide cache tokens onto the manifest').
    expect(payload.usage.total_cache_read_input_tokens).toBe(1_143_571);
    expect(payload.usage.by_source.agent.cache_read_input_tokens).toBe(1_143_571);
    // Live traces summary.
    expect(payload.summary.totalCacheReadInputTokens).toBe(1_143_571);
    expect(payload.summary.bySource.agent.cacheCreationInputTokens).toBe(3000);
  });
});

describe('costCommand — pricing fallback', () => {
  const baseSummary = (over: Partial<TracesSummary>): TracesSummary => ({
    totalCalls: 3,
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    totalCacheReadInputTokens: 0,
    totalCacheCreationInputTokens: 0,
    estimatedTotalCostUsd: 1.23,
    bySource: { agent: breakdown({ calls: 3, inputTokens: 1000, outputTokens: 500, costUsd: 1.23 }), platform: breakdown({}) },
    ...over,
  });

  it('warns when calls used fallback pricing, listing the unrecognized models', async () => {
    coreMocks.loadRunManifest.mockReturnValue(manifest({}));
    coreMocks.loadTracesSummary.mockReturnValue(
      baseSummary({ pricingFallbackCalls: 2, unpricedModels: ['mystery-1.0', 'pruned-2'] }),
    );

    await costCommand('RUN1', {});

    const out = text();
    expect(out).toContain('2 call(s) priced with a coarse default');
    expect(out).toContain('mystery-1.0, pruned-2');
    expect(out).toContain('rough estimate');
  });

  it('shows no fallback warning when every model was priced from the snapshot', async () => {
    coreMocks.loadRunManifest.mockReturnValue(manifest({}));
    coreMocks.loadTracesSummary.mockReturnValue(baseSummary({}));

    await costCommand('RUN1', {});

    expect(text()).not.toContain('coarse default');
    expect(text()).not.toContain('rough estimate');
  });

  it('carries pricing-fallback fields through --format json', async () => {
    coreMocks.loadRunManifest.mockReturnValue(manifest({}));
    coreMocks.loadTracesSummary.mockReturnValue(
      baseSummary({ pricingFallbackCalls: 1, unpricedModels: ['mystery-1.0'] }),
    );

    await costCommand('RUN1', { format: 'json' });

    const payload = JSON.parse(stdout.join(''));
    expect(payload.summary.pricingFallbackCalls).toBe(1);
    expect(payload.summary.unpricedModels).toEqual(['mystery-1.0']);
  });
});
