// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Entrypoint for the standalone binary (`bun build --compile`).
 *
 * It differs from `bin.ts` (the dev / esbuild-bundle entrypoint) by embedding
 * the host files that `bun build --compile` cannot resolve from the binary's
 * virtual FS, then wiring the rest of the CLI at them before handing off:
 *   - the host asset tarball, extracted to a real on-disk dir with
 *     `BUNSEN_ASSET_DIR` pointed at it (see `embedded-assets.ts` for why real
 *     paths are mandatory);
 *   - @braintrust/lingua's wasm core, read straight from the embedded FS via
 *     `BUNSEN_LINGUA_WASM`.
 * Everything else — command tree, env loading, error handling — lives in
 * `bin.ts`, which this imports once those are ready.
 *
 * This file is only ever compiled by `scripts/build-binary.mjs`; the embedded
 * imports resolve against `dist/assets.tar` + `dist/lingua_bg.wasm`, which that
 * script's prerequisite `pnpm --filter @bunsen-dev/cli build` produces first.
 */
import assetsTarPath from '../dist/assets.tar' with { type: 'file' };
import linguaWasmPath from '../dist/lingua_bg.wasm' with { type: 'file' };
import { ensureEmbeddedAssets } from './embedded-assets.js';

// Mark this process as the standalone (`--compile`) binary. Only this entrypoint
// runs in the compiled binary, so the dev/esbuild path never sets it. `bn
// upgrade` uses it to distinguish a self-updatable binary from a dev checkout.
process.env.BUNSEN_STANDALONE_BINARY = '1';

// @braintrust/lingua's wasm-bindgen glue loads `lingua_bg.wasm` relative to its
// own __dirname, which `bun build --compile` re-roots into the binary's virtual
// FS where the file is absent. Point the patched loader
// (patches/@braintrust__lingua-wasm@0.1.0.patch) at the embedded copy. Must be
// set before `bin.js`: that import graph pulls in lingua, which reads the wasm
// at module-eval time. Bun's fs reads this `/$bunfs` path transparently.
process.env.BUNSEN_LINGUA_WASM = linguaWasmPath;

await ensureEmbeddedAssets(assetsTarPath);
await import('./bin.js');
