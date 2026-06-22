// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Git-backed suite cache management.
 *
 * Materializes the on-disk clones referenced by `bunsen.config.yaml#suites`.
 * Cloning, fetching, and checking out are delegated to `git`; Bunsen does not
 * manage credentials.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SuiteCacheError extends Error {
  readonly code: string;
  readonly stderr?: string;

  constructor(code: string, message: string, options: { stderr?: string } = {}) {
    super(message);
    this.name = 'SuiteCacheError';
    this.code = code;
    this.stderr = options.stderr;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CloneOptions {
  url: string;
  /** Branch, tag, or commit SHA. If omitted, clones the default branch. */
  ref?: string;
  /** Absolute path where the clone lives. */
  cacheDir: string;
  onProgress?: (message: string) => void;
}

export interface UpdateOptions {
  /** Source URL — used in error messages and to detect URL changes. */
  url: string;
  /** Branch, tag, or commit SHA to check out. */
  ref?: string;
  /** Absolute path of the existing clone. */
  cacheDir: string;
  onProgress?: (message: string) => void;
}

export interface CacheStatus {
  exists: boolean;
  /** Resolved commit SHA, if the clone is materialized. */
  sha?: string;
  /** Currently checked-out ref name (`HEAD` if detached). */
  head?: string;
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;

function isSha(ref: string): boolean {
  return SHA_RE.test(ref);
}

function isNonInteractive(): boolean {
  // Match git's own heuristic: if the user has explicitly disabled prompts
  // (GIT_TERMINAL_PROMPT=0) or the parent is plainly headless (CI, no TTY),
  // we want hard-fail-on-prompt rather than a silent hang.
  if (process.env.GIT_TERMINAL_PROMPT === '0') return true;
  if (process.env.CI) return true;
  return !process.stdin.isTTY;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (isNonInteractive()) {
    // Refuse to prompt for credentials. Without this a missing cred helper
    // can hang forever on `git clone` waiting for a username/password.
    env.GIT_TERMINAL_PROMPT = '0';
    if (env.GIT_ASKPASS === undefined) {
      env.GIT_ASKPASS = '/bin/echo';
    }
  }
  return env;
}

/**
 * Run `git` with the args, returning the result. Suppresses credential
 * prompts in non-interactive shells via {@link gitEnv}.
 */
function runGit(
  args: string[],
  opts: { cwd?: string } = {},
): SpawnSyncReturns<string> {
  return spawnSync('git', args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    env: gitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Run `git` and throw {@link SuiteCacheError} on non-zero exit. The error
 * message includes git's stderr verbatim and an auth-config hint when the
 * failure looks like a credentials problem.
 */
function git(
  args: string[],
  opts: { cwd?: string; context: string; url: string; code: string },
): SpawnSyncReturns<string> {
  const result = runGit(args, { cwd: opts.cwd });
  if (result.status === 0) return result;
  const stderr = (result.stderr ?? '').trim();
  const lines = [`${opts.context} failed for ${opts.url}.`];
  if (stderr) {
    lines.push('', 'git error:', ...stderr.split('\n').map((l) => `  ${l}`));
  }
  if (
    /could not read username|terminal prompts disabled|authentication failed|access denied|permission denied/i.test(
      stderr,
    )
  ) {
    lines.push(
      '',
      'Bunsen does not manage git credentials. Configure git access for this URL via',
      '`ssh-add`, a credential helper (e.g., `git config --global credential.helper`),',
      'or `git config --global url.<insteadOf>.<original>` to rewrite the URL form.',
    );
  }
  throw new SuiteCacheError(opts.code, lines.join('\n'), { stderr });
}

/**
 * Clone a suite repository into `cacheDir`.
 *
 * If `cacheDir` already exists, it is removed and re-cloned (matches the
 * "re-clones to the ref" semantics described in `docs/SUITES.md`).
 *
 * - Branch / tag refs use `git clone --depth 1 --branch <ref>` for speed.
 * - SHA refs require a full clone (commits aren't reachable via shallow refs).
 * - If `ref` is omitted, clones the default branch shallowly.
 */
export function cloneSuite(opts: CloneOptions): { sha: string } {
  const { url, ref, cacheDir, onProgress } = opts;
  if (fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(cacheDir), { recursive: true });

  onProgress?.(`Cloning ${url}${ref ? ` @ ${ref}` : ''}...`);

  const refIsSha = ref !== undefined && isSha(ref);
  // Shallow + SHA doesn't work without uploadpack.allowReachableSHA1InWant,
  // so SHA refs require a full clone followed by an explicit checkout.
  const cloneArgs = refIsSha
    ? ['clone', url, cacheDir]
    : ['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), url, cacheDir];

  try {
    git(cloneArgs, { context: 'git clone', url, code: 'suite.cache.clone_failed' });
    if (refIsSha) {
      onProgress?.(`Checking out ${ref}...`);
      git(['checkout', '--quiet', ref!], {
        cwd: cacheDir,
        context: `git checkout ${ref}`,
        url,
        code: 'suite.cache.checkout_failed',
      });
    }
  } catch (err) {
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
    throw err;
  }

  const sha = readHeadSha(cacheDir);
  if (!sha) {
    throw new SuiteCacheError(
      'suite.cache.no_head',
      `Suite clone at ${cacheDir} has no resolvable HEAD commit.`,
    );
  }
  return { sha };
}

/**
 * Update an existing suite clone to the latest tip of `ref` (or the same
 * commit, if `ref` is a SHA).
 *
 * If the clone does not exist yet, falls back to a fresh clone via
 * {@link cloneSuite}.
 */
export function updateSuite(opts: UpdateOptions): { sha: string } {
  const { url, ref, cacheDir, onProgress } = opts;
  if (!fs.existsSync(path.join(cacheDir, '.git'))) {
    return cloneSuite({ url, ref, cacheDir, onProgress });
  }

  // Refresh remote URL in case the user `bn suites add`'d a different URL
  // pointing at the same canonical id (rare but possible — host case
  // variants, http→https, etc.).
  git(['remote', 'set-url', 'origin', url], {
    cwd: cacheDir,
    context: 'git remote set-url',
    url,
    code: 'suite.cache.remote_set_url_failed',
  });

  onProgress?.(`Fetching updates for ${url}${ref ? ` @ ${ref}` : ''}...`);
  // Fetch all branches + tags so any ref form (tag, branch, sha) the user
  // pinned resolves below. Auto-unshallow so older tags/commits are reachable.
  const fetchArgs = ['fetch', '--prune', '--tags', '--force'];
  if (fs.existsSync(path.join(cacheDir, '.git', 'shallow'))) {
    fetchArgs.push('--unshallow');
  }
  fetchArgs.push('origin');
  git(fetchArgs, { cwd: cacheDir, context: 'git fetch', url, code: 'suite.cache.fetch_failed' });

  // Resolve the target ref to a concrete commit. We prefer `origin/<ref>`
  // first so a branch name like "main" picks up the freshly fetched tip
  // rather than the stale local-tracking branch. Tags and SHAs don't have
  // an `origin/` prefix so they fall through to the literal lookup.
  const refSpec = ref ?? 'HEAD';
  const target = revParse(cacheDir, `origin/${refSpec}`) ?? revParse(cacheDir, refSpec);
  if (!target) {
    throw new SuiteCacheError(
      'suite.cache.unknown_ref',
      `Suite at ${cacheDir} has no ref matching ${JSON.stringify(refSpec)} after fetch.`,
    );
  }

  onProgress?.(`Checking out ${ref ?? 'default branch'}...`);
  // `--detach` keeps the working tree pinned to a specific commit,
  // matching the "frozen at a pinned ref" mental model for suites.
  git(['checkout', '--quiet', '--force', '--detach', target], {
    cwd: cacheDir,
    context: `git checkout ${target}`,
    url,
    code: 'suite.cache.checkout_failed',
  });

  return { sha: target };
}

/**
 * Remove a cached suite directory.
 *
 * No-op when the directory does not exist. Refuses to remove a path that
 * is not a directory (defensive: catches a bad cacheDir override).
 */
export function removeSuiteCache(cacheDir: string): void {
  if (!fs.existsSync(cacheDir)) return;
  const stat = fs.statSync(cacheDir);
  if (!stat.isDirectory()) {
    throw new SuiteCacheError(
      'suite.cache.not_directory',
      `Refusing to remove non-directory cache path: ${cacheDir}`,
    );
  }
  fs.rmSync(cacheDir, { recursive: true, force: true });
}

/** Inspect the on-disk state of a cached suite. */
export function getSuiteCacheStatus(cacheDir: string): CacheStatus {
  if (!fs.existsSync(path.join(cacheDir, '.git'))) {
    return { exists: false };
  }
  const sha = readHeadSha(cacheDir);
  const head = readHeadName(cacheDir);
  const status: CacheStatus = { exists: true };
  if (sha) status.sha = sha;
  if (head) status.head = head;
  return status;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readHeadSha(cacheDir: string): string | undefined {
  const result = runGit(['rev-parse', 'HEAD'], { cwd: cacheDir });
  if (result.status !== 0) return undefined;
  const sha = result.stdout.trim();
  return SHA_RE.test(sha) ? sha : undefined;
}

function readHeadName(cacheDir: string): string | undefined {
  const result = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: cacheDir });
  if (result.status !== 0) return undefined;
  const name = result.stdout.trim();
  return name.length > 0 ? name : undefined;
}

function revParse(cacheDir: string, ref: string): string | undefined {
  const result = runGit(['rev-parse', '--verify', '--quiet', ref], { cwd: cacheDir });
  if (result.status !== 0) return undefined;
  const sha = result.stdout.trim();
  return SHA_RE.test(sha) ? sha : undefined;
}

/**
 * For tests: detect whether `git` is on PATH so suite-cache tests can be
 * skipped on environments that don't have it.
 */
export function isGitAvailable(): boolean {
  const result = spawnSync('git', ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}
