/**
 * The evaluation criterion loop.
 *
 * Extracted from `executor.ts` so the part that decides *what a criterion's
 * result is* — gate skips, capture-degraded skips, aggregate math, script and
 * LLM dispatch, and the failure policy — can be unit-tested without Docker.
 * The executor supplies the two container-backed scorers as closures
 * ({@link CriteriaScorers}) plus the artifact bookkeeping; everything else
 * lives here.
 *
 * Failure policy (DESIGN.md D6): a scorer that could not produce a verdict —
 * crash, API failure, timeout, no verdict after the forced submit — records
 * `score: null`, `status: 'error'`, and the reason. The evaluation continues,
 * the weighted score excludes it (it is not a `0` the agent earned), and a
 * gate on that criterion is **not** evaluated (an un-gradeable criterion has
 * no verdict to gate on, so it must not silently skip every criterion after
 * it).
 */

import type {
  Criterion,
  CriterionResult,
  DependencyScore,
  JudgeEvidence,
  ScorerConfig,
  ScorerOutput,
  ScriptCriterion,
} from '@bunsen-dev/types';
import {
  resolveCriteria,
  getExecutionOrder,
  validateRubric,
  blockedJudgeEvidence,
  runAggregate,
  buildScorerConfig,
  checkGate,
  getGateThreshold,
  type ResolvedCriterion,
  type LLMCriterion,
  type ScorerPaths,
} from './evaluation-coordinator.js';
import type { LLMScorerRun } from './scorer-container.js';
import type { RunEventInput } from './run-events.js';

/** The statuses this loop can produce (`not_run` is a consumer-side state). */
type EvaluatedStatus = 'completed' | 'skipped' | 'error';

/** A criterion result this loop produced, with its status narrowed. */
type EvaluatedResult = CriterionResult & { status: EvaluatedStatus };

/** The scorer types that run a model — the ones exit code 5 is about. */
const LLM_SCORER_TYPES: ReadonlySet<string> = new Set(['judge', 'agent', 'browser-agent']);

/**
 * The two container-backed scorers the executor owns.
 *
 * `script` throws only on infrastructure failure (the container is gone, the
 * exec could not start) — a failing verifier script is a real `0` and comes
 * back as a {@link ScorerOutput}. `llm` never throws for a scorer-side
 * failure: it reports one through {@link LLMScorerRun}.
 */
export interface CriteriaScorers {
  script(criterion: ResolvedCriterion & ScriptCriterion): Promise<ScorerOutput>;
  llm(criterion: ResolvedCriterion & LLMCriterion, config: ScorerConfig): Promise<LLMScorerRun>;
}

export interface EvaluateCriteriaOptions {
  criteria: Criterion[];
  /** Evidence categories a failed capture step made unavailable. */
  failedEvidence: ReadonlySet<JudgeEvidence>;
  /** Container-side paths written into every scorer config. */
  paths: ScorerPaths;
  scorers: CriteriaScorers;
  log(msg: string): void;
  progress(msg: string): void;
  emit(event: RunEventInput): void;
  /** Clock, for deterministic durations in tests. */
  now?: () => number;
  /** Maps a scorer output's screenshot filenames to artifact keys (executor copies the files). */
  screenshotKey?: (filename: string) => string;
  /** Artifact key for a criterion's `<slug>.log`; `undefined` for criteria that leave none. */
  logPathFor?: (criterion: Criterion) => string | undefined;
}

export interface GateFailure {
  criterion: string;
  score: number | null;
  threshold: string;
}

export interface EvaluateCriteriaResult {
  results: CriterionResult[];
  /** Every criterion's `{ score, summary }`, keyed by id, for `needs` consumers. */
  dependencyScores: Record<string, DependencyScore>;
  /** The first gate that failed, if any — the caller zeroes the weighted score. */
  gateFailure: GateFailure | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Score every criterion in dependency order.
 *
 * Never throws for a scorer-side failure; it throws only for a malformed
 * rubric (duplicate ids, unknown or circular `needs`), which is a config bug
 * the caller should surface as such.
 */
export async function evaluateCriteria(
  opts: EvaluateCriteriaOptions,
): Promise<EvaluateCriteriaResult> {
  const {
    criteria,
    failedEvidence,
    paths,
    scorers,
    log,
    progress,
    emit,
    screenshotKey,
    logPathFor,
  } = opts;
  const now = opts.now ?? Date.now;

  validateRubric(criteria);
  const resolved = resolveCriteria(criteria);
  const executionOrder = getExecutionOrder(criteria);

  log(`Evaluating ${executionOrder.length} criteria: ${executionOrder.join(', ')}`);

  const results: CriterionResult[] = [];
  const dependencyScores: Record<string, DependencyScore> = {};
  let gateFailure: GateFailure | null = null;

  /** Fields every result carries, whatever the outcome. */
  const base = (criterion: ResolvedCriterion) => {
    const fields: Partial<CriterionResult> = {
      id: criterion.id,
      title: criterion.title,
      weight: criterion.resolvedWeight,
      scorerType: criterion.type,
    };
    if (criterion.scores) fields.allowedScores = criterion.scores;
    return fields;
  };

  const skipped = (criterion: ResolvedCriterion, summary: string): EvaluatedResult => ({
    ...base(criterion),
    score: null,
    summary,
    status: 'skipped',
  } as EvaluatedResult);

  const errored = (
    criterion: ResolvedCriterion,
    error: string,
    model?: string,
  ): EvaluatedResult => {
    const result = {
      ...base(criterion),
      score: null,
      summary: `Scorer error: ${error}`,
      status: 'error',
      error,
    } as EvaluatedResult;
    if (model) result.model = model;
    const logPath = logPathFor?.(criterion);
    if (logPath) result.logPath = logPath;
    return result;
  };

  const completed = (
    criterion: ResolvedCriterion,
    output: ScorerOutput,
    model?: string,
  ): EvaluatedResult => {
    const result = {
      ...base(criterion),
      score: output.score,
      summary: output.summary,
      status: 'completed',
    } as EvaluatedResult;
    if (model) result.model = model;
    const logPath = logPathFor?.(criterion);
    if (logPath) result.logPath = logPath;
    if (output.screenshots && output.screenshots.length > 0) {
      result.screenshots = output.screenshots.map((f) => (screenshotKey ? screenshotKey(f) : f));
    }
    if (output.artifacts && output.artifacts.length > 0) {
      result.artifacts = output.artifacts;
    }
    return result;
  };

  /** Record a result, publish it to dependents, and emit `criterion.completed`. */
  const record = (result: EvaluatedResult, startedAt: number): void => {
    results.push(result);
    dependencyScores[result.id] = { score: result.score, summary: result.summary };
    if (result.status === 'skipped') {
      log(`  ${result.id}: SKIPPED - ${result.summary}`);
    } else if (result.status === 'error') {
      log(`  ${result.id}: ERROR - ${result.error}`);
    } else {
      log(
        `  ${result.id}: ${result.score !== null ? result.score.toFixed(2) : 'N/A'} - ${result.summary}`,
      );
    }
    emit({
      event: 'criterion.completed',
      data: {
        id: result.id,
        score: result.score,
        durationMs: now() - startedAt,
        status: result.status,
      },
    });
  };

  const dependencyScoresFor = (criterion: ResolvedCriterion): Record<string, DependencyScore> =>
    Object.fromEntries(
      criterion.resolvedDependencies.map((name) => [name, dependencyScores[name]]),
    );

  for (const criterionName of executionOrder) {
    const criterion = resolved.find((c) => c.id === criterionName)!;
    const criterionStart = now();
    emit({ event: 'criterion.started', data: { id: criterion.id } });

    // A failed gate skips every remaining criterion. The report is run
    // separately by the caller and is unaffected.
    if (gateFailure) {
      progress(`Skipping: ${criterion.id} (gate failed: ${gateFailure.criterion})`);
      record(
        skipped(
          criterion,
          `Skipped: gate criterion "${gateFailure.criterion}" failed (scored ${gateFailure.score ?? 'null'}, required ${gateFailure.threshold})`,
        ),
        criterionStart,
      );
      continue;
    }

    // Capture-degraded runs: a judge whose evidence a failed capture step
    // destroyed is skipped (score: null) — never scored against missing
    // evidence. Aggregates whose dependencies were ALL skipped have nothing to
    // aggregate and skip likewise (mixed null/scored deps proceed;
    // runAggregate ignores nulls).
    const blockedEvidence = blockedJudgeEvidence(criterion, failedEvidence);
    if (blockedEvidence.length > 0) {
      const summary = `Skipped: required evidence unavailable (${blockedEvidence.join(', ')}) — a capture step failed before evaluation`;
      progress(`Skipping: ${criterion.id} (evidence unavailable)`);
      record(skipped(criterion, summary), criterionStart);
      continue;
    }
    const aggregateStarved =
      criterion.type === 'aggregate' &&
      criterion.resolvedDependencies.length > 0 &&
      criterion.resolvedDependencies.every((name) => dependencyScores[name]?.score === null);
    if (aggregateStarved) {
      // Why the dependencies are null decides the outcome: skipped deps mean
      // the aggregate was never reachable (skipped); an errored dep means the
      // scorer failed, and that failure must not read as a skip.
      const erroredDeps = criterion.resolvedDependencies.filter(
        (name) => results.find((r) => r.id === name)?.status === 'error',
      );
      if (erroredDeps.length > 0) {
        const reason =
          erroredDeps.length === criterion.resolvedDependencies.length
            ? 'Nothing to aggregate: every dependency errored'
            : `Nothing to aggregate: dependencies errored (${erroredDeps.join(', ')}) and the rest were skipped`;
        progress(`Scoring: ${criterion.id} (${reason})`);
        record(errored(criterion, reason), criterionStart);
      } else {
        progress(`Skipping: ${criterion.id} (dependencies skipped)`);
        record(skipped(criterion, 'Skipped: every dependency was skipped, nothing to aggregate'), criterionStart);
      }
      continue;
    }

    progress(`Scoring: ${criterion.id}`);

    let result: EvaluatedResult;
    if (criterion.type === 'aggregate') {
      try {
        result = completed(
          criterion,
          runAggregate(criterion.aggregate, dependencyScoresFor(criterion), criteria),
        );
      } catch (err) {
        result = errored(criterion, errorMessage(err));
      }
    } else if (criterion.type === 'script') {
      try {
        result = completed(criterion, await scorers.script(criterion));
      } catch (err) {
        // Script criteria resolve their own exit codes to scores; reaching
        // here means the container or the exec itself failed.
        result = errored(criterion, errorMessage(err));
      }
    } else {
      let model: string | undefined;
      try {
        const config = buildScorerConfig(criterion, paths, dependencyScoresFor(criterion));
        model = config.model;
        const run = await scorers.llm(criterion, config);
        result = run.ok
          ? completed(criterion, run.output, model)
          : errored(criterion, run.error, model);
      } catch (err) {
        result = errored(criterion, errorMessage(err), model);
      }
    }

    record(result, criterionStart);

    // Gates: only a completed criterion has a verdict to gate on. An errored
    // one is not a gate failure — it would otherwise silently skip every
    // criterion after it on a transient API error.
    if (criterion.gate !== undefined && !gateFailure) {
      if (result.status === 'error') {
        log(`Gate on "${criterion.id}" not evaluated: scorer error`);
      } else if (!checkGate(result.score, criterion.gate)) {
        const threshold = getGateThreshold(criterion.gate);
        gateFailure = { criterion: criterion.id, score: result.score, threshold };
        progress(
          `Gate failed: ${criterion.id} scored ${result.score ?? 'null'} (required ${threshold}). Skipping remaining criteria.`,
        );
      }
    }
  }

  return { results, dependencyScores, gateFailure };
}

/**
 * True when the platform could not grade the run at all: the rubric had at
 * least one LLM-backed criterion and every one of them errored. The executor
 * marks such a run failed (phase `evaluation`), which is what makes `bn run`
 * exit 5. Any other mix — one error among several scores, or a rubric with no
 * LLM criteria at all — is a normal, saved evaluation.
 */
export function allLLMCriteriaErrored(results: CriterionResult[]): boolean {
  const llmResults = results.filter((r) => LLM_SCORER_TYPES.has(r.scorerType));
  return llmResults.length > 0 && llmResults.every((r) => r.status === 'error');
}
