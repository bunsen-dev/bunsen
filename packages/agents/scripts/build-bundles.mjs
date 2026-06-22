#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Build JS bundles for platform tools (orchestrator, scorer, gitignore-filter).
 *
 * This script:
 * 1. Bundles TypeScript with esbuild to CJS
 * 2. Downloads Node.js binaries for custom images (linux-x64, linux-arm64)
 *
 * Output structure:
 *   dist/
 *     orchestrator.cjs
 *     scorer.cjs
 *     gitignore-filter.cjs
 *   runtime/
 *     node-linux-x64
 *     node-linux-arm64
 *
 * Usage:
 *   node scripts/build-bundles.mjs orchestrator
 *   node scripts/build-bundles.mjs scorer
 *   node scripts/build-bundles.mjs all
 *   node scripts/build-bundles.mjs runtime   # Just download Node.js binaries
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as https from 'node:https';
import * as tar from 'tar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const NODE_VERSION = '20.9.0';
const TARGETS = ['linux-x64', 'linux-arm64'];

/**
 * Download a file from URL to destination
 */
async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`  Downloading ${url}...`);

    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 302 || response.statusCode === 301) {
        file.close();
        fs.unlinkSync(dest);
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlinkSync(dest);
      reject(err);
    });
  });
}

/**
 * Download and extract Node.js binary for target platform
 * Returns the path to the node binary
 */
async function downloadNodeBinary(target) {
  const cacheDir = path.join(ROOT, '.node-cache');
  const runtimeDir = path.join(ROOT, 'runtime');
  const [platform, arch] = target.split('-');

  // Map our target names to Node.js naming convention
  const nodeArch = arch === 'arm64' ? 'arm64' : 'x64';
  const nodePlatform = platform;

  const tarballName = `node-v${NODE_VERSION}-${nodePlatform}-${nodeArch}.tar.gz`;
  const tarballPath = path.join(cacheDir, tarballName);
  const extractDir = path.join(cacheDir, `node-v${NODE_VERSION}-${nodePlatform}-${nodeArch}`);
  const nodeBinary = path.join(extractDir, 'bin', 'node');
  const outputPath = path.join(runtimeDir, `node-${target}`);

  // Check if already built
  if (fs.existsSync(outputPath)) {
    console.log(`  Using cached Node.js binary for ${target}`);
    return outputPath;
  }

  // Create directories
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  // Download if not cached
  if (!fs.existsSync(tarballPath)) {
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${tarballName}`;
    await downloadFile(url, tarballPath);
  }

  // Extract if not already extracted
  if (!fs.existsSync(nodeBinary)) {
    console.log(`  Extracting ${tarballName}...`);
    await tar.x({
      file: tarballPath,
      cwd: cacheDir,
    });
  }

  // Copy node binary to runtime directory
  console.log(`  Copying Node.js binary to runtime/${path.basename(outputPath)}...`);
  fs.copyFileSync(nodeBinary, outputPath);
  fs.chmodSync(outputPath, 0o755);

  return outputPath;
}

/**
 * Download Node.js binaries for all target platforms
 */
async function downloadAllNodeBinaries() {
  console.log('\nDownloading Node.js binaries for custom images...');

  for (const target of TARGETS) {
    console.log(`\n  ${target}:`);
    await downloadNodeBinary(target);
  }

  console.log('\n  Node.js binaries ready in runtime/');
}

/**
 * Bundle TypeScript to single JS file using esbuild
 */
function bundleTypeScript(name) {
  const entryPoint = path.join(ROOT, 'src', name, 'standalone.ts');
  const outFile = path.join(ROOT, 'dist', `${name}.cjs`);

  console.log(`  Bundling ${name}...`);

  // Ensure dist directory exists
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });

  // Bundle with esbuild as CJS for Node 20 compatibility.
  // `import.meta.url` is empty under esbuild's CJS output, so provide a shim:
  // the scorer resolves Playwright at runtime via `createRequire(import.meta.url)`,
  // which throws on an undefined URL without this define.
  const shimPath = path.join(ROOT, 'dist', 'import-meta-shim.js');
  fs.writeFileSync(shimPath, `
    export const importMetaUrl = typeof __filename !== 'undefined'
      ? require('url').pathToFileURL(__filename).href
      : 'file:///app/bundle.cjs';
  `);

  // Build esbuild command with optional external packages
  // The scorer uses Playwright for visual evaluation, which must be available at runtime
  // in the container rather than bundled (Playwright has native dependencies)
  const externalFlags = name === 'scorer' ? '--external:playwright --external:playwright-core' : '';

  execSync(
    `npx esbuild ${entryPoint} --bundle --platform=node --format=cjs --outfile=${outFile} --target=node20 --inject:${shimPath} --define:import.meta.url=importMetaUrl ${externalFlags}`,
    { cwd: ROOT, stdio: 'inherit' }
  );

  // Get bundle size
  const stats = fs.statSync(outFile);
  const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
  console.log(`  Created: dist/${name}.cjs (${sizeMB} MB)`);

  return outFile;
}

/**
 * Build bundle for a specific component
 */
async function buildBundle(name) {
  console.log(`\nBuilding bundle for ${name}...`);

  // Check if standalone entry point exists
  const entryPoint = path.join(ROOT, 'src', name, 'standalone.ts');
  if (!fs.existsSync(entryPoint)) {
    console.error(`Error: ${entryPoint} not found`);
    process.exit(1);
  }

  // Bundle TypeScript
  bundleTypeScript(name);

  console.log(`  ${name} bundle complete!`);
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node scripts/build-bundles.mjs <component>');
    console.log('  component: orchestrator, scorer, supervisor, gitignore-filter, runtime, or all');
    process.exit(1);
  }

  const component = args[0];

  console.log('='.repeat(60));
  console.log('Building Platform Tool Bundles');
  console.log('='.repeat(60));

  if (component === 'all' || component === 'bundles') {
    // `bundles` builds every .cjs but SKIPS the per-platform Node runtime
    // download (tens of MB, only needed for custom/non-bunsen images). It is
    // what `@bunsen-dev/cli`'s build depends on, so `pnpm -r build` produces the
    // bundles topologically without pulling the heavy Node binaries.
    await buildBundle('orchestrator');
    await buildBundle('scorer');
    await buildBundle('supervisor');
    await buildBundle('gitignore-filter');
    await buildBundle('proxy-bootstrap');
    if (component === 'all') {
      await downloadAllNodeBinaries();
    }
  } else if (component === 'runtime') {
    await downloadAllNodeBinaries();
  } else {
    await buildBundle(component);
  }

  console.log('\n' + '='.repeat(60));
  console.log('Build complete!');
  console.log('='.repeat(60));
}

main().catch((error) => {
  console.error('Build failed:', error);
  process.exit(1);
});
