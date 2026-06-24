#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Build the standalone `bn` binary with `bun build --compile`.
 *
 * Bun's bundler resolves the internal `workspace:*` packages natively, so the
 * binary is compiled straight from `src/binary-entry.ts` — no esbuild prepass.
 * (The esbuild `dist/bin.js` bundle from `build.mjs` is the npm/dev artifact and
 * the source of `dist/assets/`; this script reuses those assets but not the JS.)
 *
 * Pipeline:
 *   1. Assert `dist/assets/` exists (run `pnpm --filter @bunsen-dev/cli build`
 *      first — it assembles the agent bundles, proxy addon, Dockerfiles, skills,
 *      and starter agents that the binary embeds).
 *   2. Pack `dist/assets/` into `dist/assets.tar`. `binary-entry.ts` embeds this
 *      via `import … with { type: 'file' }`; at runtime it is extracted to a
 *      per-user cache and `BUNSEN_ASSET_DIR` is pointed at it (embedded-assets.ts).
 *   3. Cross-compile each target from this one host. x64 targets use the
 *      `-baseline` variant for broad CPU compatibility (no AVX2 requirement).
 *
 * The container Node runtime is deliberately NOT embedded — it is fetched on
 * demand by `@bunsen-dev/runtime`'s `node-runtime.ts`, so the binary stays one
 * per-platform artifact rather than carrying every platform's Node.
 *
 * Usage:
 *   node scripts/build-binary.mjs                       # all default targets
 *   node scripts/build-binary.mjs darwin-arm64 linux-x64
 *   node scripts/build-binary.mjs all                   # + windows-x64
 *   node scripts/build-binary.mjs windows-x64           # opt-in (unsigned)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(__dirname, '..');
const distDir = path.join(cliRoot, 'dist');
const assetsDir = path.join(distDir, 'assets');
const assetsTar = path.join(distDir, 'assets.tar');
const binariesDir = path.join(distDir, 'binaries');
const entry = path.join(cliRoot, 'src', 'binary-entry.ts');

// `bun build --compile --target` ids. x64 → `-baseline` for pre-AVX2 CPUs.
const ALL_TARGETS = {
  'darwin-arm64': { target: 'bun-darwin-arm64', out: 'bn-darwin-arm64' },
  'darwin-x64': { target: 'bun-darwin-x64-baseline', out: 'bn-darwin-x64' },
  'linux-x64': { target: 'bun-linux-x64-baseline', out: 'bn-linux-x64' },
  'linux-arm64': { target: 'bun-linux-arm64', out: 'bn-linux-arm64' },
  // Windows is opt-in (unsigned; the --windows-icon / --windows-hide-console
  // flags would need a Windows runner) — build it via an explicit target or `all`.
  'windows-x64': { target: 'bun-windows-x64-baseline', out: 'bn-windows-x64.exe' },
};
const DEFAULT_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];

function selectTargets(argv) {
  const args = argv.slice(2);
  if (args.length === 0) return DEFAULT_TARGETS;
  if (args.includes('all')) return Object.keys(ALL_TARGETS);
  const unknown = args.filter((a) => !(a in ALL_TARGETS));
  if (unknown.length > 0) {
    console.error(
      `\n✗ Unknown target(s): ${unknown.join(', ')}\n` +
        `  Valid: ${Object.keys(ALL_TARGETS).join(', ')}, all\n`
    );
    process.exit(1);
  }
  return args;
}

function assertAssetsPresent() {
  if (!fs.existsSync(assetsDir) || fs.readdirSync(assetsDir).length === 0) {
    console.error(
      `\n✗ ${path.relative(cliRoot, assetsDir)} is missing or empty.\n` +
        `  Build the host assets first:  pnpm --filter @bunsen-dev/cli build\n`
    );
    process.exit(1);
  }
}

function packAssets() {
  // Tar the CONTENTS of dist/assets (entries at the archive root), so extraction
  // drops `orchestrator.cjs`, `proxy/`, `images/`, … directly into the asset dir
  // that BUNSEN_ASSET_DIR points at. `portable` strips mtimes/uid/gid for a
  // stable archive across hosts.
  const entries = fs.readdirSync(assetsDir).sort();
  tar.create({ file: assetsTar, cwd: assetsDir, sync: true, portable: true }, entries);
  const bytes = fs.statSync(assetsTar).size;
  console.log(`Packed ${entries.length} asset entries → dist/assets.tar (${mb(bytes)})`);
}

function compile(name) {
  const { target, out } = ALL_TARGETS[name];
  const outPath = path.join(binariesDir, out);
  console.log(`\n── compiling ${name} (${target}) ──`);
  execFileSync(
    'bun',
    [
      'build',
      '--compile',
      `--target=${target}`,
      '--minify',
      '--sourcemap=none',
      entry,
      '--outfile',
      outPath,
    ],
    { stdio: 'inherit', cwd: cliRoot }
  );
  // Bun appends .exe for Windows targets; resolve the real path for stat/sha.
  const finalPath = fs.existsSync(outPath) ? outPath : `${outPath}.exe`;
  if (!finalPath.endsWith('.exe')) fs.chmodSync(finalPath, 0o755);
  const sha = sha256(finalPath);
  const size = fs.statSync(finalPath).size;
  console.log(`  → ${path.relative(cliRoot, finalPath)}  ${mb(size)}  sha256:${sha.slice(0, 16)}…`);
  return { name, file: path.basename(finalPath), bytes: size, sha256: sha };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function main() {
  const targets = selectTargets(process.argv);
  assertAssetsPresent();
  fs.rmSync(binariesDir, { recursive: true, force: true });
  fs.mkdirSync(binariesDir, { recursive: true });
  packAssets();

  const results = targets.map(compile);

  // A checksums manifest the release upload + install.sh can verify against.
  const manifest = results
    .map((r) => `${r.sha256}  ${r.file}`)
    .join('\n') + '\n';
  fs.writeFileSync(path.join(binariesDir, 'SHA256SUMS'), manifest);
  console.log(`\n✓ Built ${results.length} binary(ies) in dist/binaries/ (+ SHA256SUMS).`);
}

main();
