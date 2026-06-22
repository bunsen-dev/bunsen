// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import type {
  EvaluationResult,
  AllowedScores,
} from '@bunsen-dev/types';

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
    const scoreStr = formatScore(criterion.score, criterion.allowedScores);
    const weightStr = criterion.weight === 0 ? ' (observation only)' : '';

    lines.push(`\n${criterion.id}: ${scoreStr}${weightStr}`);
    lines.push(`  ${criterion.summary}`);

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

  // Report section (if present)
  if (result.report) {
    lines.push('\n' + '='.repeat(60));
    lines.push('Report');
    lines.push('='.repeat(60));
    lines.push(result.report);
  }

  return lines.join('\n');
}
