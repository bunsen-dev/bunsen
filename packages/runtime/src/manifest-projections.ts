// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Pure projections from the in-process evaluation/usage types onto
 * `RunManifestV1` sub-shapes (camelCase → snake_case). Lives here so the
 * storage layer (storage.ts) doesn't have to inline both the field-by-field
 * translation AND every other concern.
 *
 * The in-process `CriterionResult.scorerType` already uses the public
 * {@link RunManifestScorerType} vocabulary (`judge`/`script`/…), so projecting
 * it is now a passthrough — no enum remap.
 *
 * No I/O, no mutation of inputs — every helper returns a fresh object. Used
 * by storage writers when they need to refresh the manifest's projection
 * fields after persisting a new artifact file.
 */

import type {
  EvaluationResult,
  CriterionResult,
  HumanScores,
  SourceCostBreakdown,
  TracesSummary,
  RunManifestCriterion,
  RunManifestEvaluation,
  RunManifestHumanCriterion,
  RunManifestHumanScoring,
  RunManifestUsageSource,
} from '@bunsen-dev/types';

export function buildCriterionProjection(c: CriterionResult): RunManifestCriterion {
  const out: RunManifestCriterion = {
    id: c.id,
    weight: c.weight,
    score: c.score,
    summary: c.summary,
  };
  if (c.status) out.status = c.status;
  if (c.scorerType) out.scorer_type = c.scorerType;
  if (c.allowedScores !== undefined) out.allowed_scores = c.allowedScores;
  if (c.screenshots && c.screenshots.length > 0) out.screenshots = [...c.screenshots];
  if (c.logPath) out.log_path = c.logPath;
  return out;
}

export function buildEvaluationProjection(result: EvaluationResult): RunManifestEvaluation {
  const ev: RunManifestEvaluation = {
    weighted_score: result.weightedScore,
    criteria: result.criteria.map(buildCriterionProjection),
  };
  if (result.report) ev.report = result.report;
  return ev;
}

export function buildHumanScoringProjection(scores: HumanScores): RunManifestHumanScoring {
  const criteria: RunManifestHumanCriterion[] = scores.criteria.map((c) => {
    const out: RunManifestHumanCriterion = {
      id: c.criterion,
      human_score: c.humanScore,
      llm_score: c.llmScore,
    };
    if (c.notes) out.notes = c.notes;
    if (c.allowedScores !== undefined) out.allowed_scores = c.allowedScores;
    return out;
  });
  return {
    scored_by: scores.scoredBy,
    scored_at: scores.scoredAt,
    criteria,
  };
}

/**
 * Build the manifest's `usage.by_source` projection from the trace
 * summary's per-source breakdown. Returns `undefined` when there's
 * nothing to project.
 */
export function projectUsageBreakdown(
  summary: TracesSummary | undefined,
): Record<string, RunManifestUsageSource> | undefined {
  if (!summary?.bySource) return undefined;
  const bySource = summary.bySource;
  const entries: Record<string, RunManifestUsageSource> = {};

  const project = (key: string, src: SourceCostBreakdown | undefined) => {
    if (!src || src.calls === 0) return;
    entries[key] = {
      calls: src.calls,
      input_tokens: src.inputTokens,
      output_tokens: src.outputTokens,
      cache_read_input_tokens: src.cacheReadInputTokens,
      cache_creation_input_tokens: src.cacheCreationInputTokens,
      cost_usd: src.costUsd,
    };
  };

  project('agent', bySource.agent);
  project('platform', bySource.platform);
  if (bySource.orchestrator) project('orchestrator', bySource.orchestrator);
  if (bySource.supervisor) project('supervisor', bySource.supervisor);
  if (bySource.scorer) project('scorer', bySource.scorer);
  if (bySource.scorers) {
    for (const [criterion, src] of Object.entries(bySource.scorers)) {
      project(`scorer:${criterion}`, src);
    }
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
}
