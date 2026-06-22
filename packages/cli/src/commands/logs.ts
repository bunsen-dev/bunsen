// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Logs command - Show logs for a run
 */

import chalk from 'chalk';
import { loadLogs } from '@bunsen-dev/runtime';

export async function logsCommand(runId: string): Promise<void> {
  try {
    const logs = loadLogs(runId);

    if (!logs) {
      console.log(chalk.dim('No logs found for this run'));
      return;
    }

    console.log(logs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Error: ${message}`));
    process.exit(1);
  }
}
