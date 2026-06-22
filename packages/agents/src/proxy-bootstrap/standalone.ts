// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Proxy bootstrap loaded into Node-based agents via `NODE_OPTIONS=--require=...`.
 *
 * Node's native `fetch` is backed by `undici`, which does **not** honor
 * `HTTP_PROXY` / `HTTPS_PROXY` environment variables. The result is that
 * agents like Claude Code (which use the Anthropic SDK on top of native
 * fetch) bypass the mitmproxy sidecar entirely — the proxy is configured
 * for the container, but the SDK opens a direct TLS connection. Bunsen
 * never sees the request, so totals come back as zero.
 *
 * This bootstrap installs a global undici dispatcher that:
 *
 *   - Routes through the URL in `HTTPS_PROXY` (or `HTTP_PROXY`).
 *   - Trusts the CA bundle at `NODE_EXTRA_CA_CERTS` so the mitmproxy's
 *     intercepting certificate doesn't blow up TLS verification.
 *
 * No-ops when no proxy URL is set so the bundle is safe to require in any
 * Node process. Failures are logged to stderr but never throw — a broken
 * bootstrap must not take down the agent.
 *
 * The bundle is built by `packages/agents/scripts/build-bundles.mjs` and
 * mounted into agent containers at `/bunsen/runtime/proxy-bootstrap.cjs`.
 */

import * as fs from 'node:fs';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

function readProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    undefined
  );
}

function readCa(): Buffer | undefined {
  const caPath = process.env.NODE_EXTRA_CA_CERTS;
  if (!caPath) return undefined;
  try {
    return fs.readFileSync(caPath);
  } catch {
    // Fall through — caller will install the dispatcher without an explicit
    // CA, and the request will fail loudly if the mitmproxy is in path.
    return undefined;
  }
}

export function installProxyDispatcher(): boolean {
  const proxyUrl = readProxyUrl();
  if (!proxyUrl) return false;

  try {
    const ca = readCa();
    const tlsOptions = ca ? { ca } : undefined;
    setGlobalDispatcher(
      new ProxyAgent({
        uri: proxyUrl,
        ...(tlsOptions ? { requestTls: tlsOptions, proxyTls: tlsOptions } : {}),
      }),
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[bunsen] proxy bootstrap failed: ${message}\n`);
    return false;
  }
}

// Run on require so `NODE_OPTIONS=--require=<bundle>` is sufficient — no
// extra wiring required from callers.
installProxyDispatcher();
