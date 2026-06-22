// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `bn suites` — manage git-cloned suite repositories.
 *
 * Subcommands:
 *   add <git-url> [--ref <ref>] [--as <alias>]
 *   list [--json]
 *   update [<suite-id>|--all]
 *   remove <suite-id>
 *   info <suite-id> [--json]
 *
 * Identity is derived from the clone URL (`<host>/<org>/<repo>`); the `--as`
 * flag only sets a local alias used for unqualified `bn run` resolution.
 * See `docs/SUITES.md`.
 */

import * as path from 'node:path';
import { confirm } from './helpers/prompt.js';
import chalk from 'chalk';
import {
  loadProject,
  clearProjectCache,
  loadProjectSuites,
  loadSuiteFromDir,
  resolveSuiteCacheDir,
  suiteIdFromUrl,
  cloneSuite,
  updateSuite,
  removeSuiteCache,
  getSuiteCacheStatus,
  isGitAvailable,
  updateProjectSuites,
  getProjectConfigPath,
  SuiteCacheError,
  SuiteManifestError,
  ProjectConfigEditError,
  type ResolvedSuite,
} from '@bunsen-dev/runtime';
import type { ProjectSuiteEntry } from '@bunsen-dev/types';
import { resolveFormat, isMachineFormat, renderMachine } from '../format.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureGit(): void {
  if (!isGitAvailable()) {
    console.error(
      chalk.red(
        'git is required for suite management but was not found on PATH. Install git and try again.',
      ),
    );
    process.exit(2);
  }
}

function fail(message: string, exitCode = 1): never {
  console.error(chalk.red(`Error: ${message}`));
  process.exit(exitCode);
}

/**
 * Find a configured suite by its canonical id, alias, or GitHub short form.
 *
 * Returns the matching entry index from `bunsen.config.yaml#suites` or
 * `null` if there is no match (or the match is ambiguous, in which case
 * the caller should use a more specific identifier).
 */
function findSuiteIndex(
  identifier: string,
  entries: ProjectSuiteEntry[],
): { index: number; id: string } | null {
  const matches: { index: number; id: string }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    let derivedId: string;
    try {
      derivedId = suiteIdFromUrl(entry.source.url);
    } catch {
      continue;
    }
    if (
      identifier === derivedId ||
      identifier.toLowerCase() === derivedId ||
      entry.as === identifier ||
      (derivedId.startsWith('github.com/') &&
        identifier.toLowerCase() === derivedId.slice('github.com/'.length))
    ) {
      matches.push({ index: i, id: derivedId });
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    fail(
      `Ambiguous suite identifier ${JSON.stringify(identifier)} — matches multiple entries. Use the canonical id to disambiguate.`,
    );
  }
  return null;
}

function formatSuiteHeader(suite: ResolvedSuite): string {
  if (suite.alias) {
    return `${chalk.cyan(suite.id)} ${chalk.dim(`(alias: ${suite.alias})`)}`;
  }
  return chalk.cyan(suite.id);
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

interface AddOptions {
  ref?: string;
  as?: string;
}

export async function suitesAddCommand(
  url: string,
  options: AddOptions,
): Promise<void> {
  ensureGit();
  try {
    let derivedId: string;
    try {
      derivedId = suiteIdFromUrl(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fail(message, 2);
    }

    const project = loadProject();
    const configPath = getProjectConfigPath(project.root);

    // Detect collisions up front, BEFORE cloning. Cloning blindly and then
    // rolling back would clobber a previously-cached clone at the same
    // canonical id (cacheDir is derived from id, so two adds of the same
    // upstream share a directory).
    const existingEntries = project.config.suites ?? [];
    const collisionByUrl = existingEntries.find((e) => e.source.url === url);
    if (collisionByUrl) {
      const hint = collisionByUrl.as ? ` (alias '${collisionByUrl.as}')` : '';
      fail(
        `Suite URL ${url} is already configured${hint}. Use \`bn suites update\` to refresh, or remove it first.`,
      );
    }
    const collisionById = existingEntries.find((e) => {
      try {
        return suiteIdFromUrl(e.source.url) === derivedId;
      } catch {
        return false;
      }
    });
    if (collisionById) {
      fail(
        `Canonical suite id ${derivedId} is already configured (from ${collisionById.source.url}). Use a fork URL or pass --as <alias>.`,
      );
    }
    if (options.as !== undefined) {
      const collisionByAlias = existingEntries.find((e) => e.as === options.as);
      if (collisionByAlias) {
        fail(`Alias ${JSON.stringify(options.as)} is already used by ${collisionByAlias.source.url}.`);
      }
    }

    const tentativeEntry: ProjectSuiteEntry = {
      source: { type: 'git', url },
    };
    if (options.ref !== undefined) tentativeEntry.source.ref = options.ref;
    if (options.as !== undefined) tentativeEntry.as = options.as;
    const cacheDir = resolveSuiteCacheDir(project, tentativeEntry, derivedId);

    // Clone, then persist. If the persist fails (e.g., concurrent edit
    // racing in another collision), roll back the clone.
    let sha: string;
    try {
      ({ sha } = cloneSuite({
        url,
        ref: options.ref,
        cacheDir,
        onProgress: (m) => console.log(chalk.dim(m)),
      }));
    } catch (err) {
      if (err instanceof SuiteCacheError) fail(err.message);
      throw err;
    }

    try {
      updateProjectSuites(configPath, (entries) => [...entries, tentativeEntry]);
    } catch (err) {
      removeSuiteCache(cacheDir);
      if (err instanceof ProjectConfigEditError) fail(err.message);
      throw err;
    }

    clearProjectCache();

    console.log();
    console.log(chalk.green(`Added suite ${derivedId}`));
    console.log(chalk.dim(`  URL:        ${url}`));
    if (options.ref) console.log(chalk.dim(`  Ref:        ${options.ref}`));
    console.log(chalk.dim(`  Commit:     ${sha}`));
    console.log(chalk.dim(`  Cache:      ${path.relative(process.cwd(), cacheDir) || cacheDir}`));
    if (options.as) console.log(chalk.dim(`  Alias:      ${options.as}`));
    console.log(chalk.dim(`  Config:     ${path.relative(process.cwd(), configPath) || configPath}`));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(message);
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

interface ListOptions {
  format?: string;
}

export async function suitesListCommand(options: ListOptions): Promise<void> {
  const format = resolveFormat(options);
  try {
    const project = loadProject();
    const suites = loadProjectSuites(project);

    if (isMachineFormat(format)) {
      const out = suites.map((s) => {
        const entry = (project.config.suites ?? []).find(
          (e) => safeId(e.source.url) === s.id,
        );
        return {
          id: s.id,
          alias: s.alias ?? null,
          source_url: s.source_url ?? null,
          ref: entry?.source.ref ?? null,
          version: s.version ?? null,
          cache_dir: s.root,
          materialized: Boolean(s.manifest) || Boolean(s.version),
          name: s.manifest?.name ?? null,
          description: s.manifest?.description ?? null,
          version_tag: s.manifest?.version_tag ?? null,
        };
      });
      process.stdout.write(renderMachine({ suites: out }, format));
      return;
    }

    if (suites.length === 0) {
      console.log(chalk.dim('No suites configured.'));
      console.log(chalk.dim('Add one with: bn suites add <git-url>'));
      return;
    }

    console.log();
    console.log(chalk.bold(`Suites (${suites.length})`));
    for (const suite of suites) {
      console.log();
      console.log(formatSuiteHeader(suite));
      const status = getSuiteCacheStatus(suite.root);
      const entry = (project.config.suites ?? []).find(
        (e) => safeId(e.source.url) === suite.id,
      );
      if (suite.source_url) console.log(chalk.dim(`  URL:        ${suite.source_url}`));
      if (entry?.source.ref) console.log(chalk.dim(`  Ref:        ${entry.source.ref}`));
      if (status.sha) console.log(chalk.dim(`  Commit:     ${status.sha}`));
      console.log(chalk.dim(`  Cache:      ${path.relative(process.cwd(), suite.root) || suite.root}`));
      if (suite.manifest) {
        if (suite.manifest.version_tag) {
          console.log(chalk.dim(`  Version:    ${suite.manifest.version_tag}`));
        }
        if (suite.manifest.name) {
          console.log(chalk.dim(`  Name:       ${suite.manifest.name}`));
        }
        if (suite.manifest.description) {
          const firstLine = suite.manifest.description.split('\n')[0];
          console.log(chalk.dim(`  Description: ${firstLine}`));
        }
      } else {
        console.log(
          chalk.yellow(`  (not yet materialized — run \`bn suites update ${suite.alias ?? suite.id}\`)`),
        );
      }
    }
    console.log();
  } catch (err) {
    if (err instanceof SuiteManifestError) fail(err.message);
    const message = err instanceof Error ? err.message : String(err);
    fail(message);
  }
}

function safeId(url: string): string | null {
  try {
    return suiteIdFromUrl(url);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

interface UpdateCmdOptions {
  all?: boolean;
}

export async function suitesUpdateCommand(
  identifier: string | undefined,
  options: UpdateCmdOptions,
): Promise<void> {
  ensureGit();
  try {
    const project = loadProject();
    const entries = project.config.suites ?? [];
    if (entries.length === 0) {
      fail('No suites configured.', 2);
    }

    let targets: { entry: ProjectSuiteEntry; index: number; id: string }[] = [];
    if (options.all) {
      targets = entries.map((entry, index) => ({
        entry,
        index,
        id: suiteIdFromUrl(entry.source.url),
      }));
    } else if (identifier) {
      const match = findSuiteIndex(identifier, entries);
      if (!match) fail(`No configured suite matches ${JSON.stringify(identifier)}.`, 2);
      targets = [{ entry: entries[match.index], index: match.index, id: match.id }];
    } else {
      fail('Specify a suite id, alias, or pass --all.', 2);
    }

    let failures = 0;
    for (const target of targets) {
      const cacheDir = resolveSuiteCacheDir(project, target.entry, target.id);
      console.log(chalk.cyan(`Updating ${target.id}...`));
      try {
        const { sha } = updateSuite({
          url: target.entry.source.url,
          ref: target.entry.source.ref,
          cacheDir,
          onProgress: (m) => console.log(chalk.dim(`  ${m}`)),
        });
        console.log(chalk.green(`  ✓ at ${sha}`));
      } catch (err) {
        failures++;
        if (err instanceof SuiteCacheError) {
          console.error(chalk.red(`  ✗ ${err.message}`));
        } else {
          const message = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`  ✗ ${message}`));
        }
      }
    }

    clearProjectCache();
    if (failures > 0) {
      process.exit(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(message);
  }
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

interface RemoveOptions {
  force?: boolean;
}

export async function suitesRemoveCommand(
  identifier: string,
  options: RemoveOptions,
): Promise<void> {
  try {
    const project = loadProject();
    const entries = project.config.suites ?? [];
    const match = findSuiteIndex(identifier, entries);
    if (!match) fail(`No configured suite matches ${JSON.stringify(identifier)}.`, 2);

    const target = entries[match.index];
    const cacheDir = resolveSuiteCacheDir(project, target, match.id);
    if (!options.force) {
      const proceed = await confirm(
        `Remove suite ${match.id} (${target.source.url}) and delete cache at ${cacheDir}? [y/N] `,
      );
      if (!proceed) {
        console.log('Cancelled.');
        return;
      }
    }

    const configPath = getProjectConfigPath(project.root);
    updateProjectSuites(configPath, (current) => {
      // Re-resolve match against the on-disk entries (which may have changed
      // between the in-memory config snapshot and now). We match by URL —
      // it's the only field guaranteed unique by the parser.
      return current.filter((e) => e.source.url !== target.source.url);
    });
    removeSuiteCache(cacheDir);
    clearProjectCache();

    console.log(chalk.green(`Removed suite ${match.id}.`));
  } catch (err) {
    if (err instanceof ProjectConfigEditError) fail(err.message);
    const message = err instanceof Error ? err.message : String(err);
    fail(message);
  }
}

// ---------------------------------------------------------------------------
// info
// ---------------------------------------------------------------------------

interface InfoOptions {
  format?: string;
}

export async function suitesInfoCommand(
  identifier: string,
  options: InfoOptions,
): Promise<void> {
  const format = resolveFormat(options);
  try {
    const project = loadProject();
    const entries = project.config.suites ?? [];
    const match = findSuiteIndex(identifier, entries);
    if (!match) fail(`No configured suite matches ${JSON.stringify(identifier)}.`, 2);

    const target = entries[match.index];
    const cacheDir = resolveSuiteCacheDir(project, target, match.id);
    const status = getSuiteCacheStatus(cacheDir);
    let suite: ResolvedSuite | undefined;
    if (status.exists) {
      suite = loadSuiteFromDir(cacheDir, {
        expectedId: match.id,
        alias: target.as,
        sourceUrl: target.source.url,
        ref: target.source.ref,
      });
    }

    if (isMachineFormat(format)) {
      const out = {
        id: match.id,
        alias: target.as ?? null,
        source_url: target.source.url,
        ref: target.source.ref ?? null,
        cache_dir: cacheDir,
        materialized: status.exists,
        commit: status.sha ?? null,
        head: status.head ?? null,
        manifest: suite?.manifest ?? null,
      };
      process.stdout.write(renderMachine(out, format));
      return;
    }

    console.log();
    console.log(chalk.bold(`Suite ${match.id}`));
    if (target.as) console.log(`  Alias:      ${target.as}`);
    console.log(`  URL:        ${target.source.url}`);
    if (target.source.ref) console.log(`  Ref:        ${target.source.ref}`);
    console.log(`  Cache:      ${path.relative(process.cwd(), cacheDir) || cacheDir}`);
    if (status.exists) {
      if (status.sha) console.log(`  Commit:     ${status.sha}`);
      if (status.head && status.head !== 'HEAD') {
        console.log(`  HEAD:       ${status.head}`);
      }
    } else {
      console.log(chalk.yellow(`  (not yet materialized — run \`bn suites update ${target.as ?? match.id}\`)`));
    }

    if (suite?.manifest) {
      console.log();
      if (suite.manifest.name) console.log(`  Name:        ${suite.manifest.name}`);
      if (suite.manifest.version_tag) {
        console.log(`  Version:     ${suite.manifest.version_tag}`);
      }
      if (suite.manifest.license) console.log(`  License:     ${suite.manifest.license}`);
      if (suite.manifest.description) {
        console.log(`  Description: ${suite.manifest.description.split('\n')[0]}`);
      }
      if (suite.manifest.experiments.length) {
        console.log(`  Roots:       ${suite.manifest.experiments.join(', ')}`);
      }
      if (suite.manifest.tracks) {
        const trackNames = Object.keys(suite.manifest.tracks);
        if (trackNames.length) {
          console.log(`  Tracks:      ${trackNames.join(', ')}`);
        }
      }
    }
    console.log();
  } catch (err) {
    if (err instanceof SuiteManifestError || err instanceof SuiteCacheError) {
      fail(err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    fail(message);
  }
}
