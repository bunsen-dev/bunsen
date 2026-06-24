// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';

// bun:test's `vi.mock` patches in place (no hoisting), so plain objects work
// where vitest needed `vi.hoisted`.
const coreMocks = {
  loadExperiment: vi.fn(),
  loadAgent: vi.fn(),
  executeRun: vi.fn(),
  loadEvaluationResult: vi.fn(),
  parseAgentVariantSyntax: vi.fn(),
  resolveModelSelection: vi.fn(),
  loadEnvFromSources: vi.fn(),
  resolveExperiment: vi.fn(),
  resolveAgent: vi.fn(),
  describeSearchedLocations: vi.fn(),
  AgentConfigError: class AgentConfigError extends Error {},
};

const oraMocks = {
  start: vi.fn(),
  stop: vi.fn(),
  fail: vi.fn(),
  clear: vi.fn(),
  render: vi.fn(),
};

vi.mock('@bunsen-dev/runtime', () => coreMocks);

vi.mock('ora', () => ({
  default: () => ({
    start: oraMocks.start,
    stop: oraMocks.stop,
    fail: oraMocks.fail,
    clear: oraMocks.clear,
    render: oraMocks.render,
    text: '',
  }),
}));

import { runCommand } from './run.js';

describe('runCommand', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.clearAllMocks();
    process.argv = ['node', 'bn', 'run'];

    coreMocks.resolveExperiment.mockReturnValue({ path: '/tmp/exp' });
    coreMocks.resolveAgent.mockReturnValue({ path: '/tmp/agent' });
    coreMocks.parseAgentVariantSyntax.mockReturnValue(['claude-code', undefined]);
    coreMocks.loadExperiment.mockReturnValue({ name: 'fix-the-bug' });
    // loadAgent now returns the variant-merged shape directly.
    coreMocks.loadAgent.mockReturnValue({
      name: 'claude-code',
      install: { source: { type: 'local' } },
      entrypoint: { command: 'claude', args: [] },
      interaction: { mode: 'supervised' },
    });
    coreMocks.loadEnvFromSources.mockReturnValue({});
    coreMocks.executeRun.mockResolvedValue({
      run_id: 'abc123',
      status: 'completed',
      duration_ms: 1000,
      evaluation: undefined,
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it('passes rebuildAgent and platform through to executeRun options', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runCommand(
      'fix-the-bug',
      'claude-code',
      {
        skipEval: true,
        rebuildAgent: true,
        platform: 'linux/amd64',
        timeout: '12345',
      },
      { args: [] }
    );

    expect(coreMocks.executeRun).toHaveBeenCalledTimes(1);
    expect(coreMocks.executeRun.mock.calls[0][0]).toMatchObject({
      experimentPath: '/tmp/exp',
      agentPath: '/tmp/agent',
      rebuildAgent: true,
      platform: 'linux/amd64',
      timeout: 12345,
    });
    expect(exitSpy).toHaveBeenCalledWith(0);

    logSpy.mockRestore();
  });

  it('rejects --remote with a structured `not_implemented` error before touching Docker', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runCommand(
      'fix-the-bug',
      'claude-code',
      { remote: true },
      { args: [] },
    );

    expect(coreMocks.executeRun).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrOutput).toMatch(/not_implemented/);
    expect(stderrOutput).toMatch(/remote-execution backend/);

    stderrSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('emits the --remote rejection as a JSON payload under --format json', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);

    await runCommand(
      'fix-the-bug',
      'claude-code',
      { remote: true, format: 'json' },
      { args: [] },
    );

    expect(coreMocks.executeRun).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    const payload = JSON.parse(out);
    expect(payload.error.code).toBe('not_implemented');
    expect(payload.error.details.feature).toBe('remote-execution');

    stdoutSpy.mockRestore();
  });

  it('surfaces progress as plain logs after streaming output begins', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);

    coreMocks.executeRun.mockImplementation(async (_options, callbacks) => {
      callbacks.onProgress?.('Preparing');
      callbacks.onOutputChunk?.('agent output\n', 'stdout');
      callbacks.onProgress?.('Running evaluation...');
      callbacks.onProgress?.('Scoring: typescript-correctness');
      callbacks.onTransientLog?.('transient after output');
      callbacks.onClearTransientLogs?.();

      return {
        id: 'abc123',
        status: 'completed',
        summary: {
          durationMs: 1000,
          weightedScore: null,
        },
      };
    });

    await runCommand(
      'fix-the-bug',
      'claude-code',
      {
        skipEval: true,
      },
      { args: [] }
    );

    // Spinner was started exactly once, before streaming began, and never
    // restarted after — we don't want a spinner competing with logs.
    expect(oraMocks.start).toHaveBeenCalledTimes(1);
    expect(oraMocks.start).toHaveBeenCalledWith('Preparing');
    expect(stdoutWriteSpy).toHaveBeenCalledWith('agent output\n');
    expect(stderrWriteSpy).not.toHaveBeenCalled();

    // Post-streaming progress messages are surfaced as plain console output
    // so the user can see eval phase activity.
    const consoleOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(consoleOutput).toContain('Running evaluation...');
    expect(consoleOutput).toContain('Scoring: typescript-correctness');

    expect(exitSpy).toHaveBeenCalledWith(0);

    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    logSpy.mockRestore();
  });
});
