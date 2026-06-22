// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Diff command - Show workspace changes from a run
 */

import chalk from 'chalk';
import { loadWorkspaceDiff, filterLockfilesFromDiff } from '@bunsen-dev/runtime';

interface DiffOptions {
  includeLockfiles?: boolean;
}

export async function diffCommand(runId: string, options: DiffOptions): Promise<void> {
  try {
    let diff = loadWorkspaceDiff(runId);

    if (!diff) {
      console.log(chalk.yellow('No workspace diff available for this run.'));
      console.log(chalk.dim('(The experiment may not have had a workspace, or the run predates workspace isolation.)'));
      return;
    }

    if (diff.startsWith('# No changes detected')) {
      console.log(chalk.green('No workspace changes detected.'));
      return;
    }

    if (diff.startsWith('# Error')) {
      console.log(chalk.red(diff));
      return;
    }

    // Filter lockfiles unless --include-lockfiles is passed
    if (!options.includeLockfiles) {
      diff = filterLockfilesFromDiff(diff);
      if (!diff.trim()) {
        console.log(chalk.green('No workspace changes detected (only lockfile changes).'));
        return;
      }
    }

    // Output the diff with syntax highlighting
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) {
        console.log(chalk.bold(line));
      } else if (line.startsWith('+')) {
        console.log(chalk.green(line));
      } else if (line.startsWith('-')) {
        console.log(chalk.red(line));
      } else if (line.startsWith('@@')) {
        console.log(chalk.cyan(line));
      } else if (line.startsWith('diff ')) {
        console.log(chalk.bold.blue(line));
      } else {
        console.log(line);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Error: ${message}`));
    process.exit(1);
  }
}
