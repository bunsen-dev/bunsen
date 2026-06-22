// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for calibration calculations
 */

import { describe, it, expect } from 'vitest';
import { computeCalibration } from './calibration.js';
import type { RunScorePair } from './calibration.js';
import type {
  EvaluationResult,
  HumanScores,
} from '@bunsen-dev/types';

function makePair(
  overrides: {
    runId?: string;
    experimentId?: string;
    humanCriteria?: { criterion: string; humanScore: number; llmScore: number | null }[];
    llmCriteria?: {
      criterion: string;
      score: number | null;
      scorerType?: string;
      weight?: number;
    }[];
  } = {}
): RunScorePair {
  const {
    runId = 'run1',
    experimentId = 'exp1',
    humanCriteria = [],
    llmCriteria = [],
  } = overrides;

  const humanScores: HumanScores = {
    criteria: humanCriteria.map((c) => ({
      criterion: c.criterion,
      humanScore: c.humanScore,
      llmScore: c.llmScore,
    })),
    scoredBy: 'tester',
    scoredAt: '2026-02-28T12:00:00Z',
  };

  const evaluationResult: EvaluationResult = {
    criteria: llmCriteria.map((c) => ({
      id: c.criterion,
      weight: c.weight ?? 1,
      score: c.score,
      summary: 'test',
      status: 'completed',
      scorerType: (c.scorerType as EvaluationResult['criteria'][0]['scorerType']) ?? 'judge',
    })),
    weightedScore: 0.5,
  };

  return { runId, experimentId, humanScores, evaluationResult };
}

describe('computeCalibration', () => {
  it('computes basic stats for a single run, single criterion', () => {
    const pair = makePair({
      humanCriteria: [{ criterion: 'Quality', humanScore: 0.5, llmScore: 0.9 }],
      llmCriteria: [{ criterion: 'Quality', score: 0.9 }],
    });

    const result = computeCalibration([pair]);

    expect(result.runCount).toBe(1);
    expect(result.criteria).toHaveLength(1);
    expect(result.criteria[0].criterion).toBe('Quality');
    expect(result.criteria[0].count).toBe(1);
    expect(result.criteria[0].meanAbsoluteError).toBeCloseTo(0.4);
    // human (0.5) - llm (0.9) = -0.4, negative = LLM over-scores
    expect(result.criteria[0].meanSignedError).toBeCloseTo(-0.4);
    expect(result.overallMAE).toBeCloseTo(0.4);
    expect(result.overallMeanSignedError).toBeCloseTo(-0.4);
  });

  it('averages across multiple runs for the same criterion', () => {
    const pair1 = makePair({
      runId: 'run1',
      humanCriteria: [{ criterion: 'Quality', humanScore: 0.5, llmScore: 0.9 }],
      llmCriteria: [{ criterion: 'Quality', score: 0.9 }],
    });
    const pair2 = makePair({
      runId: 'run2',
      humanCriteria: [{ criterion: 'Quality', humanScore: 0.7, llmScore: 0.9 }],
      llmCriteria: [{ criterion: 'Quality', score: 0.9 }],
    });

    const result = computeCalibration([pair1, pair2]);

    expect(result.runCount).toBe(2);
    expect(result.criteria).toHaveLength(1);
    expect(result.criteria[0].count).toBe(2);
    // deltas: -0.4, -0.2 → MAE = (0.4+0.2)/2 = 0.3, MSE = (-0.4+-0.2)/2 = -0.3
    expect(result.criteria[0].meanAbsoluteError).toBeCloseTo(0.3);
    expect(result.criteria[0].meanSignedError).toBeCloseTo(-0.3);
  });

  it('handles multiple criteria with different scorer types', () => {
    const pair = makePair({
      humanCriteria: [
        { criterion: 'Visual', humanScore: 0.3, llmScore: 0.8 },
        { criterion: 'Code', humanScore: 0.9, llmScore: 0.7 },
      ],
      llmCriteria: [
        { criterion: 'Visual', score: 0.8, scorerType: 'browser-agent' },
        { criterion: 'Code', score: 0.7, scorerType: 'judge' },
      ],
    });

    const result = computeCalibration([pair]);

    expect(result.criteria).toHaveLength(2);
    // Sorted by MAE descending: Visual (0.5) then Code (0.2)
    expect(result.criteria[0].criterion).toBe('Visual');
    expect(result.criteria[0].meanAbsoluteError).toBeCloseTo(0.5);
    expect(result.criteria[0].scorerType).toBe('browser-agent');
    expect(result.criteria[1].criterion).toBe('Code');
    expect(result.criteria[1].meanAbsoluteError).toBeCloseTo(0.2);
    expect(result.criteria[1].scorerType).toBe('judge');

    // Per scorer type breakdown
    expect(result.byScorerType['browser-agent']).toBeDefined();
    expect(result.byScorerType['browser-agent'].mae).toBeCloseTo(0.5);
    expect(result.byScorerType['browser-agent'].count).toBe(1);
    expect(result.byScorerType['judge']).toBeDefined();
    expect(result.byScorerType['judge'].mae).toBeCloseTo(0.2);
  });

  it('reports positive MSE when LLM under-scores', () => {
    // Human says 0.9, LLM says 0.5 → human - llm = +0.4
    const pair = makePair({
      humanCriteria: [{ criterion: 'Quality', humanScore: 0.9, llmScore: 0.5 }],
      llmCriteria: [{ criterion: 'Quality', score: 0.5 }],
    });

    const result = computeCalibration([pair]);

    expect(result.overallMeanSignedError).toBeCloseTo(0.4); // positive = LLM under-scores
  });

  it('reports negative MSE when LLM over-scores', () => {
    // Human says 0.3, LLM says 0.8 → human - llm = -0.5
    const pair = makePair({
      humanCriteria: [{ criterion: 'Quality', humanScore: 0.3, llmScore: 0.8 }],
      llmCriteria: [{ criterion: 'Quality', score: 0.8 }],
    });

    const result = computeCalibration([pair]);

    expect(result.overallMeanSignedError).toBeCloseTo(-0.5); // negative = LLM over-scores
  });

  it('skips criteria with null LLM scores', () => {
    const pair = makePair({
      humanCriteria: [
        { criterion: 'Good', humanScore: 0.5, llmScore: 0.8 },
        { criterion: 'Null', humanScore: 0.5, llmScore: null },
      ],
      llmCriteria: [
        { criterion: 'Good', score: 0.8 },
        { criterion: 'Null', score: null },
      ],
    });

    const result = computeCalibration([pair]);

    expect(result.criteria).toHaveLength(1);
    expect(result.criteria[0].criterion).toBe('Good');
  });

  it('skips criteria where human llmScore is null', () => {
    const pair = makePair({
      humanCriteria: [{ criterion: 'Quality', humanScore: 0.5, llmScore: null }],
      llmCriteria: [{ criterion: 'Quality', score: 0.8 }],
    });

    const result = computeCalibration([pair]);

    expect(result.criteria).toHaveLength(0);
    expect(result.overallMAE).toBe(0);
  });

  it('returns zeros for empty input', () => {
    const result = computeCalibration([]);

    expect(result.runCount).toBe(0);
    expect(result.criteria).toHaveLength(0);
    expect(result.overallMAE).toBe(0);
    expect(result.overallMeanSignedError).toBe(0);
    expect(result.byScorerType).toEqual({});
  });

  it('sorts criteria by MAE descending', () => {
    const pair = makePair({
      humanCriteria: [
        { criterion: 'Small', humanScore: 0.5, llmScore: 0.6 },
        { criterion: 'Big', humanScore: 0.1, llmScore: 0.9 },
        { criterion: 'Medium', humanScore: 0.5, llmScore: 0.8 },
      ],
      llmCriteria: [
        { criterion: 'Small', score: 0.6 },
        { criterion: 'Big', score: 0.9 },
        { criterion: 'Medium', score: 0.8 },
      ],
    });

    const result = computeCalibration([pair]);

    expect(result.criteria[0].criterion).toBe('Big'); // MAE 0.8
    expect(result.criteria[1].criterion).toBe('Medium'); // MAE 0.3
    expect(result.criteria[2].criterion).toBe('Small'); // MAE 0.1
  });

  it('computes overall stats across all criteria', () => {
    const pair = makePair({
      humanCriteria: [
        { criterion: 'A', humanScore: 0.5, llmScore: 0.9 }, // delta -0.4
        { criterion: 'B', humanScore: 0.8, llmScore: 0.6 }, // delta +0.2
      ],
      llmCriteria: [
        { criterion: 'A', score: 0.9 },
        { criterion: 'B', score: 0.6 },
      ],
    });

    const result = computeCalibration([pair]);

    // Overall MAE = (0.4 + 0.2) / 2 = 0.3
    expect(result.overallMAE).toBeCloseTo(0.3);
    // Overall MSE = (-0.4 + 0.2) / 2 = -0.1
    expect(result.overallMeanSignedError).toBeCloseTo(-0.1);
  });

  it('skips criteria not found in LLM results', () => {
    const pair = makePair({
      humanCriteria: [{ criterion: 'Missing', humanScore: 0.5, llmScore: 0.8 }],
      llmCriteria: [{ criterion: 'Different', score: 0.8 }],
    });

    const result = computeCalibration([pair]);

    expect(result.criteria).toHaveLength(0);
  });
});
