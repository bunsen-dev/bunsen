// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tar from 'tar';
import { ensureEmbeddedAssets, extractTarball, isAssetDirComplete } from './embedded-assets.js';
import { CLI_VERSION } from './version.js';

// Build a tarball whose root entries match dist/assets/ (incl. the sentinels
// isAssetDirComplete checks) so extraction produces a "complete" dir.
function makeAssetTarball(dir: string): string {
  const srcDir = fs.mkdtempSync(path.join(dir, 'assets-src-'));
  fs.writeFileSync(path.join(srcDir, 'orchestrator.cjs'), '// orchestrator');
  fs.writeFileSync(path.join(srcDir, 'scorer.cjs'), '// scorer');
  fs.mkdirSync(path.join(srcDir, 'proxy'));
  fs.writeFileSync(path.join(srcDir, 'proxy', 'ai_capture.py'), '# addon');
  fs.writeFileSync(path.join(srcDir, 'proxy', 'model_prices.json'), '{}');
  const tarPath = path.join(dir, 'assets.tar');
  tar.create({ file: tarPath, cwd: srcDir, sync: true, portable: true }, fs.readdirSync(srcDir));
  return tarPath;
}

describe('embedded-assets', () => {
  let tmp: string;
  let tarPath: string;
  let assetDir: string;
  const saved = { CACHE: process.env.BUNSEN_CACHE_DIR, ASSET: process.env.BUNSEN_ASSET_DIR };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-embed-test-'));
    tarPath = makeAssetTarball(tmp);
    delete process.env.BUNSEN_ASSET_DIR;
    process.env.BUNSEN_CACHE_DIR = path.join(tmp, 'cache');
    assetDir = path.join(tmp, 'cache', 'assets', CLI_VERSION);
  });

  afterEach(() => {
    if (saved.CACHE === undefined) delete process.env.BUNSEN_CACHE_DIR;
    else process.env.BUNSEN_CACHE_DIR = saved.CACHE;
    if (saved.ASSET === undefined) delete process.env.BUNSEN_ASSET_DIR;
    else process.env.BUNSEN_ASSET_DIR = saved.ASSET;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('extracts on first run, validates sentinels, and points BUNSEN_ASSET_DIR at the dir', async () => {
    await ensureEmbeddedAssets(tarPath);
    expect(process.env.BUNSEN_ASSET_DIR).toBe(assetDir);
    expect(isAssetDirComplete(assetDir)).toBe(true);
    expect(fs.existsSync(path.join(assetDir, 'orchestrator.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(assetDir, 'proxy', 'ai_capture.py'))).toBe(true);
  });

  it('is idempotent on the cache-hit path', async () => {
    await ensureEmbeddedAssets(tarPath);
    // Stamp the extracted dir; a second call must NOT re-extract (stamp survives).
    const stamp = path.join(assetDir, 'orchestrator.cjs');
    fs.writeFileSync(stamp, '// stamped');
    await ensureEmbeddedAssets(tarPath);
    expect(fs.readFileSync(stamp, 'utf8')).toBe('// stamped');
    expect(isAssetDirComplete(assetDir)).toBe(true);
  });

  it('honors an explicit BUNSEN_ASSET_DIR override and does no extraction', async () => {
    process.env.BUNSEN_ASSET_DIR = '/some/preseeded/dir';
    await ensureEmbeddedAssets(tarPath);
    expect(process.env.BUNSEN_ASSET_DIR).toBe('/some/preseeded/dir');
    expect(fs.existsSync(assetDir)).toBe(false); // never touched the cache
  });

  it('self-heals a dir whose marker is present but a sentinel is missing', async () => {
    await ensureEmbeddedAssets(tarPath);
    fs.rmSync(path.join(assetDir, 'proxy', 'ai_capture.py'), { force: true });
    expect(isAssetDirComplete(assetDir)).toBe(false);
    delete process.env.BUNSEN_ASSET_DIR;
    await ensureEmbeddedAssets(tarPath);
    expect(isAssetDirComplete(assetDir)).toBe(true);
    expect(fs.existsSync(path.join(assetDir, 'proxy', 'ai_capture.py'))).toBe(true);
  });

  it('never deletes a complete winner: extractTarball into an already-complete dir keeps it intact', async () => {
    // Simulate a concurrent winner having published a complete dir with a unique
    // marker-content we can detect survival of.
    await ensureEmbeddedAssets(tarPath);
    const winnerFile = path.join(assetDir, 'orchestrator.cjs');
    fs.writeFileSync(winnerFile, '// WINNER');
    // Force the extract path against the already-complete dir — must NOT clobber it.
    await extractTarball(tarPath, assetDir);
    expect(isAssetDirComplete(assetDir)).toBe(true);
    expect(fs.readFileSync(winnerFile, 'utf8')).toBe('// WINNER');
  });

  it('survives concurrent extraction without error or a broken dir', async () => {
    await Promise.all(Array.from({ length: 8 }, () => ensureEmbeddedAssets(tarPath)));
    expect(isAssetDirComplete(assetDir)).toBe(true);
    expect(process.env.BUNSEN_ASSET_DIR).toBe(assetDir);
    // No stray staging/stale dirs left behind.
    const leftovers = fs
      .readdirSync(path.dirname(assetDir))
      .filter((n) => n.startsWith('.stage-') || n.includes('.stale-'));
    expect(leftovers).toEqual([]);
  });
});
