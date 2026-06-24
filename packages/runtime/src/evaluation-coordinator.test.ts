// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for the Evaluation Coordinator (v1 criteria input shape).
 */

import { describe, it, expect } from 'bun:test';
import type {
  Criterion,
  CriterionResult,
  DependencyScore,
} from '@bunsen-dev/types';
import {
  resolveDependencies,
  topologicalSort,
  determineScorerType,
  resolveCriteria,
  getExecutionOrder,
  buildScorerConfig,
  calculateWeightedScore,
  runAggregate,
  buildEvaluationResult,
  validateRubric,
  checkGate,
  getGateThreshold,
  type ResolvedCriterion,
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

describe('determineScorerType', () => {
  it('maps judge to llm', () => {
    const c: Criterion = { id: 't', title: 'Test', type: 'judge', instructions: 'x' };
    expect(determineScorerType(c)).toBe('llm');
  });

  it('maps agent to agent', () => {
    const c: Criterion = { id: 't', title: 'Test', type: 'agent', instructions: 'x' };
    expect(determineScorerType(c)).toBe('agent');
  });

  it('maps browser-agent to visual', () => {
    const c: Criterion = { id: 't', title: 'Test', type: 'browser-agent', instructions: 'x' };
    expect(determineScorerType(c)).toBe('visual');
  });

  it('maps script to code', () => {
    const c: Criterion = { id: 't', title: 'Test', type: 'script', run: 'npm test' };
    expect(determineScorerType(c)).toBe('code');
  });

  it('maps aggregate to aggregate', () => {
    const c: Criterion = {
      id: 't',
      title: 'Test',
      type: 'aggregate',
      needs: ['a'],
      aggregate: { function: 'weighted_average' },
    };
    expect(determineScorerType(c)).toBe('aggregate');
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

    const result = runAggregate('weighted_average', deps, criteria);
    expect(result.score).toBeCloseTo(0.7);
  });

  it('calculates all (all perfect)', () => {
    const deps: Record<string, DependencyScore> = {
      a: { score: 1, summary: 'Test' },
      b: { score: 1, summary: 'Test' },
    };

    const result = runAggregate('all', deps, criteria);
    expect(result.score).toBe(1);
  });

  it('calculates all (not all perfect)', () => {
    const deps: Record<string, DependencyScore> = {
      a: { score: 1, summary: 'Test' },
      b: { score: 0.9, summary: 'Test' },
    };

    const result = runAggregate('all', deps, criteria);
    expect(result.score).toBe(0);
  });

  it('calculates any (one passes)', () => {
    const deps: Record<string, DependencyScore> = {
      a: { score: 0.6, summary: 'Test' },
      b: { score: 0.3, summary: 'Test' },
    };

    const result = runAggregate('any', deps, criteria);
    expect(result.score).toBe(1);
  });

  it('calculates any (none passes)', () => {
    const deps: Record<string, DependencyScore> = {
      a: { score: 0.3, summary: 'Test' },
      b: { score: 0.4, summary: 'Test' },
    };

    const result = runAggregate('any', deps, criteria);
    expect(result.score).toBe(0);
  });

  it('calculates min', () => {
    const deps: Record<string, DependencyScore> = {
      a: { score: 0.8, summary: 'Test' },
      b: { score: 0.6, summary: 'Test' },
    };

    const result = runAggregate('min', deps, criteria);
    expect(result.score).toBeCloseTo(0.6);
  });

  it('calculates max', () => {
    const deps: Record<string, DependencyScore> = {
      a: { score: 0.8, summary: 'Test' },
      b: { score: 0.6, summary: 'Test' },
    };

    const result = runAggregate('max', deps, criteria);
    expect(result.score).toBeCloseTo(0.8);
  });

  it('throws for unknown aggregate', () => {
    const deps: Record<string, DependencyScore> = {
      a: { score: 0.8, summary: 'Test' },
    };

    expect(() => runAggregate('unknown', deps, criteria)).toThrow('Unknown aggregate function');
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
    expect(resolved[0].scorerType).toBe('llm');
    expect(resolved[0].resolvedDependencies).toEqual([]);

    expect(resolved[1].resolvedWeight).toBe(2);
    expect(resolved[1].scorerType).toBe('agent');
    expect(resolved[1].resolvedDependencies).toEqual(['a']);
  });
});

describe('buildScorerConfig', () => {
  it('builds a basic judge config', () => {
    const criterion: ResolvedCriterion = {
      id: 'test',
      title: 'Test',
      type: 'judge',
      instructions: 'Test description',
      resolvedWeight: 1,
      scorerType: 'llm',
      resolvedDependencies: [],
    };

    const config = buildScorerConfig(criterion, '/bunsen/run', '/workspace', {});

    expect(config.criterion).toBe('test');
    expect(config.instructions).toBe('Test description');
    expect(config.type).toBe('llm');
    expect(config.contextDir).toBe('/bunsen/run');
    expect(config.workspacePath).toBe('/workspace');
  });

  it('includes agent scorer config', () => {
    const criterion: ResolvedCriterion = {
      id: 'test',
      title: 'Test',
      type: 'agent',
      instructions: 'Test description',
      scorer: { model: 'gpt-4', tools: ['run_command'] },
      resolvedWeight: 1,
      scorerType: 'agent',
      resolvedDependencies: [],
    };

    const config = buildScorerConfig(criterion, '/bunsen/run', '/workspace', {});

    expect(config.model).toBe('gpt-4');
    expect(config.tools).toEqual(['run_command']);
  });

  it('includes dependency scores', () => {
    const criterion: ResolvedCriterion = {
      id: 'summary',
      title: 'Summary',
      type: 'aggregate',
      needs: ['a', 'b'],
      aggregate: { function: 'weighted_average' },
      resolvedWeight: 0,
      scorerType: 'aggregate',
      resolvedDependencies: ['a', 'b'],
    };

    const deps: Record<string, DependencyScore> = {
      a: { score: 0.8, summary: 'Good' },
      b: { score: 0.6, summary: 'OK' },
    };

    const config = buildScorerConfig(criterion, '/bunsen/run', '/workspace', deps);

    expect(config.dependencyScores).toEqual(deps);
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
