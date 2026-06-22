// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `bn eval show` — show evaluator scores for a run.
 */

import chalk from 'chalk';
import { loadEvaluationResult, getRunDir } from '@bunsen-dev/runtime';
import { formatEvaluationForTerminal } from './helpers/format-scores-for-terminal.js';
import { resolveFormat, isMachineFormat, renderMachine } from '../format.js';

interface ScoresOptions {
  format?: string;
}

export async function scoresCommand(runId: string, options: ScoresOptions = {}): Promise<void> {
  const format = resolveFormat(options);
  const result = loadEvaluationResult(runId);

  if (isMachineFormat(format)) {
    process.stdout.write(renderMachine(result ?? null, format));
    return;
  }

  if (!result) {
    console.log(chalk.dim('No scores found for this run'));
    console.log(chalk.dim('Run evaluation may have been skipped or is still in progress'));
    return;
  }

  const runDir = getRunDir(runId);
  console.log();
  console.log(formatEvaluationForTerminal(result, runDir));
  console.log();
}
