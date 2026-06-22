// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Agent source resolution — fetch agents from git, npm, or binary sources.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type {
  InstallSource,
  InstallSourceGit,
  InstallSourceNpm,
  InstallSourceBinary,
} from '@bunsen-dev/types';
import type { ResolvedAgent } from './agent-loader.js';

const SOURCES_DIR = '.bunsen/sources';

/** Root directory for the agent-source cache. */
export function getSourcesDir(baseDir: string = process.cwd()): string {
  return path.join(baseDir, SOURCES_DIR);
}

/**
 * Generate a stable cache key for an `install.source`. Local sources are not
 * cached (they point at the agent directory directly).
 */
export function generateSourceCacheKey(source: InstallSource): string {
  const parts: string[] = [source.type];
  switch (source.type) {
    case 'git': {
      parts.push(source.repo);
      parts.push(source.ref ?? 'HEAD');
      break;
    }
    case 'npm': {
      parts.push(source.package);
      parts.push(source.version ?? 'latest');
      break;
    }
    case 'binary': {
      parts.push(source.url);
      parts.push(source.sha256 ?? '');
      break;
    }
    case 'local':
      return 'local';
  }
  const hash = crypto.createHash('sha256').update(parts.join('|')).digest('hex');
  return hash.slice(0, 12);
}

/** Whether a source with the given cache key is already materialized on disk. */
export function isSourceCached(cacheKey: string, baseDir: string = process.cwd()): boolean {
  if (cacheKey === 'local') return true;
  const cachePath = path.join(getSourcesDir(baseDir), cacheKey);
  return fs.existsSync(cachePath) && fs.existsSync(path.join(cachePath, 'agent.yaml'));
}

/** Filesystem path for a cached source. */
export function getCachedSourcePath(cacheKey: string, baseDir: string = process.cwd()): string {
  return path.join(getSourcesDir(baseDir), cacheKey);
}

// ---------------------------------------------------------------------------
// Input validation (defense in depth)
//
// Agent sources come from author-controlled `agent.yaml` files, and resolving a
// non-local source runs git/npm/curl *on the host*. The resolve functions below
// invoke those tools with argv arrays (`execFileSync`, no shell) so author
// strings can never break out of their argument position. On top of that, we
// validate every author-supplied value against a strict format before it
// reaches a child process. The format checks block two classes of abuse that
// argv arrays alone do not:
//   - option injection — a value beginning with `-` parsed as a flag.
//   - transport/protocol abuse — e.g. git's `ext::` remote helper, which runs
//     an arbitrary command on the host regardless of how the URL is quoted, or
//     a `file://` binary URL reading off the local disk.
// ---------------------------------------------------------------------------

/** Plausible git ref (branch, tag, or commit) — no shell metacharacters, no leading dash. */
const GIT_REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

/**
 * Allowed git transport schemes. Deliberately excludes the `ext::` / `fd::`
 * remote helpers and other `transport::` forms, which execute commands on the
 * host.
 */
const GIT_URL_SCHEME_PATTERN = /^(https?|git|ssh|file):\/\//;

/**
 * scp-style git remote: `[user@]host:path`. The single colon is what
 * distinguishes it from `ext::`-style helper syntax (rejected by the path
 * charset, which does not include `:`).
 */
const GIT_SCP_PATTERN = /^([A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+:[A-Za-z0-9._/~-]+$/;

/** npm package name, optionally scoped — must start alphanumeric (never `-`). */
const NPM_PACKAGE_PATTERN = /^(@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * npm version, range, or dist-tag. Permissive enough for semver ranges
 * (`^1.0.0`, `>=1 <2`, `1.x`) but free of shell metacharacters, and never
 * starting with `-` (which would parse as an npm flag).
 */
const NPM_VERSION_PATTERN = /^[A-Za-z0-9~^*<>=|][A-Za-z0-9._+~^*<>=| -]*$/;

function assertValidGitRef(ref: string): void {
  if (!GIT_REF_PATTERN.test(ref) || ref.includes('..')) {
    throw new Error(
      `Invalid git ref ${JSON.stringify(ref)}: refs may contain only letters, digits, ` +
        `'.', '_', '/', '-', must not start with '-', and must not contain '..'.`
    );
  }
}

function assertValidGitRepo(repo: string): void {
  if (GIT_URL_SCHEME_PATTERN.test(repo)) {
    try {
      new URL(repo);
      return;
    } catch {
      // Fall through to the rejection below — a malformed URL is not a usable repo.
    }
  } else if (GIT_SCP_PATTERN.test(repo)) {
    return;
  }
  throw new Error(
    `Unsupported or unsafe git repo URL ${JSON.stringify(repo)}: expected an http(s), git, ` +
      `ssh, or file URL, or an scp-style 'user@host:path' remote. Transport helpers such as ` +
      `'ext::' are rejected because they execute commands on the host.`
  );
}

function assertValidNpmPackage(packageName: string): void {
  // npm caps package names at 214 characters.
  if (packageName.length > 214 || !NPM_PACKAGE_PATTERN.test(packageName)) {
    throw new Error(
      `Invalid npm package name ${JSON.stringify(packageName)}: expected a valid (optionally ` +
        `scoped) package name with no shell metacharacters.`
    );
  }
}

function assertValidNpmVersion(version: string): void {
  if (!NPM_VERSION_PATTERN.test(version)) {
    throw new Error(
      `Invalid npm version ${JSON.stringify(version)}: expected a semver version, range, or ` +
        `dist-tag with no shell metacharacters.`
    );
  }
}

function assertValidBinaryUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid binary source URL ${JSON.stringify(url)}: not a valid URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid binary source URL ${JSON.stringify(url)}: only http(s) URLs are supported ` +
        `(got protocol '${parsed.protocol}').`
    );
  }
}

async function resolveGitSource(
  source: InstallSourceGit,
  cacheDir: string,
  onProgress?: (message: string) => void
): Promise<void> {
  const { repo, ref } = source;
  assertValidGitRepo(repo);
  if (ref !== undefined) assertValidGitRef(ref);

  onProgress?.(`Cloning ${repo}...`);
  fs.mkdirSync(cacheDir, { recursive: true });

  try {
    const cloneArgs = ['clone', '--depth', '1'];
    if (ref) cloneArgs.push('--branch', ref);
    // `--` terminates option parsing so neither repo nor cacheDir can be read as a flag.
    cloneArgs.push('--', repo, cacheDir);
    execFileSync('git', cloneArgs, { stdio: 'pipe' });
    // If ref is a commit hash, fetch + checkout explicitly.
    if (ref && /^[a-f0-9]{7,40}$/i.test(ref)) {
      execFileSync('git', ['fetch', 'origin', ref], { cwd: cacheDir, stdio: 'pipe' });
      execFileSync('git', ['checkout', ref], { cwd: cacheDir, stdio: 'pipe' });
    }
    onProgress?.(`Cloned ${repo} successfully`);
  } catch (error) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to clone git repository: ${message}`);
  }
}

async function resolveNpmSource(
  source: InstallSourceNpm,
  cacheDir: string,
  onProgress?: (message: string) => void
): Promise<void> {
  const { package: packageName, version = 'latest' } = source;
  assertValidNpmPackage(packageName);
  if (version !== 'latest') assertValidNpmVersion(version);

  const packageSpec = version === 'latest' ? packageName : `${packageName}@${version}`;
  onProgress?.(`Installing ${packageSpec}...`);

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, 'package.json'),
    JSON.stringify({ name: 'bunsen-agent-source', private: true }, null, 2)
  );

  try {
    // `--ignore-scripts` prevents the third-party package's lifecycle scripts
    // (preinstall/install/postinstall) from running on the host. The package
    // spec is a single argv token that always begins with the validated package
    // name, so it can never be parsed as an npm flag.
    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', packageSpec], {
      cwd: cacheDir,
      stdio: 'pipe',
    });

    let packagePath: string;
    if (packageName.startsWith('@')) {
      const [scope, name] = packageName.split('/');
      packagePath = path.join(cacheDir, 'node_modules', scope, name);
    } else {
      packagePath = path.join(cacheDir, 'node_modules', packageName);
    }

    if (!fs.existsSync(path.join(packagePath, 'agent.yaml'))) {
      throw new Error(`Package ${packageName} does not contain an agent.yaml file`);
    }

    const tempDir = path.join(cacheDir, '_temp');
    fs.renameSync(packagePath, tempDir);
    for (const item of fs.readdirSync(tempDir)) {
      fs.renameSync(path.join(tempDir, item), path.join(cacheDir, item));
    }
    fs.rmSync(path.join(cacheDir, 'node_modules'), { recursive: true, force: true });
    fs.rmSync(path.join(cacheDir, 'package.json'), { force: true });
    fs.rmSync(path.join(cacheDir, 'package-lock.json'), { force: true });

    onProgress?.(`Installed ${packageSpec} successfully`);
  } catch (error) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to install npm package: ${message}`);
  }
}

async function resolveBinarySource(
  source: InstallSourceBinary,
  cacheDir: string,
  onProgress?: (message: string) => void
): Promise<void> {
  const { url } = source;
  assertValidBinaryUrl(url);
  onProgress?.(`Downloading binary from ${url}...`);

  fs.mkdirSync(cacheDir, { recursive: true });

  try {
    // `--proto`/`--proto-redir` pin curl to http(s) for both the initial
    // request and any redirects, so a validated http(s) URL can't be redirected
    // to file:// or another transport. The URL is a positional argument.
    execFileSync(
      'curl',
      [
        '-fsSL',
        '--proto',
        '=http,https',
        '--proto-redir',
        '=http,https',
        '-o',
        'agent-binary',
        url,
      ],
      { cwd: cacheDir, stdio: 'pipe' }
    );
    fs.chmodSync(path.join(cacheDir, 'agent-binary'), 0o755);

    if (source.sha256) {
      const actual = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(cacheDir, 'agent-binary')))
        .digest('hex');
      if (actual.toLowerCase() !== source.sha256.toLowerCase()) {
        fs.rmSync(cacheDir, { recursive: true, force: true });
        throw new Error(
          `Downloaded binary sha256 mismatch: expected ${source.sha256}, got ${actual}.`
        );
      }
    }
    onProgress?.(`Downloaded binary successfully`);
  } catch (error) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to download binary: ${message}`);
  }
}

/**
 * Resolve an agent's install source to a local directory.
 *
 * The agent must already have its variant applied (so `agent.install.source`
 * reflects any `source.ref` / `source.version` override from the variant).
 */
export async function resolveAgentSource(
  agent: ResolvedAgent,
  baseDir: string = process.cwd(),
  onProgress?: (message: string) => void
): Promise<string> {
  const source = agent.install.source;
  if (source.type === 'local') return agent.path;

  const cacheKey = generateSourceCacheKey(source);
  const cacheDir = getCachedSourcePath(cacheKey, baseDir);
  if (isSourceCached(cacheKey, baseDir)) {
    onProgress?.(`Using cached source: ${cacheKey}`);
    return cacheDir;
  }

  onProgress?.(`Resolving ${source.type} source...`);
  switch (source.type) {
    case 'git':
      await resolveGitSource(source, cacheDir, onProgress);
      break;
    case 'npm':
      await resolveNpmSource(source, cacheDir, onProgress);
      break;
    case 'binary':
      await resolveBinarySource(source, cacheDir, onProgress);
      break;
  }
  return cacheDir;
}

/** Remove every entry from the source cache. */
export function clearSourceCache(baseDir: string = process.cwd()): void {
  const sourcesDir = getSourcesDir(baseDir);
  if (fs.existsSync(sourcesDir)) {
    fs.rmSync(sourcesDir, { recursive: true, force: true });
  }
}

/** Cached source cache-keys on disk. */
export function listCachedSources(baseDir: string = process.cwd()): string[] {
  const sourcesDir = getSourcesDir(baseDir);
  if (!fs.existsSync(sourcesDir)) return [];
  return fs.readdirSync(sourcesDir).filter((entry) => {
    const entryPath = path.join(sourcesDir, entry);
    return fs.statSync(entryPath).isDirectory();
  });
}
