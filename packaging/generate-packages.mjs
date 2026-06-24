#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Generate the Homebrew cask + Scoop manifest for a release, filled with the
 * version and per-asset sha256 from `packages/cli/dist/binaries/SHA256SUMS`
 * (produced by `build-binary.mjs`). One source of truth so the two package
 * managers never drift from the actual Release artifacts.
 *
 * The outputs are meant to live in SEPARATE repos:
 *   - Homebrew cask  → bunsen-dev/homebrew-tap   Casks/bunsen.rb
 *   - Scoop manifest → bunsen-dev/scoop-bucket    bucket/bunsen.json
 * The release CI copies them there (see .github/workflows/release.yaml). See
 * packaging/README.md for bootstrapping the two repos.
 *
 * Usage:
 *   node packaging/generate-packages.mjs <version> [sha256sums-path] [out-dir]
 *   # version without a leading v, e.g. 0.2.0
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const version = (process.argv[2] || '').replace(/^v/, '');
const sumsPath = process.argv[3] || path.join(repoRoot, 'packages/cli/dist/binaries/SHA256SUMS');
const outDir = process.argv[4] || path.join(__dirname, 'out');

if (!version) {
  console.error('Usage: node packaging/generate-packages.mjs <version> [sha256sums] [out-dir]');
  process.exit(1);
}

const REPO = 'bunsen-dev/bunsen';
const DESC = 'General-purpose experiment runner for agentic systems';
const HOMEPAGE = 'https://bunsen.dev';

// Parse `<sha>  <file>` lines into { asset: sha }.
const sums = Object.fromEntries(
  fs.readFileSync(sumsPath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 2)
    .map(([sha, file]) => [file, sha]),
);

function need(asset) {
  if (!sums[asset]) {
    console.error(`✗ ${asset} missing from ${sumsPath} — was it built for this release?`);
    process.exit(1);
  }
  return sums[asset];
}

const url = (asset) => `https://github.com/${REPO}/releases/download/v${version}/${asset}`;

// --- Homebrew cask (macOS) — always generated (a release always has darwin) --
// A bare-binary cask: download the per-arch asset, install it as `bn`. NOTE: a
// cask-downloaded file is quarantined by Homebrew; Gatekeeper accepts it only
// once the binary is signed + notarized. Until then a cask user may have to clear
// quarantine manually (see the caveat) — so prefer install.sh (which strips it)
// until signing lands.
const cask = `cask "bunsen" do
  version "${version}"

  on_arm do
    sha256 "${need('bn-darwin-arm64')}"
    url "${url('bn-darwin-arm64')}"
    binary "bn-darwin-arm64", target: "bn"
  end
  on_intel do
    sha256 "${need('bn-darwin-x64')}"
    url "${url('bn-darwin-x64')}"
    binary "bn-darwin-x64", target: "bn"
  end

  name "Bunsen"
  desc "${DESC}"
  homepage "${HOMEPAGE}"

  caveats <<~EOS
    Bunsen runs experiments in Docker containers — start a Docker daemon, then:
      bn doctor

    If macOS Gatekeeper blocks bn (until the binary is notarized), clear quarantine:
      xattr -d com.apple.quarantine "$(brew --prefix)/bin/bn"
  EOS
end
`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'bunsen.rb'), cask);
console.log(`✓ Wrote ${path.relative(repoRoot, path.join(outDir, 'bunsen.rb'))} (cask) for v${version}`);
console.log('  Homebrew cask → bunsen-dev/homebrew-tap : Casks/bunsen.rb');

// --- Scoop manifest (Windows) — only when a windows asset was built ----------
// The macOS+Linux-first launch (release.yaml drops the windows matrix entry)
// produces no bn-windows-x64.exe, so skip-and-warn instead of hard-failing.
// `checkver`/`autoupdate` keep the bucket current from GitHub releases.
if (sums['bn-windows-x64.exe']) {
  const scoop = {
    version,
    description: DESC,
    homepage: HOMEPAGE,
    license: 'LicenseRef-PolyForm-Shield-1.0.0',
    architecture: {
      '64bit': {
        url: url('bn-windows-x64.exe'),
        hash: sums['bn-windows-x64.exe'],
        bin: [['bn-windows-x64.exe', 'bn']],
      },
    },
    checkver: { github: `https://github.com/${REPO}` },
    autoupdate: {
      architecture: {
        '64bit': { url: `https://github.com/${REPO}/releases/download/v$version/bn-windows-x64.exe` },
      },
      hash: { url: `https://github.com/${REPO}/releases/download/v$version/SHA256SUMS` },
    },
    notes: 'Bunsen runs experiments in Docker containers — start Docker Desktop, then `bn doctor`.',
  };
  fs.writeFileSync(path.join(outDir, 'bunsen.json'), JSON.stringify(scoop, null, 2) + '\n');
  console.log(`✓ Wrote ${path.relative(repoRoot, path.join(outDir, 'bunsen.json'))} (Scoop manifest)`);
  console.log('  Scoop manifest → bunsen-dev/scoop-bucket : bucket/bunsen.json');
} else {
  console.log('• No bn-windows-x64.exe in SHA256SUMS — skipping the Scoop manifest (macOS+Linux release).');
}
