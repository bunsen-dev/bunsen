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
  // Pulled in by `dry-run.ts` and `errors.ts`, which `run.ts` imports. They are
  // not exercised here, but the mocked barrel has to carry every name the
  // module graph binds or the import fails.
  loadProject: vi.fn(),
  mergeRunEnvironment: vi.fn(),
  resolveRunPlatform: vi.fn(),
  generateRunId: vi.fn(),
  isDockerAvailable: vi.fn(),
  getDockerInfo: vi.fn(),
  archToRunPlatform: vi.fn(),
  AgentConfigError: class AgentConfigError extends Error {},
  ProjectConfigError: class ProjectConfigError extends Error {},
  ExperimentConfigError: class ExperimentConfigError extends Error {},
  RunCanceledError: class RunCanceledError extends Error {},
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

// Imported dynamically, AFTER the mocks above: bun hoists static imports, so a
// plain `import … from './run.js'` would pull in the real `@bunsen-dev/runtime`
// barrel (Docker, dockerode, the executor) before the mock is registered.
const { runCommand, evaluationFailedOutright } = await import('./run.js');
import type { RunManifestV1, RunManifestCriterion } from '@bunsen-dev/types';

/** Minimal manifest shaped just enough for the exit-code-5 predicate. */
function manifest(
  status: RunManifestV1['status'],
  criteria?: RunManifestCriterion[],
): RunManifestV1 {
  return {
    status,
    ...(criteria ? { evaluation: { weighted_score: 0, criteria } } : {}),
  } as RunManifestV1;
}

const criterion = (
  id: string,
  scorer_type: RunManifestCriterion['scorer_type'],
  status: RunManifestCriterion['status'],
  score: number | null = null,
): RunManifestCriterion => ({ id, weight: 1, score, summary: '', status, scorer_type });

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

  it('exits 5 when every LLM-backed criterion errored', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    coreMocks.executeRun.mockResolvedValue({
      run_id: 'abc123',
      status: 'failed',
      duration_ms: 1000,
      evaluation: {
        weighted_score: 0,
        criteria: [criterion('rubric', 'judge', 'error')],
      },
    });
    coreMocks.loadEvaluationResult.mockReturnValue(undefined);

    await runCommand('fix-the-bug', 'claude-code', {}, { args: [] });

    const consoleOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(consoleOutput).toContain('Evaluation failed: every LLM-backed criterion errored');
    expect(exitSpy).toHaveBeenCalledWith(5);

    logSpy.mockRestore();
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

describe('evaluationFailedOutright', () => {
  it('is true when the run failed and every LLM-backed criterion errored', () => {
    expect(
      evaluationFailedOutright(
        manifest('failed', [
          criterion('rubric', 'judge', 'error'),
          criterion('cheat-check', 'agent', 'error'),
          // Script criteria don't count either way.
          criterion('tests-pass', 'script', 'completed', 1),
        ]),
      ),
    ).toBe(true);
  });

  it('is false when at least one LLM-backed criterion produced a verdict', () => {
    expect(
      evaluationFailedOutright(
        manifest('failed', [
          criterion('rubric', 'judge', 'error'),
          criterion('design', 'browser-agent', 'completed', 0.5),
        ]),
      ),
    ).toBe(false);
  });

  it('is false when a gate skipped the surviving LLM criterion (skipped is not errored)', () => {
    expect(
      evaluationFailedOutright(
        manifest('failed', [
          criterion('rubric', 'judge', 'error'),
          criterion('deep-review', 'judge', 'skipped'),
        ]),
      ),
    ).toBe(false);
  });

  it('is false when the rubric has no LLM-backed criteria at all', () => {
    expect(
      evaluationFailedOutright(
        manifest('failed', [
          criterion('tests-pass', 'script', 'error'),
          criterion('total', 'aggregate', 'completed', 0),
        ]),
      ),
    ).toBe(false);
  });

  it('is false when the run did not fail, even if every LLM criterion errored', () => {
    expect(
      evaluationFailedOutright(manifest('succeeded', [criterion('rubric', 'judge', 'error')])),
    ).toBe(false);
  });

  it('is false when there is no evaluation block', () => {
    expect(evaluationFailedOutright(manifest('failed'))).toBe(false);
  });
});
