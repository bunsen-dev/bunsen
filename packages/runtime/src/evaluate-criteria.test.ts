import { describe, it, expect } from 'bun:test';
import {
  evaluateCriteria,
  allLLMCriteriaErrored,
  type CriteriaScorers,
  type EvaluateCriteriaResult,
} from './evaluate-criteria.js';
import {
  calculateWeightedScore,
  DEFAULT_SCORER_MODEL,
  type ScorerPaths,
} from './evaluation-coordinator.js';
import type { RunEventInput } from './run-events.js';
import type {
  AggregateCriterion,
  BrowserAgentCriterion,
  Criterion,
  CriterionResult,
  JudgeCriterion,
  JudgeEvidence,
  ScriptCriterion,
  AgentCriterion,
} from '@bunsen-dev/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PATHS: ScorerPaths = {
  contextDir: '/bunsen/run',
  workspacePath: '/workspace',
  workspaceSourcePath: '/workspace-source',
};

const script = (over: Partial<ScriptCriterion> = {}): ScriptCriterion => ({
  id: 'tests',
  title: 'Tests pass',
  type: 'script',
  run: 'pytest -q',
  ...over,
});

const judge = (over: Partial<JudgeCriterion> = {}): JudgeCriterion => ({
  id: 'quality',
  title: 'Code quality',
  type: 'judge',
  instructions: 'Is the code clean?',
  ...over,
});

const agent = (over: Partial<AgentCriterion> = {}): AgentCriterion => ({
  id: 'cheat-check',
  title: 'No cheating',
  type: 'agent',
  instructions: 'Did the agent hard-code the answer?',
  ...over,
});

const browserAgent = (over: Partial<BrowserAgentCriterion> = {}): BrowserAgentCriterion => ({
  id: 'ui',
  title: 'UI renders',
  type: 'browser-agent',
  instructions: 'Does the page render?',
  ...over,
});

const aggregate = (over: Partial<AggregateCriterion> = {}): AggregateCriterion => ({
  id: 'overall',
  title: 'Overall',
  type: 'aggregate',
  needs: 'all',
  aggregate: { function: 'weighted_average' },
  ...over,
});

interface Harness extends EvaluateCriteriaResult {
  logs: string[];
  progress: string[];
  events: RunEventInput[];
  llmCalls: { id: string; model: string }[];
  scriptCalls: string[];
}

async function run(
  criteria: Criterion[],
  over: Partial<CriteriaScorers> = {},
  opts: { failedEvidence?: JudgeEvidence[] } = {},
): Promise<Harness> {
  const logs: string[] = [];
  const progress: string[] = [];
  const events: RunEventInput[] = [];
  const llmCalls: { id: string; model: string }[] = [];
  const scriptCalls: string[] = [];

  const scorers: CriteriaScorers = {
    script: async (criterion) => {
      scriptCalls.push(criterion.id);
      return { score: 1, summary: 'Passed' };
    },
    llm: async (criterion, config) => {
      llmCalls.push({ id: criterion.id, model: config.model });
      return { ok: true, output: { score: 1, summary: 'Met.' } };
    },
    ...over,
  };

  let tick = 0;
  const result = await evaluateCriteria({
    criteria,
    failedEvidence: new Set(opts.failedEvidence ?? []),
    paths: PATHS,
    scorers,
    log: (m) => logs.push(m),
    progress: (m) => progress.push(m),
    emit: (e) => events.push(e),
    now: () => (tick += 1000),
    screenshotKey: (filename) => `artifacts/screenshots/${filename}`,
    logPathFor: (criterion) =>
      criterion.type === 'aggregate' ? undefined : `evaluation/criteria/${criterion.id}.log`,
  });

  return { ...result, logs, progress, events, llmCalls, scriptCalls };
}

const byId = (results: CriterionResult[], id: string): CriterionResult =>
  results.find((r) => r.id === id)!;

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('evaluateCriteria — happy path', () => {
  it('scores script, judge, and aggregate criteria in dependency order', async () => {
    const h = await run([
      script(),
      judge({ needs: ['tests'] }),
      aggregate({ needs: ['tests', 'quality'] }),
    ]);

    expect(h.results.map((r) => r.id)).toEqual(['tests', 'quality', 'overall']);
    expect(h.results.map((r) => r.status)).toEqual(['completed', 'completed', 'completed']);
    expect(h.gateFailure).toBeNull();
    expect(h.scriptCalls).toEqual(['tests']);
    expect(h.llmCalls).toEqual([{ id: 'quality', model: DEFAULT_SCORER_MODEL }]);
  });

  it('records the resolved model on LLM criteria only', async () => {
    const h = await run([
      script(),
      judge({ scorer: { model: 'openai/gpt-5.5' } }),
      aggregate({ needs: ['tests', 'quality'] }),
    ]);

    expect(byId(h.results, 'quality').model).toBe('openai/gpt-5.5');
    expect(byId(h.results, 'tests').model).toBeUndefined();
    expect(byId(h.results, 'overall').model).toBeUndefined();
  });

  it('sets logPath for script and LLM criteria, not aggregates', async () => {
    const h = await run([script(), judge(), aggregate({ needs: ['tests', 'quality'] })]);
    expect(byId(h.results, 'tests').logPath).toBe('evaluation/criteria/tests.log');
    expect(byId(h.results, 'quality').logPath).toBe('evaluation/criteria/quality.log');
    expect(byId(h.results, 'overall').logPath).toBeUndefined();
  });

  it('emits started/completed for every criterion, in order', async () => {
    const h = await run([script(), judge()]);
    expect(h.events).toEqual([
      { event: 'criterion.started', data: { id: 'tests' } },
      {
        event: 'criterion.completed',
        data: { id: 'tests', score: 1, durationMs: 1000, status: 'completed' },
      },
      { event: 'criterion.started', data: { id: 'quality' } },
      {
        event: 'criterion.completed',
        data: { id: 'quality', score: 1, durationMs: 1000, status: 'completed' },
      },
    ]);
  });

  it('publishes each result to dependents and passes them to the scorer config', async () => {
    const seen: Record<string, unknown> = {};
    const h = await run([script(), judge({ needs: ['tests'] })], {
      llm: async (criterion, config) => {
        seen[criterion.id] = config.dependencyScores;
        return { ok: true, output: { score: 1, summary: 'Met.' } };
      },
    });
    expect(seen.quality).toEqual({ tests: { score: 1, summary: 'Passed' } });
    expect(h.dependencyScores).toEqual({
      tests: { score: 1, summary: 'Passed' },
      quality: { score: 1, summary: 'Met.' },
    });
  });

  it('maps screenshot filenames to artifact keys and forwards script artifacts', async () => {
    const h = await run([browserAgent(), script()], {
      llm: async () => ({
        ok: true,
        output: { score: 1, summary: 'Renders.', screenshots: ['home.png'] },
      }),
      script: async () => ({
        score: 1,
        summary: 'Passed',
        artifacts: [{ path: 'evaluation/criteria/tests/artifacts/junit.xml' }],
      }),
    });
    expect(byId(h.results, 'ui').screenshots).toEqual(['artifacts/screenshots/home.png']);
    expect(byId(h.results, 'tests').artifacts).toEqual([
      { path: 'evaluation/criteria/tests/artifacts/junit.xml' },
    ]);
  });

  it('copies allowedScores onto the result', async () => {
    const h = await run([judge({ scores: { 0: 'fail', 1: 'pass' } })]);
    expect(byId(h.results, 'quality').allowedScores).toEqual({ 0: 'fail', 1: 'pass' });
  });
});

// ---------------------------------------------------------------------------
// Failure policy (DESIGN.md D6)
// ---------------------------------------------------------------------------

describe('evaluateCriteria — errored criteria', () => {
  it('records one erroring LLM criterion and still scores its siblings', async () => {
    const h = await run([judge({ id: 'a', title: 'A' }), judge({ id: 'b', title: 'B' }), judge({ id: 'c', title: 'C' })], {
      llm: async (criterion) =>
        criterion.id === 'b'
          ? { ok: false, timedOut: true, error: 'Scorer timed out after 600s' }
          : { ok: true, output: { score: 1, summary: 'Met.' } },
    });

    const b = byId(h.results, 'b');
    expect(b.status).toBe('error');
    expect(b.score).toBeNull();
    expect(b.error).toBe('Scorer timed out after 600s');
    expect(b.summary).toBe('Scorer error: Scorer timed out after 600s');
    expect(b.logPath).toBe('evaluation/criteria/b.log');
    expect(b.model).toBe(DEFAULT_SCORER_MODEL);

    expect(byId(h.results, 'a').score).toBe(1);
    expect(byId(h.results, 'c').score).toBe(1);
    // A null score is excluded from the weighted average — not counted as 0.
    expect(calculateWeightedScore(h.results)).toBe(1);
    expect(h.gateFailure).toBeNull();
  });

  it('emits criterion.completed with status error', async () => {
    const h = await run([judge()], {
      llm: async () => ({ ok: false, timedOut: false, error: 'API failed' }),
    });
    expect(h.events[1]).toEqual({
      event: 'criterion.completed',
      data: { id: 'quality', score: null, durationMs: 1000, status: 'error' },
    });
  });

  it('errors (does not throw) when the script scorer itself fails', async () => {
    const h = await run([script(), judge()], {
      script: async () => {
        throw new Error('scorer container is gone');
      },
    });
    expect(byId(h.results, 'tests')).toMatchObject({
      status: 'error',
      score: null,
      error: 'scorer container is gone',
      summary: 'Scorer error: scorer container is gone',
    });
    // The rest of the rubric still runs.
    expect(byId(h.results, 'quality').status).toBe('completed');
  });

  it('errors (does not throw) when the LLM scorer closure throws', async () => {
    const h = await run([judge()], {
      llm: async () => {
        throw new Error('docker exec failed');
      },
    });
    expect(byId(h.results, 'quality')).toMatchObject({
      status: 'error',
      score: null,
      error: 'docker exec failed',
      model: DEFAULT_SCORER_MODEL,
    });
  });

  it('errors (does not throw) when an aggregate has nothing to aggregate', async () => {
    // Dependencies: one errored (score null) and one weight-0 (excluded by
    // runAggregate) — the aggregate has no usable input and throws inside.
    const h = await run(
      [
        judge({ id: 'broken', title: 'Broken' }),
        script({ id: 'zero', title: 'Zero weight', weight: 0 }),
        aggregate({ needs: ['broken', 'zero'] }),
      ],
      {
        llm: async () => ({ ok: false, timedOut: false, error: 'API failed' }),
      },
    );

    const overall = byId(h.results, 'overall');
    expect(overall.status).toBe('error');
    expect(overall.score).toBeNull();
    expect(overall.error).toContain('Nothing to aggregate');
    expect(overall.summary).toStartWith('Scorer error:');
  });

  it('records an aggregate whose dependencies ALL errored as an error, not a skip', async () => {
    const h = await run(
      [
        judge({ id: 'a', title: 'A' }),
        agent({ id: 'b', title: 'B' }),
        aggregate({ needs: ['a', 'b'] }),
      ],
      { llm: async () => ({ ok: false, timedOut: false, error: 'API failed' }) },
    );
    const overall = byId(h.results, 'overall');
    expect(overall.status).toBe('error');
    expect(overall.score).toBeNull();
    expect(overall.error).toBe('Nothing to aggregate: every dependency errored');
    expect(overall.summary).not.toContain('skipped');
  });

  it('names the errored dependencies when the rest were skipped', async () => {
    // `a` errors; `b` is a judge whose evidence a failed capture destroyed (skipped).
    const h = await run(
      [
        agent({ id: 'a', title: 'A' }),
        judge({ id: 'b', title: 'B', evidence: ['diff'] }),
        aggregate({ needs: ['a', 'b'] }),
      ],
      { llm: async () => ({ ok: false, timedOut: false, error: 'API failed' }) },
      { failedEvidence: ['diff'] },
    );
    const overall = byId(h.results, 'overall');
    expect(overall.status).toBe('error');
    expect(overall.error).toBe('Nothing to aggregate: dependencies errored (a) and the rest were skipped');
  });

  it('publishes an errored criterion to dependents as a null score', async () => {
    const h = await run([judge({ id: 'broken', title: 'Broken' })], {
      llm: async () => ({ ok: false, timedOut: false, error: 'API failed' }),
    });
    expect(h.dependencyScores.broken).toEqual({
      score: null,
      summary: 'Scorer error: API failed',
    });
  });
});

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

describe('evaluateCriteria — gates', () => {
  it('trips on a completed criterion that scores below the threshold', async () => {
    const h = await run([script({ gate: { ifBelow: 1 } }), judge()], {
      script: async () => ({ score: 0, summary: 'Tests failed' }),
    });

    expect(h.gateFailure).toEqual({ criterion: 'tests', score: 0, threshold: '>= 1' });
    const quality = byId(h.results, 'quality');
    expect(quality.status).toBe('skipped');
    expect(quality.summary).toBe(
      'Skipped: gate criterion "tests" failed (scored 0, required >= 1)',
    );
    expect(h.llmCalls).toEqual([]);
    expect(h.events[3]).toMatchObject({ data: { status: 'skipped' } });
  });

  it('does NOT trip on an errored criterion — downstream criteria still run', async () => {
    const h = await run([judge({ id: 'gatekeeper', title: 'Gate', gate: { ifBelow: 0.5 } }), script()], {
      llm: async () => ({ ok: false, timedOut: true, error: 'Scorer timed out after 600s' }),
    });

    expect(h.gateFailure).toBeNull();
    expect(byId(h.results, 'gatekeeper').status).toBe('error');
    expect(byId(h.results, 'tests').status).toBe('completed');
    expect(h.scriptCalls).toEqual(['tests']);
    expect(h.logs).toContain('Gate on "gatekeeper" not evaluated: scorer error');
  });

  it('keeps the first gate failure when a later criterion would also fail', async () => {
    const h = await run(
      [
        script({ id: 'first', title: 'First', gate: { ifBelow: 1 } }),
        script({ id: 'second', title: 'Second', gate: { ifBelow: 1 } }),
      ],
      { script: async () => ({ score: 0, summary: 'nope' }) },
    );
    expect(h.gateFailure?.criterion).toBe('first');
    expect(byId(h.results, 'second').status).toBe('skipped');
  });
});

// ---------------------------------------------------------------------------
// Capture-degraded skips
// ---------------------------------------------------------------------------

describe('evaluateCriteria — capture-degraded skips', () => {
  it('skips a judge whose evidence a failed capture step destroyed', async () => {
    const h = await run([judge({ evidence: ['diff'] }), script()], {}, { failedEvidence: ['diff'] });

    const quality = byId(h.results, 'quality');
    expect(quality.status).toBe('skipped');
    expect(quality.summary).toContain('required evidence unavailable (diff)');
    expect(h.llmCalls).toEqual([]);
    // Other criteria are unaffected — the workspace is still real.
    expect(byId(h.results, 'tests').status).toBe('completed');
  });

  it('does not skip an agent scorer on degraded evidence (it fetches its own)', async () => {
    const h = await run([agent()], {}, { failedEvidence: ['diff'] });
    expect(byId(h.results, 'cheat-check').status).toBe('completed');
  });

  it('skips an aggregate whose dependencies were all skipped', async () => {
    const h = await run(
      [judge({ evidence: ['diff'] }), aggregate({ needs: ['quality'] })],
      {},
      { failedEvidence: ['diff'] },
    );
    const overall = byId(h.results, 'overall');
    expect(overall.status).toBe('skipped');
    expect(overall.summary).toBe('Skipped: every dependency was skipped, nothing to aggregate');
  });
});

// ---------------------------------------------------------------------------
// Rubric validation
// ---------------------------------------------------------------------------

describe('evaluateCriteria — rubric validation', () => {
  it('throws on a duplicate criterion id (a config bug, not a scorer failure)', async () => {
    await expect(run([script(), script()])).rejects.toThrow(/duplicate criterion id "tests"/);
  });

  it('throws on an unknown dependency', async () => {
    await expect(run([judge({ needs: ['nope'] })])).rejects.toThrow(
      /depends on unknown criterion "nope"/,
    );
  });
});

// ---------------------------------------------------------------------------
// allLLMCriteriaErrored — the exit-code-5 condition
// ---------------------------------------------------------------------------

describe('allLLMCriteriaErrored', () => {
  const result = (over: Partial<CriterionResult>): CriterionResult => ({
    id: 'x',
    weight: 1,
    score: 1,
    summary: 's',
    status: 'completed',
    scorerType: 'judge',
    ...over,
  });

  it('is false with no criteria at all', () => {
    expect(allLLMCriteriaErrored([])).toBe(false);
  });

  it('is false when the rubric has no LLM-backed criteria', () => {
    expect(
      allLLMCriteriaErrored([
        result({ id: 'a', scorerType: 'script', status: 'error', score: null }),
        result({ id: 'b', scorerType: 'aggregate', status: 'error', score: null }),
      ]),
    ).toBe(false);
  });

  it('is true when every LLM criterion errored', () => {
    expect(
      allLLMCriteriaErrored([
        result({ id: 'a', scorerType: 'judge', status: 'error', score: null }),
        result({ id: 'b', scorerType: 'agent', status: 'error', score: null }),
        result({ id: 'c', scorerType: 'browser-agent', status: 'error', score: null }),
        result({ id: 'd', scorerType: 'script', status: 'completed' }),
      ]),
    ).toBe(true);
  });

  it('is false when one LLM criterion scored', () => {
    expect(
      allLLMCriteriaErrored([
        result({ id: 'a', scorerType: 'judge', status: 'error', score: null }),
        result({ id: 'b', scorerType: 'judge', status: 'completed' }),
      ]),
    ).toBe(false);
  });

  it('is false when a surviving LLM criterion was merely skipped', () => {
    // A gate skip is not a platform failure; the run is gradeable as recorded.
    expect(
      allLLMCriteriaErrored([
        result({ id: 'a', scorerType: 'judge', status: 'error', score: null }),
        result({ id: 'b', scorerType: 'judge', status: 'skipped', score: null }),
      ]),
    ).toBe(false);
  });

  it('is true for a single errored LLM criterion', () => {
    expect(
      allLLMCriteriaErrored([result({ scorerType: 'agent', status: 'error', score: null })]),
    ).toBe(true);
  });
});
