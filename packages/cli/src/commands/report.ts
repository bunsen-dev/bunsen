// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Report command - Show the evaluation report for a run
 *
 * Outputs the markdown report from the evaluator, which provides
 * a readable narrative of what happened during the run.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import chalk from 'chalk';
import { loadEvaluationResult, loadRunManifest, getRunDir, RUN_PATHS } from '@bunsen-dev/runtime';

interface ReportOptions {
  save?: boolean;
  open?: boolean;
}

export async function reportCommand(runId: string, options: ReportOptions): Promise<void> {
  try {
    if (!loadRunManifest(runId)) {
      console.error(chalk.red(`Run not found: ${runId}`));
      process.exit(1);
    }

    const evaluation = loadEvaluationResult(runId);

    if (!evaluation) {
      console.log(chalk.dim('No evaluation found for this run'));
      console.log(chalk.dim('Run evaluation may have been skipped or is still in progress'));
      return;
    }

    if (!evaluation.report) {
      console.log(chalk.dim('No report found in evaluation results'));
      return;
    }

    // Open in system default viewer
    if (options.open) {
      const tempPath = path.join(os.tmpdir(), `bunsen-report-${runId}.md`);
      fs.writeFileSync(tempPath, evaluation.report);

      const platform = os.platform();
      const openCommand =
        platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';

      exec(`${openCommand} "${tempPath}"`, (error) => {
        if (error) {
          console.error(chalk.red(`Failed to open report: ${error.message}`));
        }
      });
      return;
    }

    // Output the report to stdout
    console.log(evaluation.report);

    // Optionally save to file (always available; saveEvaluationResult also
    // writes evaluation/report.md, but `--save` lets the user write it
    // wherever they prefer).
    if (options.save) {
      const runDir = getRunDir(runId);
      const reportPath = path.join(runDir, RUN_PATHS.evaluationReport);
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, evaluation.report);
      console.log();
      console.log(chalk.green(`Report saved to: ${reportPath}`));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Error: ${message}`));
    process.exit(1);
  }
}
