// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Diff filtering utilities.
 *
 * Lockfile changes are preserved in workspace/diff.patch on disk for full
 * reproducibility and `bn export` workspace reconstruction. These utilities
 * strip lockfile sections at consumption time (scorer, CLI display, viewer)
 * so that LLM context windows aren't dominated by auto-generated noise.
 */

import * as path from 'node:path';

/** Lockfile basenames that are filtered from diffs at display/scoring time. */
export const LOCKFILE_BASENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Gemfile.lock',
  'Pipfile.lock',
  'poetry.lock',
  'composer.lock',
  'Cargo.lock',
  'go.sum',
]);

/**
 * Remove lockfile sections from a unified diff string.
 *
 * Handles two diff formats:
 *   1. Sections starting with `diff ` headers (git diff, diff -Nu per-file)
 *   2. Sections starting with `--- ` headers (diff -rNu recursive output)
 *
 * Checks the filename in each section header and drops sections whose
 * basename matches a known lockfile.
 */
export function filterLockfilesFromDiff(diff: string): string {
  if (!diff) return diff;

  const trimmed = diff.trim();
  if (trimmed.startsWith('# ')) return diff;

  const lines = diff.split('\n');
  const hasDiffHeaders = lines.some((line) => line.startsWith('diff '));

  const sections = hasDiffHeaders
    ? splitOnDiffHeaders(lines)
    : splitOnDashDashDashHeaders(lines);

  if (sections.length === 0) return diff;
  if (sections.length === 1 && !isSectionHeader(sections[0][0], hasDiffHeaders)) return diff;

  const filtered = sections.filter((section) => {
    const header = section[0];
    if (!isSectionHeader(header, hasDiffHeaders)) return true;

    const filename = extractFilename(header, hasDiffHeaders);
    if (!filename) return true;

    return !LOCKFILE_BASENAMES.has(path.basename(filename));
  });

  return filtered.map((section) => section.join('\n')).join('\n');
}

function isSectionHeader(line: string, hasDiffHeaders: boolean): boolean {
  return hasDiffHeaders ? line.startsWith('diff ') : line.startsWith('--- ');
}

function splitOnDiffHeaders(lines: string[]): string[][] {
  const sections: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith('diff ')) {
      if (current.length > 0) sections.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) sections.push(current);
  return sections;
}

function splitOnDashDashDashHeaders(lines: string[]): string[][] {
  const sections: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith('--- ')) {
      if (current.length > 0) sections.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) sections.push(current);
  return sections;
}

function extractFilename(header: string, hasDiffHeaders: boolean): string | null {
  if (hasDiffHeaders) {
    return extractFilenameFromDiffHeader(header);
  }

  return extractFilenameFromDashDashDash(header);
}

function extractFilenameFromDiffHeader(header: string): string | null {
  const gitMatch = header.match(/^diff --git a\/.+ b\/(.+)$/);
  if (gitMatch) return gitMatch[1];

  const parts = header.split(/\s+/);
  if (parts.length >= 3) {
    return parts[parts.length - 1];
  }

  return null;
}

function extractFilenameFromDashDashDash(header: string): string | null {
  const rest = header.slice(4).split('\t')[0].trim();
  if (!rest || rest === '/dev/null') return null;
  return rest;
}
