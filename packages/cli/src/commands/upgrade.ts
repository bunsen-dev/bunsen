// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `bn upgrade` — install-source-aware self-update.
 *
 * The CLI ships through three channels, each with its own update story:
 *   - **Standalone binary** (`install.sh` / `curl`): re-download the matching
 *     GitHub Release asset, MANDATORILY verify its sha256, and atomically replace
 *     the running binary in place. This command owns that.
 *   - **Homebrew / Scoop**: the package manager owns updates — defer to it with
 *     a one-line hint rather than fighting it.
 *   - **Dev checkout** (`pnpm bn` / `bun src/bin.ts`): nothing to download; point
 *     at `git pull`.
 *
 * Channel is detected from the RESOLVED `process.execPath` (symlinks followed,
 * so a Homebrew/Scoop shim or a manual `ln -s` is classified by its real target,
 * not force-replaced) + the `BUNSEN_STANDALONE_BINARY` marker that
 * `binary-entry.ts` sets (only the compiled binary runs that entry).
 *
 * Self-update is security-sensitive (it replaces the running executable), so:
 *   - checksum verification is MANDATORY — a missing/partial SHA256SUMS aborts
 *     and leaves the working binary in place (unlike install.sh, a human-invoked
 *     one-time bootstrap, this silently mutates an already-trusted binary);
 *   - the downloaded asset is size-sanity-checked before it can replace anything;
 *   - the replace follows the execPath symlink so a package-manager link is not
 *     detached into a plain file.
 */
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import chalk from 'chalk';
import { CLI_VERSION } from '../version.js';
import { EXIT_CODES } from '../exit-codes.js';

const REPO = 'bunsen-dev/bunsen';
/** A real compiled binary embeds the Bun runtime (~55–110 MB); anything tiny is
 *  a truncated download or an HTML error page, not a binary. */
const MIN_BINARY_BYTES = 1_000_000;

interface UpgradeOptions {
  force?: boolean;
}

export type InstallChannel = 'binary' | 'homebrew' | 'scoop' | 'dev';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested) — no I/O, so the safety logic is verifiable.
// ---------------------------------------------------------------------------

/**
 * Classify how this `bn` was installed from its (already symlink-resolved)
 * executable path + env. Only the compiled binary sets `BUNSEN_STANDALONE_BINARY`;
 * absent it, we're a dev build. Pass the REAL path (realpath of process.execPath)
 * so a brew/scoop shim resolves to its Cellar/Caskroom/scoop target.
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

/** The expected sha256 for `asset` from a `SHA256SUMS` body, or null if absent. */
export function parseSha256Sums(sumsText: string, asset: string): string | null {
  for (const line of sumsText.split(/\r?\n/)) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === asset && /^[0-9a-f]{64}$/i.test(sha ?? '')) return sha.toLowerCase();
  }
  return null;
}

/**
 * MANDATORY integrity gate. Throws if `asset` has no entry in `sumsText` or if
 * the bytes don't match — so a missing/partial SHA256SUMS aborts the self-update
 * rather than installing an unverified binary.
 */
export function assertChecksum(bin: Buffer, asset: string, sumsText: string): void {
  const expected = parseSha256Sums(sumsText, asset);
  if (!expected) {
    throw new Error(`no SHA256SUMS entry for ${asset} — refusing to install an unverified binary`);
  }
  const actual = crypto.createHash('sha256').update(bin).digest('hex');
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${asset} (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
  }
}

/** Reject an implausibly small download before it can replace the binary. */
export function assertPlausibleBinary(bin: Buffer): void {
  if (bin.length < MIN_BINARY_BYTES) {
    throw new Error(`downloaded asset is only ${bin.length} bytes — looks truncated or an error page, not a binary`);
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function upgradeCommand(options: UpgradeOptions): Promise<void> {
  // Follow symlinks so a brew/scoop shim or `ln -s` is classified by — and
  // replaced at — its real target, not detached into a plain file.
  let realExec = process.execPath;
  try {
    realExec = fs.realpathSync(process.execPath);
  } catch {
    /* keep execPath if it can't be resolved */
  }
  const channel = detectChannel(realExec, process.env);

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
    assertPlausibleBinary(bin);
    // Mandatory: if SHA256SUMS is unreachable or lacks the asset, this throws and
    // the existing binary is left untouched.
    const sums = await download(`${base}/SHA256SUMS`).catch(() => {
      throw new Error('could not download SHA256SUMS — refusing to install an unverified binary');
    });
    assertChecksum(bin, asset, sums.toString('utf8'));
    replaceRunningBinary(bin, realExec);

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

/**
 * Replace the executable at `target` in place. On Unix the running process keeps
 * the old inode, so writing a sibling temp file and `rename`-ing it over the path
 * is atomic — the next launch picks up the new binary. `target` is the
 * symlink-RESOLVED path, so a package-manager link pointing at it survives.
 * Exported for tests.
 */
export function replaceRunningBinary(bin: Buffer, target: string): void {
  const tmp = `${target}.new-${process.pid}`;
  try {
    fs.writeFileSync(tmp, bin);
    fs.chmodSync(tmp, 0o755); // deterministic mode regardless of umask
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
      throw new Error(`cannot write ${target} (permission denied). Re-run install.sh, or reinstall into a writable dir.`);
    }
    throw err;
  }
}
