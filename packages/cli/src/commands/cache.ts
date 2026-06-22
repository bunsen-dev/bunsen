// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Cache commands - list and clear build / deps cache entries.
 */

import chalk from 'chalk';
import { confirm } from './helpers/prompt.js';
import {
  clearBuildCache,
  clearDepsCache,
  listBuildCacheEntries,
  listDepsCacheEntries,
} from '@bunsen-dev/runtime';
import { formatBytes } from './helpers/format-bytes.js';
import { resolveFormat, isMachineFormat, renderMachine } from '../format.js';

interface CacheListOptions {
  format?: string;
}

interface CacheCleanOptions {
  force?: boolean;
}

export async function cacheListCommand(options: CacheListOptions): Promise<void> {
  const format = resolveFormat(options);
  try {
    const buildEntries = listBuildCacheEntries(process.cwd());
    const depsEntries = listDepsCacheEntries(process.cwd());

    if (isMachineFormat(format)) {
      process.stdout.write(
        renderMachine(
          {
            build: { count: buildEntries.length, entries: buildEntries },
            deps: { count: depsEntries.length, entries: depsEntries },
          },
          format,
        ),
      );
      return;
    }

    if (buildEntries.length === 0 && depsEntries.length === 0) {
      console.log(chalk.dim('No cache entries found.'));
      return;
    }

    console.log(chalk.bold(`Build Cache Entries (${buildEntries.length})`));
    if (buildEntries.length === 0) {
      console.log(chalk.dim('  (empty)'));
    } else {
      for (const entry of buildEntries) {
        const created = entry.createdAt ? new Date(entry.createdAt).toLocaleString() : 'unknown';
        console.log(
          `${chalk.cyan(entry.key)}  ${chalk.dim(formatBytes(entry.sizeBytes))}  ${chalk.dim(created)}`,
        );
        if (entry.platform || entry.arch || entry.image) {
          console.log(
            chalk.dim(
              `  platform=${entry.platform ?? 'unknown'} arch=${entry.arch ?? 'unknown'} image=${entry.image ?? 'unknown'}`,
            ),
          );
        }
      }
    }

    console.log();
    console.log(chalk.bold(`Deps Cache Entries (${depsEntries.length})`));
    if (depsEntries.length === 0) {
      console.log(chalk.dim('  (empty)'));
    } else {
      for (const entry of depsEntries) {
        const created = entry.createdAt ? new Date(entry.createdAt).toLocaleString() : 'unknown';
        const tag = entry.name
          ? entry.version
            ? `${entry.name}@${entry.version}`
            : entry.name
          : entry.key;
        console.log(
          `${chalk.cyan(entry.key)}  ${chalk.dim(formatBytes(entry.sizeBytes))}  ${chalk.dim(created)}`,
        );
        const detailParts: string[] = [tag];
        if (entry.platform) detailParts.push(`platform=${entry.platform}`);
        if (entry.image) detailParts.push(`image=${entry.image}`);
        if (entry.provides && entry.provides.length > 0)
          detailParts.push(`provides=[${entry.provides.join(',')}]`);
        console.log(chalk.dim(`  ${detailParts.join(' ')}`));
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Error: ${message}`));
    process.exit(1);
  }
}

export async function cacheCleanCommand(key: string | undefined, options: CacheCleanOptions): Promise<void> {
  try {
    if (!options.force) {
      const prompt = key
        ? `Remove cache entry ${key}? [y/N] `
        : 'Remove all build and deps cache entries? [y/N] ';
      const proceed = await confirm(prompt);
      if (!proceed) {
        console.log('Cancelled.');
        return;
      }
    }

    if (key) {
      // Try build cache first; fall through to deps cache if not found there.
      // Directory names are disjoint (build keys are 16-char hex, deps keys
      // are `<name>-<16-char-hex>`), so there's no ambiguity.
      const removedFromBuild = clearBuildCache(process.cwd(), key);
      if (removedFromBuild > 0) {
        console.log(chalk.green(`Removed 1 build cache entry.`));
        return;
      }
      const removedFromDeps = clearDepsCache(process.cwd(), key);
      if (removedFromDeps > 0) {
        console.log(chalk.green(`Removed 1 deps cache entry.`));
        return;
      }
      console.log(chalk.dim(`No cache entry found for key ${key}.`));
      return;
    }

    const removedBuild = clearBuildCache(process.cwd());
    const removedDeps = clearDepsCache(process.cwd());
    if (removedBuild === 0 && removedDeps === 0) {
      console.log(chalk.dim('No cache entries found.'));
      return;
    }
    const parts: string[] = [];
    if (removedBuild > 0)
      parts.push(`${removedBuild} build cache entr${removedBuild === 1 ? 'y' : 'ies'}`);
    if (removedDeps > 0)
      parts.push(`${removedDeps} deps cache entr${removedDeps === 1 ? 'y' : 'ies'}`);
    console.log(chalk.green(`Removed ${parts.join(' and ')}.`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Error: ${message}`));
    process.exit(1);
  }
}
