// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getNodeRuntimePath,
  getNodeRuntimeManifest,
  getHostCacheDir,
  nodeRuntimeTarget,
  nodeRuntimeBinName,
  resolveContainerNodeRuntime,
  NODE_RUNTIME_VERSION,
} from './node-runtime.js';

const ENV_KEYS = ['BUNSEN_NODE_RUNTIME_DIR', 'BUNSEN_CACHE_DIR', 'BUNSEN_NODE_OFFLINE'] as const;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('manifest is the single source of truth', () => {
  it('build-bundles.mjs reads the shared manifest and pins no version literal', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../agents/scripts/build-bundles.mjs'),
      'utf8'
    );
    expect(src).toContain('node-runtime-manifest.json');
    expect(src).toContain('MANIFEST.version');
    // No hardcoded x.y.z Node version — it must come from the manifest, so the
    // resolver and the pre-fetch can never disagree on what gets downloaded.
    expect(src).not.toMatch(/NODE_VERSION\s*=\s*['"]\d+\.\d+\.\d+['"]/);
  });
});

describe('node-runtime manifest', () => {
  it('pins a version and both linux targets with 64-hex tarball + binary hashes', () => {
    const m = getNodeRuntimeManifest();
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(NODE_RUNTIME_VERSION).toBe(m.version);
    for (const target of ['linux-x64', 'linux-arm64'] as const) {
      const e = m.targets[target];
      expect(e.url).toMatch(/^https:\/\/nodejs\.org\/dist\/v.+\.tar\.gz$/);
      expect(e.url).toContain(m.version);
      expect(e.tarballSha256).toMatch(/^[0-9a-f]{64}$/i);
      expect(e.binSha256).toMatch(/^[0-9a-f]{64}$/i);
    }
  });
});

describe('nodeRuntimeTarget / getNodeRuntimePath', () => {
  it('maps amd64 inputs to the x64 target', () => {
    expect(nodeRuntimeTarget('amd64')).toBe('linux-x64');
    expect(nodeRuntimeTarget('linux/amd64')).toBe('linux-x64');
    expect(getNodeRuntimePath('amd64')).toContain('node-linux-x64');
    expect(getNodeRuntimePath('linux/amd64')).toContain('node-linux-x64');
  });

  it('maps arm64 inputs to the arm64 target', () => {
    expect(nodeRuntimeTarget('arm64')).toBe('linux-arm64');
    expect(nodeRuntimeTarget('linux/arm64')).toBe('linux-arm64');
    expect(getNodeRuntimePath('arm64')).toContain('node-linux-arm64');
    expect(getNodeRuntimePath('linux/arm64')).toContain('node-linux-arm64');
  });

  it('resolves the asset path under getAssetDir()/runtime', () => {
    expect(getNodeRuntimePath('linux/amd64')).toMatch(/runtime[\\/]node-linux-x64$/);
  });
});

describe('getHostCacheDir', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('honors BUNSEN_CACHE_DIR (trimmed)', () => {
    process.env.BUNSEN_CACHE_DIR = '  /tmp/my-bunsen-cache  ';
    expect(getHostCacheDir()).toBe('/tmp/my-bunsen-cache');
  });

  it('falls back to a per-user OS cache dir named bunsen', () => {
    delete process.env.BUNSEN_CACHE_DIR;
    const dir = getHostCacheDir();
    expect(dir).toContain('bunsen');
    expect(path.isAbsolute(dir)).toBe(true);
  });
});

describe('resolveContainerNodeRuntime', () => {
  let saved: Record<string, string | undefined>;
  let tmp: string;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-nrt-'));
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('layer (a): returns the override-dir binary when present', async () => {
    const bin = path.join(tmp, nodeRuntimeBinName('linux-x64'));
    fs.writeFileSync(bin, 'fake-node');
    process.env.BUNSEN_NODE_RUNTIME_DIR = tmp;
    await expect(resolveContainerNodeRuntime('linux/amd64')).resolves.toBe(bin);
  });

  it('layer (a): throws a clear error when the override dir lacks the binary', async () => {
    process.env.BUNSEN_NODE_RUNTIME_DIR = tmp; // empty dir
    await expect(resolveContainerNodeRuntime('linux/arm64')).rejects.toThrow(
      /BUNSEN_NODE_RUNTIME_DIR.*node-linux-arm64 was not found/
    );
  });

  it('does not hit the network when offline and the override resolves first', async () => {
    // Offline is set, but the override short-circuits before any fetch.
    const bin = path.join(tmp, nodeRuntimeBinName('linux-arm64'));
    fs.writeFileSync(bin, 'fake-node');
    process.env.BUNSEN_NODE_RUNTIME_DIR = tmp;
    process.env.BUNSEN_NODE_OFFLINE = '1';
    await expect(resolveContainerNodeRuntime('linux/arm64')).resolves.toBe(bin);
  });
});
