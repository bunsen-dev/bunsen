// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Export command - Extract workspace from a completed run
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import chalk from 'chalk';
import { loadRunManifest, getWorkspaceTarPath, loadWorkspaceDiff } from '@bunsen-dev/runtime';

interface ExportOptions {
  output?: string;
  install?: boolean;
}

export async function exportCommand(runId: string, options: ExportOptions): Promise<void> {
  try {
    const manifest = loadRunManifest(runId);
    if (!manifest) {
      console.error(chalk.red(`Run not found: ${runId}`));
      process.exit(1);
    }

    // Determine output directory
    const outputDir = options.output
      ? path.resolve(options.output)
      : path.join(os.tmpdir(), `bunsen-export-${runId}`);

    // Clean up existing output directory to ensure fresh export
    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true });
    }

    // Check for workspace/export.tar.gz first (from --export-workspace)
    const tarGzPath = getWorkspaceTarPath(runId);
    if (fs.existsSync(tarGzPath)) {
      console.log(chalk.dim('Using workspace/export.tar.gz from run...'));

      // Create output directory
      fs.mkdirSync(outputDir, { recursive: true });

      // Validate before extraction: workspace exports are agent-produced data.
      // Do not let a crafted archive write outside the requested output dir.
      assertSafeWorkspaceTar(tarGzPath);
      extractTarGz(tarGzPath, outputDir);

      console.log(chalk.green('✓ Workspace extracted from tar.gz'));
    } else {
      // Fall back to diff reconstruction
      const diff = loadWorkspaceDiff(runId);

      if (!diff) {
        console.error(chalk.red('Error: No workspace/diff.patch or workspace/export.tar.gz available for this run.'));
        process.exit(1);
      }

      if (diff.startsWith('# No changes detected') || diff.startsWith('# Error')) {
        console.error(chalk.red('Error: Workspace diff indicates no changes or an error occurred.'));
        console.error(chalk.dim(diff));
        process.exit(1);
      }

      console.log(chalk.dim('Reconstructing workspace from diff...'));

      // Get experiment workspace path
      const experimentPath = manifest.experiment.path;
      if (!experimentPath) {
        console.error(chalk.red('Run manifest does not record experiment path; cannot reconstruct workspace.'));
        process.exit(1);
      }
      const experimentWorkspacePath = path.join(experimentPath, 'workspace');

      // Create output directory
      fs.mkdirSync(outputDir, { recursive: true });

      // Copy original workspace if it exists and has contents
      if (fs.existsSync(experimentWorkspacePath)) {
        const entries = fs.readdirSync(experimentWorkspacePath);
        if (entries.length > 0) {
          copyDirRecursive(experimentWorkspacePath, outputDir);
          console.log(chalk.dim(`Copied original workspace from ${experimentWorkspacePath}`));
        }
      }

      // Write diff to temp file and apply it
      const diffPath = path.join(os.tmpdir(), `bunsen-diff-${runId}.patch`);

      // Transform the diff paths: /workspace-source/* and /workspace/* -> ./*
      const transformedDiff = transformDiffPaths(diff);
      fs.writeFileSync(diffPath, transformedDiff);

      try {
        // Apply the diff
        // Use -p1 since we transformed paths to relative
        execSync(`patch -p1 --no-backup-if-mismatch < "${diffPath}"`, {
          cwd: outputDir,
          stdio: 'pipe',
        });
        console.log(chalk.green('✓ Workspace reconstructed from diff'));
      } catch (error) {
        // patch may return non-zero even on partial success
        // Check if we got any files
        const files = fs.readdirSync(outputDir);
        if (files.length > 0) {
          console.log(chalk.yellow('⚠ Diff applied with warnings (some hunks may have failed)'));
        } else {
          console.error(chalk.red('Error: Failed to apply workspace diff.'));
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(chalk.dim(errorMessage));
          process.exit(1);
        }
      } finally {
        // Clean up temp diff file
        fs.unlinkSync(diffPath);
      }
    }

    // Optionally run install
    if (options.install) {
      console.log(chalk.dim('Running package install...'));

      if (fs.existsSync(path.join(outputDir, 'package.json'))) {
        runNodeInstall(outputDir);
      } else {
        const pythonInstalled = runPythonInstall(outputDir);
        if (!pythonInstalled) {
          console.log(chalk.dim('No package.json or Python project found'));
        }
      }
    }

    // Print result
    console.log('');
    console.log(chalk.bold('Exported workspace:'));
    console.log(chalk.cyan(outputDir));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Error: ${message}`));
    process.exit(1);
  }
}

interface TarMember {
  path: string;
  type: string;
  linkPath?: string;
}

const TAR_BLOCK_SIZE = 512;
const ZERO_BLOCK = Buffer.alloc(TAR_BLOCK_SIZE);

function extractTarGz(tarGzPath: string, outputDir: string): void {
  const args = ['-xzf', tarGzPath, '-C', outputDir];
  if (tarSupportsNoAbsoluteFilenames()) {
    args.unshift('--no-absolute-filenames');
  }
  execFileSync('tar', args, { stdio: 'inherit' });
}

let tarNoAbsoluteFilenamesSupport: boolean | undefined;

function tarSupportsNoAbsoluteFilenames(): boolean {
  if (tarNoAbsoluteFilenamesSupport !== undefined) {
    return tarNoAbsoluteFilenamesSupport;
  }

  const result = spawnSync('tar', ['--no-absolute-filenames', '-tf', '/dev/null'], {
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  tarNoAbsoluteFilenamesSupport =
    result.error === undefined && !/not supported|unrecognized option|illegal option/i.test(output);
  return tarNoAbsoluteFilenamesSupport;
}

function assertSafeWorkspaceTar(tarGzPath: string): void {
  const members = readTarGzMembers(tarGzPath);
  for (const member of members) {
    assertSafeTarMemberPath(member.path, `archive member "${member.path}"`);

    if (member.type === '2') {
      assertSafeTarSymlink(member.path, member.linkPath);
    } else if (member.type === '1') {
      assertSafeTarMemberPath(
        member.linkPath ?? '',
        `hardlink target for archive member "${member.path}"`,
      );
    }
  }
}

function assertSafeTarMemberPath(value: string, label: string): void {
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/');

  if (
    normalized === '' ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.includes('\0') ||
    parts.includes('..')
  ) {
    throw new Error(`Unsafe workspace export tarball: ${label} escapes the output directory.`);
  }
}

function assertSafeTarSymlink(memberPath: string, linkPath: string | undefined): void {
  if (!linkPath) {
    throw new Error(`Unsafe workspace export tarball: symlink "${memberPath}" has no target.`);
  }

  const normalizedTarget = linkPath.replace(/\\/g, '/');
  if (
    normalizedTarget.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalizedTarget) ||
    normalizedTarget.includes('\0')
  ) {
    throw new Error(`Unsafe workspace export tarball: symlink "${memberPath}" points outside the output directory.`);
  }

  const containingDir = path.posix.dirname(memberPath.replace(/\\/g, '/'));
  const resolved = path.posix.normalize(path.posix.join(containingDir, normalizedTarget));
  if (resolved === '..' || resolved.startsWith('../')) {
    throw new Error(`Unsafe workspace export tarball: symlink "${memberPath}" points outside the output directory.`);
  }
}

function readTarGzMembers(tarGzPath: string): TarMember[] {
  const tar = gunzipSync(fs.readFileSync(tarGzPath));
  const members: TarMember[] = [];
  let offset = 0;
  let nextLongPath: string | undefined;
  let nextLongLinkPath: string | undefined;
  let nextPaxHeaders: Record<string, string> | undefined;

  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.equals(ZERO_BLOCK)) {
      break;
    }

    const size = parseTarOctal(header.subarray(124, 136));
    const type = tarString(header.subarray(156, 157)) || '0';
    const dataStart = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      throw new Error('Unsafe workspace export tarball: archive is truncated.');
    }

    const data = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;

    if (type === 'x') {
      nextPaxHeaders = parsePaxHeaders(data);
      continue;
    }
    if (type === 'g') {
      continue;
    }
    if (type === 'L') {
      nextLongPath = tarString(data);
      continue;
    }
    if (type === 'K') {
      nextLongLinkPath = tarString(data);
      continue;
    }

    let memberPath = tarPath(header);
    let linkPath = tarString(header.subarray(157, 257));
    if (nextLongPath) {
      memberPath = nextLongPath;
      nextLongPath = undefined;
    }
    if (nextLongLinkPath) {
      linkPath = nextLongLinkPath;
      nextLongLinkPath = undefined;
    }
    if (nextPaxHeaders) {
      memberPath = nextPaxHeaders.path ?? memberPath;
      linkPath = nextPaxHeaders.linkpath ?? linkPath;
      nextPaxHeaders = undefined;
    }

    members.push({ path: memberPath, type, linkPath: linkPath || undefined });
  }

  return members;
}

function tarPath(header: Buffer): string {
  const name = tarString(header.subarray(0, 100));
  const prefix = tarString(header.subarray(345, 500));
  return prefix ? `${prefix}/${name}` : name;
}

function tarString(value: Buffer): string {
  const nul = value.indexOf(0);
  const end = nul === -1 ? value.length : nul;
  return value.subarray(0, end).toString('utf8');
}

function parseTarOctal(value: Buffer): number {
  const raw = tarString(value).trim();
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 8);
  if (Number.isNaN(parsed)) {
    throw new Error('Unsafe workspace export tarball: archive contains an invalid tar header.');
  }
  return parsed;
}

function parsePaxHeaders(data: Buffer): Record<string, string> {
  const result: Record<string, string> = {};
  let offset = 0;

  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;

    const recordLength = Number.parseInt(data.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isFinite(recordLength) || recordLength <= 0 || offset + recordLength > data.length) {
      throw new Error('Unsafe workspace export tarball: archive contains an invalid pax header.');
    }

    const record = data.subarray(space + 1, offset + recordLength);
    const equals = record.indexOf(0x3d);
    if (equals !== -1) {
      const key = record.subarray(0, equals).toString('utf8');
      const rawValue = record.subarray(equals + 1);
      const valueBytes =
        rawValue.length > 0 && rawValue[rawValue.length - 1] === 0x0a
          ? rawValue.subarray(0, rawValue.length - 1)
          : rawValue;
      const value = valueBytes.toString('utf8');
      result[key] = value;
    }

    offset += recordLength;
  }

  return result;
}

/**
 * Transform diff paths from Docker container format to relative format
 *
 * Input:  --- /workspace-source/file.txt
 *         +++ /workspace/file.txt
 *
 * Output: --- a/file.txt
 *         +++ b/file.txt
 */
function transformDiffPaths(diff: string): string {
  const lines = diff.split('\n');
  const transformed: string[] = [];

  for (const line of lines) {
    if (line.startsWith('--- /workspace-source/')) {
      // Original file path (may be /dev/null for new files)
      const filePath = line.slice('--- /workspace-source/'.length);
      transformed.push(`--- a/${filePath}`);
    } else if (line.startsWith('--- /workspace-source')) {
      // Handle edge case of exactly /workspace-source (root)
      transformed.push('--- a/');
    } else if (line.startsWith('+++ /workspace/')) {
      // New file path
      const filePath = line.slice('+++ /workspace/'.length);
      transformed.push(`+++ b/${filePath}`);
    } else if (line.startsWith('+++ /workspace')) {
      // Handle edge case of exactly /workspace (root)
      transformed.push('+++ b/');
    } else {
      transformed.push(line);
    }
  }

  return transformed.join('\n');
}

/**
 * Recursively copy a directory
 */
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Detect Node.js package manager and run install
 * Assumes package.json exists
 */
function runNodeInstall(dir: string): void {
  const exists = (name: string) => fs.existsSync(path.join(dir, name));

  let pm = 'npm';
  let cmd = 'npm install';

  if (exists('bun.lockb') || exists('bun.lock')) {
    pm = 'bun';
    cmd = 'bun install';
  } else if (exists('pnpm-lock.yaml')) {
    pm = 'pnpm';
    cmd = 'pnpm install';
  } else if (exists('yarn.lock')) {
    pm = 'yarn';
    cmd = 'yarn install';
  }

  try {
    execSync(cmd, { cwd: dir, stdio: 'inherit' });
    console.log(chalk.green(`✓ ${pm} install complete`));
  } catch {
    console.log(chalk.yellow(`⚠ ${pm} install failed`));
  }
}

/**
 * Detect Python package manager and run install
 * Returns true if a Python project was found (regardless of install success)
 */
function runPythonInstall(dir: string): boolean {
  const exists = (name: string) => fs.existsSync(path.join(dir, name));

  // Check lockfiles first (most specific), then config files
  const managers: Array<{ file: string; pm: string; cmd: string }> = [
    // Lockfiles
    { file: 'poetry.lock', pm: 'poetry', cmd: 'poetry install' },
    { file: 'Pipfile.lock', pm: 'pipenv', cmd: 'pipenv install' },
    { file: 'uv.lock', pm: 'uv', cmd: 'uv sync' },
    { file: 'pdm.lock', pm: 'pdm', cmd: 'pdm install' },
    // Config files
    { file: 'Pipfile', pm: 'pipenv', cmd: 'pipenv install' },
    { file: 'pyproject.toml', pm: 'pip', cmd: 'pip install -e .' },
    // Fallback
    { file: 'requirements.txt', pm: 'pip', cmd: 'pip install -r requirements.txt' },
  ];

  for (const { file, pm, cmd } of managers) {
    if (exists(file)) {
      try {
        execSync(cmd, { cwd: dir, stdio: 'inherit' });
        console.log(chalk.green(`✓ ${pm} install complete`));
      } catch {
        console.log(chalk.yellow(`⚠ ${pm} install failed`));
      }
      return true;
    }
  }

  return false;
}
