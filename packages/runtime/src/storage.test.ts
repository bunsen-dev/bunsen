// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for storage operations
 *
 * Reads consume `RunManifestV1` directly via `loadRunManifest` /
 * `mutateRunManifest`. The legacy camelCase `loadRunMetadata` /
 * `saveRunMetadata` / `loadRun` projection layer was removed in the CLI
 * command-tree restructure (task 16); these tests assert on snake_case
 * manifest fields instead.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  getBunsenDir,
  getRunsDir,
  getRunDir,
  ensureStorageDir,
  createRun,
  updateRunStatus,
  loadRunManifest,
  mutateRunManifest,
  saveLogs,
  loadLogs,
  appendLogs,
  saveEvaluationResult,
  loadEvaluationResult,
  saveHumanScores,
  loadHumanScores,
  parseTracesJsonl,
  finalizeTracesStreaming,
  finalizeRunTraces,
  loadTraces,
  loadTracesSummary,
  loadThreadHeadTail,
  listRuns,
  markTraceCaptureMissing,
  markTraceCaptureSkipped,
  RUN_PATHS,
} from './storage.js';
import { openRunIndex, getRunSummary } from './run-index.js';
import type {
  EvaluationResult,
  AITrace,
  HumanScores,
} from '@bunsen-dev/types';

// Helper to write traces in JSONL format (simulating mitmproxy output)
function writeTracesJsonl(runDir: string, traces: AITrace[]): void {
  const tracesDir = path.join(runDir, 'traces');
  fs.mkdirSync(tracesDir, { recursive: true });
  const content = traces.map((t) => JSON.stringify(t)).join('\n');
  fs.writeFileSync(path.join(tracesDir, 'agent.jsonl'), content);
}

// Helper: simulate the proxy producing a JSONL trace file, then run the
// streaming finalize pass — the same path production uses.
async function persistTraces(runId: string, traces: AITrace[], baseDir: string): Promise<void> {
  writeTracesJsonl(getRunDir(runId, baseDir), traces);
  await finalizeTracesStreaming(runId, baseDir);
}

describe('storage paths', () => {
  it('returns correct bunsen directory', () => {
    expect(getBunsenDir('/home/user/project')).toBe('/home/user/project/.bunsen');
  });

  it('returns correct runs directory', () => {
    expect(getRunsDir('/home/user/project')).toBe('/home/user/project/.bunsen/runs');
  });

  it('returns correct run directory', () => {
    expect(getRunDir('abc123', '/home/user/project')).toBe(
      '/home/user/project/.bunsen/runs/abc123'
    );
  });
});

describe('run lifecycle', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates storage directory', () => {
    ensureStorageDir(tempDir);
    expect(fs.existsSync(path.join(tempDir, '.bunsen', 'runs'))).toBe(true);
  });

  it('creates a new run', () => {
    const manifest = createRun({
      experimentId: 'test-experiment',
      experimentPath: '/path/to/experiment',
      agentId: 'test-agent',
      agentPath: '/path/to/agent',
      args: ['--verbose'],
      baseDir: tempDir,
    });

    expect(manifest.run_id).toHaveLength(26);
    expect(manifest.run_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(manifest.experiment.id).toBe('test-experiment');
    expect(manifest.agent.id).toBe('test-agent');
    expect(manifest.agent.args).toEqual(['--verbose']);
    expect(manifest.status).toBe('pending');

    // Check manifest + v1 layout subdirs were created
    const runDir = getRunDir(manifest.run_id, tempDir);
    expect(fs.existsSync(path.join(runDir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'traces'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'artifacts', 'output'))).toBe(true);
    // Legacy `run.json` is gone — manifest is the sole source of truth.
    expect(fs.existsSync(path.join(runDir, 'run.json'))).toBe(false);
  });

  it('loads run manifest', () => {
    const created = createRun({
      experimentId: 'exp',
      experimentPath: '/exp',
      agentId: 'agent',
      agentPath: '/agent',
      args: [],
      baseDir: tempDir,
    });

    const loaded = loadRunManifest(created.run_id, tempDir);
    expect(loaded).toBeDefined();
    expect(loaded!.run_id).toBe(created.run_id);
    expect(loaded!.experiment.id).toBe('exp');
    expect(loaded!.agent.id).toBe('agent');
  });

  it('persists resolved run platform via mutateRunManifest', () => {
    const created = createRun({
      experimentId: 'exp',
      experimentPath: '/exp',
      agentId: 'agent',
      agentPath: '/agent',
      args: [],
      baseDir: tempDir,
    });
    mutateRunManifest(created.run_id, tempDir, (m) => {
      m.platform = 'linux/amd64';
    });

    const loaded = loadRunManifest(created.run_id, tempDir)!;
    expect(loaded.platform).toBe('linux/amd64');
  });

  it('updates run status', () => {
    const created = createRun({
      experimentId: 'exp',
      experimentPath: '/exp',
      agentId: 'agent',
      agentPath: '/agent',
      args: [],
      baseDir: tempDir,
    });

    updateRunStatus(created.run_id, 'running', undefined, tempDir);
    let loaded = loadRunManifest(created.run_id, tempDir)!;
    expect(loaded.status).toBe('running');

    updateRunStatus(created.run_id, 'succeeded', 0, tempDir);
    loaded = loadRunManifest(created.run_id, tempDir)!;
    expect(loaded.status).toBe('succeeded');
    expect(loaded.exit_code).toBe(0);
    expect(loaded.completed_at).toBeDefined();
    expect(loaded.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('returns null when loading nonexistent run', () => {
    expect(loadRunManifest('nonexistent', tempDir)).toBeNull();
  });

  it('records suite provenance in the manifest when supplied', () => {
    const created = createRun({
      experimentId: 'exp',
      experimentPath: '/exp',
      agentId: 'agent',
      agentPath: '/agent',
      baseDir: tempDir,
      suite: {
        id: 'github.com/cursiv/terminal-bench',
        version: 'abc123def',
        source_url: 'https://github.com/cursiv/terminal-bench.git',
      },
    });
    const manifest = loadRunManifest(created.run_id, tempDir)!;
    expect(manifest.experiment.suite_id).toBe('github.com/cursiv/terminal-bench');
    expect(manifest.experiment.suite_version).toBe('abc123def');
    expect(manifest.experiment.suite_source_url).toBe(
      'https://github.com/cursiv/terminal-bench.git',
    );
  });

  it('preserves suite provenance through mutateRunManifest round-trips', () => {
    const created = createRun({
      experimentId: 'exp',
      experimentPath: '/exp',
      agentId: 'agent',
      agentPath: '/agent',
      baseDir: tempDir,
      suite: { id: 'local/my-suite' },
    });
    mutateRunManifest(created.run_id, tempDir, (m) => {
      m.platform = 'linux/arm64';
    });
    const after = loadRunManifest(created.run_id, tempDir)!;
    expect(after.experiment.suite_id).toBe('local/my-suite');
    expect(after.platform).toBe('linux/arm64');
  });
});

describe('logs', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('saves and loads logs', () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });
    saveLogs(run.run_id, 'Hello, World!', tempDir);
    const logs = loadLogs(run.run_id, tempDir);
    expect(logs).toBe('Hello, World!');
  });

  it('appends to logs', () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });
    saveLogs(run.run_id, 'Line 1\n', tempDir);
    appendLogs(run.run_id, 'Line 2\n', tempDir);
    const logs = loadLogs(run.run_id, tempDir);
    expect(logs).toBe('Line 1\nLine 2\n');
  });

  it('returns undefined for missing logs', () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });
    const logs = loadLogs(run.run_id, tempDir);
    expect(logs).toBeUndefined();
  });
});

describe('evaluation results', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('saves and loads evaluation results', () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });

    const evaluation: EvaluationResult = {
      criteria: [
        { id: 'Correctness', weight: 1, score: 1.0, summary: 'Perfect', status: 'completed', scorerType: 'judge' },
        { id: 'Quality', weight: 1, score: 0.8, summary: 'Good', status: 'completed', scorerType: 'judge' },
      ],
      weightedScore: 0.9,
      report: '## Summary\nGreat job!',
    };

    saveEvaluationResult(run.run_id, evaluation, tempDir);
    const loaded = loadEvaluationResult(run.run_id, tempDir);
    expect(loaded).toEqual(evaluation);

    // Weighted score is projected onto the manifest.
    const manifest = loadRunManifest(run.run_id, tempDir)!;
    expect(manifest.evaluation?.weighted_score).toBe(0.9);
  });

  it('returns undefined for missing evaluation', () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });
    const evaluation = loadEvaluationResult(run.run_id, tempDir);
    expect(evaluation).toBeUndefined();
  });
});

describe('human scores', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('saves and loads human scores', () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });

    const humanScores: HumanScores = {
      criteria: [
        {
          criterion: 'Visual Quality',
          humanScore: 0.5,
          llmScore: 0.9,
          notes: 'Shader barely works',
          allowedScores: [0, 0.25, 0.5, 0.75, 1],
        },
        {
          criterion: 'Code Quality',
          humanScore: 0.8,
          llmScore: 0.7,
        },
      ],
      scoredBy: 'tester',
      scoredAt: '2026-02-28T12:00:00Z',
    };

    saveHumanScores(run.run_id, humanScores, tempDir);
    const loaded = loadHumanScores(run.run_id, tempDir);
    expect(loaded).toEqual(humanScores);
  });

  it('returns undefined for missing human scores', () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });
    const scores = loadHumanScores(run.run_id, tempDir);
    expect(scores).toBeUndefined();
  });

  it('overwrites existing human scores', () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });

    const first: HumanScores = {
      criteria: [{ criterion: 'Test', humanScore: 0.5, llmScore: 0.8 }],
      scoredBy: 'tester',
      scoredAt: '2026-02-28T12:00:00Z',
    };

    const second: HumanScores = {
      criteria: [{ criterion: 'Test', humanScore: 0.3, llmScore: 0.8, notes: 'Updated' }],
      scoredBy: 'tester',
      scoredAt: '2026-02-28T13:00:00Z',
    };

    saveHumanScores(run.run_id, first, tempDir);
    saveHumanScores(run.run_id, second, tempDir);
    const loaded = loadHumanScores(run.run_id, tempDir);
    expect(loaded).toEqual(second);
  });
});

describe('listRuns', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('lists all run manifests sorted by date (newest first)', async () => {
    const run1 = createRun({ experimentId: 'exp1', experimentPath: '/exp1', agentId: 'agent1', agentPath: '/agent1', args: [], baseDir: tempDir });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const run2 = createRun({ experimentId: 'exp2', experimentPath: '/exp2', agentId: 'agent2', agentPath: '/agent2', args: [], baseDir: tempDir });

    const runs = listRuns(tempDir);

    expect(runs).toHaveLength(2);
    expect(runs[0].run_id).toBe(run2.run_id);
    expect(runs[1].run_id).toBe(run1.run_id);
  });

  it('returns empty array when no runs', () => {
    ensureStorageDir(tempDir);
    expect(listRuns(tempDir)).toEqual([]);
  });

  it('returns empty array when .bunsen does not exist', () => {
    expect(listRuns(tempDir)).toEqual([]);
  });
});

describe('traces', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads traces from JSONL file', () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });
    const runDir = getRunDir(run.run_id, tempDir);

    const traces: AITrace[] = [
      {
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        endpoint: '/v1/messages',
        timestamp: '2024-01-15T12:00:00Z',
        latencyMs: 1500,
        request: {
          messages: [{ role: 'user', content: 'Hello' }],
          system: 'You are helpful',
        },
        response: {
          content: [{ type: 'text', text: 'Hello! How can I help?' }],
          usage: { inputTokens: 10, outputTokens: 8 },
        },
        estimatedCostUsd: 0.000054,
      },
    ];

    writeTracesJsonl(runDir, traces);

    const loaded = loadTraces(run.run_id, tempDir);
    expect(loaded).toHaveLength(1);
    expect(loaded![0].provider).toBe('anthropic');
    expect(loaded![0].model).toBe('claude-3-sonnet');
    expect(loaded![0].response.content).toEqual([{ type: 'text', text: 'Hello! How can I help?' }]);
  });

  it('calculates traces summary', async () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });

    const traces: AITrace[] = [
      {
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        endpoint: '/v1/messages',
        timestamp: '2024-01-15T12:00:00Z',
        latencyMs: 1500,
        request: {},
        response: { usage: { inputTokens: 100, outputTokens: 50 } },
        estimatedCostUsd: 0.001,
      },
      {
        provider: 'openai',
        model: 'gpt-4o',
        endpoint: '/v1/chat/completions',
        timestamp: '2024-01-15T12:01:00Z',
        latencyMs: 2000,
        request: {},
        response: { usage: { inputTokens: 200, outputTokens: 100 } },
        estimatedCostUsd: 0.002,
      },
    ];

    await persistTraces(run.run_id, traces, tempDir);
    const summary = loadTracesSummary(run.run_id, tempDir);

    expect(summary).toBeDefined();
    expect(summary!.totalCalls).toBe(2);
    expect(summary!.totalInputTokens).toBe(300);
    expect(summary!.totalOutputTokens).toBe(150);
    expect(summary!.estimatedTotalCostUsd).toBe(0.003);
  });

  it('returns undefined for missing traces', () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });
    const traces = loadTraces(run.run_id, tempDir);
    expect(traces).toBeUndefined();
  });

  it('updates manifest usage with trace data', async () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });

    const traces: AITrace[] = [
      {
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        endpoint: '/v1/messages',
        timestamp: '2024-01-15T12:00:00Z',
        latencyMs: 1500,
        request: {},
        response: { usage: { inputTokens: 100, outputTokens: 50 } },
        estimatedCostUsd: 0.001,
      },
    ];

    await persistTraces(run.run_id, traces, tempDir);
    const manifest = loadRunManifest(run.run_id, tempDir)!;

    expect(manifest.usage.total_ai_calls).toBe(1);
    expect(manifest.usage.total_input_tokens).toBe(100);
    expect(manifest.usage.total_output_tokens).toBe(50);
    expect(manifest.usage.estimated_cost_usd).toBe(0.001);
  });

  it('parses JSONL format correctly', () => {
    const tempFile = path.join(tempDir, 'test-agent.jsonl');
    const traces = [
      { provider: 'anthropic', model: 'claude-3', timestamp: '2024-01-01T00:00:00Z' },
      { provider: 'openai', model: 'gpt-4', timestamp: '2024-01-01T00:01:00Z' },
    ];

    fs.writeFileSync(tempFile, traces.map((t) => JSON.stringify(t)).join('\n'));

    const parsed = parseTracesJsonl(tempFile);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].provider).toBe('anthropic');
    expect(parsed[1].provider).toBe('openai');
  });

  it('handles malformed JSONL lines gracefully', () => {
    const tempFile = path.join(tempDir, 'malformed.jsonl');
    const content = [
      '{"provider":"anthropic","model":"claude","timestamp":"2024-01-01"}',
      'not valid json',
      '{"provider":"openai","model":"gpt-4","timestamp":"2024-01-02"}',
      '',
    ].join('\n');

    fs.writeFileSync(tempFile, content);

    const parsed = parseTracesJsonl(tempFile);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].provider).toBe('anthropic');
    expect(parsed[1].provider).toBe('openai');
  });
});

describe('trace accounting status', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('finalizeTracesStreaming stamps accounting_status="captured"', async () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });

    const traces: AITrace[] = [
      {
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        endpoint: '/v1/messages',
        timestamp: '2024-01-15T12:00:00Z',
        latencyMs: 1500,
        request: {},
        response: { usage: { inputTokens: 100, outputTokens: 50 } },
        estimatedCostUsd: 0.001,
      },
    ];

    await persistTraces(run.run_id, traces, tempDir);
    const manifest = loadRunManifest(run.run_id, tempDir)!;
    expect(manifest.usage.accounting_status).toBe('captured');
  });

  it('finalizeTracesStreaming records the observed per-model breakdown, excluding platform + errored calls', async () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });

    const traces: AITrace[] = [
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        endpoint: '/v1/messages',
        timestamp: '2024-01-15T12:00:00Z',
        latencyMs: 1500,
        request: {},
        response: { usage: { inputTokens: 100, outputTokens: 50 } },
        estimatedCostUsd: 0.001,
        source: 'agent',
      },
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        endpoint: '/v1/messages',
        timestamp: '2024-01-15T12:00:01Z',
        latencyMs: 1500,
        request: {},
        response: { usage: { inputTokens: 80, outputTokens: 40 } },
        estimatedCostUsd: 0.001,
        source: 'agent',
      },
      // Secondary agent model — fewer calls, so it ranks second.
      {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        endpoint: '/v1/messages',
        timestamp: '2024-01-15T12:00:02Z',
        latencyMs: 400,
        request: {},
        response: { usage: { inputTokens: 20, outputTokens: 10 } },
        estimatedCostUsd: 0.0002,
        source: 'agent',
      },
      // A platform call on a third model must not appear in the breakdown.
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        endpoint: '/v1/messages',
        timestamp: '2024-01-15T12:00:03Z',
        latencyMs: 400,
        request: {},
        response: { usage: { inputTokens: 10, outputTokens: 5 } },
        estimatedCostUsd: 0.0001,
        source: 'orchestrator',
      },
      // An errored (404) agent call to an unavailable model must not appear,
      // even though it would otherwise out-rank haiku by call count.
      {
        provider: 'anthropic',
        model: 'claude-3-5-haiku-latest',
        endpoint: '/v1/messages',
        timestamp: '2024-01-15T12:00:04Z',
        latencyMs: 50,
        statusCode: 404,
        request: {},
        response: { error: { type: 'not_found_error' } },
        estimatedCostUsd: 0,
        source: 'agent',
      },
      {
        provider: 'anthropic',
        model: 'claude-3-5-haiku-latest',
        endpoint: '/v1/messages',
        timestamp: '2024-01-15T12:00:05Z',
        latencyMs: 50,
        statusCode: 404,
        request: {},
        response: { error: { type: 'not_found_error' } },
        estimatedCostUsd: 0,
        source: 'agent',
      },
    ];

    await persistTraces(run.run_id, traces, tempDir);
    const manifest = loadRunManifest(run.run_id, tempDir)!;
    expect(manifest.agent.models).toEqual([
      { model: 'claude-opus-4-7', calls: 2, input_tokens: 180, output_tokens: 90, cost_usd: 0.002 },
      { model: 'claude-haiku-4-5', calls: 1, input_tokens: 20, output_tokens: 10, cost_usd: 0.0002 },
    ]);
  });

  it('finalizeTracesStreaming leaves agent.models unset when traces report only "unknown"', async () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });

    const traces: AITrace[] = [
      {
        provider: 'anthropic',
        model: 'unknown',
        endpoint: '/v1/messages',
        timestamp: '2024-01-15T12:00:00Z',
        latencyMs: 1500,
        request: {},
        response: { usage: { inputTokens: 100, outputTokens: 50 } },
        estimatedCostUsd: 0.001,
        source: 'agent',
      },
    ];

    await persistTraces(run.run_id, traces, tempDir);
    const manifest = loadRunManifest(run.run_id, tempDir)!;
    expect(manifest.agent.models).toBeUndefined();
  });

  it('markTraceCaptureMissing flips accounting_status and writes a zero summary', () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });

    markTraceCaptureMissing(run.run_id, tempDir);

    const manifest = loadRunManifest(run.run_id, tempDir)!;
    expect(manifest.usage.accounting_status).toBe('missing');
    expect(manifest.usage.total_ai_calls).toBe(0);
    expect(manifest.usage.estimated_cost_usd).toBe(0);

    // Zero summary file is on disk so consumers can distinguish "no trace
    // file" from "missing accounting".
    const summary = loadTracesSummary(run.run_id, tempDir);
    expect(summary).toEqual({
      totalCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadInputTokens: 0,
      totalCacheCreationInputTokens: 0,
      estimatedTotalCostUsd: 0,
    });
  });

  it('markTraceCaptureSkipped flips accounting_status without writing a summary', () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });

    markTraceCaptureSkipped(run.run_id, tempDir);

    const manifest = loadRunManifest(run.run_id, tempDir)!;
    expect(manifest.usage.accounting_status).toBe('skipped');

    // No summary should have been written for an explicitly-skipped run.
    const runDir = getRunDir(run.run_id, tempDir);
    expect(fs.existsSync(path.join(runDir, RUN_PATHS.tracesSummary))).toBe(false);
  });

  describe('loadThreadHeadTail', () => {
    async function setupRunWith20Turns(): Promise<string> {
      const run = createRun({
        experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir,
      });
      const accumulated: Array<{ role: string; content: string }> = [];
      const traces: AITrace[] = [];
      for (let i = 0; i < 20; i++) {
        accumulated.push({ role: 'user', content: `turn ${i}` });
        traces.push({
          provider: 'anthropic',
          model: 'claude-3-sonnet',
          endpoint: '/v1/messages',
          source: 'agent',
          timestamp: new Date(1700000000000 + i * 1000).toISOString(),
          latencyMs: 100,
          request: { messages: [...accumulated], system: 'sys' },
          response: { content: `response ${i}`, usage: { inputTokens: 1, outputTokens: 1 } },
          estimatedCostUsd: 0.0001,
        });
        accumulated.push({ role: 'assistant', content: `response ${i}` });
      }
      await persistTraces(run.run_id, traces, tempDir);
      return run.run_id;
    }

    it('returns all turns when below the head+tail cap', async () => {
      const runId = await setupRunWith20Turns();
      const turns = loadThreadHeadTail(runId, 'thread-1', 20, 30, 30, tempDir);
      expect(turns).toHaveLength(20);
    });

    it('returns head+tail above the cap', async () => {
      const runId = await setupRunWith20Turns();
      const turns = loadThreadHeadTail(runId, 'thread-1', 20, 3, 4, tempDir);
      expect(turns).toHaveLength(7);
      expect(turns[0].turnIndex).toBe(0);
      expect(turns[2].turnIndex).toBe(2);
      expect(turns[3].turnIndex).toBe(16);
      expect(turns[6].turnIndex).toBe(19);
    });
  });

  it('finalizeTracesStreaming overrides a prior "missing" status when traces arrive late', async () => {
    // Simulates: proxy initially reported zero traces (executor marked
    // missing), then a later writer found and persisted real ones.
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });

    markTraceCaptureMissing(run.run_id, tempDir);
    expect(loadRunManifest(run.run_id, tempDir)!.usage.accounting_status).toBe('missing');

    const traces: AITrace[] = [
      {
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        endpoint: '/v1/messages',
        timestamp: '2024-01-15T12:00:00Z',
        latencyMs: 1500,
        request: {},
        response: { usage: { inputTokens: 10, outputTokens: 5 } },
        estimatedCostUsd: 0.0001,
      },
    ];
    await persistTraces(run.run_id, traces, tempDir);

    const manifest = loadRunManifest(run.run_id, tempDir)!;
    expect(manifest.usage.accounting_status).toBe('captured');
    expect(manifest.usage.total_ai_calls).toBe(1);
  });
});

// Regression coverage for COST_NOT_CAPTURED_ON_FAILED_RUNS. The executor now
// calls finalizeRunTraces from its `finally`, so cost is folded in on EVERY
// termination path — not just clean success. These tests stand in for the
// executor's finally: they create a run, flip it to a non-success terminal
// status, drop whatever the proxy captured before the failure, and assert the
// cost survives in both the manifest and the SQLite index.
describe('finalizeRunTraces (cost capture on abnormal termination)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Two agent calls captured before the failure kicked in — summing to the
  // $0.77 that the password-recovery run captured "by accident" in the v1
  // sweep. Here it's the rule, not the exception.
  const partialCapture: AITrace[] = [
    {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      endpoint: '/v1/messages',
      timestamp: '2026-05-28T00:00:00Z',
      latencyMs: 1500,
      request: {},
      response: { usage: { inputTokens: 1000, outputTokens: 500 } },
      estimatedCostUsd: 0.42,
      source: 'agent',
    },
    {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      endpoint: '/v1/messages',
      timestamp: '2026-05-28T00:05:00Z',
      latencyMs: 1500,
      request: {},
      response: { usage: { inputTokens: 800, outputTokens: 400 } },
      estimatedCostUsd: 0.35,
      source: 'agent',
    },
  ];

  it('captures cost in manifest AND index after a hard exec timeout', async () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });

    // The agent burned tokens, then hit the --timeout ceiling: status flips to
    // failed and the proxy's partial capture is on disk.
    writeTracesJsonl(getRunDir(run.run_id, tempDir), partialCapture);
    updateRunStatus(run.run_id, 'failed', 1, tempDir);

    await finalizeRunTraces({ runId: run.run_id, baseDir: tempDir, skipTraces: false });

    const manifest = loadRunManifest(run.run_id, tempDir)!;
    expect(manifest.status).toBe('failed');
    expect(manifest.usage.accounting_status).toBe('captured');
    expect(manifest.usage.total_ai_calls).toBe(2);
    expect(manifest.usage.estimated_cost_usd).toBeCloseTo(0.77, 5);

    // The index is what `bn runs list` / sweep cost rollups read — it must not
    // report the timed-out run as free.
    const db = openRunIndex(tempDir);
    try {
      const summary = getRunSummary(db, run.run_id);
      expect(summary).not.toBeNull();
      expect(summary!.estimatedCostUsd).toBeCloseTo(0.77, 5);
    } finally {
      db.close();
    }
  });

  it('captures cost in the manifest after a mid-flight cancel', async () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });

    // `bn runs cancel` stopped the containers and flipped status to canceled;
    // the foreground executor reaches its finally and finalizes the capture.
    writeTracesJsonl(getRunDir(run.run_id, tempDir), partialCapture);
    updateRunStatus(run.run_id, 'canceled', 130, tempDir);

    await finalizeRunTraces({ runId: run.run_id, baseDir: tempDir, skipTraces: false });

    const manifest = loadRunManifest(run.run_id, tempDir)!;
    expect(manifest.status).toBe('canceled');
    expect(manifest.usage.estimated_cost_usd).toBeCloseTo(0.77, 5);
  });

  it('skips the torn final trace line an abrupt proxy kill leaves behind', async () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });

    // A force-removed proxy can leave a half-written final line. The complete
    // calls before it must still be counted; the torn line is dropped.
    const tracesDir = path.join(getRunDir(run.run_id, tempDir), 'traces');
    fs.mkdirSync(tracesDir, { recursive: true });
    const goodLines = partialCapture.map((t) => JSON.stringify(t)).join('\n');
    const tornLine = '{"provider":"anthropic","model":"claude-opus-4-7","timestamp":"2026-05-28T00:09';
    fs.writeFileSync(path.join(tracesDir, 'agent.jsonl'), goodLines + '\n' + tornLine);

    await finalizeRunTraces({ runId: run.run_id, baseDir: tempDir, skipTraces: false });

    const manifest = loadRunManifest(run.run_id, tempDir)!;
    expect(manifest.usage.accounting_status).toBe('captured');
    expect(manifest.usage.total_ai_calls).toBe(2);
    expect(manifest.usage.estimated_cost_usd).toBeCloseTo(0.77, 5);
  });

  it('projects per-source and run-wide cache tokens onto the manifest', async () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });

    // Cache reads routinely dwarf fresh input on agent loops; the manifest is
    // the durable surface `bn runs cost` reads, so the split must land there.
    const withCache: AITrace[] = [
      {
        provider: 'anthropic', model: 'claude-opus-4-7', endpoint: '/v1/messages',
        timestamp: '2026-05-28T00:00:00Z', latencyMs: 1500, request: {},
        response: { usage: { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 1_143_571, cacheCreationInputTokens: 3000 } },
        estimatedCostUsd: 0.42, source: 'agent',
      },
      {
        provider: 'anthropic', model: 'claude-haiku-4-5', endpoint: '/v1/messages',
        timestamp: '2026-05-28T00:01:00Z', latencyMs: 800, request: {},
        response: { usage: { inputTokens: 200, outputTokens: 50, cacheReadInputTokens: 4000, cacheCreationInputTokens: 0 } },
        estimatedCostUsd: 0.01, source: 'orchestrator',
      },
    ];
    writeTracesJsonl(getRunDir(run.run_id, tempDir), withCache);

    await finalizeRunTraces({ runId: run.run_id, baseDir: tempDir, skipTraces: false });

    const manifest = loadRunManifest(run.run_id, tempDir)!;
    expect(manifest.usage.total_cache_read_input_tokens).toBe(1_147_571);
    expect(manifest.usage.total_cache_creation_input_tokens).toBe(3000);
    expect(manifest.usage.by_source?.agent.cache_read_input_tokens).toBe(1_143_571);
    expect(manifest.usage.by_source?.agent.cache_creation_input_tokens).toBe(3000);
    expect(manifest.usage.by_source?.orchestrator?.cache_read_input_tokens).toBe(4000);
    // Fresh input stays disjoint from cache.
    expect(manifest.usage.total_input_tokens).toBe(1200);
  });

  it('projects the unpriced-model fallback signal onto the manifest usage', async () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });

    const traces: AITrace[] = [
      {
        provider: 'anthropic', model: 'claude-sonnet-4-6', endpoint: '/v1/messages',
        timestamp: '2026-05-28T00:00:00Z', latencyMs: 900, request: {},
        response: { usage: { inputTokens: 1000, outputTokens: 200 } },
        estimatedCostUsd: 0.05, source: 'agent', // priced — no flag
      },
      {
        provider: 'google', model: 'gemini-pruned-1.0', endpoint: '/v1/generateContent',
        timestamp: '2026-05-28T00:01:00Z', latencyMs: 700, request: {},
        response: { usage: { inputTokens: 500, outputTokens: 100 } },
        estimatedCostUsd: 0.02, source: 'agent', pricingFallback: true,
      },
    ];
    writeTracesJsonl(getRunDir(run.run_id, tempDir), traces);

    await finalizeRunTraces({ runId: run.run_id, baseDir: tempDir, skipTraces: false });

    const manifest = loadRunManifest(run.run_id, tempDir)!;
    expect(manifest.usage.pricing_fallback_calls).toBe(1);
    expect(manifest.usage.unpriced_models).toEqual(['gemini-pruned-1.0']);
  });

  it('omits the fallback signal from the manifest when every model was priced', async () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });

    writeTracesJsonl(getRunDir(run.run_id, tempDir), [
      {
        provider: 'anthropic', model: 'claude-sonnet-4-6', endpoint: '/v1/messages',
        timestamp: '2026-05-28T00:00:00Z', latencyMs: 900, request: {},
        response: { usage: { inputTokens: 1000, outputTokens: 200 } },
        estimatedCostUsd: 0.05, source: 'agent',
      },
    ]);

    await finalizeRunTraces({ runId: run.run_id, baseDir: tempDir, skipTraces: false });

    const manifest = loadRunManifest(run.run_id, tempDir)!;
    expect(manifest.usage.pricing_fallback_calls).toBeUndefined();
    expect(manifest.usage.unpriced_models).toBeUndefined();
  });

  it('marks accounting "missing" when tracing was on but nothing was captured', async () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });

    // Pre-API-call failure (cmd-not-found, container setup error): the proxy
    // produced no traces. $0 here is honest, flagged as 'missing'.
    await finalizeRunTraces({ runId: run.run_id, baseDir: tempDir, skipTraces: false });

    const manifest = loadRunManifest(run.run_id, tempDir)!;
    expect(manifest.usage.accounting_status).toBe('missing');
    expect(manifest.usage.estimated_cost_usd).toBe(0);
  });

  it('marks accounting "skipped" without computing cost when --skip-traces is set', async () => {
    const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: tempDir });

    // Even with a trace file present, --skip-traces means we never read it.
    writeTracesJsonl(getRunDir(run.run_id, tempDir), partialCapture);

    await finalizeRunTraces({ runId: run.run_id, baseDir: tempDir, skipTraces: true });

    const manifest = loadRunManifest(run.run_id, tempDir)!;
    expect(manifest.usage.accounting_status).toBe('skipped');
    expect(manifest.usage.estimated_cost_usd).toBe(0);
  });
});
