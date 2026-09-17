import type {
  EvaluationResult,
  CriterionResult,
  AllowedScores,
} from '@bunsen-dev/types';

/**
 * The score cell for one criterion.
 *
 * A `null` score means different things depending on why: `error` is "the
 * scorer could not produce a verdict" (excluded from the weighted score, and
 * explicitly *not* a zero the agent earned), `skipped` is "an upstream gate
 * closed", and a plain `null` on a completed criterion is an observation-only
 * note. They must not all read as `N/A`.
 */
function formatScoreCell(criterion: CriterionResult): string {
  if (criterion.status === 'error') return 'ERROR';
  if (criterion.status === 'skipped') return 'SKIPPED';
  return formatScore(criterion.score, criterion.allowedScores);
}

/**
 * Format a score value for display
 */
function formatScore(score: number | null, allowedScores?: AllowedScores): string {
  if (score === null) return 'N/A';

  // If we have labeled scores, find the label
  if (allowedScores && !Array.isArray(allowedScores)) {
    const label = allowedScores[score];
    if (label) {
      return `${score.toFixed(2)} (${label})`;
    }
  }

  return score.toFixed(2);
}

/**
 * Format evaluation results for terminal display (0-1 scores)
 */
export function formatEvaluationForTerminal(result: EvaluationResult, runDir?: string): string {
  const lines: string[] = [];

  lines.push('Evaluation Results');
  lines.push('='.repeat(60));

  // Scores section
  for (const criterion of result.criteria) {
    const scoreStr = formatScoreCell(criterion);
    const weightStr = criterion.weight === 0 ? ' (observation only)' : '';

    lines.push(`\n${criterion.id}: ${scoreStr}${weightStr}`);
    // An errored criterion's summary is synthesized from its error; print the
    // error once rather than the same text twice.
    const summaryIsError =
      criterion.status === 'error' && criterion.summary === `Scorer error: ${criterion.error}`;
    if (!summaryIsError) lines.push(`  ${criterion.summary}`);

    // Why there is no verdict, verbatim from the scorer.
    if (criterion.error) {
      lines.push(`  Error: ${criterion.error}`);
    }

    // Provenance: which model produced this score.
    if (criterion.model) {
      lines.push(`  Model: ${criterion.model}`);
    }

    // Show log path for code-based scorers
    if (criterion.logPath) {
      const displayPath = runDir ? `${runDir}/${criterion.logPath}` : criterion.logPath;
      lines.push(`  Log: ${displayPath}`);
    }

    // Show screenshots if present
    if (criterion.screenshots && criterion.screenshots.length > 0) {
      for (const screenshot of criterion.screenshots) {
        // If runDir is provided, show full clickable path for VS Code terminal
        const displayPath = runDir ? `${runDir}/${screenshot}` : screenshot;
        lines.push(`  Screenshot: ${displayPath}`);
      }
    }
  }

  lines.push('\n' + '-'.repeat(60));
  lines.push(`Weighted Score: ${result.weightedScore.toFixed(2)} (0-1 scale)`);

  // Report section (if present). A configured report that failed is recorded,
  // not thrown — say so rather than silently omitting the section.
  if (result.report) {
    lines.push('\n' + '='.repeat(60));
    lines.push('Report');
    lines.push('='.repeat(60));
    lines.push(result.report);
  } else if (result.reportError) {
    lines.push('\n' + '='.repeat(60));
    lines.push(`Report: not generated — ${result.reportError}`);
  }

  return lines.join('\n');
}
