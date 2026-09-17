import { describe, it, expect } from 'bun:test';
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

  it('renders an errored criterion as ERROR with the scorer error', () => {
    const result: EvaluationResult = {
      criteria: [
        {
          id: 'design-quality',
          weight: 1,
          score: null,
          summary: 'Scorer error: the scorer produced no verdict',
          status: 'error',
          scorerType: 'agent',
          error: 'no verdict: the forced submit_score call was not made',
        },
        { id: 'tests-pass', weight: 1, score: 1, summary: 'All 42 tests pass', status: 'completed', scorerType: 'script' },
      ],
      weightedScore: 1,
    };

    const output = formatEvaluationForTerminal(result);

    expect(output).toContain('design-quality: ERROR');
    expect(output).not.toContain('design-quality: N/A');
    expect(output).toContain('Scorer error: the scorer produced no verdict');
    expect(output).toContain('Error: no verdict: the forced submit_score call was not made');
    // The siblings still render normally.
    expect(output).toContain('tests-pass: 1.00');
  });

  it('renders a gate-skipped criterion as SKIPPED', () => {
    const result: EvaluationResult = {
      criteria: [
        {
          id: 'deep-review',
          weight: 2,
          score: null,
          summary: 'Skipped: gate `tests-pass` did not pass',
          status: 'skipped',
          scorerType: 'judge',
        },
      ],
      weightedScore: 0,
    };

    const output = formatEvaluationForTerminal(result);

    expect(output).toContain('deep-review: SKIPPED');
    expect(output).toContain('Skipped: gate `tests-pass` did not pass');
  });

  it('shows the scoring model for LLM-backed criteria', () => {
    const result: EvaluationResult = {
      criteria: [
        {
          id: 'rubric',
          weight: 1,
          score: 0.5,
          summary: 'Partly met',
          status: 'completed',
          scorerType: 'judge',
          model: 'openai/gpt-5.5',
        },
        { id: 'tests-pass', weight: 1, score: 1, summary: 'Green', status: 'completed', scorerType: 'script' },
      ],
      weightedScore: 0.75,
    };

    const output = formatEvaluationForTerminal(result);

    expect(output).toContain('Model: openai/gpt-5.5');
    // Script criteria carry no model, so no empty row is printed.
    expect(output.match(/Model:/g)).toHaveLength(1);
  });

  it('reports a failed report instead of omitting the section', () => {
    const result: EvaluationResult = {
      criteria: [
        { id: 'tests-pass', weight: 1, score: 1, summary: 'Green', status: 'completed', scorerType: 'script' },
      ],
      weightedScore: 1,
      reportError: 'report scorer exited 1',
    };

    const output = formatEvaluationForTerminal(result);

    expect(output).toContain('Report: not generated — report scorer exited 1');
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
