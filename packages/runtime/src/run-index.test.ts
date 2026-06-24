// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for the SQLite run-index.
 *
 * These exercise the index against a real on-disk SQLite file (bun:sqlite),
 * asserting against the persisted schema + the delete-and-rebuild recovery the
 * production code relies on. Each test gets a fresh tempdir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  countRuns,
  deleteRun,
  getRunIndexPath,
  findRunIdsByModel,
  getRunSummary,
  listRunAgentModels,
  listRunCriteria,
  listRunSummaries,
  openRunIndex,
  rebuildIndex,
  RUN_INDEX_FILENAME,
  RUN_INDEX_SCHEMA_VERSION,
  upsertManifest,
  upsertManifestSafely,
} from './run-index.js';
import { refreshRunManifest, saveRunManifest } from './manifest.js';
import {
  createRun,
  finalizeTracesStreaming,
  getRunDir,
  saveEvaluationResult,
  updateRunStatus,
} from './storage.js';
import type { EvaluationResult, RunManifestV1 } from '@bunsen-dev/types';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-run-index-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeManifest(overrides: Partial<RunManifestV1> = {}): RunManifestV1 {
  return {
    schema_version: 1,
    run_id: 'r1',
    manifest_revision: 1,
    run_source: 'local',
    created_at: '2026-04-27T00:00:00Z',
    updated_at: '2026-04-27T00:00:00Z',
    status: 'succeeded',
    started_at: '2026-04-27T00:00:00Z',
    duration_ms: 1500,
    experiment: { id: 'exp', path: '/exp', variant: 'hard' },
    agent: { id: 'agent', path: '/agent', variant: 'haiku', args: ['--x', 'y'] },
    usage: {
      total_ai_calls: 5,
      total_input_tokens: 100,
      total_output_tokens: 200,
      total_cache_read_input_tokens: 9000,
      total_cache_creation_input_tokens: 300,
      estimated_cost_usd: 0.05,
      agent_cost_usd: 0.04,
      platform_cost_usd: 0.01,
      by_source: {
        agent: { calls: 3, input_tokens: 60, output_tokens: 120, cache_read_input_tokens: 8000, cache_creation_input_tokens: 300, cost_usd: 0.04 },
        platform: { calls: 2, input_tokens: 40, output_tokens: 80, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, cost_usd: 0.01 },
      },
    },
    evaluation: {
      weighted_score: 0.75,
      criteria: [
        {
          id: 'tests',
          weight: 1,
          score: 0.75,
          summary: 'Mostly passing',
          status: 'completed',
          scorer_type: 'script',
          allowed_scores: [0, 0.5, 1],
          log_path: 'scorer-tests.log',
        },
      ],
    },
    provenance: { verification_tier: 'self_reported', replayable: false },
    artifacts: [
      { key: 'runs/r1/logs.txt', kind: 'logs', rel_path: 'logs.txt', bytes: 100, created_at: '2026-04-27T00:00:00Z' },
      { key: 'runs/r1/evaluation/result.json', kind: 'scores', rel_path: 'evaluation/result.json', bytes: 50, created_at: '2026-04-27T00:00:00Z' },
    ],
    ...overrides,
  };
}

// ===========================================================================

describe('openRunIndex', () => {
  it('creates the index file + schema and stores schema_version', () => {
    const db = openRunIndex(tempDir);
    try {
      const row = db.prepare<{ value: string }, [string]>(
        'SELECT value FROM meta WHERE key = ?'
      ).get('schema_version');
      expect(row?.value).toBe(String(RUN_INDEX_SCHEMA_VERSION));
    } finally {
      db.close();
    }
    expect(fs.existsSync(getRunIndexPath(tempDir))).toBe(true);
    expect(getRunIndexPath(tempDir).endsWith(RUN_INDEX_FILENAME)).toBe(true);
  });

  it('self-heals a stale-schema index by deleting and rebuilding from manifests', () => {
    const manifest = makeManifest();
    saveRunManifest(manifest.run_id, manifest, tempDir);

    // Build the index at the current schema version, then forge an older one.
    let db = openRunIndex(tempDir);
    upsertManifest(db, manifest);
    db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    db.close();

    // Any subsequent open detects the mismatch, drops the file, and rebuilds
    // from the manifest on disk — the new column is now present and queryable.
    db = openRunIndex(tempDir, { readonly: true });
    try {
      const version = db.prepare<{ value: string }, [string]>(
        'SELECT value FROM meta WHERE key = ?'
      ).get('schema_version');
      expect(version?.value).toBe(String(RUN_INDEX_SCHEMA_VERSION));
      const summary = getRunSummary(db, manifest.run_id);
      expect(summary).not.toBeNull();
      expect(summary?.totalCacheReadInputTokens).toBe(9000);
    } finally {
      db.close();
    }
  });

  it('readonly mode requires the file to exist', () => {
    expect(() => openRunIndex(tempDir, { readonly: true })).toThrow();
    // Once it exists, readonly works.
    openRunIndex(tempDir).close();
    const db = openRunIndex(tempDir, { readonly: true });
    try {
      expect(countRuns(db)).toBe(0);
    } finally {
      db.close();
    }
  });

});

// ===========================================================================

describe('upsertManifest', () => {
  it('persists every column and supports update-on-conflict', () => {
    const db = openRunIndex(tempDir);
    try {
      upsertManifest(db, makeManifest());
      expect(countRuns(db)).toBe(1);

      // Fetch raw row to confirm column-level fidelity.
      const row = db.prepare(
        `SELECT run_id, status, exit_code, weighted_score, agent_cost_usd,
                platform_cost_usd, total_ai_calls, agent_variant, replayable,
                args_json, manifest_revision
           FROM runs WHERE run_id = ?`
      ).get('r1') as Record<string, unknown>;
      expect(row.run_id).toBe('r1');
      expect(row.status).toBe('succeeded');
      expect(row.weighted_score).toBe(0.75);
      expect(row.agent_cost_usd).toBe(0.04);
      expect(row.total_ai_calls).toBe(5);
      expect(row.agent_variant).toBe('haiku');
      expect(row.replayable).toBe(0);
      expect(row.args_json).toBe('["--x","y"]');
      expect(row.manifest_revision).toBe(1);

      // Replace with a higher revision and confirm the row is overwritten.
      upsertManifest(db, makeManifest({ manifest_revision: 2, status: 'failed' }));
      expect(countRuns(db)).toBe(1);
      const updated = db.prepare<{ manifest_revision: number; status: string }, [string]>(
        'SELECT manifest_revision, status FROM runs WHERE run_id = ?'
      ).get('r1');
      expect(updated?.manifest_revision).toBe(2);
      expect(updated?.status).toBe('failed');
    } finally {
      db.close();
    }
  });

  it('round-trips the pricing-fallback count onto RunSummary', () => {
    const db = openRunIndex(tempDir);
    try {
      // Default manifest prices every model -> absent on the summary.
      upsertManifest(db, makeManifest());
      expect(getRunSummary(db, 'r1')?.pricingFallbackCalls).toBeUndefined();

      // A run with unpriced calls carries the count through to RunSummary.
      upsertManifest(
        db,
        makeManifest({
          run_id: 'r2',
          usage: { ...makeManifest().usage, pricing_fallback_calls: 3, unpriced_models: ['mystery-1.0'] },
        }),
      );
      expect(getRunSummary(db, 'r2')?.pricingFallbackCalls).toBe(3);
    } finally {
      db.close();
    }
  });

  it('writes child rows for criteria, cost breakdown, and artifacts', () => {
    const db = openRunIndex(tempDir);
    try {
      upsertManifest(db, makeManifest());

      expect(listRunCriteria(db, 'r1')).toEqual([
        {
          runId: 'r1',
          criterion: 'tests',
          weight: 1,
          score: 0.75,
          summary: 'Mostly passing',
          status: 'completed',
          scorerType: 'script',
          allowedScores: [0, 0.5, 1],
          logPath: 'scorer-tests.log',
        },
      ]);

      const cost = db.prepare<{ source_key: string; calls: number; cache_read_input_tokens: number | null; cost_usd: number }, [string]>(
        'SELECT source_key, calls, cache_read_input_tokens, cost_usd FROM run_cost_breakdown WHERE run_id = ? ORDER BY source_key'
      ).all('r1');
      expect(cost).toEqual([
        { source_key: 'agent', calls: 3, cache_read_input_tokens: 8000, cost_usd: 0.04 },
        { source_key: 'platform', calls: 2, cache_read_input_tokens: 1000, cost_usd: 0.01 },
      ]);

      // Run-wide cache totals land on the runs table too.
      const totals = db.prepare<{ total_cache_read_input_tokens: number | null }, [string]>(
        'SELECT total_cache_read_input_tokens FROM runs WHERE run_id = ?'
      ).get('r1');
      expect(totals?.total_cache_read_input_tokens).toBe(9000);

      const artifacts = db.prepare<{ kind: string; rel_path: string }, [string]>(
        'SELECT kind, rel_path FROM run_artifacts WHERE run_id = ? ORDER BY kind'
      ).all('r1');
      expect(artifacts).toEqual([
        { kind: 'logs', rel_path: 'logs.txt' },
        { kind: 'scores', rel_path: 'evaluation/result.json' },
      ]);
    } finally {
      db.close();
    }
  });

  it('replaces (not merges) child rows on re-upsert', () => {
    const db = openRunIndex(tempDir);
    try {
      upsertManifest(db, makeManifest());
      const replaced = makeManifest({
        evaluation: {
          weighted_score: 1,
          criteria: [
            { id: 'lint', weight: 1, score: 1, summary: 'Clean', status: 'completed', scorer_type: 'script' },
          ],
        },
        artifacts: [
          { key: 'runs/r1/logs.txt', kind: 'logs', rel_path: 'logs.txt', bytes: 100, created_at: 't' },
        ],
        usage: { ...makeManifest().usage, by_source: undefined },
      });
      upsertManifest(db, replaced);

      const criteria = listRunCriteria(db, 'r1');
      expect(criteria).toHaveLength(1);
      expect(criteria[0].criterion).toBe('lint');
      // Cost breakdown should be empty now.
      const cost = db.prepare<{ c: number }, [string]>(
        'SELECT COUNT(*) AS c FROM run_cost_breakdown WHERE run_id = ?'
      ).get('r1');
      expect(cost?.c).toBe(0);
      // Artifacts trimmed.
      const artifacts = db.prepare<{ c: number }, [string]>(
        'SELECT COUNT(*) AS c FROM run_artifacts WHERE run_id = ?'
      ).get('r1');
      expect(artifacts?.c).toBe(1);
    } finally {
      db.close();
    }
  });
});

// ===========================================================================

describe('deleteRun', () => {
  it('cascades to child rows', () => {
    const db = openRunIndex(tempDir);
    try {
      upsertManifest(db, makeManifest());
      deleteRun(db, 'r1');
      expect(countRuns(db)).toBe(0);
      const cost = db.prepare<{ c: number }, [string]>(
        'SELECT COUNT(*) AS c FROM run_cost_breakdown WHERE run_id = ?'
      ).get('r1');
      expect(cost?.c).toBe(0);
    } finally {
      db.close();
    }
  });
});

// ===========================================================================

describe('listRunSummaries', () => {
  function seed(db: ReturnType<typeof openRunIndex>) {
    upsertManifest(db, makeManifest({
      run_id: 'a', experiment: { id: 'exp1' }, agent: { id: 'agent1', args: [] },
      status: 'succeeded', started_at: '2026-04-25T00:00:00Z',
      evaluation: { weighted_score: 0.9, criteria: [] },
    }));
    upsertManifest(db, makeManifest({
      run_id: 'b', experiment: { id: 'exp2' }, agent: { id: 'agent1', args: [] },
      status: 'failed', started_at: '2026-04-26T00:00:00Z',
      evaluation: { weighted_score: 0.2, criteria: [] },
    }));
    upsertManifest(db, makeManifest({
      run_id: 'c', experiment: { id: 'exp1' }, agent: { id: 'agent2', args: [] },
      status: 'succeeded', started_at: '2026-04-27T00:00:00Z',
      evaluation: { weighted_score: 0.5, criteria: [] },
    }));
  }

  it('orders newest-first by default', () => {
    const db = openRunIndex(tempDir);
    try {
      seed(db);
      const summaries = listRunSummaries(db);
      expect(summaries.map((s) => s.runId)).toEqual(['c', 'b', 'a']);
    } finally {
      db.close();
    }
  });

  it('filters by experimentId', () => {
    const db = openRunIndex(tempDir);
    try {
      seed(db);
      const summaries = listRunSummaries(db, { experimentId: 'exp1' });
      expect(summaries.map((s) => s.runId).sort()).toEqual(['a', 'c']);
    } finally {
      db.close();
    }
  });

  it('filters by agentId', () => {
    const db = openRunIndex(tempDir);
    try {
      seed(db);
      const summaries = listRunSummaries(db, { agentId: 'agent1' });
      expect(summaries.map((s) => s.runId).sort()).toEqual(['a', 'b']);
    } finally {
      db.close();
    }
  });

  it('filters by status array', () => {
    const db = openRunIndex(tempDir);
    try {
      seed(db);
      const summaries = listRunSummaries(db, { status: ['succeeded'] });
      expect(summaries.map((s) => s.runId).sort()).toEqual(['a', 'c']);
    } finally {
      db.close();
    }
  });

  it('filters by score range and date range', () => {
    const db = openRunIndex(tempDir);
    try {
      seed(db);
      const above = listRunSummaries(db, { minScore: 0.5 });
      expect(above.map((s) => s.runId).sort()).toEqual(['a', 'c']);

      const after = listRunSummaries(db, { startedAfter: '2026-04-26T00:00:00Z' });
      expect(after.map((s) => s.runId).sort()).toEqual(['b', 'c']);
    } finally {
      db.close();
    }
  });

  it('respects limit + offset for pagination', () => {
    const db = openRunIndex(tempDir);
    try {
      seed(db);
      const page1 = listRunSummaries(db, { limit: 2, offset: 0 });
      expect(page1.map((s) => s.runId)).toEqual(['c', 'b']);
      const page2 = listRunSummaries(db, { limit: 2, offset: 2 });
      expect(page2.map((s) => s.runId)).toEqual(['a']);
    } finally {
      db.close();
    }
  });

  it('returns RunSummary shape including variant, model headline, exit code, cost breakdown, and token totals', () => {
    const db = openRunIndex(tempDir);
    try {
      upsertManifest(db, makeManifest({
        run_id: 'unique',
        exit_code: 0,
        agent: {
          id: 'agent',
          args: [],
          variant: 'haiku',
          models: [
            // Rank-0 by cost is Opus, even though the cheap Haiku below it fired
            // far more calls — the headline must follow cost, not call count.
            { model: 'claude-opus-4-7', calls: 3, input_tokens: 90, output_tokens: 180, cost_usd: 0.05 },
            { model: 'claude-haiku-4-5', calls: 12, input_tokens: 10, output_tokens: 20, cost_usd: 0.01 },
          ],
        },
      }));
      const [summary] = listRunSummaries(db);
      expect(summary).toMatchObject({
        runId: 'unique',
        agentVariant: 'haiku',
        // Headline is the rank-0 (highest-cost) model; count flags multi-model.
        agentModel: 'claude-opus-4-7',
        agentModelCount: 2,
        exitCode: 0,
        weightedScore: 0.75,
        agentCostUsd: 0.04,
        platformCostUsd: 0.01,
        // Headline (agent-only) cost stays separate from agent_cost_usd
        // even when they happen to be equal here.
        estimatedCostUsd: 0.05,
        totalAiCalls: 5,
        totalInputTokens: 100,
        totalOutputTokens: 200,
      });
    } finally {
      db.close();
    }
  });

  it('projects agent.models into the run_agent_models child table by rank', () => {
    const db = openRunIndex(tempDir);
    try {
      upsertManifest(db, makeManifest({
        run_id: 'multi',
        agent: {
          id: 'agent',
          args: [],
          models: [
            { model: 'claude-opus-4-7', calls: 4, input_tokens: 90, output_tokens: 180, cost_usd: 0.05 },
            { model: 'claude-haiku-4-5', calls: 1, input_tokens: 10, output_tokens: 20, cost_usd: 0.01 },
          ],
        },
      }));

      expect(listRunAgentModels(db, 'multi')).toEqual([
        { model: 'claude-opus-4-7', calls: 4, input_tokens: 90, output_tokens: 180, cost_usd: 0.05 },
        { model: 'claude-haiku-4-5', calls: 1, input_tokens: 10, output_tokens: 20, cost_usd: 0.01 },
      ]);

      // The cross-run query the headline column can't answer: a model that
      // ran only secondarily is still found.
      expect(findRunIdsByModel(db, 'claude-haiku-4-5')).toEqual(['multi']);
    } finally {
      db.close();
    }
  });

  it('re-upserting a manifest replaces its agent-model rows', () => {
    const db = openRunIndex(tempDir);
    try {
      upsertManifest(db, makeManifest({
        run_id: 'r',
        agent: { id: 'agent', args: [], models: [
          { model: 'claude-opus-4-7', calls: 3, input_tokens: 30, output_tokens: 15, cost_usd: 0.03 },
        ] },
      }));
      // Re-run observed a different model — old rows must not linger.
      upsertManifest(db, makeManifest({
        run_id: 'r',
        manifest_revision: 2,
        agent: { id: 'agent', args: [], models: [
          { model: 'gpt-5.5', calls: 5, input_tokens: 50, output_tokens: 25, cost_usd: 0.05 },
        ] },
      }));

      expect(listRunAgentModels(db, 'r').map((m) => m.model)).toEqual(['gpt-5.5']);
      expect(findRunIdsByModel(db, 'claude-opus-4-7')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('getRunSummary returns null for missing runs', () => {
    const db = openRunIndex(tempDir);
    try {
      expect(getRunSummary(db, 'missing')).toBeNull();
    } finally {
      db.close();
    }
  });
});

// ===========================================================================

describe('rebuildIndex', () => {
  async function setupTwoCompleteRuns(): Promise<string[]> {
    const ids: string[] = [];
    for (const tag of ['alpha', 'beta']) {
      const run = createRun({ experimentId: `exp-${tag}`, experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });
      updateRunStatus(run.run_id, 'succeeded', 0, tempDir);
      // Simulate the proxy producing an empty agent.jsonl, then run the
      // streaming finalize pass. Drives accounting_status -> 'captured' and
      // writes summary.json with zero totals — same as a real zero-call run.
      const tracesDir = path.join(getRunDir(run.run_id, tempDir), 'traces');
      fs.mkdirSync(tracesDir, { recursive: true });
      fs.writeFileSync(path.join(tracesDir, 'agent.jsonl'), '');
      await finalizeTracesStreaming(run.run_id, tempDir);
      const evalResult: EvaluationResult = {
        weightedScore: 0.5,
        criteria: [
          { id: 'c1', weight: 1, score: 0.5, summary: 's', status: 'completed', scorerType: 'judge' },
        ],
      };
      saveEvaluationResult(run.run_id, evalResult, tempDir);
      ids.push(run.run_id);
    }
    return ids;
  }

  it('indexes every run that has a manifest.json on disk', async () => {
    const [a, b] = await setupTwoCompleteRuns();
    // Every run is born with a manifest, so they're already on disk.
    expect(fs.existsSync(path.join(tempDir, '.bunsen', 'runs', a, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, '.bunsen', 'runs', b, 'manifest.json'))).toBe(true);

    const report = rebuildIndex(tempDir);

    expect(report.indexedRuns).toBe(2);
    expect(report.skippedRuns).toEqual([]);

    const db = openRunIndex(tempDir, { readonly: true });
    try {
      expect(countRuns(db)).toBe(2);
      const summaries = listRunSummaries(db);
      expect(summaries.map((s) => s.runId).sort()).toEqual([a, b].sort());
    } finally {
      db.close();
    }
  });

  it('recovers a stale-schema file on a direct rebuild (the bn index rebuild path)', () => {
    const manifest = makeManifest();
    saveRunManifest(manifest.run_id, manifest, tempDir);

    // Build the index, then forge an older schema version on disk.
    let db = openRunIndex(tempDir);
    upsertManifest(db, manifest);
    db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    db.close();

    // rebuildIndex (what `bn index rebuild` calls) must delete the stale FILE,
    // not just its rows — otherwise the new columns never materialize and every
    // run is skipped on re-upsert.
    const report = rebuildIndex(tempDir);
    expect(report.skippedRuns).toEqual([]);
    expect(report.indexedRuns).toBe(1);

    db = openRunIndex(tempDir, { readonly: true });
    try {
      expect(getRunSummary(db, manifest.run_id)?.totalCacheReadInputTokens).toBe(9000);
    } finally {
      db.close();
    }
  });

  it('skips run dirs that lack a manifest.json', () => {
    const orphanDir = path.join(tempDir, '.bunsen', 'runs', 'orphan');
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, 'logs.txt'), 'just logs');

    const report = rebuildIndex(tempDir);
    expect(report.indexedRuns).toBe(0);
    expect(report.skippedRuns).toContain('orphan');
  });

  it('returns empty report when no runs dir exists', () => {
    const report = rebuildIndex(tempDir);
    expect(report).toEqual({ indexedRuns: 0, skippedRuns: [] });
  });

  it('drops existing rows by default so stale entries do not linger', async () => {
    const [a] = await setupTwoCompleteRuns();

    // Seed a stale row that should not survive a rebuild.
    const db = openRunIndex(tempDir);
    try {
      upsertManifest(db, makeManifest({ run_id: 'stale' }));
    } finally {
      db.close();
    }

    rebuildIndex(tempDir);
    const db2 = openRunIndex(tempDir, { readonly: true });
    try {
      expect(getRunSummary(db2, 'stale')).toBeNull();
      expect(getRunSummary(db2, a)?.runId).toBe(a);
    } finally {
      db2.close();
    }
  });
});

// ===========================================================================

describe('upsertManifestSafely', () => {
  it('keeps the index in sync without throwing on success', () => {
    const m = makeManifest();
    expect(() => upsertManifestSafely(m, tempDir)).not.toThrow();
    const db = openRunIndex(tempDir, { readonly: true });
    try {
      expect(getRunSummary(db, m.run_id)?.runId).toBe(m.run_id);
    } finally {
      db.close();
    }
  });

  it('does not throw when the index path is unwritable', () => {
    // Pointing baseDir at a path with a read-only ancestor would normally
    // throw — the safely variant catches and swallows.
    const unreachable = path.join(tempDir, 'does-not-exist', 'nested');
    expect(() => upsertManifestSafely(makeManifest(), unreachable)).not.toThrow();
  });
});

// ===========================================================================

describe('manifest write path drives index in sync', () => {
  it('refreshRunManifest + upsertManifestSafely keep manifest.json/sqlite consistent', () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });
    updateRunStatus(run.run_id, 'succeeded', 0, tempDir);
    saveEvaluationResult(run.run_id, {
      weightedScore: 0.42, criteria: [{ id: 'c1', weight: 1, score: 0.42, summary: 's', status: 'completed', scorerType: 'judge' }],
    }, tempDir);

    const manifest = refreshRunManifest(run.run_id, tempDir);
    expect(manifest).not.toBeNull();
    if (manifest) upsertManifestSafely(manifest, tempDir);

    const db = openRunIndex(tempDir, { readonly: true });
    try {
      const summary = getRunSummary(db, run.run_id);
      expect(summary?.weightedScore).toBe(0.42);
      expect(summary?.status).toBe('succeeded');
    } finally {
      db.close();
    }
  });
});

// ===========================================================================

describe('saveRunManifest interop', () => {
  it('a manifest written directly with saveRunManifest is also indexable', () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });
    const m = makeManifest({ run_id: run.run_id });
    const db = openRunIndex(tempDir);
    try {
      saveRunManifest(run.run_id, m, tempDir);
      upsertManifest(db, m);
      expect(getRunSummary(db, run.run_id)?.runId).toBe(run.run_id);
    } finally {
      db.close();
    }
  });
});
