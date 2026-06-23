// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Container Node runtime resolution.
 *
 * Bunsen's platform tools (orchestrator, supervisor, scorers) run *inside* the
 * agent container. Bunsen base images ship Node 20, so on those the container's
 * own `node` is used. But a custom Dockerfile / non-bunsen base image may have
 * no Node — so for those Bunsen mounts its *own* Node binary at
 * `/bunsen/runtime/node`. This is the platform honoring the same "anti-contract"
 * the environment model imposes on agents: if you need a runtime, ship it; don't
 * depend on the substrate having it (see docs/ENVIRONMENT.md). The mounted Node
 * is the platform's `closure`-linkage dependency, in the model's own vocabulary.
 *
 * The per-platform Node binary is ~95 MB, so it is NOT embedded in every
 * distribution artifact (npm package, future standalone binary). Instead this
 * module resolves it through a layered lookup and, on a miss, performs a
 * sha256-verified download into a shared host cache — the same on-demand pattern
 * Docker/esbuild/Playwright use, and the only one that keeps every distribution
 * small while staying reproducible (the version + hashes are pinned in
 * node-runtime-manifest.json, the single source of truth shared with
 * packages/agents/scripts/build-bundles.mjs).
 *
 * Resolution order (first hit wins):
 *   (a) BUNSEN_NODE_RUNTIME_DIR override   — air-gapped / power users
 *   (b) bundled asset getAssetDir()/runtime/ — a distribution that shipped it
 *   (c) from-source packages/agents/runtime/ — `pnpm build:bundles:runtime` output
 *   (d) shared host cache                   — a prior verified download
 *   (e) verified download                   — fetched, hashed, cached (unless BUNSEN_NODE_OFFLINE)
 *
 * libc: these are glibc builds. They run on every Bunsen base image plus the
 * common custom bases (debian/ubuntu/CUDA/distroless-glibc). A musl/Alpine base
 * is not yet supported — see resolveContainerNodeRuntime's error path.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

import { getAssetDir, normalizeRunPlatform, runPlatformToArch } from './container.js';
import manifest from './node-runtime-manifest.json' with { type: 'json' };

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Bunsen target id for a run platform: the Node tarball/dir suffix. */
export type NodeRuntimeTarget = 'linux-x64' | 'linux-arm64';

interface NodeRuntimeTargetEntry {
  url: string;
  tarballSha256: string;
  binSha256: string;
}

/** The pinned Node version Bunsen mounts into custom-image containers. */
export const NODE_RUNTIME_VERSION: string = manifest.version;

/** Typed accessor over the shared pinned manifest. */
export function getNodeRuntimeManifest(): {
  version: string;
  targets: Record<NodeRuntimeTarget, NodeRuntimeTargetEntry>;
} {
  return manifest as unknown as {
    version: string;
    targets: Record<NodeRuntimeTarget, NodeRuntimeTargetEntry>;
  };
}

/** Map a run platform (or bare arch) to the Bunsen Node target id. */
export function nodeRuntimeTarget(platform: string): NodeRuntimeTarget {
  return runPlatformToArch(normalizeRunPlatform(platform)) === 'arm64'
    ? 'linux-arm64'
    : 'linux-x64';
}

/** Binary basename for a target, e.g. `node-linux-arm64`. Stable across layers. */
export function nodeRuntimeBinName(target: NodeRuntimeTarget): string {
  return `node-${target}`;
}

/**
 * Asset-layer path for the per-platform Node binary, i.e. where a distribution
 * that *shipped* the runtime keeps it (alongside the platform .cjs bundles).
 * Layer (b) of the resolver. Not guaranteed to exist — the npm CLI omits it.
 */
export function getNodeRuntimePath(platform: string): string {
  return path.join(getAssetDir(), 'runtime', nodeRuntimeBinName(nodeRuntimeTarget(platform)));
}

/**
 * Per-user host cache root for project-invariant, Bunsen-pinned artifacts (the
 * Node runtime today). Deliberately distinct from `getAssetDir()` (read-only,
 * ships-with-distribution) and from the project-local `.bunsen/` caches (which
 * are project/agent-specified): the Node runtime is one pinned binary identical
 * across every project, so a shared per-user shelf avoids re-downloading 95 MB
 * per checkout and is the writable location a read-only standalone binary needs.
 */
export function getHostCacheDir(): string {
  const override = process.env.BUNSEN_CACHE_DIR;
  if (override && override.trim()) return override.trim();
  const home = os.homedir();
  switch (os.platform()) {
    case 'darwin':
      return path.join(home, 'Library', 'Caches', 'bunsen');
    case 'win32': {
      const localAppData = process.env.LOCALAPPDATA;
      const base = localAppData && localAppData.trim() ? localAppData.trim() : path.join(home, 'AppData', 'Local');
      return path.join(base, 'bunsen', 'Cache');
    }
    default: {
      const xdg = process.env.XDG_CACHE_HOME;
      const base = xdg && xdg.trim() ? xdg.trim() : path.join(home, '.cache');
      return path.join(base, 'bunsen');
    }
  }
}

function hostCacheRuntimePath(target: NodeRuntimeTarget): string {
  return path.join(
    getHostCacheDir(),
    'node-runtimes',
    `v${manifest.version}`,
    nodeRuntimeBinName(target)
  );
}

/**
 * From-source layer (c): find packages/agents/runtime/<bin> in a real monorepo
 * checkout. Anchored on a positive signal — an adjacent packages/agents whose
 * package.json is `@bunsen-dev/agents` — so a published @bunsen-dev/runtime in a
 * consumer's node_modules (or the Bun-compiled binary's virtual FS) never walks
 * into an unrelated tree.
 */
function findMonorepoAgentsRuntime(binName: string): string | undefined {
  let dir = __moduleDir;
  for (let i = 0; i < 8; i++) {
    const agentsPkg = path.join(dir, 'packages', 'agents', 'package.json');
    if (fs.existsSync(agentsPkg)) {
      try {
        const name = JSON.parse(fs.readFileSync(agentsPkg, 'utf8'))?.name;
        if (name === '@bunsen-dev/agents') {
          return path.join(dir, 'packages', 'agents', 'runtime', binName);
        }
      } catch {
        // unreadable/!json — not the monorepo root; keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function isTruthyEnv(name: string): boolean {
  const v = process.env[name];
  return !!v && v.trim() !== '' && v.trim() !== '0' && v.trim().toLowerCase() !== 'false';
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function verifySha(file: string, expected: string, label: string): void {
  const actual = sha256File(file);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `Node runtime ${label} sha256 mismatch: expected ${expected}, got ${actual} (${file}).`
    );
  }
}

function offlineErrorMessage(runPlatform: string, target: NodeRuntimeTarget): string {
  return (
    `Node runtime for ${runPlatform} is not available locally and a network fetch is disabled ` +
    `(BUNSEN_NODE_OFFLINE is set, or there is no network). This experiment uses a custom / ` +
    `non-bunsen base image, which needs Bunsen's Node ${manifest.version} runtime inside the ` +
    `container. Options: pre-fetch it with \`pnpm --filter @bunsen-dev/agents build:bundles:runtime\` ` +
    `(from a source checkout), point BUNSEN_NODE_RUNTIME_DIR at a directory containing ` +
    `${nodeRuntimeBinName(target)}, or re-run with network access.`
  );
}

/**
 * Download the pinned Node tarball, verify it (tarball + extracted binary) against
 * the manifest, and atomically place the `node` binary into the host cache.
 * Concurrency-safe: extracts to a unique temp dir on the same filesystem as the
 * cache and renames into place; a racing winner just makes us a cache hit.
 */
async function downloadAndCacheNodeRuntime(
  entry: NodeRuntimeTargetEntry,
  target: NodeRuntimeTarget,
  finalPath: string
): Promise<void> {
  const url = entry.url;
  if (!/^https:\/\//i.test(url)) {
    throw new Error(`Refusing to fetch Node runtime from non-https URL: ${url}`);
  }
  const cacheRoot = path.dirname(finalPath);
  fs.mkdirSync(cacheRoot, { recursive: true });
  // Temp dir on the SAME filesystem as the cache so the final rename is atomic
  // (os.tmpdir() can be a different device → EXDEV).
  const tmpDir = fs.mkdtempSync(path.join(cacheRoot, '.dl-'));
  try {
    const tarball = path.join(tmpDir, 'node.tar.gz');
    // `--proto`/`--proto-redir` pin curl to https for the request and any
    // redirect, so a hijacked URL can't downgrade to file:// or http.
    execFileSync(
      'curl',
      ['-fsSL', '--proto', '=https', '--proto-redir', '=https', '-o', tarball, url],
      { stdio: 'pipe', timeout: 5 * 60 * 1000 }
    );
    verifySha(tarball, entry.tarballSha256, 'tarball');

    // Extract ONLY <root>/bin/node — never honor `..` or absolute paths from a
    // corrupt/hostile tarball.
    await tar.x({
      file: tarball,
      cwd: tmpDir,
      filter: (p: string) => /(^|\/)bin\/node$/.test(p) && !p.includes('..'),
    });
    const extracted = path.join(tmpDir, `node-v${manifest.version}-${target}`, 'bin', 'node');
    if (!fs.existsSync(extracted)) {
      throw new Error(`Node binary not found in tarball for ${target} (expected ${extracted}).`);
    }
    verifySha(extracted, entry.binSha256, 'binary');

    // Atomic publish: stage beside the final path (same fs), then rename.
    const staged = path.join(cacheRoot, `.${nodeRuntimeBinName(target)}.${process.pid}.tmp`);
    fs.copyFileSync(extracted, staged);
    fs.chmodSync(staged, 0o755);
    try {
      fs.renameSync(staged, finalPath);
    } catch (err) {
      // A concurrent winner already published the (identical, verified) binary.
      if (fs.existsSync(finalPath)) {
        fs.rmSync(staged, { force: true });
      } else {
        throw err;
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

interface ResolveOptions {
  log?: (message: string) => void;
}

/**
 * Resolve a host path to a ready-to-mount Node binary for `platform`, fetching
 * and caching it (verified) if necessary. Throws an actionable error if it
 * genuinely cannot be obtained (offline + uncached, or an unsupported base).
 *
 * This is the single authoritative gate: callers mount the returned path at
 * `/bunsen/runtime/node`. Resolve once per run and thread the path to every
 * consumer; never probe existence separately.
 */
export async function resolveContainerNodeRuntime(
  platform: string,
  opts: ResolveOptions = {}
): Promise<string> {
  const runPlatform = normalizeRunPlatform(platform);
  const target = nodeRuntimeTarget(runPlatform);
  const entry = getNodeRuntimeManifest().targets[target];
  if (!entry) {
    throw new Error(`No pinned Node runtime for ${runPlatform} (target ${target}).`);
  }
  const binName = nodeRuntimeBinName(target);
  const log = opts.log ?? (() => {});

  // (a) explicit override
  const override = process.env.BUNSEN_NODE_RUNTIME_DIR;
  if (override && override.trim()) {
    const p = path.join(override.trim(), binName);
    if (fs.existsSync(p)) return p;
    throw new Error(
      `BUNSEN_NODE_RUNTIME_DIR is set to "${override.trim()}" but ${binName} was not found there.`
    );
  }

  // (b) bundled asset
  const assetPath = getNodeRuntimePath(runPlatform);
  if (fs.existsSync(assetPath)) return assetPath;

  // (c) from-source monorepo build output
  const devPath = findMonorepoAgentsRuntime(binName);
  if (devPath && fs.existsSync(devPath)) return devPath;

  // (d) shared host cache
  const cachePath = hostCacheRuntimePath(target);
  if (fs.existsSync(cachePath)) return cachePath;

  // (e) verified download
  if (isTruthyEnv('BUNSEN_NODE_OFFLINE')) {
    throw new Error(offlineErrorMessage(runPlatform, target));
  }
  log(
    `Fetching Node ${manifest.version} runtime for ${runPlatform} (first use on this host; ` +
      `verified against pinned sha256, cached in ${path.dirname(cachePath)})...`
  );
  try {
    await downloadAndCacheNodeRuntime(entry, target, cachePath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to obtain the Node ${manifest.version} runtime for ${runPlatform}: ${detail}\n` +
        offlineErrorMessage(runPlatform, target)
    );
  }
  return cachePath;
}
