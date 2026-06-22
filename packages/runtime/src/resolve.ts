// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Centralized resolution for experiments and agents.
 *
 * Thin wrapper around {@link loadProject} that exposes the name/path
 * resolution used by the CLI and runtime. The project config and storage
 * paths live in `project-loader.ts`; this module is only about turning an
 * experiment/agent name into a directory.
 *
 * Experiment resolution is suite-aware: the project's configured
 * `bunsen.config.yaml#suites` entries contribute additional search roots
 * after the local `paths.experiments`. Suite experiments can be addressed
 * with the canonical id, the GitHub short form, the local alias, or — when
 * unambiguous — by basename.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import {
  loadProject,
  getExperimentSearchPaths as projectExperimentSearchPaths,
  getAgentSearchPaths as projectAgentSearchPaths,
  clearProjectCache,
  type ResolvedProject,
} from './project-loader.js';
import {
  getSuiteExperimentSearchPaths,
  loadProjectSuites,
} from './suite-loader.js';
import type { ResolvedSuite } from '@bunsen-dev/types';

/** Result of resolving an experiment or agent name. */
export interface ResolveResult {
  path: string;
  source: 'direct' | 'config' | 'default' | 'suite';
  matchedSearchPath?: string;
  /** When `source: 'suite'`, the canonical suite id the experiment came from. */
  suiteId?: string;
  /** When `source: 'suite'`, the experiment's path relative to the suite root. */
  suiteRelative?: string;
}

export { clearProjectCache as clearProjectInfoCache };

/**
 * Resolve an experiment name or path to its directory.
 *
 * Resolution order:
 *   1. Direct path (if arg is a valid directory with `experiment.yaml`).
 *   2. Configured `paths.experiments` from `bunsen.config.yaml`.
 *   3. Default search path (`experiments/`) when no config is present.
 *   4. Suite-prefixed lookup: `<alias>/<exp>`, `<host>/<org>/<repo>/<exp>`,
 *      or `<org>/<repo>/<exp>` (github.com short form).
 *   5. Recursive basename search across local + suite search paths.
 */
export function resolveExperiment(
  nameOrPath: string,
  project?: ResolvedProject,
): ResolveResult | null {
  return resolveExperimentByName(nameOrPath, project);
}

/**
 * Resolve an agent name or path to its directory.
 *
 * Resolution order:
 *   1. Direct path (if arg is a valid directory with `agent.yaml`).
 *   2. Recursive search by `agent.yaml#name` across configured agent paths.
 *
 * Folder names are not part of an agent's identity. The yaml `name` field is
 * the canonical identifier — the same field surfaced by `bn agents list` and,
 * once agents are distributed like suites, the field carried in any registry
 * or manifest. A locally-renamed clone still resolves correctly.
 */
export function resolveAgent(
  nameOrPath: string,
  project?: ResolvedProject,
): ResolveResult | null {
  return resolveAgentByName(nameOrPath, project);
}

function resolveExperimentByName(
  nameOrPath: string,
  project?: ResolvedProject,
): ResolveResult | null {
  const configFile = 'experiment.yaml';

  // 1. Direct path.
  const directPath = path.resolve(nameOrPath);
  if (fs.existsSync(directPath) && fs.existsSync(path.join(directPath, configFile))) {
    return { path: directPath, source: 'direct' };
  }

  const proj = project || loadProject();
  const localSearchPaths = projectExperimentSearchPaths(proj);
  const hasConfig = proj.config.paths?.experiments !== undefined;

  // 2 & 3. Local prefix match.
  for (const searchPath of localSearchPaths) {
    const candidatePath = path.join(searchPath, nameOrPath);
    if (
      fs.existsSync(candidatePath) &&
      fs.existsSync(path.join(candidatePath, configFile))
    ) {
      return {
        path: candidatePath,
        source: hasConfig ? 'config' : 'default',
        matchedSearchPath: searchPath,
      };
    }
  }

  // 4. Suite-prefixed lookup.
  const suites = safeLoadSuites(proj);
  const suiteHit = resolveSuitePrefixed(nameOrPath, suites);
  if (suiteHit) return suiteHit;

  // 5. Recursive basename search across local + every suite's experiment roots.
  if (!nameOrPath.includes('/') && !nameOrPath.includes('\\')) {
    const allMatches: { path: string; suiteId?: string; root: string }[] = [];
    for (const searchPath of localSearchPaths) {
      const found: string[] = [];
      findAllByNameRecursive(searchPath, nameOrPath, configFile, found);
      for (const f of found) allMatches.push({ path: f, root: searchPath });
    }
    for (const suite of suites) {
      for (const root of getSuiteExperimentSearchPaths(suite)) {
        const found: string[] = [];
        findAllByNameRecursive(root, nameOrPath, configFile, found);
        for (const f of found) allMatches.push({ path: f, suiteId: suite.id, root });
      }
    }

    if (allMatches.length === 1) {
      const m = allMatches[0];
      const result: ResolveResult = {
        path: m.path,
        source: m.suiteId ? 'suite' : hasConfig ? 'config' : 'default',
        matchedSearchPath: m.root,
      };
      if (m.suiteId) {
        result.suiteId = m.suiteId;
        const suite = suites.find((s) => s.id === m.suiteId);
        if (suite) result.suiteRelative = path.relative(suite.root, m.path);
      }
      return result;
    }

    if (allMatches.length > 1) {
      const relativePaths = allMatches.map((m) =>
        m.suiteId
          ? `${qualifyByAliasOrId(m.suiteId, suites)}/${path.basename(m.path)}`
          : path.relative(proj.root, m.path),
      );
      throw new Error(
        `Ambiguous experiment name "${nameOrPath}". Multiple matches found:\n` +
          relativePaths.map((p) => `  - ${p}`).join('\n') +
          `\n\nUse the full path or qualified id to disambiguate (e.g., "${relativePaths[0]}").`,
      );
    }
  }

  return null;
}

function resolveAgentByName(
  nameOrPath: string,
  project?: ResolvedProject,
): ResolveResult | null {
  const configFile = 'agent.yaml';

  // 1. Direct path.
  const directPath = path.resolve(nameOrPath);
  if (fs.existsSync(directPath) && fs.existsSync(path.join(directPath, configFile))) {
    return { path: directPath, source: 'direct' };
  }

  const proj = project || loadProject();
  const searchPaths = projectAgentSearchPaths(proj);
  const hasConfig = proj.config.paths?.agents !== undefined;

  // 2. Recursive search by agent.yaml `name`.
  if (!nameOrPath.includes('/') && !nameOrPath.includes('\\')) {
    const allMatches: { path: string; root: string }[] = [];
    for (const searchPath of searchPaths) {
      const found: string[] = [];
      findAllAgentsByYamlName(searchPath, nameOrPath, found);
      for (const f of found) allMatches.push({ path: f, root: searchPath });
    }
    if (allMatches.length === 1) {
      return {
        path: allMatches[0].path,
        source: hasConfig ? 'config' : 'default',
        matchedSearchPath: allMatches[0].root,
      };
    }
    if (allMatches.length > 1) {
      const relativePaths = allMatches.map((m) => path.relative(proj.root, m.path));
      throw new Error(
        `Ambiguous agent name "${nameOrPath}". Multiple matches found:\n` +
          relativePaths.map((p) => `  - ${p}`).join('\n') +
          `\n\nUse the full path to disambiguate (e.g., "${relativePaths[0]}").`,
      );
    }
  }

  return null;
}

function readAgentYamlName(configPath: string): string | null {
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && 'name' in parsed) {
      const name = (parsed as { name: unknown }).name;
      if (typeof name === 'string') return name;
    }
  } catch {
    // Malformed YAML — treat as nameless; loader will surface the real error.
  }
  return null;
}

function findAllAgentsByYamlName(dir: string, targetName: string, results: string[]): void {
  if (!fs.existsSync(dir)) return;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const entryPath = path.join(dir, entry.name);
      const configPath = path.join(entryPath, 'agent.yaml');

      if (fs.existsSync(configPath)) {
        if (readAgentYamlName(configPath) === targetName) {
          results.push(entryPath);
        }
        // Don't recurse into a directory that already has agent.yaml.
        continue;
      }

      findAllAgentsByYamlName(entryPath, targetName, results);
    }
  } catch {
    // Ignore permission errors.
  }
}

/**
 * Try to interpret `nameOrPath` as a suite-prefixed reference
 * (alias/exp, host/org/repo/exp, or org/repo/exp on github.com).
 *
 * Returns null if no prefix matches a configured suite.
 */
function resolveSuitePrefixed(
  nameOrPath: string,
  suites: ResolvedSuite[],
): ResolveResult | null {
  if (!nameOrPath.includes('/')) return null;
  if (suites.length === 0) return null;

  const segments = nameOrPath.split('/').filter((s) => s.length > 0);

  for (const suite of suites) {
    // Build the set of valid prefixes for this suite. Each prefix represents
    // how many leading segments of `nameOrPath` identify the suite itself;
    // anything left over is the experiment path within the suite.
    const prefixes = candidatePrefixesForSuite(suite);
    for (const prefix of prefixes) {
      const prefixSegs = prefix.split('/').filter((s) => s.length > 0);
      if (segments.length <= prefixSegs.length) continue;
      const matches = prefixSegs.every(
        (p, i) => segments[i].toLowerCase() === p.toLowerCase(),
      );
      if (!matches) continue;
      const expRel = segments.slice(prefixSegs.length).join('/');
      for (const root of getSuiteExperimentSearchPaths(suite)) {
        const candidate = path.join(root, expRel);
        if (fs.existsSync(path.join(candidate, 'experiment.yaml'))) {
          return {
            path: candidate,
            source: 'suite',
            matchedSearchPath: suite.root,
            suiteId: suite.id,
            suiteRelative: path.relative(suite.root, candidate),
          };
        }
      }
    }
  }
  return null;
}

function candidatePrefixesForSuite(suite: ResolvedSuite): string[] {
  const prefixes: string[] = [suite.id];
  if (suite.alias) prefixes.push(suite.alias);
  // GitHub short form: drop the `github.com/` host segment.
  if (suite.id.startsWith('github.com/')) {
    prefixes.push(suite.id.slice('github.com/'.length));
  }
  return prefixes;
}

function qualifyByAliasOrId(id: string, suites: ResolvedSuite[]): string {
  const match = suites.find((s) => s.id === id);
  return match?.alias ?? id;
}

function safeLoadSuites(project: ResolvedProject): ResolvedSuite[] {
  try {
    return loadProjectSuites(project);
  } catch {
    return [];
  }
}

function findAllByNameRecursive(
  dir: string,
  targetName: string,
  configFile: string,
  results: string[],
): void {
  if (!fs.existsSync(dir)) return;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const entryPath = path.join(dir, entry.name);

      if (entry.name === targetName && fs.existsSync(path.join(entryPath, configFile))) {
        results.push(entryPath);
      }

      if (!fs.existsSync(path.join(entryPath, configFile))) {
        findAllByNameRecursive(entryPath, targetName, configFile, results);
      }
    }
  } catch {
    // Ignore permission errors
  }
}

/**
 * Get a human-readable description of searched locations for error messages.
 */
export function describeSearchedLocations(
  type: 'experiment' | 'agent',
  project?: ResolvedProject,
): string {
  const proj = project || loadProject();
  const searchPaths =
    type === 'experiment'
      ? projectExperimentSearchPaths(proj)
      : projectAgentSearchPaths(proj);

  const lines = searchPaths.map((p) => `  - ${path.relative(process.cwd(), p) || '.'}`);

  if (type === 'experiment') {
    const suites = safeLoadSuites(proj);
    for (const suite of suites) {
      const label = suite.alias ? `${suite.id} (alias: ${suite.alias})` : suite.id;
      const status = suite.manifest ? '' : '  [not yet cloned — run `bn suites update`]';
      lines.push(`  - suite ${label}${status}`);
      for (const root of getSuiteExperimentSearchPaths(suite)) {
        lines.push(`      ${path.relative(process.cwd(), root) || '.'}`);
      }
    }
  }

  if (proj.configPath) {
    return `Searched in paths from ${path.relative(process.cwd(), proj.configPath)}:\n${lines.join('\n')}`;
  }

  return `Searched in default paths:\n${lines.join('\n')}`;
}

/**
 * Find all experiments in the configured search paths.
 *
 * Searches recursively, so experiments can be organized in subfolders.
 * Returns absolute paths to experiment directories. Includes experiments
 * from configured suites (those with a materialized cache directory).
 */
export function findAllExperiments(project?: ResolvedProject): string[] {
  const proj = project || loadProject();
  const searchPaths = projectExperimentSearchPaths(proj);
  const results: string[] = [];

  for (const searchPath of searchPaths) {
    if (!fs.existsSync(searchPath)) continue;
    findConfigFilesRecursive(searchPath, 'experiment.yaml', results);
  }

  for (const suite of safeLoadSuites(proj)) {
    for (const root of getSuiteExperimentSearchPaths(suite)) {
      if (!fs.existsSync(root)) continue;
      findConfigFilesRecursive(root, 'experiment.yaml', results);
    }
  }

  return results;
}

/**
 * Find all agents in the configured search paths.
 *
 * Searches recursively. Returns absolute paths to agent directories.
 */
export function findAllAgents(project?: ResolvedProject): string[] {
  const proj = project || loadProject();
  const searchPaths = projectAgentSearchPaths(proj);
  const results: string[] = [];

  for (const searchPath of searchPaths) {
    if (!fs.existsSync(searchPath)) continue;
    findConfigFilesRecursive(searchPath, 'agent.yaml', results);
  }

  return results;
}

function findConfigFilesRecursive(dir: string, configFile: string, results: string[]): void {
  if (!fs.existsSync(dir)) return;

  const configPath = path.join(dir, configFile);
  if (fs.existsSync(configPath)) {
    results.push(dir);
    return;
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      findConfigFilesRecursive(path.join(dir, entry.name), configFile, results);
    }
  } catch {
    // Ignore permission errors etc.
  }
}
