/**
 * Evaluation Coordinator
 *
 * Orchestrates the evaluation of experiment results by:
 * 1. Resolving the `evaluation.criteria` list (sequential order, each criterion
 *    may reference earlier entries via `needs`).
 * 2. Resolving each LLM-backed criterion's scorer model (`<provider>/<model>`)
 *    and the set of providers an evaluation needs keys for.
 * 3. Building the scorer-runtime config the bundled scorer consumes.
 * 4. Calculating weighted scores.
 * 5. Running aggregate math.
 *
 * Consumes the v1 {@link Criterion} shape directly. `script` and `aggregate`
 * criteria are dispatched by the executor and never become a
 * {@link ScorerConfig}; the report step builds its config via
 * {@link buildReportScorerConfig}.
 */

import type {
  Criterion,
  JudgeCriterion,
  AgentCriterion,
  BrowserAgentCriterion,
  AggregateCriterion,
  ScriptCriterion,
  AggregateSettings,
  EvaluationConfig,
  JudgeEvidence,
  AllowedScores,
  ReportConfig,
  ScorerConfig,
  ScorerOutput,
  ScorerProvider,
  ScorerToolName,
  CriterionResult,
  EvaluationResult,
  DependencyScore,
} from '@bunsen-dev/types';
import { parseScorerModelRef } from '@bunsen-dev/types';

/**
 * The model every LLM-backed scorer (`judge`, `agent`, `browser-agent`, and
 * `evaluation.report`) runs on unless the criterion sets `scorer.model` (or
 * the report sets `report.model`). Defined once, here, on the host: the
 * bundled scorer never applies a default — it always receives a resolved
 * `<provider>/<model>`.
 */
export const DEFAULT_SCORER_MODEL = 'anthropic/claude-sonnet-4-6';

/**
 * Resolved criterion with computed fields. Extends the v1 {@link Criterion}
 * discriminated union with expanded dependencies (`needs: 'all'` expanded to
 * the actual list of prior criterion ids).
 */
export type ResolvedCriterion = Criterion & {
  /** Resolved weight (default 1). */
  resolvedWeight: number;
  /** Dependency ids, with `needs: 'all'` expanded. */
  resolvedDependencies: string[];
};

/** The criterion types the bundled (LLM-backed) scorer runs. */
export type LLMCriterion = JudgeCriterion | AgentCriterion | BrowserAgentCriterion;

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

/** Resolve all criteria with computed fields. */
export function resolveCriteria(criteria: Criterion[]): ResolvedCriterion[] {
  const depGraph = resolveDependencies(criteria);

  return criteria.map((criterion) => ({
    ...criterion,
    resolvedWeight: criterion.weight ?? 1,
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
/** `judge`, `agent`, or `browser-agent` — the criteria the bundled scorer runs. */
export function isLLMCriterion(c: Criterion): c is LLMCriterion {
  return c.type === 'judge' || c.type === 'agent' || c.type === 'browser-agent';
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

/** Read a user-facing scorer model override, if any (unresolved; see {@link criterionScorerModel}). */
export function criterionModel(c: Criterion): string | undefined {
  return isLLMCriterion(c) ? c.scorer?.model : undefined;
}

/**
 * The `<provider>/<model>` an LLM-backed criterion will score with —
 * `scorer.model` or {@link DEFAULT_SCORER_MODEL}. `undefined` for `script`
 * and `aggregate`, which run no model.
 */
export function criterionScorerModel(c: Criterion): string | undefined {
  if (!isLLMCriterion(c)) return undefined;
  return c.scorer?.model ?? DEFAULT_SCORER_MODEL;
}

/** The `<provider>/<model>` the report step will run on. */
export function reportScorerModel(report: ReportConfig): string {
  return report.model ?? DEFAULT_SCORER_MODEL;
}

/** Read the user-facing system-prompt replacement, if any. */
export function criterionSystemPrompt(c: Criterion): string | undefined {
  return isLLMCriterion(c) ? c.scorer?.systemPrompt : undefined;
}

/** Read the exploration-tool allowlist (agent/browser-agent only). */
export function criterionTools(c: Criterion): ScorerToolName[] | undefined {
  if (c.type === 'agent' || c.type === 'browser-agent') return c.scorer?.tools;
  return undefined;
}

/** One LLM-backed criterion (or the report) that needs a given provider's key. */
export interface ScorerProviderRequirement {
  /** Criterion id, or `report` for the `evaluation.report` step. */
  id: string;
  type: 'judge' | 'agent' | 'browser-agent' | 'report';
  weight: number;
  /** The resolved `<provider>/<model>`. */
  model: string;
}

/**
 * The providers an evaluation needs API keys for, with the criteria behind
 * each — derived from every LLM-backed criterion's resolved model plus the
 * report. Script/aggregate-only rubrics yield an empty map (no key needed).
 * Throws on a malformed model reference (the loader rejects those first for
 * YAML-sourced configs).
 */
export function requiredScorerProviders(
  evaluation: Pick<EvaluationConfig, 'criteria' | 'report'>,
): Map<ScorerProvider, ScorerProviderRequirement[]> {
  const out = new Map<ScorerProvider, ScorerProviderRequirement[]>();
  const add = (req: ScorerProviderRequirement) => {
    const { provider } = parseScorerModelRef(req.model);
    const list = out.get(provider) ?? [];
    list.push(req);
    out.set(provider, list);
  };
  for (const c of evaluation.criteria) {
    const model = criterionScorerModel(c);
    if (model === undefined || !isLLMCriterion(c)) continue;
    add({ id: c.id, type: c.type, weight: c.weight ?? 1, model });
  }
  if (evaluation.report) {
    add({ id: 'report', type: 'report', weight: 0, model: reportScorerModel(evaluation.report) });
  }
  return out;
}

/** Read the aggregate settings for aggregate criteria. */
export function criterionAggregate(c: Criterion): AggregateSettings | undefined {
  return c.type === 'aggregate' ? c.aggregate : undefined;
}

/** Read the script `run` command for script criteria. */
export function criterionRun(c: Criterion): string | undefined {
  return c.type === 'script' ? c.run : undefined;
}

/**
 * Evidence categories this criterion needs that a failed capture step made
 * unavailable. Non-empty means the criterion must be skipped (score: null)
 * rather than scored against missing evidence — a judge grading an absent
 * diff would record a plausible-looking but meaningless number.
 *
 * Only `judge` criteria consume platform-assembled evidence; `agent` /
 * `browser-agent` scorers fetch their own ground truth via tools and
 * `script` criteria run against the real extracted workspace, so all of
 * those proceed on degraded runs.
 */
export function blockedJudgeEvidence(
  c: Criterion,
  failedEvidence: ReadonlySet<JudgeEvidence>,
): JudgeEvidence[] {
  if (c.type !== 'judge' || failedEvidence.size === 0) return [];
  const needed = c.evidence ?? ['diff'];
  return needed.filter((e) => failedEvidence.has(e));
}

/** Container-side paths the scorer reads. */
export interface ScorerPaths {
  /** Run context inside the scorer container (`/bunsen/run`). */
  contextDir: string;
  /** The agent's final workspace (`/workspace`). */
  workspacePath: string;
  /** The pre-run snapshot, when mounted (`/workspace-source`; dedicated mode only). */
  workspaceSourcePath?: string;
}

/**
 * Build the config the bundled scorer receives for an LLM-backed criterion.
 * The model is always resolved here (never left for the bundle to default).
 * Throws for `script` / `aggregate` criteria — the executor dispatches those
 * itself and must never build a scorer config for them.
 */
export function buildScorerConfig(
  criterion: ResolvedCriterion,
  paths: ScorerPaths,
  dependencyScores: Record<string, DependencyScore>,
): ScorerConfig {
  if (!isLLMCriterion(criterion)) {
    throw new Error(
      `buildScorerConfig: criterion "${criterion.id}" is type "${criterion.type}", which the bundled scorer does not run`,
    );
  }
  const config: ScorerConfig = {
    type: criterion.type,
    id: criterion.id,
    title: criterion.title,
    instructions: criterion.instructions,
    model: criterionScorerModel(criterion) ?? DEFAULT_SCORER_MODEL,
    contextDir: paths.contextDir,
    workspacePath: paths.workspacePath,
  };
  if (paths.workspaceSourcePath) config.workspaceSourcePath = paths.workspaceSourcePath;

  const systemPrompt = criterionSystemPrompt(criterion);
  if (systemPrompt !== undefined) config.systemPrompt = systemPrompt;

  const tools = criterionTools(criterion);
  if (tools) config.tools = [...tools];

  if (criterion.scores) config.scores = criterion.scores as AllowedScores;

  const evidence = criterionEvidence(criterion);
  if (evidence) config.evidence = [...evidence];

  if (criterion.resolvedDependencies.length > 0) {
    config.dependencyScores = Object.fromEntries(
      criterion.resolvedDependencies
        .filter((id) => id in dependencyScores)
        .map((id) => [id, dependencyScores[id]]),
    );
  }

  return config;
}

/**
 * Build the config for the `evaluation.report` step. `needs` (default
 * `'all'`) selects which criterion results the report sees; `evidence`
 * defaults to `['diff']` in the bundle when absent.
 */
export function buildReportScorerConfig(
  report: ReportConfig,
  criteria: Criterion[],
  paths: ScorerPaths,
  dependencyScores: Record<string, DependencyScore>,
): ScorerConfig {
  const allIds = criteria.map((c) => c.id);
  const needs: string[] =
    report.needs === undefined || report.needs === 'all' ? allIds : [...report.needs];
  const deps: Record<string, DependencyScore> = {};
  for (const id of needs) {
    if (dependencyScores[id]) deps[id] = dependencyScores[id];
  }

  const config: ScorerConfig = {
    type: 'report',
    id: 'summary-report',
    title: 'Evaluation report',
    instructions: report.instructions,
    model: reportScorerModel(report),
    contextDir: paths.contextDir,
    workspacePath: paths.workspacePath,
    dependencyScores: deps,
  };
  if (paths.workspaceSourcePath) config.workspaceSourcePath = paths.workspaceSourcePath;
  if (report.systemPrompt !== undefined) config.systemPrompt = report.systemPrompt;
  if (report.evidence) config.evidence = [...report.evidence];
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
  aggregate: AggregateSettings,
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

  switch (aggregate.function) {
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

    case 'threshold': {
      const at = aggregate.at;
      if (typeof at !== 'number' || at < 0 || at > 1) {
        throw new Error(`'threshold' aggregate requires 'at' in [0, 1], got: ${at}`);
      }
      const below = validScores.filter((v) => v.score < at);
      score = below.length === 0 ? 1 : 0;
      summary =
        below.length === 0
          ? `All ${validScores.length} criteria scored >= ${at}`
          : `Below threshold ${at}: ${below.map((v) => `${v.name} (${v.score.toFixed(2)})`).join(', ')}`;
      break;
    }

    default:
      throw new Error(`Unknown aggregate function: ${aggregate.function}`);
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
