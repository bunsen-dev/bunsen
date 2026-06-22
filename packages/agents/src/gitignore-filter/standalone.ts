#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Standalone gitignore filter for listing non-ignored files.
 *
 * This is the entry point for the gitignore-filter bundle. It reads .gitignore
 * files from a directory tree and outputs a filtered list of files that are
 * NOT ignored.
 *
 * Usage:
 *   gitignore-filter [root-dir] [options]
 *
 * Arguments:
 *   root-dir    Directory to scan (default: current directory)
 *
 * Options:
 *   --output FILE    Write output to file instead of stdout
 *   --null           Separate files with NUL character (for xargs -0)
 *
 * Output:
 *   List of relative file paths (one per line, or NUL-separated with --null)
 *
 * Behavior:
 *   - Recursively finds all .gitignore files
 *   - Uses proper gitignore semantics (via 'ignore' library)
 *   - Handles nested .gitignore files with path-relative patterns
 *   - Falls back to common exclusions if no .gitignore found
 *   - Always excludes .git directory
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import ignoreLib from 'ignore';
const ignore = ignoreLib.default || ignoreLib;
type Ignore = ReturnType<typeof ignore>;

// =============================================================================
// Constants
// =============================================================================

const FALLBACK_EXCLUSIONS = [
  'node_modules',
  '.pnpm-store',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '*.pyc',
  '.pytest_cache',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  'coverage',
  '.nyc_output',
  '.idea',
  '.vscode',
  '*.swp',
  '*.swo',
  '.DS_Store',
  'Thumbs.db',
  '*.log',
  'npm-debug.log*',
  'yarn-debug.log*',
  'yarn-error.log*',
];

// =============================================================================
// Gitignore Handling
// =============================================================================

interface GitignoreFile {
  absolutePath: string;
  relativeDir: string;
}

/**
 * Recursively find all .gitignore files in a directory tree.
 */
function findGitignoreFiles(dir: string, relativeTo: string = dir): GitignoreFile[] {
  const results: GitignoreFile[] = [];

  function walk(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        // Skip .git directory
        if (entry.name === '.git') continue;
        // Skip node_modules for performance (will be ignored anyway)
        if (entry.name === 'node_modules') continue;

        walk(fullPath);
      } else if (entry.isFile() && entry.name === '.gitignore') {
        const relativeDir = path.relative(relativeTo, currentDir);
        results.push({
          absolutePath: fullPath,
          relativeDir: relativeDir || '.',
        });
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Build an ignore filter from all .gitignore files.
 */
function buildFilter(rootDir: string): Ignore {
  const ig = ignore();

  // Always ignore .git
  ig.add('.git');

  const gitignoreFiles = findGitignoreFiles(rootDir);

  if (gitignoreFiles.length === 0) {
    // No .gitignore files found, use fallback
    ig.add(FALLBACK_EXCLUSIONS);
    process.stderr.write(`No .gitignore found, using ${FALLBACK_EXCLUSIONS.length} fallback exclusions\n`);
  } else {
    process.stderr.write(`Found ${gitignoreFiles.length} .gitignore file(s)\n`);

    for (const { absolutePath, relativeDir } of gitignoreFiles) {
      try {
        const content = fs.readFileSync(absolutePath, 'utf-8');
        const lines = content.split('\n');

        // Adjust patterns to be relative to root
        const adjustedPatterns = lines
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#'))
          .map(pattern => {
            if (relativeDir === '.') {
              return pattern;
            }
            // Nested .gitignore: prefix pattern with relative directory
            if (pattern.startsWith('!')) {
              return '!' + path.join(relativeDir, pattern.slice(1));
            }
            return path.join(relativeDir, pattern);
          });

        ig.add(adjustedPatterns);
      } catch {
        // Skip unreadable files
        continue;
      }
    }
  }

  return ig;
}

/**
 * List all files in a directory tree.
 */
function listAllFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(dir, fullPath);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }

  walk(dir);
  return files;
}

// =============================================================================
// Main
// =============================================================================

function main(): void {
  const args = process.argv.slice(2);

  // Parse arguments
  let rootDir = process.cwd();
  let outputFile: string | null = null;
  let useNull = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--output' && i + 1 < args.length) {
      outputFile = args[++i];
    } else if (arg === '--null') {
      useNull = true;
    } else if (!arg.startsWith('-')) {
      rootDir = path.resolve(arg);
    }
  }

  // Validate root directory
  if (!fs.existsSync(rootDir)) {
    process.stderr.write(`Error: Directory not found: ${rootDir}\n`);
    process.exit(1);
  }

  if (!fs.statSync(rootDir).isDirectory()) {
    process.stderr.write(`Error: Not a directory: ${rootDir}\n`);
    process.exit(1);
  }

  process.stderr.write(`Scanning ${rootDir}...\n`);

  // Build filter from .gitignore files
  const filter = buildFilter(rootDir);

  // List all files
  const allFiles = listAllFiles(rootDir);
  process.stderr.write(`Found ${allFiles.length} total files\n`);

  // Filter files
  const filteredFiles = filter.filter(allFiles);
  process.stderr.write(`After filtering: ${filteredFiles.length} files\n`);

  // Output (empty string when no files, to avoid creating phantom empty lines)
  const separator = useNull ? '\0' : '\n';
  const output = filteredFiles.length > 0
    ? filteredFiles.join(separator) + (useNull ? '\0' : '\n')
    : '';

  if (outputFile) {
    fs.writeFileSync(outputFile, output);
    process.stderr.write(`Wrote file list to ${outputFile}\n`);
  } else {
    process.stdout.write(output);
  }
}

main();
