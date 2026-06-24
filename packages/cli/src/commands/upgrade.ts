// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `bn upgrade` — install-source-aware self-update.
 *
 * The CLI ships through three channels, each with its own update story:
 *   - **Standalone binary** (`install.sh` / `curl`): re-download the matching
 *     GitHub Release asset, verify its sha256, and atomically replace the
 *     running binary in place. This command owns that.
 *   - **Homebrew / Scoop**: the package manager owns updates — defer to it with
 *     a one-line hint rather than fighting it.
 *   - **Dev checkout** (`pnpm bn` / `bun src/bin.ts`): nothing to download; point
 *     at `git pull`.
 *
 * Channel is detected from `process.execPath` + the `BUNSEN_STANDALONE_BINARY`
 * marker that `binary-entry.ts` sets (only the compiled binary runs that entry).
 */
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import chalk from 'chalk';
import { CLI_VERSION } from '../version.js';
import { EXIT_CODES } from '../exit-codes.js';

const REPO = 'bunsen-dev/bunsen';

interface UpgradeOptions {
  force?: boolean;
}

export type InstallChannel = 'binary' | 'homebrew' | 'scoop' | 'dev';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested) — no I/O, so the detection logic is verifiable.
// ---------------------------------------------------------------------------

/**
 * Classify how this `bn` was installed from its executable path + env. Only the
 * compiled binary sets `BUNSEN_STANDALONE_BINARY`; absent it, we're a dev build.
 */
export function detectChannel(execPath: string, env: NodeJS.ProcessEnv): InstallChannel {
  if (env.BUNSEN_STANDALONE_BINARY !== '1') return 'dev';
  const p = execPath.replace(/\\/g, '/');
  if (/\/(Cellar|Caskroom)\//.test(p)) return 'homebrew';
  if (env.HOMEBREW_PREFIX && execPath.startsWith(env.HOMEBREW_PREFIX)) return 'homebrew';
  if (/\/scoop\/(apps|shims)\//i.test(p)) return 'scoop';
  return 'binary';
}

/** GitHub Release asset name for the running OS/arch (matches build-binary.mjs). */
export function assetNameFor(platform: NodeJS.Platform, arch: string): string {
  const os = platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : 'linux';
  const cpu = arch === 'arm64' ? 'arm64' : 'x64';
  return os === 'windows' ? `bn-${os}-${cpu}.exe` : `bn-${os}-${cpu}`;
}

/** Normalize a tag (`v0.2.0`) and version (`0.2.0`) for equality comparison. */
export function sameVersion(tag: string, version: string): boolean {
  const norm = (s: string) => s.trim().replace(/^v/, '');
  return norm(tag) === norm(version);
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function upgradeCommand(options: UpgradeOptions): Promise<void> {
  const channel = detectChannel(process.execPath, process.env);

  if (channel === 'dev') {
    console.log('You are running a dev build (not a standalone binary).');
    console.log('Update with: ' + chalk.cyan('git pull && pnpm install && pnpm -r build'));
    process.exit(EXIT_CODES.SUCCESS);
  }
  if (channel === 'homebrew') {
    console.log('Installed via Homebrew. Upgrade with: ' + chalk.cyan('brew upgrade bunsen'));
    process.exit(EXIT_CODES.SUCCESS);
  }
  if (channel === 'scoop') {
    console.log('Installed via Scoop. Upgrade with: ' + chalk.cyan('scoop update bunsen'));
    process.exit(EXIT_CODES.SUCCESS);
  }
  // channel === 'binary'
  if (process.platform === 'win32') {
    console.log('A running Windows .exe cannot replace itself. Reinstall via Scoop, or re-download from:');
    console.log(`  https://github.com/${REPO}/releases/latest`);
    process.exit(EXIT_CODES.SUCCESS);
  }

  try {
    const latest = await fetchLatestTag();
    if (!options.force && sameVersion(latest, CLI_VERSION)) {
      console.log(`Already on the latest version (${chalk.bold(CLI_VERSION)}).`);
      process.exit(EXIT_CODES.SUCCESS);
    }

    const asset = assetNameFor(process.platform, process.arch);
    const base = `https://github.com/${REPO}/releases/download/${latest}`;
    console.log(`Updating ${chalk.dim('v' + CLI_VERSION)} → ${chalk.bold(latest)} (${asset})…`);

    const bin = await download(`${base}/${asset}`);
    await verifyChecksum(bin, asset, `${base}/SHA256SUMS`);
    replaceRunningBinary(bin);

    console.log(chalk.green(`✓ Upgraded to ${latest}. Run \`bn --version\` to confirm.`));
    process.exit(EXIT_CODES.SUCCESS);
  } catch (err) {
    console.error(chalk.red('✗ Upgrade failed: ') + (err instanceof Error ? err.message : String(err)));
    console.error(`  Re-install manually: curl -fsSL https://bunsen.dev/install.sh | sh`);
    process.exit(EXIT_CODES.GENERIC);
  }
}

async function fetchLatestTag(): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'bunsen-cli' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} (no published release yet?)`);
  const json = (await res.json()) as { tag_name?: string };
  if (!json.tag_name) throw new Error('latest release has no tag');
  return json.tag_name;
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'User-Agent': 'bunsen-cli' } });
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function verifyChecksum(bin: Buffer, asset: string, sumsUrl: string): Promise<void> {
  let sums: string;
  try {
    sums = (await download(sumsUrl)).toString('utf8');
  } catch {
    console.warn(chalk.yellow('!  No SHA256SUMS published — skipping checksum verification.'));
    return;
  }
  const expected = sums.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).find((p) => p[1] === asset)?.[0];
  if (!expected) {
    console.warn(chalk.yellow(`!  No SHA256SUMS entry for ${asset} — skipping verification.`));
    return;
  }
  const actual = crypto.createHash('sha256').update(bin).digest('hex');
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${asset} (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
  }
}

/**
 * Replace the running executable in place. On Unix the running process keeps the
 * old inode, so writing a sibling temp file and `rename`-ing it over the path is
 * atomic and safe — the next launch picks up the new binary.
 */
function replaceRunningBinary(bin: Buffer): void {
  const target = process.execPath;
  const tmp = `${target}.new-${process.pid}`;
  try {
    fs.writeFileSync(tmp, bin, { mode: 0o755 });
    if (process.platform === 'darwin') {
      // Best-effort: strip the quarantine bit a download may carry.
      try {
        execFileSync('xattr', ['-d', 'com.apple.quarantine', tmp], { stdio: 'ignore' });
      } catch {
        /* not quarantined / xattr absent — fine */
      }
    }
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if ((err as NodeJS.ErrnoException).code === 'EACCES' || (err as NodeJS.ErrnoException).code === 'EPERM') {
      throw new Error(`cannot write ${target} (permission denied). Re-run install.sh, or set BUNSEN_INSTALL_DIR to a writable dir.`);
    }
    throw err;
  }
}
