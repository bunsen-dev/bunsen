// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `bn agents add [names…]` — copy bundled starter agents into the project.
 *
 * A fresh `bn init` leaves `paths.agents` pointing at an empty `agents/` dir, so
 * a brand-new project has nothing to run. Bunsen ships a curated set of starter
 * agents (the frontier coding CLIs — `claude-code`, `codex-cli`, `gemini-cli`)
 * bundled inside `@bunsen-dev/cli` (under `dist/assets/agents/`, the same
 * `getAssetDir()` plumbing the platform bundles and `bn skills` use), so they are
 * version-matched to the `bn` the user already has. This command copies them into
 * the project's first agent search path (default `agents/`), where `bn run` finds
 * them by their `agent.yaml` `name:` field.
 *
 * Unlike `bn skills install` (which owns and always replaces the `bunsen-*`
 * skill dirs), a copied agent becomes the user's to edit — so an agent dir that
 * already exists is *skipped*, never silently overwritten. Pass `--force` to
 * replace it.
 *
 * With no names, every bundled starter is added. `--list` prints the available
 * starters without copying anything.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import yaml from 'js-yaml';
import { getAssetDir, loadProject, getAgentSearchPaths } from '@bunsen-dev/runtime';
import { BunsenCliError } from '../errors.js';
import { isMachineFormat, renderMachine, resolveFormat } from '../format.js';

interface AgentsAddOptions {
  force?: boolean;
  list?: boolean;
  format?: string;
}

/** Per-agent outcome of an add. */
export type AddStatus = 'added' | 'skipped' | 'overwritten';

export interface AgentAddResult {
  name: string;
  status: AddStatus;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Resolve the directory the bundled starter agents live in. */
export function bundledAgentsDir(): string {
  const override = process.env.BUNSEN_AGENTS_DIR;
  if (override && override.trim()) return override;
  return path.join(getAssetDir(), 'agents');
}

/** Names of every bundled starter agent (a subdir containing an `agent.yaml`), sorted. */
export function listBundledAgents(sourceDir: string): string[] {
  if (!fs.existsSync(sourceDir)) return [];
  return fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(sourceDir, d.name, 'agent.yaml')))
    .map((d) => d.name)
    .sort();
}

/** First non-empty line of a starter agent's `description:`, for the `--list` view. */
export function bundledAgentSummary(sourceDir: string, name: string): string {
  try {
    const raw = fs.readFileSync(path.join(sourceDir, name, 'agent.yaml'), 'utf8');
    const doc = yaml.load(raw) as { description?: unknown } | undefined;
    const desc = typeof doc?.description === 'string' ? doc.description : '';
    const firstLine = desc.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
    return firstLine ?? '';
  } catch {
    return '';
  }
}

/**
 * Copy the named starter agents from `sourceDir` into `agentsDir`.
 *
 * An agent dir that already exists is skipped unless `force` is set (then it is
 * removed and recopied). Returns a per-agent result. Throws if a requested name
 * is not a bundled starter.
 */
export function installAgentsInto(
  sourceDir: string,
  agentsDir: string,
  names: string[],
  options: { force?: boolean } = {},
): AgentAddResult[] {
  const available = listBundledAgents(sourceDir);
  if (available.length === 0) {
    throw new BunsenCliError('agents_assets_missing', `No bundled starter agents found at ${sourceDir}.`, {
      details: {
        hint: 'This is a packaging error — the CLI build should populate dist/assets/agents/.',
      },
    });
  }

  const unknown = names.filter((n) => !available.includes(n));
  if (unknown.length > 0) {
    throw new BunsenCliError(
      'agents_add_unknown',
      `Unknown starter agent(s): ${unknown.join(', ')}`,
      {
        details: {
          requested: names,
          available,
          hint: `Available starters: ${available.join(', ')}`,
        },
      },
    );
  }

  fs.mkdirSync(agentsDir, { recursive: true });
  const results: AgentAddResult[] = [];
  for (const name of names) {
    const dest = path.join(agentsDir, name);
    const exists = fs.existsSync(dest);
    if (exists && !options.force) {
      results.push({ name, status: 'skipped' });
      continue;
    }
    // force-overwrite: remove first so no stale files from a prior copy survive.
    if (exists) fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(path.join(sourceDir, name), dest, { recursive: true });
    results.push({ name, status: exists ? 'overwritten' : 'added' });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function agentsAddCommand(
  names: string[],
  options: AgentsAddOptions,
): Promise<void> {
  const format = resolveFormat(options);
  const sourceDir = bundledAgentsDir();
  const available = listBundledAgents(sourceDir);

  if (available.length === 0) {
    throw new BunsenCliError('agents_assets_missing', `No bundled starter agents found at ${sourceDir}.`, {
      details: {
        hint: 'This is a packaging error — the CLI build should populate dist/assets/agents/.',
      },
    });
  }

  // `--list`: show available starters and exit without writing anything.
  if (options.list) {
    if (isMachineFormat(format)) {
      process.stdout.write(
        renderMachine(
          { agents: available.map((name) => ({ name, summary: bundledAgentSummary(sourceDir, name) })) },
          format,
        ),
      );
      return;
    }
    console.log(chalk.bold('Available starter agents:'));
    for (const name of available) {
      const summary = bundledAgentSummary(sourceDir, name);
      console.log(`  ${chalk.cyan(name)}${summary ? chalk.dim(` — ${summary}`) : ''}`);
    }
    console.log();
    console.log(chalk.dim('Add one:  bn agents add claude-code'));
    console.log(chalk.dim('Add all:  bn agents add'));
    return;
  }

  const project = loadProject(process.cwd());
  const agentsDir = getAgentSearchPaths(project)[0];
  if (!agentsDir) {
    throw new BunsenCliError(
      'agents_no_search_path',
      'No agent search path is configured.',
      { details: { hint: 'Add a directory under paths.agents in bunsen.config.yaml.' } },
    );
  }
  const requested = names.length > 0 ? names : available;

  const results = installAgentsInto(sourceDir, agentsDir, requested, { force: options.force });

  if (isMachineFormat(format)) {
    process.stdout.write(renderMachine({ agentsDir, results }, format));
    return;
  }

  const added = results.filter((r) => r.status !== 'skipped');
  const skipped = results.filter((r) => r.status === 'skipped');

  if (added.length > 0) {
    console.log(chalk.green(`✓ Added ${added.length} agent(s) to ${path.relative(process.cwd(), agentsDir) || '.'}/`));
    for (const r of added) {
      const note = r.status === 'overwritten' ? chalk.dim(' (overwritten)') : '';
      console.log(chalk.dim(`    + ${r.name}${note}`));
    }
  }
  if (skipped.length > 0) {
    console.log(
      chalk.yellow(`• Skipped ${skipped.length} existing agent(s): ${skipped.map((r) => r.name).join(', ')}`),
    );
    console.log(chalk.dim('  Pass --force to overwrite.'));
  }

  console.log();
  console.log(chalk.dim('These agents call hosted models — set the matching key in your .env:'));
  console.log(chalk.dim('  claude-code → ANTHROPIC_API_KEY   codex-cli → OPENAI_API_KEY   gemini-cli → GEMINI_API_KEY'));
  console.log(chalk.dim('Then run, e.g.:  bn run <experiment> claude-code'));
}
