// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Evaluation Coordinator
 *
 * Orchestrates the evaluation of experiment results by:
 * 1. Resolving the `evaluation.criteria` list (sequential order, each criterion
 *    may reference earlier entries via `needs`).
 * 2. Determining the scorer type from the v1 `type` enum.
 * 3. Building scorer-runtime configs.
 * 4. Calculating weighted scores.
 * 5. Running aggregate math.
 *
 * Consumes the v1 {@link Criterion} shape directly. Report generation is
 * handled separately via {@link ExperimentConfig.evaluation.report}.
 */

import type {
  Criterion,
  JudgeCriterion,
  AgentCriterion,
  BrowserAgentCriterion,
  AggregateCriterion,
  ScriptCriterion,
  AggregateFunction,
  JudgeEvidence,
  AllowedScores,
  ScorerType,
  ScorerConfig,
  ScorerOutput,
  CriterionResult,
  EvaluationResult,
  DependencyScore,
} from '@bunsen-dev/types';

/**
 * Resolved criterion with computed fields. Extends the v1 {@link Criterion}
 * discriminated union with the derived scorer type + expanded dependencies
 * (`needs: 'all'` expanded to the actual list of prior criterion ids).
 */
export type ResolvedCriterion = Criterion & {
  /** Resolved weight (default 1). */
  resolvedWeight: number;
  /** Resolved scorer type (maps v1 `type` to the internal scorer enum). */
  scorerType: ScorerType;
  /** Dependency ids, with `needs: 'all'` expanded. */
  resolvedDependencies: string[];
};

/**
 * Build dependency graph and resolve the `all` keyword.
 *
 * Each criterion's dependency list contains the ids of criteria that must
 * resolve before it. `needs: 'all'` expands to "every criterion that appears
 * earlier in the list" (the v1 schema requires `needs` references to point
 * backwards, so this is the natural interpretation).
 */
export function resolveDependencies(criteria: Criterion[]): Map<string, string[]> {
  const allIds = new Set(criteria.map((c) => c.id));
  const graph = new Map<string, string[]>();

  if (allIds.has('all')) {
    console.warn(
      'Warning: A criterion is named "all", which conflicts with the reserved keyword. ' +
        'This criterion cannot be used as a dependency target via `needs: all`.',
    );
  }

  criteria.forEach((criterion, idx) => {
    let deps: string[] = [];

    if (criterion.needs === 'all') {
      // Depends on every earlier criterion (matches v1 back-reference rule).
      deps = criteria.slice(0, idx).map((c) => c.id);
    } else if (Array.isArray(criterion.needs)) {
      for (const dep of criterion.needs) {
        if (!allIds.has(dep)) {
          throw new Error(
            `Invalid rubric: criterion "${criterion.id}" depends on unknown criterion "${dep}"`,
          );
        }
        if (dep === criterion.id) {
          throw new Error(
            `Invalid rubric: criterion "${criterion.id}" cannot depend on itself`,
          );
        }
      }
      deps = [...criterion.needs];
    }

    graph.set(criterion.id, deps);
  });

  return graph;
}

/**
 * Detect cycles in dependency graph using DFS
 */
function detectCycles(graph: Map<string, string[]>): string[] | null {
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): boolean {
    visited.add(node);
    recursionStack.add(node);
    path.push(node);

    const deps = graph.get(node) || [];
    for (const dep of deps) {
      if (!visited.has(dep)) {
        if (dfs(dep)) return true;
      } else if (recursionStack.has(dep)) {
        path.push(dep);
        return true;
      }
    }

    path.pop();
    recursionStack.delete(node);
    return false;
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      if (dfs(node)) {
        const cycleStartIdx = path.indexOf(path[path.length - 1]);
        return path.slice(cycleStartIdx);
      }
    }
  }

  return null;
}

/**
 * Topological sort using Kahn's algorithm.
 *
 * In our graph, graph.get(node) returns what 'node' depends on. So if B
 * depends on A, graph.get('B') = ['A']. In topological order, A must come
 * before B.
 */
export function topologicalSort(graph: Map<string, string[]>): string[] {
  const cycle = detectCycles(graph);
  if (cycle) {
    throw new Error(`Invalid rubric: circular dependency detected: ${cycle.join(' -> ')}`);
  }

  const inDegree = new Map<string, number>();
  for (const [node, deps] of graph.entries()) {
    inDegree.set(node, deps.length);
  }

  const queue: string[] = [];
  for (const [node, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(node);
    }
  }

  const result: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    result.push(node);

    for (const [other, deps] of graph.entries()) {
      if (deps.includes(node)) {
        const newDegree = (inDegree.get(other) || 1) - 1;
        inDegree.set(other, newDegree);
        if (newDegree === 0) {
          queue.push(other);
        }
      }
    }
  }

  return result;
}

/** Map v1 criterion `type` to the internal scorer-type enum. */
export function determineScorerType(criterion: Criterion): ScorerType {
  switch (criterion.type) {
    case 'script':
      return 'code';
    case 'judge':
      return 'llm';
    case 'agent':
      return 'agent';
    case 'browser-agent':
      return 'visual';
    case 'aggregate':
      return 'aggregate';
  }
}

/** Resolve all criteria with computed fields. */
export function resolveCriteria(criteria: Criterion[]): ResolvedCriterion[] {
  const depGraph = resolveDependencies(criteria);

  return criteria.map((criterion) => ({
    ...criterion,
    resolvedWeight: criterion.weight ?? 1,
    scorerType: determineScorerType(criterion),
    resolvedDependencies: depGraph.get(criterion.id) || [],
  }));
}

/** Get the execution order for criteria. */
export function getExecutionOrder(criteria: Criterion[]): string[] {
  const depGraph = resolveDependencies(criteria);
  return topologicalSort(depGraph);
}

/** Convenience narrowers for callers that need the discriminated branch. */
export function isScriptCriterion(c: Criterion): c is ScriptCriterion {
  return c.type === 'script';
}
export function isJudgeCriterion(c: Criterion): c is JudgeCriterion {
  return c.type === 'judge';
}
export function isAgentCriterion(c: Criterion): c is AgentCriterion {
  return c.type === 'agent';
}
export function isBrowserAgentCriterion(c: Criterion): c is BrowserAgentCriterion {
  return c.type === 'browser-agent';
}
export function isAggregateCriterion(c: Criterion): c is AggregateCriterion {
  return c.type === 'aggregate';
}

/** Read `instructions` if the criterion type carries one. */
export function criterionInstructions(c: Criterion): string | undefined {
  switch (c.type) {
    case 'judge':
    case 'agent':
    case 'browser-agent':
      return c.instructions;
    default:
      return undefined;
  }
}

/** Read `evidence` (judge only). */
export function criterionEvidence(c: Criterion): JudgeEvidence[] | undefined {
  return c.type === 'judge' ? c.evidence : undefined;
}

/** Read a user-facing scorer model override, if any. */
export function criterionModel(c: Criterion): string | undefined {
  switch (c.type) {
    case 'judge':
      return c.scorer?.model;
    case 'agent':
    case 'browser-agent':
      return c.scorer?.model;
    default:
      return undefined;
  }
}

/** Read extra scorer tools (agent/browser-agent only). */
export function criterionTools(c: Criterion): string[] | undefined {
  if (c.type === 'agent' || c.type === 'browser-agent') return c.scorer?.tools;
  return undefined;
}

/** Read the aggregate function for aggregate criteria. */
export function criterionAggregate(c: Criterion): AggregateFunction | undefined {
  return c.type === 'aggregate' ? c.aggregate.function : undefined;
}

/** Read the script `run` command for script criteria. */
export function criterionRun(c: Criterion): string | undefined {
  return c.type === 'script' ? c.run : undefined;
}

/**
 * Build scorer config for a criterion
 */
export function buildScorerConfig(
  criterion: ResolvedCriterion,
  contextDir: string,
  workspacePath: string,
  dependencyScores: Record<string, DependencyScore>,
): ScorerConfig {
  const config: ScorerConfig = {
    criterion: criterion.id,
    instructions: criterionInstructions(criterion),
    type: criterion.scorerType,
    contextDir,
    workspacePath,
  };

  if (criterion.scores) {
    config.scores = criterion.scores as AllowedScores;
  }

  if (criterion.resolvedDependencies.length > 0) {
    config.dependencyScores = dependencyScores;
  }

  const aggregate = criterionAggregate(criterion);
  if (aggregate) {
    config.aggregate = aggregate;
  }

  const evidence = criterionEvidence(criterion);
  if (evidence) {
    config.context = evidence;
  }

  const model = criterionModel(criterion);
  if (model) {
    config.model = model;
  }
  const tools = criterionTools(criterion);
  if (tools) {
    config.tools = tools;
  }

  return config;
}

/**
 * Calculate weighted score from criterion results
 */
export function calculateWeightedScore(results: CriterionResult[]): number {
  let totalWeight = 0;
  let weightedSum = 0;

  for (const result of results) {
    if (result.weight === 0) continue;
    if (result.score === null) continue;
    totalWeight += result.weight;
    weightedSum += result.score * result.weight;
  }

  if (totalWeight === 0) return 0;
  return parseFloat((weightedSum / totalWeight).toFixed(5));
}

/**
 * Run aggregate function on dependency scores.
 */
export function runAggregate(
  aggregate: string,
  dependencyScores: Record<string, DependencyScore>,
  criteria: Criterion[],
): ScorerOutput {
  const weightMap = new Map<string, number>();
  for (const c of criteria) {
    weightMap.set(c.id, c.weight ?? 1);
  }

  const validScores: { name: string; score: number; weight: number }[] = [];
  const skippedZeroWeight: string[] = [];

  for (const [name, data] of Object.entries(dependencyScores)) {
    if (data.score === null) continue;
    const weight = weightMap.get(name) ?? 1;
    if (weight === 0) {
      skippedZeroWeight.push(name);
      continue;
    }
    validScores.push({ name, score: data.score, weight });
  }

  if (skippedZeroWeight.length > 0) {
    console.warn(
      `Warning: Aggregate calculation skipped criteria with weight: 0: ${skippedZeroWeight.join(', ')}`,
    );
  }

  if (validScores.length === 0) {
    throw new Error(
      `Invalid aggregate: all dependencies have weight: 0 or null scores. Nothing to aggregate.`,
    );
  }

  let score: number;
  let summary: string;

  switch (aggregate) {
    case 'weighted_average': {
      let totalWeight = 0;
      let weightedSum = 0;
      for (const v of validScores) {
        totalWeight += v.weight;
        weightedSum += v.score * v.weight;
      }
      score = totalWeight > 0 ? weightedSum / totalWeight : 0;
      summary = `Weighted average of ${validScores.length} criteria: ${score.toFixed(2)}`;
      break;
    }

    case 'all': {
      const allPerfect = validScores.every((v) => v.score === 1);
      score = allPerfect ? 1 : 0;
      summary = allPerfect
        ? `All ${validScores.length} criteria scored 1.0`
        : `Not all criteria scored 1.0`;
      break;
    }

    case 'any': {
      const anyPass = validScores.some((v) => v.score > 0.5);
      score = anyPass ? 1 : 0;
      summary = anyPass ? `At least one criterion scored > 0.5` : `No criterion scored > 0.5`;
      break;
    }

    case 'min': {
      score = Math.min(...validScores.map((v) => v.score));
      const minCriterion = validScores.find((v) => v.score === score);
      summary = `Minimum score: ${score.toFixed(2)} (${minCriterion?.name})`;
      break;
    }

    case 'max': {
      score = Math.max(...validScores.map((v) => v.score));
      const maxCriterion = validScores.find((v) => v.score === score);
      summary = `Maximum score: ${score.toFixed(2)} (${maxCriterion?.name})`;
      break;
    }

    default:
      throw new Error(`Unknown aggregate function: ${aggregate}`);
  }

  return { score, summary };
}

/**
 * Build evaluation result from criterion results
 */
export function buildEvaluationResult(
  results: CriterionResult[],
  report?: string,
): EvaluationResult {
  const weightedScore = calculateWeightedScore(results);

  return {
    criteria: results,
    weightedScore,
    report,
  };
}

/**
 * Check if a score passes a gate threshold.
 *
 * v1 gates are `{ ifBelow: <threshold> }` — the gate fails (skips remaining
 * criteria) when the resolved score is strictly below `ifBelow`.
 */
export function checkGate(score: number | null, gate: { ifBelow: number }): boolean {
  if (score === null) return false;
  return score >= gate.ifBelow;
}

/** Human-readable description of the gate threshold. */
export function getGateThreshold(gate: { ifBelow: number }): string {
  return `>= ${gate.ifBelow}`;
}

/**
 * Validate rubric for common errors (duplicate ids, aggregates without
 * `needs`, missing dependencies). The v1 parser already enforces most of
 * this; this helper runs the same checks at the evaluation boundary so
 * programmatically-constructed rubrics (tests, future SDK surfaces) get
 * caught too.
 */
export function validateRubric(criteria: Criterion[]): void {
  const ids = new Set<string>();
  for (const c of criteria) {
    if (ids.has(c.id)) {
      throw new Error(`Invalid rubric: duplicate criterion id "${c.id}"`);
    }
    ids.add(c.id);
  }

  for (const c of criteria) {
    if (c.type === 'aggregate' && (!c.needs || (Array.isArray(c.needs) && c.needs.length === 0))) {
      throw new Error(
        `Invalid rubric: criterion "${c.id}" is 'aggregate' but has empty 'needs'`,
      );
    }
  }

  // Dependency graph (throws on cycles / unknown refs).
  resolveDependencies(criteria);
}
