// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Gitignore-based exclusion for workspace diffs and exports.
 *
 * Uses the 'ignore' library for proper gitignore semantics, including:
 * - Nested .gitignore files
 * - Negation patterns
 * - Complex glob syntax
 *
 * For diff commands, we still use --exclude patterns (simpler, good enough).
 * For tar exports, we use proper file-list filtering for accuracy.
 */

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import ignore, { Ignore } from 'ignore';

// =============================================================================
// Types
// =============================================================================

export interface ExclusionResult {
  /** Patterns to exclude (for --exclude flags) */
  patterns: string[];
  /** Where the patterns came from */
  source: 'gitignore' | 'fallback';
}

export interface GitignoreFilter {
  /** The ignore instance for filtering paths */
  ig: Ignore;
  /** Check if a relative path should be ignored */
  ignores: (relativePath: string) => boolean;
  /** Filter an array of relative paths, returning non-ignored ones */
  filter: (relativePaths: string[]) => string[];
}

export interface GitignoreContent {
  /** The raw content of the .gitignore file */
  content: string;
  /** The directory containing this .gitignore, relative to workspace root (use '.' for root) */
  relativeDir: string;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Default exclusions used when no .gitignore is present.
 * Covers common dependency directories, build outputs, and caches.
 */
export const FALLBACK_EXCLUSIONS = [
  // Dependencies
  'node_modules',
  '.pnpm-store',
  'vendor',
  // Python
  '__pycache__',
  '.venv',
  'venv',
  '*.pyc',
  '.pytest_cache',
  // Build outputs
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  // Coverage and testing
  'coverage',
  '.nyc_output',
  // IDE and editor
  '.idea',
  '.vscode',
  '*.swp',
  '*.swo',
  // OS files
  '.DS_Store',
  'Thumbs.db',
  // Logs
  '*.log',
  'npm-debug.log*',
  'yarn-debug.log*',
  'yarn-error.log*',
];

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Recursively find all .gitignore files in a directory.
 *
 * @param dir - Directory to search
 * @param relativeTo - Base directory for relative paths
 * @returns Array of { path, relativePath } for each .gitignore found
 */
async function findGitignoreFiles(
  dir: string,
  relativeTo: string = dir
): Promise<Array<{ absolutePath: string; relativeDir: string }>> {
  const results: Array<{ absolutePath: string; relativeDir: string }> = [];

  async function walk(currentDir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsPromises.readdir(currentDir, { withFileTypes: true });
    } catch {
      // Directory not readable, skip
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        // Skip .git directory
        if (entry.name === '.git') continue;

        // Skip common large directories for performance
        // (they'll be ignored anyway, no need to descend)
        if (entry.name === 'node_modules') continue;

        await walk(fullPath);
      } else if (entry.isFile() && entry.name === '.gitignore') {
        const relativeDir = path.relative(relativeTo, currentDir);
        results.push({
          absolutePath: fullPath,
          relativeDir: relativeDir || '.',
        });
      }
    }
  }

  await walk(dir);
  return results;
}

/**
 * Split raw `.gitignore` content into patterns (dropping blanks/comments) and
 * rebase each onto `relativeDir` so a nested `.gitignore` matches from the root.
 * Negation (`!`) patterns are preserved.
 */
function adjustGitignorePatterns(content: string, relativeDir: string): string[] {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(pattern => {
      if (relativeDir === '.') {
        // Root .gitignore, use patterns as-is
        return pattern;
      }
      // Nested .gitignore: prefix pattern with relative directory (preserve negation)
      if (pattern.startsWith('!')) {
        return '!' + path.join(relativeDir, pattern.slice(1));
      }
      return path.join(relativeDir, pattern);
    });
}

/**
 * Build a gitignore filter from raw .gitignore file contents.
 *
 * This is useful when reading .gitignore files from a container or other source
 * where direct filesystem access isn't available.
 *
 * @param contents - Array of gitignore file contents with their relative directories
 * @param useFallback - If true and no contents provided, use FALLBACK_EXCLUSIONS
 * @returns GitignoreFilter with methods to check/filter paths
 */
export function buildGitignoreFilterFromContents(
  contents: GitignoreContent[],
  useFallback: boolean = true
): GitignoreFilter {
  const ig = ignore();

  // Always ignore .git
  ig.add('.git');

  if (contents.length === 0 && useFallback) {
    // No .gitignore files found, use fallback
    ig.add(FALLBACK_EXCLUSIONS);
  } else {
    // Process each .gitignore content
    for (const { content, relativeDir } of contents) {
      ig.add(adjustGitignorePatterns(content, relativeDir));
    }
  }

  return {
    ig,
    ignores: (relativePath: string) => ig.ignores(relativePath),
    filter: (relativePaths: string[]) => ig.filter(relativePaths),
  };
}

/**
 * Build a gitignore filter from all .gitignore files in a directory tree.
 *
 * This properly handles nested .gitignore files by adjusting patterns
 * to be relative to the root directory.
 *
 * @param rootDir - Root directory to scan for .gitignore files
 * @returns GitignoreFilter with methods to check/filter paths
 */
export async function buildGitignoreFilter(rootDir: string): Promise<GitignoreFilter> {
  const ig = ignore();

  // Always ignore .git
  ig.add('.git');

  // Find all .gitignore files
  const gitignoreFiles = await findGitignoreFiles(rootDir);

  if (gitignoreFiles.length === 0) {
    // No .gitignore files found, use fallback
    ig.add(FALLBACK_EXCLUSIONS);
  } else {
    // Process each .gitignore file
    for (const { absolutePath, relativeDir } of gitignoreFiles) {
      try {
        const content = await fsPromises.readFile(absolutePath, 'utf-8');
        ig.add(adjustGitignorePatterns(content, relativeDir));
      } catch {
        // File not readable, skip
        continue;
      }
    }
  }

  return {
    ig,
    ignores: (relativePath: string) => ig.ignores(relativePath),
    filter: (relativePaths: string[]) => ig.filter(relativePaths),
  };
}

/**
 * List all non-ignored files in a directory.
 *
 * @param rootDir - Directory to scan
 * @param filter - Optional pre-built gitignore filter (will build one if not provided)
 * @returns Array of relative file paths that are not ignored
 */
export async function listNonIgnoredFiles(
  rootDir: string,
  filter?: GitignoreFilter
): Promise<string[]> {
  const ig = filter || (await buildGitignoreFilter(rootDir));
  const files: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsPromises.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);

      // Check if this path should be ignored
      if (ig.ignores(relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }

  await walk(rootDir);
  return files;
}

/**
 * Collect all exclusion patterns from all .gitignore files in a directory tree.
 *
 * This flattens nested .gitignore patterns for use with --exclude flags.
 * Note: This doesn't preserve the relative path semantics of nested gitignores,
 * so it may over-exclude in some cases. For precise filtering, use
 * buildGitignoreFilter + listNonIgnoredFiles instead.
 *
 * @param rootDir - Root directory to scan
 * @returns All unique patterns found
 */
export async function collectAllExclusionPatterns(rootDir: string): Promise<ExclusionResult> {
  const patterns = new Set<string>(['.git']);

  const gitignoreFiles = await findGitignoreFiles(rootDir);

  if (gitignoreFiles.length === 0) {
    FALLBACK_EXCLUSIONS.forEach(p => patterns.add(p));
    return { patterns: Array.from(patterns), source: 'fallback' };
  }

  for (const { absolutePath } of gitignoreFiles) {
    try {
      const content = await fsPromises.readFile(absolutePath, 'utf-8');
      const parsed = parseGitignore(content);
      parsed.forEach(p => patterns.add(p));
    } catch {
      continue;
    }
  }

  return { patterns: Array.from(patterns), source: 'gitignore' };
}

/**
 * Parse `.gitignore` file content into a flat list of patterns, dropping blank
 * lines, comments, and negations. Helper for `collectAllExclusionPatterns`.
 */
export function parseGitignore(content: string): string[] {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => {
      if (!line) return false;
      if (line.startsWith('#')) return false;
      if (line.startsWith('!')) return false;
      return true;
    })
    .map(line => line.replace(/\/+$/, ''));
}
