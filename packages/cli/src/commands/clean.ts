// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Clean command - Remove orphaned bunsen containers and networks
 */

import chalk from 'chalk';
import { listBunsenContainers, listBunsenNetworks, cleanupBunsenContainers } from '@bunsen-dev/runtime';
import { confirm } from './helpers/prompt.js';
import { shortRunId } from './helpers/short-id.js';

interface CleanOptions {
  force?: boolean;
  dryRun?: boolean;
}

function formatAge(createdTimestamp: number): string {
  const ageMs = Date.now() - createdTimestamp * 1000;
  const minutes = Math.floor(ageMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

export async function cleanCommand(options: CleanOptions): Promise<void> {
  try {
    const containers = await listBunsenContainers();
    const networks = await listBunsenNetworks();

    if (containers.length === 0 && networks.length === 0) {
      console.log(chalk.green('No orphaned bunsen containers or networks found.'));
      return;
    }

    // Display what was found
    if (containers.length > 0) {
      console.log(chalk.bold(`Containers (${containers.length}):`));
      for (const c of containers) {
        const name = c.name || c.id.slice(0, 12);
        const state = c.state === 'running' ? chalk.yellow(c.state) : chalk.dim(c.state);
        const component = c.component ? chalk.cyan(c.component) : chalk.dim('unknown');
        const age = formatAge(c.created);
        const runId = c.runId ? chalk.dim(` run:${shortRunId(c.runId)}`) : '';
        console.log(`  ${state} ${name} [${component}] ${chalk.dim(age)}${runId}`);
      }
    }

    if (networks.length > 0) {
      console.log(chalk.bold(`Networks (${networks.length}):`));
      for (const n of networks) {
        console.log(`  ${n.name}`);
      }
    }

    console.log();

    if (options.dryRun) {
      console.log(chalk.dim(`Would remove ${containers.length} container(s) and ${networks.length} network(s).`));
      return;
    }

    // Confirm unless --force
    if (!options.force) {
      const proceed = await confirm(
        `Remove ${containers.length} container(s) and ${networks.length} network(s)? [y/N] `
      );
      if (!proceed) {
        console.log('Cancelled.');
        return;
      }
    }

    const result = await cleanupBunsenContainers();

    console.log(chalk.green(`Removed ${result.containersRemoved} container(s) and ${result.networksRemoved} network(s).`));

    if (result.errors.length > 0) {
      console.log(chalk.yellow(`\nWarnings:`));
      for (const err of result.errors) {
        console.log(chalk.yellow(`  ${err}`));
      }
    }
  } catch (error) {
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
    process.exit(1);
  }
}
