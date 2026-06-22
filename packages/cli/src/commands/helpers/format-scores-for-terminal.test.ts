// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect } from 'vitest';
import { formatEvaluationForTerminal } from './format-scores-for-terminal.js';
import type { EvaluationResult } from '@bunsen-dev/types';

describe('formatEvaluationForTerminal', () => {
  it('formats evaluation results correctly', () => {
    const result: EvaluationResult = {
      criteria: [
        { id: 'Correctness', weight: 1, score: 0.9, summary: 'All tests pass', status: 'completed', scorerType: 'judge' },
        { id: 'Quality', weight: 1, score: 0.75, summary: 'Good but could be cleaner', status: 'completed', scorerType: 'judge' },
        { id: 'Notes', weight: 0, score: null, summary: 'Agent showed good debugging', status: 'completed', scorerType: 'judge' },
      ],
      weightedScore: 0.825,
      report: '## Summary\nOverall good performance',
    };

    const output = formatEvaluationForTerminal(result);

    expect(output).toContain('Correctness: 0.90');
    expect(output).toContain('All tests pass');
    expect(output).toContain('Quality: 0.75');
    expect(output).toContain('Notes: N/A (observation only)');
    expect(output).toContain('Weighted Score: 0.82 (0-1 scale)');
    expect(output).toContain('Overall good performance');
  });

  it('handles labeled scores', () => {
    const result: EvaluationResult = {
      criteria: [
        {
          id: 'Severity',
          weight: 0,
          score: 0.66,
          summary: 'Moderate issues found',
          status: 'completed',
          scorerType: 'judge',
          allowedScores: { 0: 'none', 0.33: 'minor', 0.66: 'moderate', 1: 'severe' },
        },
      ],
      weightedScore: 0,
    };

    const output = formatEvaluationForTerminal(result);

    expect(output).toContain('Severity: 0.66 (moderate)');
    expect(output).toContain('Moderate issues found');
  });

  it('handles missing report gracefully', () => {
    const result: EvaluationResult = {
      criteria: [
        { id: 'Test', weight: 1, score: 0.8, summary: 'Passed', status: 'completed', scorerType: 'judge' },
      ],
      weightedScore: 0.8,
    };

    const output = formatEvaluationForTerminal(result);

    expect(output).toContain('Test: 0.80');
    expect(output).not.toContain('Report');
  });

  it('displays screenshots when present', () => {
    const result: EvaluationResult = {
      criteria: [
        {
          id: 'Visual Design',
          weight: 1,
          score: 0.9,
          summary: 'Good visual design',
          status: 'completed',
          scorerType: 'browser-agent',
          screenshots: ['screenshots/visual-design-1.png', 'screenshots/visual-design-2.png'],
        },
      ],
      weightedScore: 0.9,
    };

    const output = formatEvaluationForTerminal(result);

    expect(output).toContain('Visual Design: 0.90');
    expect(output).toContain('Screenshot: screenshots/visual-design-1.png');
    expect(output).toContain('Screenshot: screenshots/visual-design-2.png');
  });

  it('shows full path when runDir is provided', () => {
    const result: EvaluationResult = {
      criteria: [
        {
          id: 'Visual',
          weight: 1,
          score: 0.8,
          summary: 'Looks good',
          status: 'completed',
          scorerType: 'browser-agent',
          screenshots: ['screenshots/visual-1.png'],
        },
      ],
      weightedScore: 0.8,
    };

    const output = formatEvaluationForTerminal(result, '/path/to/.bunsen/runs/abc123');

    expect(output).toContain('Screenshot: /path/to/.bunsen/runs/abc123/screenshots/visual-1.png');
  });
});
