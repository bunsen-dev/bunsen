// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';

// bun:test's `vi.mock` patches in place (no hoisting), so a plain object works
// where vitest needed `vi.hoisted`.
const coreMocks = {
  clearBuildCache: vi.fn(),
  clearDepsCache: vi.fn(),
  listBuildCacheEntries: vi.fn(),
  listDepsCacheEntries: vi.fn(),
};

vi.mock('@bunsen-dev/runtime', () => coreMocks);

import { cacheCleanCommand, cacheListCommand } from './cache.js';

describe('cache commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    coreMocks.listBuildCacheEntries.mockReturnValue([]);
    coreMocks.listDepsCacheEntries.mockReturnValue([]);
    coreMocks.clearBuildCache.mockReturnValue(0);
    coreMocks.clearDepsCache.mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints JSON output for cache list including build + deps sections', async () => {
    coreMocks.listBuildCacheEntries.mockReturnValue([
      { key: 'abc', path: '/tmp/cache/abc', sizeBytes: 1234 },
    ]);
    coreMocks.listDepsCacheEntries.mockReturnValue([
      {
        key: 'ripgrep-def',
        path: '/tmp/deps/ripgrep-def',
        sizeBytes: 5000,
        name: 'ripgrep',
        version: '14.1.1',
        cacheKey: 'def',
        provides: ['rg'],
      },
    ]);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await cacheListCommand({ format: 'json' });

    expect(coreMocks.listBuildCacheEntries).toHaveBeenCalledWith(process.cwd());
    expect(coreMocks.listDepsCacheEntries).toHaveBeenCalledWith(process.cwd());

    const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
    const payload = JSON.parse(output);
    expect(payload).toMatchObject({
      build: { count: 1, entries: [{ key: 'abc', sizeBytes: 1234 }] },
      deps: {
        count: 1,
        entries: [{ key: 'ripgrep-def', name: 'ripgrep', version: '14.1.1', provides: ['rg'] }],
      },
    });
  });

  it('cleans a specific build cache key when force is enabled', async () => {
    coreMocks.clearBuildCache.mockReturnValue(1);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await cacheCleanCommand('abc', { force: true });

    expect(coreMocks.clearBuildCache).toHaveBeenCalledWith(process.cwd(), 'abc');
    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Removed 1 build cache entry.');
  });

  it('falls through to the deps cache when the key is not in build cache', async () => {
    coreMocks.clearBuildCache.mockReturnValue(0);
    coreMocks.clearDepsCache.mockReturnValue(1);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await cacheCleanCommand('ripgrep-def', { force: true });

    expect(coreMocks.clearBuildCache).toHaveBeenCalledWith(process.cwd(), 'ripgrep-def');
    expect(coreMocks.clearDepsCache).toHaveBeenCalledWith(process.cwd(), 'ripgrep-def');
    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Removed 1 deps cache entry.');
  });

  it('prune removes both caches', async () => {
    coreMocks.clearBuildCache.mockReturnValue(3);
    coreMocks.clearDepsCache.mockReturnValue(2);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await cacheCleanCommand(undefined, { force: true });

    expect(coreMocks.clearBuildCache).toHaveBeenCalledWith(process.cwd());
    expect(coreMocks.clearDepsCache).toHaveBeenCalledWith(process.cwd());
    const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Removed 3 build cache entries and 2 deps cache entries.');
  });
});

