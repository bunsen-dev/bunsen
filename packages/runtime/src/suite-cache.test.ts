// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for the git-backed suite cache.
 *
 * These tests use a local bare git repository as a fake "remote" so they
 * exercise real `git clone` / `git fetch` paths without any network I/O.
 * Skipped automatically when `git` is not on PATH.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  cloneSuite,
  updateSuite,
  removeSuiteCache,
  getSuiteCacheStatus,
  isGitAvailable,
  SuiteCacheError,
} from './suite-cache.js';

const HAS_GIT = isGitAvailable();

const skipWithoutGit = HAS_GIT ? describe : describe.skip;

function mkTemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-suite-cache-test-'));
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Build a bare repo with a couple of commits, plus an extra branch and tag.
 * Returns the absolute path to the bare repo (suitable as a clone URL).
 */
function makeFakeRemote(): { remotePath: string; commits: string[]; tagSha: string } {
  const root = mkTemp();
  const work = path.join(root, 'work');
  const remote = path.join(root, 'remote.git');

  fs.mkdirSync(work);
  git(work, ['init', '-q', '-b', 'main']);
  git(work, ['config', 'user.email', 'test@example.com']);
  git(work, ['config', 'user.name', 'Test User']);
  git(work, ['commit', '--allow-empty', '-m', 'initial']);
  fs.writeFileSync(path.join(work, 'README.md'), '# fake suite');
  git(work, ['add', 'README.md']);
  git(work, ['commit', '-m', 'add readme']);
  const c1 = git(work, ['rev-parse', 'HEAD']);

  git(work, ['tag', 'v1.0']);
  const tagSha = git(work, ['rev-parse', 'v1.0^{commit}']);

  fs.writeFileSync(path.join(work, 'README.md'), '# fake suite v2');
  git(work, ['add', 'README.md']);
  git(work, ['commit', '-m', 'update']);
  const c2 = git(work, ['rev-parse', 'HEAD']);

  // Create a second branch with its own commit so we can test branch refs.
  git(work, ['checkout', '-q', '-b', 'feature']);
  fs.writeFileSync(path.join(work, 'feature.txt'), 'feature');
  git(work, ['add', 'feature.txt']);
  git(work, ['commit', '-m', 'feature commit']);
  const c3 = git(work, ['rev-parse', 'HEAD']);
  git(work, ['checkout', '-q', 'main']);

  // Bare clone for use as a remote.
  execFileSync('git', ['clone', '--bare', '-q', work, remote]);
  // bare clones default HEAD to whatever the source had checked out (main).

  return { remotePath: remote, commits: [c1, c2, c3], tagSha };
}

skipWithoutGit('cloneSuite', () => {
  let temp: string;

  beforeEach(() => {
    temp = mkTemp();
  });

  afterEach(() => {
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it('clones the default branch when no ref is provided', () => {
    const { remotePath } = makeFakeRemote();
    const cacheDir = path.join(temp, 'clone');
    const { sha } = cloneSuite({ url: remotePath, cacheDir });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.existsSync(path.join(cacheDir, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, 'README.md'))).toBe(true);
  });

  it('clones a tag ref shallowly', () => {
    const { remotePath, tagSha } = makeFakeRemote();
    const cacheDir = path.join(temp, 'clone');
    const { sha } = cloneSuite({ url: remotePath, ref: 'v1.0', cacheDir });
    expect(sha).toBe(tagSha);
  });

  it('clones a branch ref shallowly', () => {
    const { remotePath, commits } = makeFakeRemote();
    const cacheDir = path.join(temp, 'clone');
    const { sha } = cloneSuite({ url: remotePath, ref: 'feature', cacheDir });
    expect(sha).toBe(commits[2]);
  });

  it('clones a commit SHA via full clone + checkout', () => {
    const { remotePath, commits } = makeFakeRemote();
    const cacheDir = path.join(temp, 'clone');
    const { sha } = cloneSuite({ url: remotePath, ref: commits[0], cacheDir });
    expect(sha).toBe(commits[0]);
  });

  it('replaces an existing clone when re-cloned', () => {
    const { remotePath } = makeFakeRemote();
    const cacheDir = path.join(temp, 'clone');
    cloneSuite({ url: remotePath, cacheDir });
    fs.writeFileSync(path.join(cacheDir, 'sentinel'), '!');
    cloneSuite({ url: remotePath, cacheDir });
    expect(fs.existsSync(path.join(cacheDir, 'sentinel'))).toBe(false);
  });

  it('throws SuiteCacheError on a bogus URL', () => {
    const cacheDir = path.join(temp, 'clone');
    expect(() => cloneSuite({ url: '/no/such/repo.git', cacheDir })).toThrow(SuiteCacheError);
    expect(fs.existsSync(cacheDir)).toBe(false);
  });
});

skipWithoutGit('updateSuite', () => {
  let temp: string;

  beforeEach(() => {
    temp = mkTemp();
  });

  afterEach(() => {
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it('falls back to cloneSuite when the cacheDir is empty', () => {
    const { remotePath } = makeFakeRemote();
    const cacheDir = path.join(temp, 'clone');
    const { sha } = updateSuite({ url: remotePath, cacheDir });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('updates a cached clone to a new branch tip', () => {
    const { remotePath } = makeFakeRemote();
    const cacheDir = path.join(temp, 'clone');
    cloneSuite({ url: remotePath, ref: 'main', cacheDir });
    const beforeSha = getSuiteCacheStatus(cacheDir).sha!;

    // Push a new commit to the remote and update.
    const work = mkTemp();
    execFileSync('git', ['clone', '-q', remotePath, work]);
    fs.writeFileSync(path.join(work, 'NEW.txt'), 'new');
    git(work, ['config', 'user.email', 'a@b.c']);
    git(work, ['config', 'user.name', 'A']);
    git(work, ['add', 'NEW.txt']);
    git(work, ['commit', '-m', 'new commit']);
    git(work, ['push', '-q', 'origin', 'main']);
    fs.rmSync(work, { recursive: true, force: true });

    // updateSuite without a pinned ref → follows the default branch tip.
    const { sha: afterSha } = updateSuite({ url: remotePath, ref: 'main', cacheDir });
    expect(afterSha).not.toBe(beforeSha);
    expect(fs.existsSync(path.join(cacheDir, 'NEW.txt'))).toBe(true);
  });

  it('checks out a tag ref on update', () => {
    const { remotePath, tagSha } = makeFakeRemote();
    const cacheDir = path.join(temp, 'clone');
    cloneSuite({ url: remotePath, cacheDir });
    const { sha } = updateSuite({ url: remotePath, ref: 'v1.0', cacheDir });
    expect(sha).toBe(tagSha);
  });
});

skipWithoutGit('removeSuiteCache + getSuiteCacheStatus', () => {
  let temp: string;

  beforeEach(() => {
    temp = mkTemp();
  });

  afterEach(() => {
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it('reports exists=false for a missing cache dir', () => {
    expect(getSuiteCacheStatus(path.join(temp, 'missing')).exists).toBe(false);
  });

  it('reports exists=true with sha after clone', () => {
    const { remotePath } = makeFakeRemote();
    const cacheDir = path.join(temp, 'clone');
    cloneSuite({ url: remotePath, cacheDir });
    const status = getSuiteCacheStatus(cacheDir);
    expect(status.exists).toBe(true);
    expect(status.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('removeSuiteCache deletes the dir', () => {
    const { remotePath } = makeFakeRemote();
    const cacheDir = path.join(temp, 'clone');
    cloneSuite({ url: remotePath, cacheDir });
    removeSuiteCache(cacheDir);
    expect(fs.existsSync(cacheDir)).toBe(false);
  });

  it('removeSuiteCache no-ops on missing dir', () => {
    expect(() => removeSuiteCache(path.join(temp, 'missing'))).not.toThrow();
  });

  it('removeSuiteCache refuses to delete a non-directory path', () => {
    const filePath = path.join(temp, 'not-a-dir');
    fs.writeFileSync(filePath, 'oops');
    expect(() => removeSuiteCache(filePath)).toThrow(SuiteCacheError);
  });
});
