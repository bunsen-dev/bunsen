#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Build the publishable @bunsen-dev/cli artifact.
 *
 * Plain `tsc` cannot ship to npm: the CLI imports the *private* workspace
 * packages (`@bunsen-dev/runtime`, transitively `@bunsen-dev/types` / `@bunsen-dev/diff-filter`)
 * whose `workspace:*` specifiers npm cannot resolve, and `@bunsen-dev/runtime`
 * resolves its in-container assets (agent bundles, proxy addon, base-image
 * Dockerfiles) via monorepo-relative paths that don't exist in a flattened
 * tarball. This script fixes both:
 *
 *   1. esbuild bundles `src/bin.ts` → `dist/bin.js`, INLINING all `@bunsen-dev/*`
 *      workspace code and leaving every third-party dep (and native module)
 *      external — so the published `package.json` declares only real npm deps.
 *   2. It assembles every host-side runtime asset into `dist/assets/`, the
 *      single directory `getAssetDir()` (packages/runtime/src/container.ts)
 *      resolves against at runtime:
 *        dist/assets/<bundle>.cjs        platform agent bundles
 *        dist/assets/proxy/*             proxy addon + pricing snapshot
 *        dist/assets/images/<name>/*     base-image Dockerfiles
 *      (Per-platform Node runtimes — tens of MB each — are deliberately NOT
 *      shipped; the custom-image path throws an actionable error instead.)
 *
 * Prerequisite: the agent `.cjs` bundles must already be built
 * (`pnpm --filter @bunsen-dev/agents build:bundles`). The script fails loudly if
 * they're missing.
 */

import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isBuiltin } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(__dirname, '../../..');

const distDir = path.join(cliRoot, 'dist');
const assetsDir = path.join(distDir, 'assets');

const agentsDist = path.join(repoRoot, 'packages/agents/dist');
const proxySrc = path.join(repoRoot, 'packages/runtime/src/proxy');
const imagesSrc = path.join(repoRoot, 'images');
const skillsSrc = path.join(cliRoot, 'assets/skills');
const exampleAgentsSrc = path.join(repoRoot, 'examples/agents');
const genSkillReference = path.join(repoRoot, 'scripts/gen-skill-reference.mjs');

const PLATFORM_BUNDLES = [
  'orchestrator',
  'scorer',
  'supervisor',
  'gitignore-filter',
  'proxy-bootstrap',
];
const PROXY_ASSETS = ['ai_capture.py', 'model_prices.json'];

// Curated starter agents shipped inside the CLI so `bn agents add` / `bn init
// --agents` can scaffold a runnable agent into a fresh project. The canonical
// definitions live in `examples/agents/`; this is the single list that decides
// which ones travel in the published package. Keep it to the frontier coding
// CLIs (single-binary / self-contained) — the heavier reference agents stay
// checkout-only.
const STARTER_AGENTS = ['claude-code', 'codex-cli', 'gemini-cli'];

/**
 * esbuild plugin: inline only our own `@bunsen-dev/*` workspace packages; keep
 * every other bare specifier (third-party deps + Node builtins) external, so
 * the bundle carries no `workspace:*` references and native modules
 * (better-sqlite3, dockerode→ssh2→cpu-features) are never bundled.
 */
const externalizeNonBunsen = {
  name: 'externalize-non-bunsen',
  setup(build) {
    // Match bare specifiers only (not relative `./` or absolute `/` paths).
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith('@bunsen-dev/')) return null; // inline workspace code
      return { path: args.path, external: true };
    });
  },
};

function assertBundlesPresent() {
  const missing = PLATFORM_BUNDLES.filter(
    (name) => !fs.existsSync(path.join(agentsDist, `${name}.cjs`))
  );
  if (missing.length > 0) {
    console.error(
      `\n✗ Missing agent bundles: ${missing.map((n) => `${n}.cjs`).join(', ')}\n` +
        `  Build them first:  pnpm --filter @bunsen-dev/agents build:bundles\n`
    );
    process.exit(1);
  }
}

function assertStarterAgentsPresent() {
  const missing = STARTER_AGENTS.filter(
    (name) => !fs.existsSync(path.join(exampleAgentsSrc, name, 'agent.yaml'))
  );
  if (missing.length > 0) {
    console.error(
      `\n✗ Missing starter agents under examples/agents/: ${missing.join(', ')}\n` +
        `  Each STARTER_AGENTS entry must have an agent.yaml in examples/agents/<name>/.\n`
    );
    process.exit(1);
  }
}

async function bundleCli() {
  const result = await esbuild.build({
    entryPoints: [path.join(cliRoot, 'src/bin.ts')],
    outfile: path.join(distDir, 'bin.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    metafile: true,
    // No sourcemap: it would ~double the published payload (the bundle is a
    // single file, so traces stay navigable without it).
    sourcemap: false,
    plugins: [externalizeNonBunsen],
    logLevel: 'info',
  });

  // esbuild preserves the entry hashbang, but guard against drift and make the
  // bin executable.
  const binPath = path.join(distDir, 'bin.js');
  let code = fs.readFileSync(binPath, 'utf8');
  if (!code.startsWith('#!')) {
    code = `#!/usr/bin/env node\n${code}`;
    fs.writeFileSync(binPath, code);
  }
  fs.chmodSync(binPath, 0o755);

  // Surface the external dep set so package.json `dependencies` can be kept
  // honest. `isBuiltin` filters BOTH `node:`-prefixed and bare builtins (e.g.
  // `fs`, `http`, `child_process`), leaving only real npm deps in the list.
  const externals = new Set();
  for (const out of Object.values(result.metafile.outputs)) {
    for (const imp of out.imports ?? []) {
      // Drop Node builtins (`fs`, `node:path`, …) AND Bun builtins (`bun:sqlite`)
      // — neither is an npm dependency. `bun:sqlite` is provided by the Bun
      // runtime that executes this bundle (dev: `bun …`; release: the compiled
      // binary), so it never belongs in package.json `dependencies`.
      if (imp.external && !isBuiltin(imp.path) && !imp.path.startsWith('bun:')) {
        externals.add(imp.path);
      }
    }
  }
  console.log(`\nExternal runtime deps (must be in package.json dependencies):`);
  console.log(`  ${[...externals].sort().join(', ') || '(none)'}`);
}

function copyAssets() {
  fs.rmSync(assetsDir, { recursive: true, force: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  // 1. Platform agent bundles → dist/assets/<name>.cjs
  for (const name of PLATFORM_BUNDLES) {
    fs.copyFileSync(
      path.join(agentsDist, `${name}.cjs`),
      path.join(assetsDir, `${name}.cjs`)
    );
  }

  // 2. Proxy addon + pricing snapshot → dist/assets/proxy/*
  const proxyOut = path.join(assetsDir, 'proxy');
  fs.mkdirSync(proxyOut, { recursive: true });
  for (const asset of PROXY_ASSETS) {
    fs.copyFileSync(path.join(proxySrc, asset), path.join(proxyOut, asset));
  }

  // 3. Base-image Dockerfiles (tiny) → dist/assets/images/<name>/*
  fs.cpSync(imagesSrc, path.join(assetsDir, 'images'), { recursive: true });

  // 4. Cross-agent SKILL.md authoring skills → dist/assets/skills/<skill>/*
  //    (`bn skills install` reads these from getAssetDir()/skills at runtime.)
  fs.cpSync(skillsSrc, path.join(assetsDir, 'skills'), { recursive: true });

  // 5. Curated starter agents → dist/assets/agents/<name>/*
  //    (`bn agents add` / `bn init --agents` read these from getAssetDir()/agents.)
  const agentsOut = path.join(assetsDir, 'agents');
  for (const name of STARTER_AGENTS) {
    fs.cpSync(path.join(exampleAgentsSrc, name), path.join(agentsOut, name), { recursive: true });
  }

  const bundleCount = PLATFORM_BUNDLES.length;
  console.log(
    `\nAssets assembled in dist/assets/ (${bundleCount} bundles, proxy addon + pricing, base-image Dockerfiles, skills, ${STARTER_AGENTS.length} starter agents).`
  );
}

/**
 * Anti-staleness guard: the skills' generated `reference/*.md` field tables are
 * derived from the JSON Schemas in `@bunsen-dev/types`. Fail the build if a schema
 * change landed without regenerating them, so the published CLI never ships a
 * reference that disagrees with the validator it bundles.
 */
function assertSkillReferenceFresh() {
  try {
    execFileSync(process.execPath, [genSkillReference, '--check'], { stdio: 'inherit' });
  } catch {
    console.error(
      '\n✗ Skill reference is stale. Run `pnpm gen:skill-reference` and commit the result.\n'
    );
    process.exit(1);
  }
}

async function main() {
  assertBundlesPresent();
  assertStarterAgentsPresent();
  assertSkillReferenceFresh();
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  await bundleCli();
  copyAssets();
  console.log('\n✓ @bunsen-dev/cli build complete.');
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
