// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for the RunManifestV1 helpers.
 *
 * The manifest is now the on-disk source of truth, so the storage writers
 * mutate it in place. These tests focus on:
 *
 *   - `classifyArtifact` (path -> ArtifactKind)
 *   - the storage writers' projections onto manifest fields
 *   - `refreshRunManifest` re-walking the run dir for `artifacts[]`
 *
 * The legacy "synthesize manifest from `run.json` + `scores.json`" path is
 * gone (every run dir is born with a manifest), so there's nothing to test
 * for synthesis anymore.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  classifyArtifact,
  getRunManifestPath,
  refreshRunManifest,
} from './manifest.js';
import {
  createRun,
  getRunDir,
  loadRunManifest,
  finalizeTracesStreaming,
  saveEvaluationResult,
  saveHumanScores,
  saveRunManifest,
  saveWorkspaceDiff,
  updateRunStatus,
  RUN_MANIFEST_FILENAME,
  RUN_MANIFEST_SCHEMA_VERSION,
} from './storage.js';
import type {
  AITrace,
  EvaluationResult,
  HumanScores,
  RunManifestV1,
} from '@bunsen-dev/types';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-manifest-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function setupCompleteRun(): Promise<{ runId: string }> {
  const run = createRun({ experimentId: 'exp-id', experimentPath: '/path/to/exp', agentId: 'agent-id', agentPath: '/path/to/agent', args: ['--foo'], baseDir: tempDir, variant: 'haiku' });
  updateRunStatus(run.run_id, 'succeeded', 0, tempDir);

  const traces: AITrace[] = [
    {
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      endpoint: '/v1/messages',
      source: 'agent',
      timestamp: '2026-04-27T00:00:01Z',
      latencyMs: 100,
      request: {},
      response: {
        usage: { inputTokens: 50, outputTokens: 80 },
      },
      estimatedCostUsd: 0.001,
    },
    {
      provider: 'anthropic',
      model: 'claude-haiku-4',
      endpoint: '/v1/messages',
      source: 'orchestrator',
      timestamp: '2026-04-27T00:00:00Z',
      latencyMs: 50,
      request: {},
      response: {
        usage: { inputTokens: 10, outputTokens: 20 },
      },
      estimatedCostUsd: 0.0002,
    },
    {
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      endpoint: '/v1/messages',
      source: 'scorer:tests-pass',
      timestamp: '2026-04-27T00:00:02Z',
      latencyMs: 200,
      request: {},
      response: {
        usage: { inputTokens: 30, outputTokens: 40 },
      },
      estimatedCostUsd: 0.0005,
    },
  ];
  // Simulate the proxy producing a JSONL file, then run the streaming
  // finalize pass (which is what production does).
  const tracesDir = path.join(getRunDir(run.run_id, tempDir), 'traces');
  fs.mkdirSync(tracesDir, { recursive: true });
  fs.writeFileSync(
    path.join(tracesDir, 'agent.jsonl'),
    traces.map((t) => JSON.stringify(t)).join('\n') + '\n',
  );
  await finalizeTracesStreaming(run.run_id, tempDir);

  const evalResult: EvaluationResult = {
    weightedScore: 0.8,
    criteria: [
      {
        id: 'tests-pass',
        weight: 1,
        score: 0.8,
        summary: 'Mostly passing',
        status: 'completed',
        scorerType: 'script',
        allowedScores: [0, 1],
        logPath: 'evaluation/criteria/tests-pass.log',
      },
      {
        id: 'visual',
        weight: 0.5,
        score: 0.6,
        summary: 'Layout off',
        status: 'completed',
        scorerType: 'browser-agent',
        screenshots: ['artifacts/screenshots/screenshot_1.png'],
      },
    ],
    report: 'Run summary narrative',
  };
  saveEvaluationResult(run.run_id, evalResult, tempDir);

  saveWorkspaceDiff(run.run_id, 'diff --git a/foo b/foo\n', tempDir);

  // Make the v1-layout artifact files real on disk
  const runDir = getRunDir(run.run_id, tempDir);
  fs.mkdirSync(path.join(runDir, 'artifacts', 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'artifacts', 'screenshots', 'screenshot_1.png'), 'png-bytes');
  fs.mkdirSync(path.join(runDir, 'artifacts', 'output'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'artifacts', 'output', 'hello.txt'), 'hi');
  fs.writeFileSync(path.join(runDir, 'logs.txt'), 'log lines');
  // Per-criterion script log lives under evaluation/criteria/<slug>.log.
  fs.mkdirSync(path.join(runDir, 'evaluation', 'criteria'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'evaluation', 'criteria', 'tests-pass.log'), 'scorer log');

  return { runId: run.run_id };
}

// ===========================================================================

describe('classifyArtifact', () => {
  it.each([
    ['logs.txt', 'logs'],
    ['task/prompt.md', 'task_prompt'],
    ['orchestration/result.json', 'orchestration_result'],
    ['workspace/diff.patch', 'workspace_diff'],
    ['workspace/export.tar.gz', 'workspace_tar'],
    ['workspace/export.tar.zst', 'workspace_tar'],
    ['evaluation/result.json', 'scores'],
    ['evaluation/report.md', 'report'],
    ['evaluation/human.json', 'human_scores'],
    ['evaluation/criteria/tests-pass.json', 'criterion_result'],
    ['evaluation/criteria/tests-pass.log', 'scorer_log'],
    ['artifacts/recording.cast', 'recording_cast'],
    ['artifacts/screenshots/diag.png', 'screenshot'],
    ['artifacts/output/hello.txt', 'output'],
    ['artifacts/output/nested/deep.txt', 'output'],
    ['supervisor.log', 'supervisor'],
    ['traces/agent.jsonl', 'trace_raw'],
    ['traces/platform.jsonl', 'trace_platform'],
    ['traces/threads/index.json', 'trace_structured'],
    ['traces/threads/thread-1.jsonl', 'trace_structured'],
    ['traces/threads/thread-42.jsonl', 'trace_structured'],
    ['traces/summary.json', 'trace_summary'],
    ['unknown-file.dat', 'output'],
  ] as const)('classifies %s as %s', (relPath, expected) => {
    expect(classifyArtifact(relPath)).toBe(expected);
  });

  it('skips the manifest file itself', () => {
    expect(classifyArtifact(RUN_MANIFEST_FILENAME)).toBeUndefined();
  });

  it('skips events.jsonl (manifest is the index, events.jsonl is its log)', () => {
    expect(classifyArtifact('events.jsonl')).toBeUndefined();
  });

  it('skips internal scratch files', () => {
    expect(classifyArtifact('agent-script.sh')).toBeUndefined();
    expect(classifyArtifact('agent-complete.marker')).toBeUndefined();
    expect(classifyArtifact('launcher.sh')).toBeUndefined();
    expect(classifyArtifact('supervisor.json')).toBeUndefined();
  });
});

// ===========================================================================

describe('saveRunManifest + loadRunManifest', () => {
  it('persists and reloads a manifest atomically', () => {
    const run = createRun({ experimentId: 'e', experimentPath: '/e', agentId: 'a', agentPath: '/a', args: [], baseDir: tempDir });
    const manifest: RunManifestV1 = {
      schema_version: RUN_MANIFEST_SCHEMA_VERSION,
      run_id: run.run_id,
      manifest_revision: 1,
      run_source: 'local',
      created_at: '2026-04-27T00:00:00Z',
      updated_at: '2026-04-27T00:00:00Z',
      status: 'succeeded',
      started_at: '2026-04-27T00:00:00Z',
      duration_ms: 0,
      experiment: { id: 'e' },
      agent: { id: 'a', args: [] },
      usage: {
        total_ai_calls: 0, total_input_tokens: 0, total_output_tokens: 0, estimated_cost_usd: 0,
      },
      provenance: { verification_tier: 'self_reported', replayable: false },
      artifacts: [],
    };
    saveRunManifest(run.run_id, manifest, tempDir);
    expect(loadRunManifest(run.run_id, tempDir)).toEqual(manifest);
  });

  it('returns the initial manifest when one was never overwritten', () => {
    // createRun writes an initial manifest; loadRunManifest finds it.
    const run = createRun({ experimentId: 'e', experimentPath: '/e', agentId: 'a', agentPath: '/a', args: [], baseDir: tempDir });
    const loaded = loadRunManifest(run.run_id, tempDir);
    expect(loaded?.run_id).toBe(run.run_id);
    expect(loaded?.status).toBe('pending');
  });

  it('does not leave a temp file alongside on failure', () => {
    const run = createRun({ experimentId: 'e', experimentPath: '/e', agentId: 'a', agentPath: '/a', args: [], baseDir: tempDir });
    const manifest: RunManifestV1 = {
      schema_version: 1, run_id: run.run_id, manifest_revision: 1, run_source: 'local',
      created_at: 't', updated_at: 't', status: 'pending', started_at: 't', duration_ms: 0,
      experiment: { id: 'e' }, agent: { id: 'a', args: [] },
      usage: { total_ai_calls: 0, total_input_tokens: 0, total_output_tokens: 0, estimated_cost_usd: 0 },
      provenance: { verification_tier: 'self_reported', replayable: false }, artifacts: [],
    };
    saveRunManifest(run.run_id, manifest, tempDir);

    const runDir = getRunDir(run.run_id, tempDir);
    const tempFiles = fs.readdirSync(runDir).filter((n) => n.includes('manifest.json.tmp'));
    expect(tempFiles).toEqual([]);
    expect(fs.existsSync(getRunManifestPath(run.run_id, tempDir))).toBe(true);
  });
});

// ===========================================================================

describe('storage writers project onto manifest fields', () => {
  it('every write target lands in the manifest after refreshRunManifest', async () => {
    const { runId } = await setupCompleteRun();
    // refreshRunManifest only touches artifacts[]; the other projections
    // were written incrementally by the storage writers in setupCompleteRun.
    const manifest = refreshRunManifest(runId, tempDir);
    expect(manifest).not.toBeNull();
    if (!manifest) return;

    expect(manifest.schema_version).toBe(1);
    expect(manifest.run_id).toBe(runId);
    expect(manifest.run_source).toBe('local');
    expect(manifest.status).toBe('succeeded');
    expect(manifest.exit_code).toBe(0);

    expect(manifest.experiment).toEqual({ id: 'exp-id', path: '/path/to/exp' });
    expect(manifest.agent.id).toBe('agent-id');
    expect(manifest.agent.variant).toBe('haiku');
    expect(manifest.agent.args).toEqual(['--foo']);

    // Usage: total_ai_calls = full traces (3); estimated_cost_usd = agent-only.
    expect(manifest.usage.total_ai_calls).toBe(3);
    expect(manifest.usage.total_input_tokens).toBe(50 + 10 + 30);
    expect(manifest.usage.total_output_tokens).toBe(80 + 20 + 40);
    expect(manifest.usage.estimated_cost_usd).toBeCloseTo(0.001, 5);
    expect(manifest.usage.agent_cost_usd).toBeCloseTo(0.001, 5);
    expect(manifest.usage.platform_cost_usd).toBeCloseTo(0.0007, 5);

    expect(manifest.usage.by_source).toBeDefined();
    expect(manifest.usage.by_source!.agent.calls).toBe(1);
    expect(manifest.usage.by_source!.platform.calls).toBe(2);
    expect(manifest.usage.by_source!.orchestrator.calls).toBe(1);
    expect(manifest.usage.by_source!['scorer:tests-pass'].calls).toBe(1);

    expect(manifest.evaluation).toBeDefined();
    expect(manifest.evaluation!.weighted_score).toBe(0.8);
    expect(manifest.evaluation!.report).toBe('Run summary narrative');
    expect(manifest.evaluation!.criteria).toHaveLength(2);
    const tests = manifest.evaluation!.criteria.find((c) => c.id === 'tests-pass')!;
    expect(tests.scorer_type).toBe('script');
    expect(tests.allowed_scores).toEqual([0, 1]);
    expect(tests.log_path).toBe('evaluation/criteria/tests-pass.log');
    const visual = manifest.evaluation!.criteria.find((c) => c.id === 'visual')!;
    expect(visual.scorer_type).toBe('browser-agent');
    expect(visual.screenshots).toEqual(['artifacts/screenshots/screenshot_1.png']);

    expect(manifest.provenance).toEqual({ verification_tier: 'self_reported', replayable: false });

    // Artifacts: every v1-layout file (manifest.json + scorer log under
    // evaluation/criteria/ + workspace/diff.patch + screenshots + output +
    // traces summary + agent + platform traces + per-criterion JSON
    // projections + evaluation/result.json + evaluation/report.md). Sorted
    // by (kind, key). `run_metadata` is no longer present — the manifest is
    // the metadata.
    const kinds = manifest.artifacts.map((a) => a.kind);
    expect(kinds).not.toContain('run_metadata');
    expect(kinds).toContain('scores');
    expect(kinds).toContain('criterion_result');
    expect(kinds).toContain('report');
    expect(kinds).toContain('logs');
    expect(kinds).toContain('workspace_diff');
    expect(kinds).toContain('scorer_log');
    expect(kinds).toContain('screenshot');
    expect(kinds).toContain('output');
    expect(kinds).toContain('trace_summary');
    expect(kinds).toContain('trace_raw');
    expect(kinds).toContain('trace_platform');

    const output = manifest.artifacts.find((a) => a.kind === 'output')!;
    expect(output.key).toBe(`runs/${runId}/artifacts/output/hello.txt`);
    expect(output.rel_path).toBe('artifacts/output/hello.txt');
    expect(output.bytes).toBe(2);
  });

  it('refresh is a no-op for the artifacts walk on a missing run', () => {
    expect(refreshRunManifest('does-not-exist', tempDir)).toBeNull();
  });

  it('omits human_scoring when no human.json exists', async () => {
    const { runId } = await setupCompleteRun();
    const manifest = refreshRunManifest(runId, tempDir);
    expect(manifest?.human_scoring).toBeUndefined();
  });

  it('saveHumanScores projects onto the manifest', async () => {
    const { runId } = await setupCompleteRun();
    const human: HumanScores = {
      criteria: [
        { criterion: 'tests-pass', humanScore: 1, llmScore: 0.8, notes: 'agreed', allowedScores: [0, 1] },
      ],
      scoredBy: 'matt',
      scoredAt: '2026-04-27T01:00:00Z',
    };
    saveHumanScores(runId, human, tempDir);
    const manifest = loadRunManifest(runId, tempDir);
    expect(manifest?.human_scoring).toEqual({
      scored_by: 'matt',
      scored_at: '2026-04-27T01:00:00Z',
      criteria: [
        {
          id: 'tests-pass',
          human_score: 1,
          llm_score: 0.8,
          notes: 'agreed',
          allowed_scores: [0, 1],
        },
      ],
    });
  });

  it('bumps manifest_revision only when artifacts[] actually changed', async () => {
    const { runId } = await setupCompleteRun();
    const before = loadRunManifest(runId, tempDir)!;
    const m1 = refreshRunManifest(runId, tempDir);
    expect(m1?.manifest_revision).toBe(before.manifest_revision + 1);

    // No new files on disk → second refresh is a no-op.
    const m2 = refreshRunManifest(runId, tempDir);
    expect(m2?.manifest_revision).toBe(m1?.manifest_revision);

    // Drop a new artifact and confirm the next refresh ticks.
    fs.writeFileSync(path.join(getRunDir(runId, tempDir), 'artifacts', 'output', 'fresh.txt'), 'x');
    const m3 = refreshRunManifest(runId, tempDir);
    expect(m3?.manifest_revision).toBe((m2?.manifest_revision ?? 0) + 1);

    // created_at stays pinned across all of them.
    expect(m3?.created_at).toBe(before.created_at);
  });
});

// ===========================================================================

describe('refreshRunManifest', () => {
  it('writes the manifest and returns it', async () => {
    const { runId } = await setupCompleteRun();
    const manifest = refreshRunManifest(runId, tempDir);
    expect(manifest).not.toBeNull();
    expect(loadRunManifest(runId, tempDir)).toEqual(manifest);
  });

  it('no-ops on a missing run', () => {
    const result = refreshRunManifest('missing', tempDir);
    expect(result).toBeNull();
    expect(fs.existsSync(getRunManifestPath('missing', tempDir))).toBe(false);
  });
});
