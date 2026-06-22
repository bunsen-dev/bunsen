// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Calibration calculations - compare human vs LLM scores
 */

import type {
  HumanScores,
  EvaluationResult,
  CalibrationCriterionStats,
  CalibrationResult,
  RunManifestScorerType,
} from '@bunsen-dev/types';

/**
 * A paired set of human and LLM scores for one run
 */
export interface RunScorePair {
  runId: string;
  experimentId: string;
  humanScores: HumanScores;
  evaluationResult: EvaluationResult;
}

/**
 * Compute calibration statistics from paired human/LLM scores
 */
export function computeCalibration(pairs: RunScorePair[]): CalibrationResult {
  // Group all score pairs by criterion name
  const byCriterion = new Map<
    string,
    {
      deltas: number[]; // human - llm (signed)
      scorerType: RunManifestScorerType;
    }
  >();

  for (const pair of pairs) {
    for (const hs of pair.humanScores.criteria) {
      const llmCriterion = pair.evaluationResult.criteria.find(
        (c) => c.id === hs.criterion
      );
      if (!llmCriterion || llmCriterion.score === null || hs.llmScore === null) continue;

      const entry = byCriterion.get(hs.criterion) || {
        deltas: [],
        scorerType: llmCriterion.scorerType,
      };
      entry.deltas.push(hs.humanScore - hs.llmScore);
      byCriterion.set(hs.criterion, entry);
    }
  }

  // Per-criterion stats
  const criteriaStats: CalibrationCriterionStats[] = [];
  const allDeltas: number[] = [];
  const byScorerType = new Map<string, number[]>();

  for (const [criterion, data] of byCriterion) {
    const mae = data.deltas.reduce((s, d) => s + Math.abs(d), 0) / data.deltas.length;
    const meanSignedError = data.deltas.reduce((s, d) => s + d, 0) / data.deltas.length;

    criteriaStats.push({
      criterion,
      count: data.deltas.length,
      meanAbsoluteError: mae,
      meanSignedError,
      scorerType: data.scorerType,
    });

    allDeltas.push(...data.deltas);

    const type = data.scorerType;
    const typeDeltas = byScorerType.get(type) || [];
    typeDeltas.push(...data.deltas);
    byScorerType.set(type, typeDeltas);
  }

  // Sort by MAE descending (worst offenders first)
  criteriaStats.sort((a, b) => b.meanAbsoluteError - a.meanAbsoluteError);

  // Overall stats
  const overallMAE =
    allDeltas.length > 0
      ? allDeltas.reduce((s, d) => s + Math.abs(d), 0) / allDeltas.length
      : 0;
  const overallMeanSignedError =
    allDeltas.length > 0 ? allDeltas.reduce((s, d) => s + d, 0) / allDeltas.length : 0;

  // Per scorer-type
  const byScorerTypeResult: Record<string, { mae: number; meanSignedError: number; count: number }> = {};
  for (const [type, deltas] of byScorerType) {
    byScorerTypeResult[type] = {
      mae: deltas.reduce((s, d) => s + Math.abs(d), 0) / deltas.length,
      meanSignedError: deltas.reduce((s, d) => s + d, 0) / deltas.length,
      count: deltas.length,
    };
  }

  return {
    criteria: criteriaStats,
    overallMAE,
    overallMeanSignedError,
    runCount: pairs.length,
    byScorerType: byScorerTypeResult,
  };
}
