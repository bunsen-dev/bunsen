/**
 * Tests for the Evaluation Coordinator (v1 criteria input shape).
 */

import { describe, it, expect } from 'bun:test';
import type {
  Criterion,
  CriterionResult,
  DependencyScore,
  ReportConfig,
} from '@bunsen-dev/types';
import {
  blockedJudgeEvidence,
  resolveDependencies,
  topologicalSort,
  isLLMCriterion,
  criterionScorerModel,
  reportScorerModel,
  requiredScorerProviders,
  resolveCriteria,
  getExecutionOrder,
  buildScorerConfig,
  buildReportScorerConfig,
  calculateWeightedScore,
  runAggregate,
  buildEvaluationResult,
  validateRubric,
  checkGate,
  getGateThreshold,
  DEFAULT_SCORER_MODEL,
  type ResolvedCriterion,
  type ScorerPaths,
} from './evaluation-coordinator.js';

describe('resolveDependencies', () => {
  it('returns empty dependencies for criteria without needs', () => {
    const criteria: Criterion[] = [
      { id: 'a', title: 'A', type: 'judge', instructions: 'Test A' },
      { id: 'b', title: 'B', type: 'judge', instructions: 'Test B' },
    ];

    const graph = resolveDependencies(criteria);
    expect(graph.get('a')).toEqual([]);
    expect(graph.get('b')).toEqual([]);
  });

  it('resolves explicit needs arrays', () => {
    const criteria: Criterion[] = [
      { id: 'a', title: 'A', type: 'judge', instructions: 'Test A' },
      { id: 'b', title: 'B', type: 'judge', instructions: 'Test B', needs: ['a'] },
    ];

    const graph = resolveDependencies(criteria);
    expect(graph.get('a')).toEqual([]);
    expect(graph.get('b')).toEqual(['a']);
  });

  it('resolves needs: all to all earlier criteria', () => {
    const criteria: Criterion[] = [
      { id: 'a', title: 'A', type: 'judge', instructions: 'Test A' },
      { id: 'b', title: 'B', type: 'judge', instructions: 'Test B' },
      {
        id: 'summary',
        title: 'Summary',
        type: 'aggregate',
        needs: 'all',
        aggregate: { function: 'weighted_average' },
      },
    ];

    const graph = resolveDependencies(criteria);
    expect(graph.get('summary')).toEqual(['a', 'b']);
  });

  it('throws for unknown dependency', () => {
    const criteria: Criterion[] = [
      { id: 'a', title: 'A', type: 'judge', instructions: 'Test A', needs: ['missing'] },
    ];

    expect(() => resolveDependencies(criteria)).toThrow('unknown criterion "missing"');
  });

  it('throws for self-dependency', () => {
    const criteria: Criterion[] = [
      { id: 'a', title: 'A', type: 'judge', instructions: 'Test A', needs: ['a'] },
    ];

    expect(() => resolveDependencies(criteria)).toThrow('cannot depend on itself');
  });
});

describe('topologicalSort', () => {
  it('returns correct order for no dependencies', () => {
    const graph = new Map([
      ['A', []],
      ['B', []],
      ['C', []],
    ]);

    const order = topologicalSort(graph);
    expect(order).toHaveLength(3);
    expect(new Set(order)).toEqual(new Set(['A', 'B', 'C']));
  });

  it('returns correct order for linear dependencies', () => {
    const graph = new Map([
      ['A', []],
      ['B', ['A']],
      ['C', ['B']],
    ]);

    const order = topologicalSort(graph);
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'));
    expect(order.indexOf('B')).toBeLessThan(order.indexOf('C'));
  });

  it('returns correct order for diamond dependencies', () => {
    const graph = new Map([
      ['A', []],
      ['B', ['A']],
      ['C', ['A']],
      ['D', ['B', 'C']],
    ]);

    const order = topologicalSort(graph);
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'));
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('C'));
    expect(order.indexOf('B')).toBeLessThan(order.indexOf('D'));
    expect(order.indexOf('C')).toBeLessThan(order.indexOf('D'));
  });

  it('throws for circular dependency', () => {
    const graph = new Map([
      ['A', ['B']],
      ['B', ['A']],
    ]);

    expect(() => topologicalSort(graph)).toThrow('circular dependency');
  });
});

const SCRIPT: Criterion = { id: 's', title: 'Script', type: 'script', run: 'npm test' };
const AGGREGATE: Criterion = {
  id: 'agg',
  title: 'Agg',
  type: 'aggregate',
  needs: ['s'],
  aggregate: { function: 'weighted_average' },
};

describe('isLLMCriterion', () => {
  it('accepts judge, agent, and browser-agent', () => {
    const llm: Criterion[] = [
      { id: 'j', title: 'J', type: 'judge', instructions: 'x' },
      { id: 'a', title: 'A', type: 'agent', instructions: 'x' },
      { id: 'ba', title: 'BA', type: 'browser-agent', instructions: 'x' },
    ];
    for (const c of llm) expect(isLLMCriterion(c)).toBe(true);
  });

  it('rejects script and aggregate', () => {
    expect(isLLMCriterion(SCRIPT)).toBe(false);
    expect(isLLMCriterion(AGGREGATE)).toBe(false);
  });
});

describe('criterionScorerModel', () => {
  it('applies the default model when the criterion sets none', () => {
    const c: Criterion = { id: 'j', title: 'J', type: 'judge', instructions: 'x' };
    expect(criterionScorerModel(c)).toBe(DEFAULT_SCORER_MODEL);
    expect(DEFAULT_SCORER_MODEL).toBe('anthropic/claude-sonnet-4-6');
  });

  it('honors an explicit scorer.model on every LLM-backed type', () => {
    const judge: Criterion = {
      id: 'j',
      title: 'J',
      type: 'judge',
      instructions: 'x',
      scorer: { model: 'openai/gpt-5.5' },
    };
    const agent: Criterion = {
      id: 'a',
      title: 'A',
      type: 'agent',
      instructions: 'x',
      scorer: { model: 'google/gemini-2.5-pro' },
    };
    const browser: Criterion = {
      id: 'ba',
      title: 'BA',
      type: 'browser-agent',
      instructions: 'x',
      scorer: { model: 'anthropic/claude-opus-4-5' },
    };
    expect(criterionScorerModel(judge)).toBe('openai/gpt-5.5');
    expect(criterionScorerModel(agent)).toBe('google/gemini-2.5-pro');
    expect(criterionScorerModel(browser)).toBe('anthropic/claude-opus-4-5');
  });

  it('returns undefined for script and aggregate (no model runs)', () => {
    expect(criterionScorerModel(SCRIPT)).toBeUndefined();
    expect(criterionScorerModel(AGGREGATE)).toBeUndefined();
  });
});

describe('reportScorerModel', () => {
  it('defaults when report.model is absent', () => {
    expect(reportScorerModel({ instructions: 'Summarize.' })).toBe(DEFAULT_SCORER_MODEL);
  });

  it('honors report.model', () => {
    expect(reportScorerModel({ instructions: 'Summarize.', model: 'openai/gpt-5.5' })).toBe(
      'openai/gpt-5.5',
    );
  });
});

describe('requiredScorerProviders', () => {
  it('groups LLM-backed criteria by provider with id, type, weight, and model', () => {
    const providers = requiredScorerProviders({
      criteria: [
        SCRIPT,
        { id: 'j', title: 'J', type: 'judge', instructions: 'x', weight: 2 },
        {
          id: 'a',
          title: 'A',
          type: 'agent',
          instructions: 'x',
          scorer: { model: 'openai/gpt-5.5' },
        },
        {
          id: 'ba',
          title: 'BA',
          type: 'browser-agent',
          instructions: 'x',
          scorer: { model: 'openai/gpt-5.5-mini' },
          weight: 0,
        },
      ],
    });

    expect([...providers.keys()].sort()).toEqual(['anthropic', 'openai']);
    expect(providers.get('anthropic')).toEqual([
      { id: 'j', type: 'judge', weight: 2, model: DEFAULT_SCORER_MODEL },
    ]);
    expect(providers.get('openai')).toEqual([
      { id: 'a', type: 'agent', weight: 1, model: 'openai/gpt-5.5' },
      { id: 'ba', type: 'browser-agent', weight: 0, model: 'openai/gpt-5.5-mini' },
    ]);
  });

  it('includes the report step as id "report"', () => {
    const providers = requiredScorerProviders({
      criteria: [SCRIPT],
      report: { instructions: 'Summarize.', model: 'google/gemini-2.5-pro' },
    });
    expect(providers.get('google')).toEqual([
      { id: 'report', type: 'report', weight: 0, model: 'google/gemini-2.5-pro' },
    ]);
  });

  it('returns an empty map for a script/aggregate-only rubric', () => {
    const providers = requiredScorerProviders({ criteria: [SCRIPT, AGGREGATE] });
    expect(providers.size).toBe(0);
  });

  it('throws on a malformed model reference', () => {
    expect(() =>
      requiredScorerProviders({
        criteria: [
          {
            id: 'j',
            title: 'J',
            type: 'judge',
            instructions: 'x',
            scorer: { model: 'claude-sonnet-4-6' },
          },
        ],
      }),
    ).toThrow('must be "<provider>/<model>"');
  });
});

describe('calculateWeightedScore', () => {
  it('calculates correct weighted average', () => {
    const results: CriterionResult[] = [
      { id: 'a', weight: 1, score: 0.8, summary: 'Test', status: 'completed', scorerType: 'judge' },
      { id: 'b', weight: 1, score: 0.6, summary: 'Test', status: 'completed', scorerType: 'judge' },
    ];

    expect(calculateWeightedScore(results)).toBeCloseTo(0.7);
  });

  it('respects weights', () => {
    const results: CriterionResult[] = [
      { id: 'a', weight: 2, score: 0.8, summary: 'Test', status: 'completed', scorerType: 'judge' },
      { id: 'b', weight: 1, score: 0.5, summary: 'Test', status: 'completed', scorerType: 'judge' },
    ];

    expect(calculateWeightedScore(results)).toBeCloseTo(0.7);
  });

  it('excludes weight: 0 criteria', () => {
    const results: CriterionResult[] = [
      { id: 'a', weight: 1, score: 0.8, summary: 'Test', status: 'completed', scorerType: 'judge' },
      { id: 'b', weight: 0, score: 0.2, summary: 'Test', status: 'completed', scorerType: 'judge' },
    ];

    expect(calculateWeightedScore(results)).toBeCloseTo(0.8);
  });

  it('excludes null scores', () => {
    const results: CriterionResult[] = [
      { id: 'a', weight: 1, score: 0.8, summary: 'Test', status: 'completed', scorerType: 'judge' },
      { id: 'report', weight: 0, score: null, summary: 'Test', status: 'completed', scorerType: 'judge' },
    ];

    expect(calculateWeightedScore(results)).toBeCloseTo(0.8);
  });

  it('returns 0 for no valid scores', () => {
    const results: CriterionResult[] = [
      { id: 'a', weight: 0, score: 0.8, summary: 'Test', status: 'completed', scorerType: 'judge' },
    ];

    expect(calculateWeightedScore(results)).toBe(0);
  });
});

describe('runAggregate', () => {
  const criteria: Criterion[] = [
    { id: 'a', title: 'A', type: 'judge', instructions: 'A', weight: 1 },
    { id: 'b', title: 'B', type: 'judge', instructions: 'B', weight: 1 },
    { id: 'c', title: 'C', type: 'judge', instructions: 'C', weight: 2 },
  ];

  it('calculates weighted_average', () => {
    const deps: Record<string, DependencyScore> = {
      a: { score: 0.8, summary: 'Test' },
      b: { score: 0.6, summary: 'Test' },
    };

    const result = runAggregate({ function: 'weighted_average' }, deps, criteria);
    expect(result.score).toBeCloseTo(0.7);
  });

  it('calculates all (all perfect)', () => {
    const deps: Record<string, DependencyScore> = {
      a: { score: 1, summary: 'Test' },
      b: { score: 1, summary: 'Test' },
    };

    const result = runAggregate({ function: 'all' }, deps, criteria);
    expect(result.score).toBe(1);
  });

  it('calculates all (not all perfect)', () => {
    const deps: Record<string, DependencyScore> = {
      a: { score: 1, summary: 'Test' },
      b: { score: 0.9, summary: 'Test' },
    };

    const result = runAggregate({ function: 'all' }, deps, criteria);
    expect(result.score).toBe(0);
  });

  it('calculates any (one passes)', () => {
    const deps: Record<string, DependencyScore> = {
      a: { score: 0.6, summary: 'Test' },
      b: { score: 0.3, summary: 'Test' },
    };

    const result = runAggregate({ function: 'any' }, deps, criteria);
    expect(result.score).toBe(1);
  });

  it('calculates any (none passes)', () => {
    const deps: Record<string, DependencyScore> = {
      a: { score: 0.3, summary: 'Test' },
      b: { score: 0.4, summary: 'Test' },
    };

    const result = runAggregate({ function: 'any' }, deps, criteria);
    expect(result.score).toBe(0);
  });

  it('calculates min', () => {
    const deps: Record<string, DependencyScore> = {
      a: { score: 0.8, summary: 'Test' },
      b: { score: 0.6, summary: 'Test' },
    };

    const result = runAggregate({ function: 'min' }, deps, criteria);
    expect(result.score).toBeCloseTo(0.6);
  });

  it('calculates max', () => {
    const deps: Record<string, DependencyScore> = {
      a: { score: 0.8, summary: 'Test' },
      b: { score: 0.6, summary: 'Test' },
    };

    const result = runAggregate({ function: 'max' }, deps, criteria);
    expect(result.score).toBeCloseTo(0.8);
  });

  it('calculates threshold (all deps clear it)', () => {
    const deps: Record<string, DependencyScore> = {
      a: { score: 0.97, summary: 'Test' },
      b: { score: 0.95, summary: 'Test' },
    };

    const result = runAggregate({ function: 'threshold', at: 0.95 }, deps, criteria);
    expect(result.score).toBe(1);
    expect(result.summary).toContain('>= 0.95');
  });

  it('calculates threshold (one dep below)', () => {
    const deps: Record<string, DependencyScore> = {
      a: { score: 0.97, summary: 'Test' },
      b: { score: 0.94, summary: 'Test' },
    };

    const result = runAggregate({ function: 'threshold', at: 0.95 }, deps, criteria);
    expect(result.score).toBe(0);
    expect(result.summary).toContain('b (0.94)');
  });

  it('threshold comparison is >= (a score exactly at the threshold clears it)', () => {
    const deps: Record<string, DependencyScore> = {
      a: { score: 0.95, summary: 'Test' },
    };

    expect(runAggregate({ function: 'threshold', at: 0.95 }, deps, criteria).score).toBe(1);
  });

  it('threshold at 1.0 matches all-semantics on perfect scores', () => {
    const deps: Record<string, DependencyScore> = {
      a: { score: 1, summary: 'Test' },
      b: { score: 1, summary: 'Test' },
    };

    expect(runAggregate({ function: 'threshold', at: 1 }, deps, criteria).score).toBe(1);
  });

  it('threshold without at throws', () => {
    const deps: Record<string, DependencyScore> = {
      a: { score: 0.8, summary: 'Test' },
    };

    expect(() => runAggregate({ function: 'threshold' }, deps, criteria)).toThrow(
      "'threshold' aggregate requires 'at'"
    );
  });

  it('throws for unknown aggregate', () => {
    const deps: Record<string, DependencyScore> = {
      a: { score: 0.8, summary: 'Test' },
    };

    expect(() => runAggregate({ function: 'unknown' as never }, deps, criteria)).toThrow('Unknown aggregate function');
  });
});

describe('blockedJudgeEvidence', () => {
  const failedDiff = new Set<'diff' | 'logs' | 'traces'>(['diff']);

  it('blocks a judge with default evidence when diff capture failed', () => {
    const judge: Criterion = { id: 'j', title: 'J', type: 'judge', instructions: 'x' };
    expect(blockedJudgeEvidence(judge, failedDiff)).toEqual(['diff']);
  });

  it('does not block a judge whose explicit evidence avoids the failed category', () => {
    const judge: Criterion = {
      id: 'j',
      title: 'J',
      type: 'judge',
      instructions: 'x',
      evidence: ['logs'],
    };
    expect(blockedJudgeEvidence(judge, failedDiff)).toEqual([]);
  });

  it('reports only the failed subset of multi-category evidence', () => {
    const judge: Criterion = {
      id: 'j',
      title: 'J',
      type: 'judge',
      instructions: 'x',
      evidence: ['diff', 'logs', 'traces'],
    };
    expect(blockedJudgeEvidence(judge, new Set(['diff', 'traces']))).toEqual(['diff', 'traces']);
  });

  it('never blocks script, agent, browser-agent, or aggregate criteria', () => {
    const criteria: Criterion[] = [
      { id: 's', title: 'S', type: 'script', run: 'true' },
      { id: 'a', title: 'A', type: 'agent', instructions: 'x' },
      { id: 'ba', title: 'BA', type: 'browser-agent', instructions: 'x' },
      { id: 'agg', title: 'G', type: 'aggregate', needs: ['s'], aggregate: { function: 'all' } },
    ];
    for (const c of criteria) {
      expect(blockedJudgeEvidence(c, failedDiff)).toEqual([]);
    }
  });

  it('returns empty when no capture step failed', () => {
    const judge: Criterion = { id: 'j', title: 'J', type: 'judge', instructions: 'x' };
    expect(blockedJudgeEvidence(judge, new Set())).toEqual([]);
  });
});

describe('validateRubric', () => {
  it('accepts valid rubric', () => {
    const criteria: Criterion[] = [
      { id: 'a', title: 'A', type: 'judge', instructions: 'Test A' },
      { id: 'b', title: 'B', type: 'judge', instructions: 'Test B', needs: ['a'] },
    ];

    expect(() => validateRubric(criteria)).not.toThrow();
  });

  it('throws for duplicate criterion ids', () => {
    const criteria: Criterion[] = [
      { id: 'a', title: 'A', type: 'judge', instructions: 'Test A' },
      { id: 'a', title: 'A dup', type: 'judge', instructions: 'Test A duplicate' },
    ];

    expect(() => validateRubric(criteria)).toThrow('duplicate criterion id');
  });

  it('throws for aggregate with empty needs', () => {
    const criteria: Criterion[] = [
      {
        id: 'a',
        title: 'A',
        type: 'aggregate',
        needs: [],
        aggregate: { function: 'weighted_average' },
      },
    ];

    expect(() => validateRubric(criteria)).toThrow("'aggregate' but has empty 'needs'");
  });

  it('accepts valid rubric with script criterion', () => {
    const criteria: Criterion[] = [
      { id: 'tests-pass', title: 'Tests Pass', type: 'script', run: 'npm test' },
      { id: 'quality', title: 'Quality', type: 'judge', instructions: 'Evaluate code quality' },
    ];

    expect(() => validateRubric(criteria)).not.toThrow();
  });
});

describe('buildEvaluationResult', () => {
  it('builds result with weighted score', () => {
    const results: CriterionResult[] = [
      { id: 'a', weight: 1, score: 0.8, summary: 'Good', status: 'completed', scorerType: 'judge' },
      { id: 'b', weight: 1, score: 0.6, summary: 'OK', status: 'completed', scorerType: 'judge' },
    ];

    const result = buildEvaluationResult(results);
    expect(result.criteria).toBe(results);
    expect(result.weightedScore).toBeCloseTo(0.7);
    expect(result.report).toBeUndefined();
  });

  it('includes report when provided', () => {
    const results: CriterionResult[] = [
      { id: 'a', weight: 1, score: 0.8, summary: 'Good', status: 'completed', scorerType: 'judge' },
    ];

    const result = buildEvaluationResult(results, '## Report');
    expect(result.report).toBe('## Report');
  });
});

describe('getExecutionOrder', () => {
  it('returns all criteria in valid execution order', () => {
    const criteria: Criterion[] = [
      { id: 'a', title: 'A', type: 'judge', instructions: 'Test A' },
      { id: 'b', title: 'B', type: 'judge', instructions: 'Test B', needs: ['a'] },
      {
        id: 'summary',
        title: 'Summary',
        type: 'aggregate',
        needs: 'all',
        aggregate: { function: 'weighted_average' },
      },
    ];

    const order = getExecutionOrder(criteria);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('summary'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('summary'));
  });
});

describe('resolveCriteria', () => {
  it('resolves all fields correctly', () => {
    const criteria: Criterion[] = [
      { id: 'a', title: 'A', type: 'judge', instructions: 'Test A' },
      {
        id: 'b',
        title: 'B',
        type: 'agent',
        instructions: 'Test B',
        weight: 2,
        needs: ['a'],
      },
    ];

    const resolved = resolveCriteria(criteria);

    expect(resolved[0].resolvedWeight).toBe(1);
    expect(resolved[0].type).toBe('judge');
    expect(resolved[0].resolvedDependencies).toEqual([]);

    expect(resolved[1].resolvedWeight).toBe(2);
    expect(resolved[1].type).toBe('agent');
    expect(resolved[1].resolvedDependencies).toEqual(['a']);
  });
});

describe('buildScorerConfig', () => {
  const paths: ScorerPaths = { contextDir: '/bunsen/run', workspacePath: '/workspace' };

  it('builds a judge config with the resolved default model and no dead fields', () => {
    const criterion: ResolvedCriterion = {
      id: 'test',
      title: 'Test',
      type: 'judge',
      instructions: 'Test description',
      resolvedWeight: 1,
      resolvedDependencies: [],
    };

    const config = buildScorerConfig(criterion, paths, {});

    expect(config).toEqual({
      type: 'judge',
      id: 'test',
      title: 'Test',
      instructions: 'Test description',
      model: DEFAULT_SCORER_MODEL,
      contextDir: '/bunsen/run',
      workspacePath: '/workspace',
    });
    // The bundle contract is exactly these keys — no `criterion`, `prompt`,
    // `context`, or `aggregate` left over from the old shape.
    expect(Object.keys(config).sort()).toEqual([
      'contextDir',
      'id',
      'instructions',
      'model',
      'title',
      'type',
      'workspacePath',
    ]);
  });

  it('carries scorer.model, systemPrompt, tools, scores, and evidence through', () => {
    const criterion: ResolvedCriterion = {
      id: 'test',
      title: 'Test',
      type: 'agent',
      instructions: 'Test description',
      scores: { 0: 'no', 1: 'yes' },
      scorer: {
        model: 'openai/gpt-5.5',
        systemPrompt: 'You are terse.',
        tools: ['run_command', 'read_file'],
      },
      resolvedWeight: 1,
      resolvedDependencies: [],
    };

    const config = buildScorerConfig(criterion, paths, {});

    expect(config.type).toBe('agent');
    expect(config.model).toBe('openai/gpt-5.5');
    expect(config.systemPrompt).toBe('You are terse.');
    expect(config.tools).toEqual(['run_command', 'read_file']);
    expect(config.scores).toEqual({ 0: 'no', 1: 'yes' });
    // Copied, not aliased — the bundle config is serialized independently.
    expect(config.tools).not.toBe(criterion.scorer!.tools);
  });

  it('copies a judge criterion evidence list', () => {
    const criterion: ResolvedCriterion = {
      id: 'j',
      title: 'J',
      type: 'judge',
      instructions: 'x',
      evidence: ['diff', 'traces'],
      resolvedWeight: 1,
      resolvedDependencies: [],
    };

    const config = buildScorerConfig(criterion, paths, {});
    expect(config.evidence).toEqual(['diff', 'traces']);
    expect(config.evidence).not.toBe(criterion.evidence);
  });

  it('includes workspaceSourcePath only when the snapshot is mounted', () => {
    const criterion: ResolvedCriterion = {
      id: 'j',
      title: 'J',
      type: 'judge',
      instructions: 'x',
      resolvedWeight: 1,
      resolvedDependencies: [],
    };

    expect(buildScorerConfig(criterion, paths, {}).workspaceSourcePath).toBeUndefined();
    expect(
      buildScorerConfig(
        criterion,
        { ...paths, workspaceSourcePath: '/workspace-source' },
        {},
      ).workspaceSourcePath,
    ).toBe('/workspace-source');
  });

  it('passes only the dependency scores this criterion declared', () => {
    const criterion: ResolvedCriterion = {
      id: 'summary',
      title: 'Summary',
      type: 'judge',
      instructions: 'Summarize a and b',
      needs: ['a', 'b'],
      resolvedWeight: 1,
      resolvedDependencies: ['a', 'b'],
    };

    const config = buildScorerConfig(criterion, paths, {
      a: { score: 0.8, summary: 'Good' },
      b: { score: 0.6, summary: 'OK' },
      unrelated: { score: 1, summary: 'Not a dependency' },
    });

    expect(config.dependencyScores).toEqual({
      a: { score: 0.8, summary: 'Good' },
      b: { score: 0.6, summary: 'OK' },
    });
  });

  it('omits dependencyScores when the criterion has no dependencies', () => {
    const criterion: ResolvedCriterion = {
      id: 'j',
      title: 'J',
      type: 'judge',
      instructions: 'x',
      resolvedWeight: 1,
      resolvedDependencies: [],
    };
    expect(buildScorerConfig(criterion, paths, { a: { score: 1, summary: 'x' } })
      .dependencyScores).toBeUndefined();
  });

  it('throws for script and aggregate criteria (the executor dispatches those)', () => {
    const script: ResolvedCriterion = {
      ...SCRIPT,
      resolvedWeight: 1,
      resolvedDependencies: [],
    } as ResolvedCriterion;
    const aggregate: ResolvedCriterion = {
      ...AGGREGATE,
      resolvedWeight: 0,
      resolvedDependencies: ['s'],
    } as ResolvedCriterion;

    expect(() => buildScorerConfig(script, paths, {})).toThrow(
      'which the bundled scorer does not run',
    );
    expect(() => buildScorerConfig(aggregate, paths, {})).toThrow(
      'which the bundled scorer does not run',
    );
  });
});

describe('buildReportScorerConfig', () => {
  const paths: ScorerPaths = { contextDir: '/bunsen/run', workspacePath: '/workspace' };
  const criteria: Criterion[] = [
    { id: 'a', title: 'A', type: 'judge', instructions: 'x' },
    { id: 'b', title: 'B', type: 'judge', instructions: 'x' },
  ];
  const deps: Record<string, DependencyScore> = {
    a: { score: 0.8, summary: 'Good' },
    b: { score: 0.6, summary: 'OK' },
  };

  it('builds the report step with its reserved id and title', () => {
    const report: ReportConfig = { instructions: 'Summarize the run.' };
    const config = buildReportScorerConfig(report, criteria, paths, deps);

    expect(config.type).toBe('report');
    expect(config.id).toBe('summary-report');
    expect(config.title).toBe('Evaluation report');
    expect(config.instructions).toBe('Summarize the run.');
    expect(config.model).toBe(DEFAULT_SCORER_MODEL);
    expect(config.contextDir).toBe('/bunsen/run');
    expect(config.workspacePath).toBe('/workspace');
    expect(config.workspaceSourcePath).toBeUndefined();
  });

  it('defaults needs to every criterion', () => {
    const config = buildReportScorerConfig({ instructions: 'x' }, criteria, paths, deps);
    expect(config.dependencyScores).toEqual(deps);

    const explicitAll = buildReportScorerConfig(
      { instructions: 'x', needs: 'all' },
      criteria,
      paths,
      deps,
    );
    expect(explicitAll.dependencyScores).toEqual(deps);
  });

  it('narrows dependency scores to an explicit needs list', () => {
    const config = buildReportScorerConfig(
      { instructions: 'x', needs: ['b'] },
      criteria,
      paths,
      deps,
    );
    expect(config.dependencyScores).toEqual({ b: { score: 0.6, summary: 'OK' } });
  });

  it('carries model, systemPrompt, evidence, and the workspace snapshot', () => {
    const config = buildReportScorerConfig(
      {
        instructions: 'x',
        model: 'google/gemini-2.5-pro',
        systemPrompt: 'Write like a lab notebook.',
        evidence: ['diff', 'logs'],
      },
      criteria,
      { ...paths, workspaceSourcePath: '/workspace-source' },
      deps,
    );

    expect(config.model).toBe('google/gemini-2.5-pro');
    expect(config.systemPrompt).toBe('Write like a lab notebook.');
    expect(config.evidence).toEqual(['diff', 'logs']);
    expect(config.workspaceSourcePath).toBe('/workspace-source');
    expect(config.tools).toBeUndefined();
    expect(config.scores).toBeUndefined();
  });
});

describe('checkGate', () => {
  it('passes when score >= threshold', () => {
    expect(checkGate(1, { ifBelow: 1 })).toBe(true);
    expect(checkGate(0.5, { ifBelow: 0.5 })).toBe(true);
    expect(checkGate(0.8, { ifBelow: 0.5 })).toBe(true);
  });

  it('fails when score < threshold', () => {
    expect(checkGate(0.9, { ifBelow: 1 })).toBe(false);
    expect(checkGate(0.4, { ifBelow: 0.5 })).toBe(false);
    expect(checkGate(0, { ifBelow: 0.5 })).toBe(false);
  });

  it('fails when score is null', () => {
    expect(checkGate(null, { ifBelow: 0.5 })).toBe(false);
  });
});

describe('getGateThreshold', () => {
  it('returns ">= N" for the ifBelow threshold', () => {
    expect(getGateThreshold({ ifBelow: 1 })).toBe('>= 1');
    expect(getGateThreshold({ ifBelow: 0.5 })).toBe('>= 0.5');
    expect(getGateThreshold({ ifBelow: 0 })).toBe('>= 0');
  });
});
