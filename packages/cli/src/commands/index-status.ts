// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `bn index status` — report SQLite run-index location, size, and freshness.
 *
 * Lightweight read-only view: counts how many runs the index knows about and
 * whether it lags behind the run directory scan. Doesn't touch the index for
 * writes — `bn index rebuild` is the path for that.
 */

import * as fs from 'node:fs';
import chalk from 'chalk';
import {
  countRuns,
  getRunIndexPath,
  getRunsDir,
  openRunIndex,
} from '@bunsen-dev/runtime';
import { formatBytes } from './helpers/format-bytes.js';
import { resolveFormat, isMachineFormat, renderMachine } from '../format.js';

interface IndexStatusOptions {
  format?: string;
}

export async function indexStatusCommand(options: IndexStatusOptions): Promise<void> {
  const format = resolveFormat(options);
  try {
    const indexPath = getRunIndexPath();
    const runsDir = getRunsDir();
    const indexExists = fs.existsSync(indexPath);

    let runDirCount = 0;
    if (fs.existsSync(runsDir)) {
      runDirCount = fs
        .readdirSync(runsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .length;
    }

    let indexedRuns: number | null = null;
    let indexBytes: number | null = null;
    let indexMtime: string | null = null;

    if (indexExists) {
      const stat = fs.statSync(indexPath);
      indexBytes = stat.size;
      indexMtime = stat.mtime.toISOString();
      try {
        const db = openRunIndex(process.cwd(), { readonly: true });
        try {
          indexedRuns = countRuns(db);
        } finally {
          db.close();
        }
      } catch (err) {
        // The index is unreadable; surface that to the user but don't bail.
        const msg = err instanceof Error ? err.message : String(err);
        if (isMachineFormat(format)) {
          process.stdout.write(renderMachine({ indexPath, indexExists, error: msg }, format));
          return;
        }
        console.log(chalk.yellow(`Index exists but could not be opened: ${msg}`));
        console.log(chalk.dim('Try `bn index rebuild`.'));
        return;
      }
    }

    if (isMachineFormat(format)) {
      process.stdout.write(
        renderMachine(
          {
            indexPath,
            indexExists,
            indexBytes,
            indexMtime,
            indexedRuns,
            runDirCount,
            inSync: indexedRuns !== null && indexedRuns === runDirCount,
          },
          format,
        ),
      );
      return;
    }

    if (!indexExists) {
      console.log(chalk.yellow('No run index present.'));
      console.log(chalk.dim(`Expected at: ${indexPath}`));
      console.log(chalk.dim(`Run dirs found: ${runDirCount}`));
      if (runDirCount > 0) {
        console.log(chalk.dim('Run `bn index rebuild` to populate the index.'));
      }
      return;
    }

    console.log(chalk.bold('Run index'));
    console.log(`  Path:           ${indexPath}`);
    if (indexBytes !== null) {
      console.log(chalk.dim(`  Size:           ${formatBytes(indexBytes)}`));
    }
    if (indexMtime) {
      console.log(chalk.dim(`  Last updated:   ${new Date(indexMtime).toLocaleString()}`));
    }
    console.log(`  Indexed runs:   ${indexedRuns ?? 'unknown'}`);
    console.log(`  Run dirs found: ${runDirCount}`);
    if (indexedRuns !== null && indexedRuns !== runDirCount) {
      console.log(chalk.yellow('  Status:         OUT OF SYNC — run `bn index rebuild`.'));
    } else {
      console.log(chalk.green('  Status:         in sync'));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Error: ${message}`));
    process.exit(1);
  }
}

