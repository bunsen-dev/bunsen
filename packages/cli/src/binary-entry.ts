// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Entrypoint for the standalone binary (`bun build --compile`).
 *
 * It differs from `bin.ts` (the dev / esbuild-bundle entrypoint) in exactly one
 * way: it embeds the host asset tarball and, before handing off to the normal
 * CLI program, extracts it and points `BUNSEN_ASSET_DIR` at the real on-disk
 * copy (see `embedded-assets.ts` for why real paths are mandatory). Everything
 * else — command tree, env loading, error handling — lives in `bin.ts`, which
 * this imports once the asset dir is ready.
 *
 * This file is only ever compiled by `scripts/build-binary.mjs`; the `*.tar`
 * import resolves against `dist/assets.tar`, which that script builds first.
 */
import assetsTarPath from '../dist/assets.tar' with { type: 'file' };
import { ensureEmbeddedAssets } from './embedded-assets.js';

// Mark this process as the standalone (`--compile`) binary. Only this entrypoint
// runs in the compiled binary, so the dev/esbuild path never sets it. `bn
// upgrade` uses it to distinguish a self-updatable binary from a dev checkout.
process.env.BUNSEN_STANDALONE_BINARY = '1';

await ensureEmbeddedAssets(assetsTarPath);
await import('./bin.js');
