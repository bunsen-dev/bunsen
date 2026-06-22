// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for the proxy bootstrap.
 *
 * These tests import the source module (not the built bundle) so we can
 * exercise the dispatcher selection logic directly. The bundle itself is
 * verified by `pnpm build:bundles:all` producing `dist/proxy-bootstrap.cjs`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProxyAgent, getGlobalDispatcher, setGlobalDispatcher, Agent } from 'undici';
import { installProxyDispatcher } from './standalone.js';

describe('proxy-bootstrap', () => {
  // Save and restore the dispatcher around each test so we don't leak state
  // into other suites that might exercise undici.
  const saved = getGlobalDispatcher();
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-bootstrap-test-'));
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.NODE_EXTRA_CA_CERTS;
    setGlobalDispatcher(new Agent());
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    setGlobalDispatcher(saved);
  });

  it('is a no-op when no proxy env is set', () => {
    expect(installProxyDispatcher()).toBe(false);
    expect(getGlobalDispatcher()).not.toBeInstanceOf(ProxyAgent);
  });

  it('installs a ProxyAgent when HTTPS_PROXY is set', () => {
    process.env.HTTPS_PROXY = 'http://proxy.test:9999';
    expect(installProxyDispatcher()).toBe(true);
    expect(getGlobalDispatcher()).toBeInstanceOf(ProxyAgent);
  });

  it('falls back to HTTP_PROXY when HTTPS_PROXY is not set', () => {
    process.env.HTTP_PROXY = 'http://proxy.test:8888';
    expect(installProxyDispatcher()).toBe(true);
    expect(getGlobalDispatcher()).toBeInstanceOf(ProxyAgent);
  });

  it('still installs a dispatcher when NODE_EXTRA_CA_CERTS points to a missing file', () => {
    process.env.HTTPS_PROXY = 'http://proxy.test:9999';
    process.env.NODE_EXTRA_CA_CERTS = path.join(tempDir, 'no-such-file.pem');
    expect(installProxyDispatcher()).toBe(true);
    expect(getGlobalDispatcher()).toBeInstanceOf(ProxyAgent);
  });

  it('passes the CA bundle when NODE_EXTRA_CA_CERTS is readable', () => {
    process.env.HTTPS_PROXY = 'http://proxy.test:9999';
    const caPath = path.join(tempDir, 'ca.pem');
    fs.writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n');
    process.env.NODE_EXTRA_CA_CERTS = caPath;
    expect(installProxyDispatcher()).toBe(true);
    expect(getGlobalDispatcher()).toBeInstanceOf(ProxyAgent);
  });
});
