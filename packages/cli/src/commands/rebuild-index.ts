// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `bn rebuild-index` — rebuild the SQLite run index from manifest.json files.
 *
 * Every run dir is born with a `manifest.json`, so this is now a pure
 * upsert: scan run dirs, read each manifest, replace the index. Run dirs
 * without a `manifest.json` are skipped and reported.
 */
import chalk from 'chalk';
import { rebuildIndex, getRunIndexPath } from '@bunsen-dev/runtime';
import { resolveFormat, isMachineFormat, renderMachine } from '../format.js';

interface RebuildIndexOptions {
  format?: string;
}

export async function rebuildIndexCommand(options: RebuildIndexOptions): Promise<void> {
  const format = resolveFormat(options);
  try {
    const start = Date.now();
    const report = rebuildIndex();
    const elapsedMs = Date.now() - start;

    if (isMachineFormat(format)) {
      process.stdout.write(
        renderMachine({ ...report, elapsedMs, indexPath: getRunIndexPath() }, format),
      );
      return;
    }

    console.log(chalk.bold('Run index rebuild complete'));
    console.log(`  Indexed runs:    ${chalk.green(report.indexedRuns)}`);
    if (report.skippedRuns.length > 0) {
      console.log(`  Skipped:         ${chalk.yellow(report.skippedRuns.length)} ${report.skippedRuns.length === 1 ? 'run' : 'runs'}`);
      for (const id of report.skippedRuns) {
        console.log(chalk.dim(`    - ${id} (no manifest.json)`));
      }
    }
    console.log(chalk.dim(`  Index path:      ${getRunIndexPath()}`));
    console.log(chalk.dim(`  Elapsed:         ${elapsedMs}ms`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Error: ${message}`));
    process.exit(1);
  }
}
