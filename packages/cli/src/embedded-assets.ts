// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Runtime asset extraction for the standalone (`bun build --compile`) binary.
 *
 * Under `--compile`, `import.meta.url` / `__dirname` re-root to the binary's
 * embedded virtual filesystem, so `getAssetDir()`'s default
 * (`path.join(__dirname, 'assets')`) points at a path that does not exist on the
 * real disk. The binary therefore embeds the host assets (agent `.cjs` bundles,
 * the proxy addon + pricing snapshot, base-image Dockerfiles, skills, starter
 * agents) as a single tarball and, on first run, extracts them to a per-user
 * cache directory and points `BUNSEN_ASSET_DIR` at it.
 *
 * Real on-disk paths are mandatory, not a convenience: the proxy addon
 * (`ai_capture.py`) and pricing snapshot (`model_prices.json`) are **bind-mounted**
 * into the mitmproxy sidecar (`container.ts` → `getAddonScriptPath` /
 * `getPricingDataPath`), and Docker cannot bind-mount a path inside the binary's
 * virtual FS. Extraction is what turns the embedded bytes back into mountable
 * host files.
 *
 * Only the standalone binary runs this. The npm/dev paths resolve
 * `getAssetDir()` straight off `dist/assets/` on disk and never call it. The
 * container Node runtime is deliberately NOT embedded — it is fetched on demand
 * by `@bunsen-dev/runtime`'s `node-runtime.ts`.
 *
 * Concurrency model (mirrors `node-runtime.ts`): the published dir is created by
 * a SINGLE atomic `renameSync` of a fully-staged temp dir — never by mutating
 * the live dir in place, and never by deleting the destination first. So a
 * concurrent first run (a script firing several `bn` invocations at once, a CI
 * matrix) can at worst lose the publish race; it then accepts the winner's
 * complete dir rather than clobbering it out from under an actively-running peer.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tar from 'tar';
import { CLI_VERSION } from './version.js';

const MARKER = '.complete';
/**
 * Files that MUST exist in a fully-extracted asset dir. The `.complete` marker
 * alone is insufficient — a partial extraction from an older build or an external
 * deletion could leave the marker beside missing assets, which would fail
 * opaquely at proxy/container startup far from the cause. These two cover the
 * bind-mounted proxy addon and a platform agent bundle.
 */
const SENTINELS = ['orchestrator.cjs', path.join('proxy', 'ai_capture.py')];

/** Root of the per-user cache where embedded assets are unpacked. */
function assetCacheRoot(): string {
  const override = process.env.BUNSEN_CACHE_DIR?.trim();
  if (override) return override;
  // Mirror the platform cache conventions the rest of Bunsen leans on.
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'bunsen', 'cache');
  }
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  return path.join(xdg || path.join(os.homedir(), '.cache'), 'bunsen');
}

/**
 * A cached asset dir is usable only if the marker AND every sentinel asset is
 * present — guards against a marker left beside a partial/corrupt extraction.
 * Exported for tests.
 */
export function isAssetDirComplete(assetDir: string): boolean {
  if (!fs.existsSync(path.join(assetDir, MARKER))) return false;
  return SENTINELS.every((rel) => fs.existsSync(path.join(assetDir, rel)));
}

/**
 * Extract the embedded asset tarball to a versioned cache dir (once) and set
 * `BUNSEN_ASSET_DIR` so every downstream resolver (`getAssetDir()` and the four
 * asset paths derived from it) finds real host files.
 *
 * - Respects an explicit `BUNSEN_ASSET_DIR` (power users / air-gapped seeds): if
 *   set, no extraction happens and the override stands.
 * - Keyed by `CLI_VERSION`; the common path on every run after the first is a
 *   marker+sentinel check and an env assignment.
 *
 * @param embeddedTarPath The path yielded by `import … with { type: 'file' }`
 *   (a handle into the binary's embedded FS, readable via `Bun.file`).
 */
export async function ensureEmbeddedAssets(embeddedTarPath: string): Promise<void> {
  if (process.env.BUNSEN_ASSET_DIR?.trim()) return; // explicit override wins

  const assetDir = path.join(assetCacheRoot(), 'assets', CLI_VERSION);

  if (!isAssetDirComplete(assetDir)) {
    await extractTarball(embeddedTarPath, assetDir);
  }
  process.env.BUNSEN_ASSET_DIR = assetDir;
}

/** Read the embedded handle and unpack it into a fully-staged temp dir. */
async function stage(embeddedTarPath: string, stageDir: string): Promise<void> {
  // The embedded handle is read through Bun.file; write the bytes to a real temp
  // tarball so `tar.extract` can stream them back out onto disk.
  const bytes = new Uint8Array(await Bun.file(embeddedTarPath).arrayBuffer());
  const tmpTar = `${stageDir}.tar`;
  fs.writeFileSync(tmpTar, bytes);
  try {
    tar.extract({ file: tmpTar, cwd: stageDir, sync: true });
  } finally {
    fs.rmSync(tmpTar, { force: true });
  }
  // Marker written LAST, after every asset is on disk, so its presence implies a
  // complete dir.
  fs.writeFileSync(path.join(stageDir, MARKER), CLI_VERSION);
}

export async function extractTarball(embeddedTarPath: string, assetDir: string): Promise<void> {
  const parent = path.dirname(assetDir);
  fs.mkdirSync(parent, { recursive: true });

  // Stage on the SAME filesystem as the cache so the publish rename is atomic and
  // never crosses devices (EXDEV). mkdtemp gives a unique dir even for same-pid.
  const stageDir = fs.mkdtempSync(path.join(parent, `.stage-${process.pid}-`));
  try {
    await stage(embeddedTarPath, stageDir);
    publish(stageDir, assetDir);
  } catch (err) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    // A concurrent run may have completed the dir while we were extracting.
    if (isAssetDirComplete(assetDir)) return;
    throw new Error(
      `Failed to unpack the bundled assets to ${assetDir}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Set BUNSEN_CACHE_DIR to a writable directory, or BUNSEN_ASSET_DIR to a pre-extracted asset dir.`
    );
  }
}

/**
 * Publish a fully-staged dir to `assetDir`. The single `renameSync` is the only
 * way `assetDir` ever comes into existence, so it is always atomic and always
 * complete. Never deletes a live destination:
 *  - dest absent  → atomic rename (the normal first-run path).
 *  - dest present + complete → a concurrent run won; drop ours, keep theirs.
 *  - dest present + stale/incomplete (old build, partial deletion) → move it
 *    aside, publish ours, then drop the stale copy.
 */
function publish(stageDir: string, assetDir: string): void {
  try {
    fs.renameSync(stageDir, assetDir);
    return;
  } catch {
    // assetDir already exists (rename can't replace a non-empty dir on POSIX) or
    // some other error — fall through to recover.
  }
  if (isAssetDirComplete(assetDir)) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    return; // concurrent winner — accept theirs
  }
  // Stale/corrupt dir in the way: swap it out (move aside, never in-place delete
  // of a path a peer might be mid-read on — and a stale dir has no valid readers
  // since isAssetDirComplete gates every consumer).
  const aside = `${assetDir}.stale-${process.pid}`;
  try {
    fs.renameSync(assetDir, aside);
  } catch {
    // Lost the race to move it; if it's now complete, accept the winner.
    if (isAssetDirComplete(assetDir)) {
      fs.rmSync(stageDir, { recursive: true, force: true });
      return;
    }
    throw new Error(`could not replace a stale asset dir at ${assetDir}`);
  }
  fs.renameSync(stageDir, assetDir);
  fs.rmSync(aside, { recursive: true, force: true });
}
