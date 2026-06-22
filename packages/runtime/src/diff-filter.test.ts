// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for diff filtering utilities
 */

import { describe, it, expect } from 'vitest';
import { filterLockfilesFromDiff, LOCKFILE_BASENAMES } from './diff-filter.js';

// Helper: build a unified diff section with "diff -Nu" header (per-file mode)
function makeDiffSection(filepath: string, content = '+added line'): string {
  return [
    `diff -Nu /workspace-source/${filepath} /workspace/${filepath}`,
    `--- /workspace-source/${filepath}\t2024-01-01 00:00:00.000000000 +0000`,
    `+++ /workspace/${filepath}\t2024-01-01 00:00:00.000000000 +0000`,
    '@@ -1,3 +1,4 @@',
    ' context',
    content,
    ' more context',
  ].join('\n');
}

// Helper: build a diff section with git format
function makeGitDiffSection(filepath: string, content = '+added line'): string {
  return [
    `diff --git a/${filepath} b/${filepath}`,
    `--- a/${filepath}`,
    `+++ b/${filepath}`,
    '@@ -1,3 +1,4 @@',
    ' context',
    content,
    ' more context',
  ].join('\n');
}

// Helper: build a diff section with only --- /+++ headers (recursive diff -rNu format)
function makeRecursiveDiffSection(filepath: string, content = '+added line'): string {
  return [
    `--- /workspace-source/${filepath}\t2024-01-01 00:00:00.000000000 +0000`,
    `+++ /workspace/${filepath}\t2024-01-01 00:00:00.000000000 +0000`,
    '@@ -1,3 +1,4 @@',
    ' context',
    content,
    ' more context',
  ].join('\n');
}

describe('LOCKFILE_BASENAMES', () => {
  it('contains 9 lockfile basenames', () => {
    expect(LOCKFILE_BASENAMES.size).toBe(9);
  });

  it('includes common lockfiles', () => {
    expect(LOCKFILE_BASENAMES.has('package-lock.json')).toBe(true);
    expect(LOCKFILE_BASENAMES.has('yarn.lock')).toBe(true);
    expect(LOCKFILE_BASENAMES.has('pnpm-lock.yaml')).toBe(true);
    expect(LOCKFILE_BASENAMES.has('Cargo.lock')).toBe(true);
    expect(LOCKFILE_BASENAMES.has('go.sum')).toBe(true);
  });
});

describe('filterLockfilesFromDiff', () => {
  describe('with diff headers (per-file format)', () => {
    it('filters root-level lockfile', () => {
      const diff = [
        makeDiffSection('src/app.ts', '+console.log("hello")'),
        makeDiffSection('package-lock.json', '+lots of deps'),
      ].join('\n');

      const result = filterLockfilesFromDiff(diff);
      expect(result).toContain('src/app.ts');
      expect(result).not.toContain('package-lock.json');
    });

    it('filters nested lockfile at any depth', () => {
      const diff = [
        makeDiffSection('src/app.ts'),
        makeDiffSection('packages/core/package-lock.json', '+nested dep changes'),
      ].join('\n');

      const result = filterLockfilesFromDiff(diff);
      expect(result).toContain('src/app.ts');
      expect(result).not.toContain('package-lock.json');
    });

    it('preserves non-lockfile sections', () => {
      const diff = [
        makeDiffSection('src/index.ts', '+export {}'),
        makeDiffSection('package.json', '+"name": "app"'),
        makeDiffSection('README.md', '+# Hello'),
      ].join('\n');

      const result = filterLockfilesFromDiff(diff);
      expect(result).toContain('src/index.ts');
      expect(result).toContain('package.json');
      expect(result).toContain('README.md');
    });

    it('handles all 9 lockfile basenames', () => {
      const lockfiles = Array.from(LOCKFILE_BASENAMES);
      const sections = [
        makeDiffSection('src/app.ts'),
        ...lockfiles.map((name) => makeDiffSection(name)),
      ];
      const diff = sections.join('\n');

      const result = filterLockfilesFromDiff(diff);
      expect(result).toContain('src/app.ts');
      for (const name of lockfiles) {
        expect(result).not.toContain(name);
      }
    });

    it('handles git-format diff headers', () => {
      const diff = [
        makeGitDiffSection('src/app.ts'),
        makeGitDiffSection('yarn.lock', '+dependency data'),
      ].join('\n');

      const result = filterLockfilesFromDiff(diff);
      expect(result).toContain('src/app.ts');
      expect(result).not.toContain('yarn.lock');
    });

    it('handles all-lockfile diff (returns empty)', () => {
      const diff = [
        makeDiffSection('package-lock.json'),
        makeDiffSection('yarn.lock'),
      ].join('\n');

      const result = filterLockfilesFromDiff(diff);
      expect(result.trim()).toBe('');
    });
  });

  describe('with --- headers only (recursive diff format)', () => {
    it('filters root-level lockfile', () => {
      const diff = [
        makeRecursiveDiffSection('hello.js', '+console.log("hello")'),
        makeRecursiveDiffSection('package-lock.json', '+lots of deps'),
      ].join('\n');

      const result = filterLockfilesFromDiff(diff);
      expect(result).toContain('hello.js');
      expect(result).not.toContain('package-lock.json');
    });

    it('filters nested lockfile', () => {
      const diff = [
        makeRecursiveDiffSection('src/index.ts'),
        makeRecursiveDiffSection('sub/yarn.lock', '+dep data'),
      ].join('\n');

      const result = filterLockfilesFromDiff(diff);
      expect(result).toContain('src/index.ts');
      expect(result).not.toContain('yarn.lock');
    });

    it('preserves non-lockfile sections', () => {
      const diff = [
        makeRecursiveDiffSection('hello.js'),
        makeRecursiveDiffSection('package.json'),
      ].join('\n');

      const result = filterLockfilesFromDiff(diff);
      expect(result).toContain('hello.js');
      expect(result).toContain('package.json');
    });

    it('handles all 9 lockfile basenames', () => {
      const lockfiles = Array.from(LOCKFILE_BASENAMES);
      const sections = [
        makeRecursiveDiffSection('src/app.ts'),
        ...lockfiles.map((name) => makeRecursiveDiffSection(name)),
      ];
      const diff = sections.join('\n');

      const result = filterLockfilesFromDiff(diff);
      expect(result).toContain('src/app.ts');
      for (const name of lockfiles) {
        expect(result).not.toContain(name);
      }
    });

    it('handles all-lockfile diff (returns empty)', () => {
      const diff = [
        makeRecursiveDiffSection('package-lock.json'),
        makeRecursiveDiffSection('yarn.lock'),
      ].join('\n');

      const result = filterLockfilesFromDiff(diff);
      expect(result.trim()).toBe('');
    });
  });

  describe('edge cases', () => {
    it('returns empty string for empty input', () => {
      expect(filterLockfilesFromDiff('')).toBe('');
    });

    it('preserves sentinel: no changes', () => {
      const input = '# No changes detected';
      expect(filterLockfilesFromDiff(input)).toBe(input);
    });

    it('preserves sentinel: error', () => {
      const input = '# Error generating diff';
      expect(filterLockfilesFromDiff(input)).toBe(input);
    });

    it('returns input unchanged when no diff headers present', () => {
      const input = 'This is just some text\nwith no diff markers\nat all';
      expect(filterLockfilesFromDiff(input)).toBe(input);
    });

    it('handles single non-lockfile section', () => {
      const diff = makeDiffSection('src/app.ts', '+hello');
      const result = filterLockfilesFromDiff(diff);
      expect(result).toContain('src/app.ts');
      expect(result).toContain('+hello');
    });

    it('handles single non-lockfile section (recursive format)', () => {
      const diff = makeRecursiveDiffSection('src/app.ts', '+hello');
      const result = filterLockfilesFromDiff(diff);
      expect(result).toContain('src/app.ts');
      expect(result).toContain('+hello');
    });
  });
});
