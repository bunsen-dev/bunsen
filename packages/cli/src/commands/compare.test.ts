// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunManifestV1 } from '@bunsen-dev/types';

const coreMocks = vi.hoisted(() => ({
  listRuns: vi.fn(),
  loadRunManifest: vi.fn(),
}));

vi.mock('@bunsen-dev/runtime', () => coreMocks);

import { compareCommand } from './compare.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface MkOpts {
  id: string;
  exp?: string;
  agent?: string;
  variant?: string;
  started?: string;
  status?: RunManifestV1['status'];
  cost?: number;
  accounting?: 'captured' | 'missing' | 'skipped';
  score?: number | null;
  /** Per-criterion scores, projected onto manifest.evaluation.criteria. */
  criteria?: Array<[string, number | null]>;
  model?: string;
  /** Calls priced with a coarse default (model not in the price table). */
  fallback?: number;
}

function mk(o: MkOpts): RunManifestV1 {
  return {
    schema_version: 1,
    run_id: o.id,
    manifest_revision: 1,
    run_source: 'local',
    created_at: o.started ?? '2026-06-01T00:00:00Z',
    updated_at: o.started ?? '2026-06-01T00:00:00Z',
    status: o.status ?? 'succeeded',
    started_at: o.started ?? '2026-06-01T00:00:00Z',
    completed_at: o.started ?? '2026-06-01T00:01:00Z',
    duration_ms: 60000,
    experiment: { id: o.exp ?? 'hello-world' },
    agent: {
      id: o.agent ?? 'claude-code',
      args: [],
      ...(o.variant ? { variant: o.variant } : {}),
      ...(o.model ? { models: [{ model: o.model, calls: 1, input_tokens: 1, output_tokens: 1, cost_usd: o.cost ?? 0 }] } : {}),
    },
    usage: {
      total_ai_calls: 1,
      total_input_tokens: 100,
      total_output_tokens: 50,
      estimated_cost_usd: o.cost ?? 0,
      accounting_status: o.accounting ?? 'captured',
      ...(o.fallback ? { pricing_fallback_calls: o.fallback, unpriced_models: ['mystery-1.0'] } : {}),
    },
    ...(o.score !== undefined && o.score !== null
      ? {
          evaluation: {
            weighted_score: o.score,
            criteria: (o.criteria ?? []).map(([id, score]) => ({ id, weight: 1, score, summary: '' })),
          },
        }
      : {}),
    provenance: { verification_tier: 'self_reported', replayable: false },
    artifacts: [],
  };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;
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

afterEach(() => {
  vi.restoreAllMocks();
});

const text = () => strip(logs.join('\n'));
const machine = () => JSON.parse(stdout.join(''));

// ---------------------------------------------------------------------------
// Cohort selection (Option A)
// ---------------------------------------------------------------------------

describe('compareCommand — cohort selection', () => {
  it('takes the newest run per agent and excludes stale/duplicate runs (--experiment)', async () => {
    // Newest-first, as listRuns() returns.
    coreMocks.listRuns.mockReturnValue([
      mk({ id: 'cc-new', agent: 'claude-code', variant: 'auto', started: '2026-06-04T00:00:00Z' }),
      mk({ id: 'cc-dup', agent: 'claude-code', variant: 'auto', started: '2026-06-03T00:00:00Z' }),
      mk({ id: 'gem', agent: 'gemini-cli', started: '2026-06-02T00:00:00Z' }),
      mk({ id: 'cc-stale', agent: 'claude-code', variant: 'auto', started: '2026-05-23T00:00:00Z' }),
    ]);

    await compareCommand([], { experiment: 'hello-world', format: 'json' });

    const payload = machine();
    expect(payload.runs.map((r: { id: string }) => r.id)).toEqual(['cc-new', 'gem']);
    expect(payload.mode).toBe('experiment');
    expect(payload.experiment).toBe('hello-world');
    expect(payload.hidden).toBe(2); // cc-dup + cc-stale
    expect(payload.note).toMatch(/newest run per agent/);
  });

  it('distinguishes agent variants as separate columns', async () => {
    coreMocks.listRuns.mockReturnValue([
      mk({ id: 'auto', agent: 'claude-code', variant: 'auto', started: '2026-06-04T00:00:00Z' }),
      mk({ id: 'def', agent: 'claude-code', variant: 'default', started: '2026-06-03T00:00:00Z' }),
    ]);

    await compareCommand([], { experiment: 'hello-world', format: 'json' });

    const ids = machine().runs.map((r: { id: string }) => r.id);
    expect(ids).toEqual(['auto', 'def']);
    expect(machine().hidden).toBe(0);
  });

  it('--last takes raw N most-recent runs without per-agent dedup', async () => {
    coreMocks.listRuns.mockReturnValue([
      mk({ id: 'a', agent: 'claude-code', variant: 'auto', started: '2026-06-04T00:00:00Z' }),
      mk({ id: 'b', agent: 'claude-code', variant: 'auto', started: '2026-06-03T00:00:00Z' }),
      mk({ id: 'c', agent: 'gemini-cli', started: '2026-06-02T00:00:00Z' }),
    ]);

    await compareCommand([], { experiment: 'hello-world', last: '2', format: 'json' });

    const payload = machine();
    expect(payload.runs.map((r: { id: string }) => r.id)).toEqual(['a', 'b']); // dup agent kept
    expect(payload.hidden).toBe(1);
    expect(payload.note).toMatch(/showing 2 of 3/);
  });

  it('--agent mirrors --experiment: newest run per experiment', async () => {
    coreMocks.listRuns.mockReturnValue([
      mk({ id: 'hw', agent: 'claude-code', exp: 'hello-world', started: '2026-06-04T00:00:00Z' }),
      mk({ id: 'csv', agent: 'claude-code', exp: 'csv-to-parquet', started: '2026-06-03T00:00:00Z' }),
      mk({ id: 'hw-old', agent: 'claude-code', exp: 'hello-world', started: '2026-06-01T00:00:00Z' }),
      mk({ id: 'other', agent: 'gemini-cli', exp: 'hello-world', started: '2026-06-05T00:00:00Z' }),
    ]);

    await compareCommand([], { agent: 'claude-code', format: 'json' });

    const payload = machine();
    expect(payload.runs.map((r: { id: string }) => r.id)).toEqual(['hw', 'csv']); // gemini filtered out
    expect(payload.mode).toBe('agent');
    expect(payload.agent).toBe('claude-code');
  });

  it('experiment + agent pins a cell: shows all runs of that cell', async () => {
    coreMocks.listRuns.mockReturnValue([
      mk({ id: 'r1', agent: 'claude-code', exp: 'hello-world', started: '2026-06-04T00:00:00Z' }),
      mk({ id: 'r2', agent: 'claude-code', exp: 'hello-world', started: '2026-06-03T00:00:00Z' }),
      mk({ id: 'nope', agent: 'gemini-cli', exp: 'hello-world', started: '2026-06-05T00:00:00Z' }),
    ]);

    await compareCommand([], { experiment: 'hello-world', agent: 'claude-code', format: 'json' });

    const payload = machine();
    expect(payload.runs.map((r: { id: string }) => r.id)).toEqual(['r1', 'r2']);
    expect(payload.mode).toBe('cell');
  });

  it('caps a heavily-rerun pinned cell (newest first) with a note', async () => {
    // 14 runs of one cell, newest-first. Without a cap this is an unusable
    // 14-column table; the cap keeps the newest 12 and notes the rest.
    coreMocks.listRuns.mockReturnValue(
      Array.from({ length: 14 }, (_, i) =>
        mk({
          id: `r${i}`,
          agent: 'claude-code',
          exp: 'hello-world',
          started: `2026-06-${String(20 - i).padStart(2, '0')}T00:00:00Z`,
        }),
      ),
    );

    await compareCommand([], { experiment: 'hello-world', agent: 'claude-code', format: 'json' });

    const payload = machine();
    expect(payload.runs).toHaveLength(12); // CELL_CAP
    expect(payload.runs[0].id).toBe('r0'); // newest kept
    expect(payload.hidden).toBe(2);
    expect(payload.note).toMatch(/showing 12 of 14 runs of this cell/);
  });

  it('--since filters out older runs before dedup', async () => {
    coreMocks.listRuns.mockReturnValue([
      mk({ id: 'new1', agent: 'claude-code', started: '2026-06-04T00:00:00Z' }),
      mk({ id: 'new2', agent: 'gemini-cli', started: '2026-06-02T00:00:00Z' }),
      mk({ id: 'old', agent: 'codex-cli', started: '2026-05-01T00:00:00Z' }),
    ]);

    await compareCommand([], { experiment: 'hello-world', since: '2026-06-01', format: 'json' });

    expect(machine().runs.map((r: { id: string }) => r.id)).toEqual(['new1', 'new2']);
  });

  it('errors when fewer than 2 runs match', async () => {
    coreMocks.listRuns.mockReturnValue([mk({ id: 'solo', agent: 'claude-code' })]);
    await expect(
      compareCommand([], { experiment: 'hello-world', format: 'json' }),
    ).rejects.toThrow(/at least 2 runs/);
  });

  it('errors when no run IDs and no filter are given', async () => {
    await expect(compareCommand([], { format: 'json' })).rejects.toThrow(/Provide run IDs/);
  });

  it('rejects an invalid --since date', async () => {
    coreMocks.listRuns.mockReturnValue([mk({ id: 'a' }), mk({ id: 'b' })]);
    await expect(
      compareCommand([], { experiment: 'hello-world', since: 'not-a-date' }),
    ).rejects.toThrow(/Invalid --since/);
  });

  it('uses explicit run IDs verbatim, ignoring filters', async () => {
    coreMocks.loadRunManifest.mockImplementation((id: string) =>
      mk({ id, agent: id === 'x' ? 'claude-code' : 'gemini-cli' }),
    );
    await compareCommand(['x', 'y'], { format: 'json' });
    expect(machine().runs.map((r: { id: string }) => r.id)).toEqual(['x', 'y']);
    expect(coreMocks.listRuns).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('compareCommand — text rendering', () => {
  it('labels columns by agent and titles by experiment', async () => {
    coreMocks.listRuns.mockReturnValue([
      mk({ id: 'a', agent: 'claude-code', variant: 'auto', model: 'opus-4.7' }),
      mk({ id: 'b', agent: 'gemini-cli', model: 'gemini-2.5-pro' }),
    ]);

    await compareCommand([], { experiment: 'hello-world' });

    const out = text();
    expect(out).toContain('hello-world · 2 agents');
    expect(out).toContain('claude-code:auto');
    expect(out).toContain('gemini-cli');
    // Run id is no longer the primary header, but stays as a dim cross-ref.
    expect(out).toMatch(/Model/);
  });

  it('distinguishes a captured $0 run from a run with no captured cost', async () => {
    coreMocks.listRuns.mockReturnValue([
      mk({ id: 'free', agent: 'gemini-cli', cost: 0, accounting: 'captured' }),
      mk({ id: 'died', agent: 'codex-cli', cost: 0, accounting: 'missing', status: 'failed' }),
    ]);

    await compareCommand([], { experiment: 'hello-world' });

    const out = text();
    expect(out).toContain('$0.0000'); // free vendor, real zero
    expect(out).toContain('—'); // failed-before-API-call
    expect(out).toContain('no cost captured'); // legend
    expect(out).toContain('failed'); // status row renders even without scores
  });

  it('flags runs whose cost includes coarse-default (unpriced-model) pricing', async () => {
    coreMocks.listRuns.mockReturnValue([
      mk({ id: 'priced', agent: 'claude-code', cost: 0.5 }),
      mk({ id: 'guessed', agent: 'gemini-cli', cost: 0.3, fallback: 4 }),
    ]);

    await compareCommand([], { experiment: 'hello-world' });

    const out = text();
    expect(out).toContain('$0.3000*'); // fallback-priced cost is marked
    expect(out).not.toContain('$0.5000*'); // fully-priced run is not
    expect(out).toContain('coarse default'); // legend explains the marker
  });

  it('carries the pricing-fallback signal through --format json', async () => {
    coreMocks.listRuns.mockReturnValue([
      mk({ id: 'priced', agent: 'claude-code', cost: 0.5 }),
      mk({ id: 'guessed', agent: 'gemini-cli', cost: 0.3, fallback: 4 }),
    ]);

    await compareCommand([], { experiment: 'hello-world', format: 'json' });

    const byId = Object.fromEntries(machine().runs.map((r: { id: string; summary: Record<string, unknown> }) => [r.id, r.summary]));
    expect(byId.guessed.pricingFallbackCalls).toBe(4);
    expect(byId.guessed.unpricedModels).toEqual(['mystery-1.0']);
    expect(byId.priced.pricingFallbackCalls).toBeNull(); // fully priced → null
  });

  it('renders structural rows even when no run has scores', async () => {
    coreMocks.listRuns.mockReturnValue([
      mk({ id: 'a', agent: 'claude-code', status: 'failed' }),
      mk({ id: 'b', agent: 'gemini-cli', status: 'failed' }),
    ]);

    await compareCommand([], { experiment: 'hello-world' });

    const out = text();
    expect(out).toContain('Status');
    expect(out).toContain('Cost');
    expect(out).toContain('Weighted Score');
  });

  it('shows criterion rows and a hidden-runs note', async () => {
    coreMocks.listRuns.mockReturnValue([
      mk({ id: 'a', agent: 'claude-code', score: 1, criteria: [['tests-pass', 1]] }),
      mk({ id: 'a-old', agent: 'claude-code', started: '2026-05-01T00:00:00Z', score: 0 }),
      mk({ id: 'b', agent: 'gemini-cli', score: 0.5, criteria: [['tests-pass', 0.5]] }),
    ]);

    await compareCommand([], { experiment: 'hello-world' });

    const out = text();
    expect(out).toContain('tests-pass');
    expect(out).toMatch(/note: newest run per agent · 1 older run hidden/);
  });

  it('renders numeric weighted and criterion scores from the manifest, including a real 0.00', async () => {
    coreMocks.listRuns.mockReturnValue([
      mk({ id: 'a', agent: 'claude-code', score: 1, criteria: [['tests-pass', 1]] }),
      mk({ id: 'b', agent: 'gemini-cli', score: 0, criteria: [['tests-pass', 0]] }),
    ]);

    await compareCommand([], { experiment: 'hello-world' });

    const out = text();
    // The criterion and weighted-score rows must show the actual numbers, and a
    // real 0 must render as 0.00 — not collapse to '-' (falsy-zero guard).
    expect(out).toMatch(/tests-pass\s+1\.00\s+0\.00/);
    expect(out).toMatch(/Weighted Score\s+1\.00\s+0\.00/);
  });

  it('--annotate adds a manifest-field row', async () => {
    coreMocks.listRuns.mockReturnValue([
      mk({ id: 'a', agent: 'claude-code', accounting: 'captured' }),
      mk({ id: 'b', agent: 'gemini-cli', accounting: 'missing' }),
    ]);

    await compareCommand([], { experiment: 'hello-world', annotate: ['cost-source', 'run-id'] });

    const out = text();
    expect(out).toContain('Cost source');
    expect(out).toContain('captured');
    expect(out).toContain('Run id');
    expect(out).toContain('a'); // run-id value
  });
});

// ---------------------------------------------------------------------------
// Matrix mode
// ---------------------------------------------------------------------------

describe('compareCommand — matrix', () => {
  it('emits a 2D experiments × agents structure with scores and gaps (json)', async () => {
    coreMocks.listRuns.mockReturnValue([
      mk({ id: 'hw-cc', exp: 'hello-world', agent: 'claude-code', score: 1 }),
      mk({ id: 'hw-gem', exp: 'hello-world', agent: 'gemini-cli', score: 1 }),
      mk({ id: 'csv-cc', exp: 'csv-to-parquet', agent: 'claude-code', score: 0.5 }),
      // gemini never ran csv-to-parquet → a gap.
      mk({ id: 'chess-cc', exp: 'chess-best-move', agent: 'claude-code', status: 'failed' }), // no score
    ]);

    await compareCommand([], { matrix: true, format: 'json' });

    const payload = machine();
    expect(payload.axes.experiments).toEqual(['chess-best-move', 'csv-to-parquet', 'hello-world']);
    expect(payload.axes.agents).toEqual(['claude-code', 'gemini-cli']);

    const csvRow = payload.rows.find((r: { experiment: string }) => r.experiment === 'csv-to-parquet');
    const gemCell = csvRow.cells.find((c: { agent: string }) => c.agent === 'gemini-cli');
    expect(gemCell.runId).toBeNull(); // gap
    const ccCell = csvRow.cells.find((c: { agent: string }) => c.agent === 'claude-code');
    expect(ccCell.weightedScore).toBe(0.5);

    const chessRow = payload.rows.find((r: { experiment: string }) => r.experiment === 'chess-best-move');
    expect(chessRow.cells.find((c: { agent: string }) => c.agent === 'claude-code').weightedScore).toBeNull();
  });

  it('renders the matrix text with score, no-run, and no-score markers', async () => {
    coreMocks.listRuns.mockReturnValue([
      mk({ id: 'hw-cc', exp: 'hello-world', agent: 'claude-code', score: 1 }),
      mk({ id: 'hw-gem', exp: 'hello-world', agent: 'gemini-cli', score: 0 }),
      mk({ id: 'csv-cc', exp: 'csv-to-parquet', agent: 'claude-code', score: 0.5 }),
    ]);

    await compareCommand([], { matrix: true });

    const out = text();
    expect(out).toContain('Run Matrix');
    expect(out).toContain('1.00');
    expect(out).toContain('·'); // gap: gemini × csv-to-parquet
    expect(out).toContain('no run');
  });

  it('comma-separated --experiment / --agent define the matrix axes in order', async () => {
    coreMocks.listRuns.mockReturnValue([
      mk({ id: '1', exp: 'b', agent: 'y', score: 1 }),
      mk({ id: '2', exp: 'a', agent: 'x', score: 1 }),
      mk({ id: '3', exp: 'c', agent: 'z', score: 1 }), // excluded by axis filter
    ]);

    await compareCommand([], { matrix: true, experiment: 'b,a', agent: 'y,x', format: 'json' });

    const payload = machine();
    expect(payload.axes.experiments).toEqual(['b', 'a']); // caller order preserved
    expect(payload.axes.agents).toEqual(['y', 'x']);
  });

  it('keeps agent variants in separate columns without double-attributing a run', async () => {
    // The bare-id run and a newer :auto run of the same agent+experiment. The
    // old by-id cell match showed the newer :auto run in BOTH columns and hid
    // the bare run entirely.
    coreMocks.listRuns.mockReturnValue([
      mk({ id: 'auto', exp: 'hello-world', agent: 'claude-code', variant: 'auto', started: '2026-06-04T00:00:00Z', score: 1 }),
      mk({ id: 'bare', exp: 'hello-world', agent: 'claude-code', started: '2026-06-01T00:00:00Z', score: 0.2 }),
    ]);

    await compareCommand([], { matrix: true, format: 'json' });

    const payload = machine();
    expect(payload.axes.agents).toEqual(['claude-code', 'claude-code:auto']);
    const row = payload.rows.find((r: { experiment: string }) => r.experiment === 'hello-world');
    const bare = row.cells.find((c: { agent: string }) => c.agent === 'claude-code');
    const auto = row.cells.find((c: { agent: string }) => c.agent === 'claude-code:auto');
    expect(bare.runId).toBe('bare'); // not shadowed by the newer :auto run
    expect(auto.runId).toBe('auto');
  });

  it('expands a bare --agent token to one column per variant present', async () => {
    coreMocks.listRuns.mockReturnValue([
      mk({ id: 'auto', exp: 'hello-world', agent: 'claude-code', variant: 'auto', score: 1 }),
      mk({ id: 'fast', exp: 'hello-world', agent: 'claude-code', variant: 'fast', score: 0.3 }),
      mk({ id: 'gem', exp: 'hello-world', agent: 'gemini-cli', score: 1 }),
    ]);

    await compareCommand([], { matrix: true, agent: 'claude-code', format: 'json' });

    // Both variants get their own column; gemini-cli is filtered out, and they
    // are NOT collapsed into a single 'claude-code' column.
    expect(machine().axes.agents).toEqual(['claude-code:auto', 'claude-code:fast']);
  });
});
