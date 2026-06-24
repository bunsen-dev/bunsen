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
 * host files. See BUILD_AND_DISTRIBUTE_BN_CLI.md Phase 1.
 *
 * Only the standalone binary runs this. The npm/dev paths resolve
 * `getAssetDir()` straight off `dist/assets/` on disk and never call it. The
 * container Node runtime is deliberately NOT embedded — it is fetched on demand
 * by `@bunsen-dev/runtime`'s `node-runtime.ts`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tar from 'tar';
import { CLI_VERSION } from './version.js';

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
 * Extract the embedded asset tarball to a versioned cache dir (once) and set
 * `BUNSEN_ASSET_DIR` so every downstream resolver (`getAssetDir()` and the four
 * asset paths derived from it) finds real host files.
 *
 * - Respects an explicit `BUNSEN_ASSET_DIR` (power users / air-gapped seeds):
 *   if set, no extraction happens and the override stands.
 * - Keyed by `CLI_VERSION`, with a `.complete` marker, so the common path on
 *   every run after the first is a single `existsSync` and an env assignment.
 * - Extracts to a sibling temp dir and renames into place, so a crash or a
 *   concurrent invocation never leaves a half-populated asset dir behind.
 *
 * @param embeddedTarPath The path yielded by `import … with { type: 'file' }`
 *   (a handle into the binary's embedded FS, readable via `Bun.file`).
 */
export async function ensureEmbeddedAssets(embeddedTarPath: string): Promise<void> {
  if (process.env.BUNSEN_ASSET_DIR?.trim()) return; // explicit override wins

  const assetDir = path.join(assetCacheRoot(), 'assets', CLI_VERSION);
  const marker = path.join(assetDir, '.complete');

  if (!fs.existsSync(marker)) {
    await extractTarball(embeddedTarPath, assetDir, marker);
  }
  process.env.BUNSEN_ASSET_DIR = assetDir;
}

async function extractTarball(embeddedTarPath: string, assetDir: string, marker: string): Promise<void> {
  const parent = path.dirname(assetDir);
  fs.mkdirSync(parent, { recursive: true });

  const tmpDir = `${assetDir}.tmp-${process.pid}`;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // The embedded handle is read through Bun.file; write the bytes to a real
    // temp tarball so `tar.x` can stream it back out onto disk.
    const bytes = new Uint8Array(await Bun.file(embeddedTarPath).arrayBuffer());
    const tmpTar = `${tmpDir}.tar`;
    fs.writeFileSync(tmpTar, bytes);
    try {
      tar.extract({ file: tmpTar, cwd: tmpDir, sync: true });
    } finally {
      fs.rmSync(tmpTar, { force: true });
    }

    fs.writeFileSync(path.join(tmpDir, '.complete'), CLI_VERSION);

    // Atomic-ish swap into place. If another process won the race and the dir
    // is already complete, drop our copy and use theirs.
    fs.rmSync(assetDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, assetDir);
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (fs.existsSync(marker)) return; // a concurrent run completed it
    throw err;
  }
}
