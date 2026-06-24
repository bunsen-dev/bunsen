// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect } from 'bun:test';
import { detectChannel, assetNameFor, sameVersion } from './upgrade.js';

describe('detectChannel', () => {
  it('is dev when the standalone marker is absent (pnpm bn / bun src)', () => {
    expect(detectChannel('/Users/me/.bun/bin/bun', {})).toBe('dev');
    expect(detectChannel('/usr/local/bin/bn', { HOMEBREW_PREFIX: '/usr/local' })).toBe('dev');
  });

  it('is homebrew when the binary lives under a Cellar/Caskroom path', () => {
    const env = { BUNSEN_STANDALONE_BINARY: '1' };
    expect(detectChannel('/opt/homebrew/Cellar/bunsen/0.2.0/bin/bn', env)).toBe('homebrew');
    expect(detectChannel('/usr/local/Caskroom/bunsen/0.2.0/bn', env)).toBe('homebrew');
  });

  it('is homebrew when the binary is under HOMEBREW_PREFIX', () => {
    expect(
      detectChannel('/opt/homebrew/bin/bn', { BUNSEN_STANDALONE_BINARY: '1', HOMEBREW_PREFIX: '/opt/homebrew' }),
    ).toBe('homebrew');
  });

  it('is scoop when under a scoop apps/shims path (Windows)', () => {
    const env = { BUNSEN_STANDALONE_BINARY: '1' };
    expect(detectChannel('C:\\Users\\me\\scoop\\apps\\bunsen\\current\\bn.exe', env)).toBe('scoop');
    expect(detectChannel('C:\\Users\\me\\scoop\\shims\\bn.exe', env)).toBe('scoop');
  });

  it('is binary for a plain curl/install.sh install', () => {
    expect(detectChannel('/Users/me/.local/bin/bn', { BUNSEN_STANDALONE_BINARY: '1' })).toBe('binary');
    expect(detectChannel('/usr/local/bin/bn', { BUNSEN_STANDALONE_BINARY: '1' })).toBe('binary');
  });
});

describe('assetNameFor', () => {
  it('maps platform+arch to the Release asset names from build-binary.mjs', () => {
    expect(assetNameFor('darwin', 'arm64')).toBe('bn-darwin-arm64');
    expect(assetNameFor('darwin', 'x64')).toBe('bn-darwin-x64');
    expect(assetNameFor('linux', 'arm64')).toBe('bn-linux-arm64');
    expect(assetNameFor('linux', 'x64')).toBe('bn-linux-x64');
    expect(assetNameFor('win32', 'x64')).toBe('bn-windows-x64.exe');
  });
});

describe('sameVersion', () => {
  it('compares tag and version ignoring a leading v', () => {
    expect(sameVersion('v0.1.1', '0.1.1')).toBe(true);
    expect(sameVersion('0.1.1', '0.1.1')).toBe(true);
    expect(sameVersion('v0.2.0', '0.1.1')).toBe(false);
  });
});
