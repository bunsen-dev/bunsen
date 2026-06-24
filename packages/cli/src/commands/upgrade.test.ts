// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  detectChannel,
  assetNameFor,
  sameVersion,
  parseSha256Sums,
  assertChecksum,
  assertPlausibleBinary,
  replaceRunningBinary,
} from './upgrade.js';

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

describe('parseSha256Sums', () => {
  const sums = `${'a'.repeat(64)}  bn-darwin-arm64\n${'b'.repeat(64)}  bn-linux-x64\n`;
  it('returns the sha for a present asset (lowercased)', () => {
    expect(parseSha256Sums(sums, 'bn-darwin-arm64')).toBe('a'.repeat(64));
  });
  it('returns null for an absent asset', () => {
    expect(parseSha256Sums(sums, 'bn-windows-x64.exe')).toBeNull();
  });
  it('ignores malformed lines', () => {
    expect(parseSha256Sums('not-a-sha  bn-darwin-arm64\n', 'bn-darwin-arm64')).toBeNull();
  });
});

describe('assertChecksum (mandatory integrity gate)', () => {
  const bin = Buffer.from('hello world');
  const sha = crypto.createHash('sha256').update(bin).digest('hex');

  it('passes when the sha matches', () => {
    expect(() => assertChecksum(bin, 'bn-darwin-arm64', `${sha}  bn-darwin-arm64\n`)).not.toThrow();
  });
  it('THROWS when the asset is absent (refuses unverified install)', () => {
    expect(() => assertChecksum(bin, 'bn-darwin-arm64', `${sha}  bn-linux-x64\n`)).toThrow(/no SHA256SUMS entry/);
  });
  it('THROWS on a checksum mismatch', () => {
    expect(() => assertChecksum(bin, 'bn-darwin-arm64', `${'0'.repeat(64)}  bn-darwin-arm64\n`)).toThrow(/checksum mismatch/);
  });
});

describe('assertPlausibleBinary', () => {
  it('throws on an implausibly small payload (truncated / HTML error)', () => {
    expect(() => assertPlausibleBinary(Buffer.from('<html>404</html>'))).toThrow(/looks truncated/);
  });
  it('accepts a plausibly-sized payload', () => {
    expect(() => assertPlausibleBinary(Buffer.alloc(2_000_000))).not.toThrow();
  });
});

describe('replaceRunningBinary', () => {
  it('atomically replaces the target file in place', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-replace-'));
    try {
      const target = path.join(dir, 'bn');
      fs.writeFileSync(target, 'OLD');
      replaceRunningBinary(Buffer.from('NEW'), target);
      expect(fs.readFileSync(target, 'utf8')).toBe('NEW');
      // No leftover sibling temp.
      expect(fs.readdirSync(dir).filter((n) => n.includes('.new-'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps a permission error to a friendly message and leaves no temp behind', () => {
    // Target inside a non-existent dir → ENOENT on rename (writeFileSync of the
    // sibling fails first) — exercises the catch/cleanup path.
    const target = path.join(os.tmpdir(), 'no-such-dir-xyz', 'bn');
    expect(() => replaceRunningBinary(Buffer.from('NEW'), target)).toThrow();
    expect(fs.existsSync(`${target}.new-${process.pid}`)).toBe(false);
  });
});
