// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for v1 agent source resolution.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock the host child-process layer so the security tests can assert exactly how
// git/npm/curl are invoked (argv arrays, no shell) without spawning them.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import {
  generateSourceCacheKey,
  isSourceCached,
  getCachedSourcePath,
  getSourcesDir,
  clearSourceCache,
  listCachedSources,
  resolveAgentSource,
} from './sources.js';
import type { InstallSource } from '@bunsen-dev/types';
import type { ResolvedAgent } from './agent-loader.js';

const mockExecFileSync = vi.mocked(execFileSync);

function makeAgent(
  overrides: Partial<ResolvedAgent> & Pick<ResolvedAgent, 'install'>
): ResolvedAgent {
  const { install, ...rest } = overrides;
  return {
    version: 'v1',
    name: 'test-agent',
    install,
    entrypoint: { command: 'python', args: ['main.py'] },
    interaction: { mode: 'direct' },
    path: '/path/to/agent',
    configPath: '/path/to/agent/agent.yaml',
    ...rest,
  };
}

describe('generateSourceCacheKey', () => {
  it('generates key for git source', () => {
    const source: InstallSource = { type: 'git', repo: 'https://github.com/user/repo.git' };
    const key = generateSourceCacheKey(source);
    expect(key).toHaveLength(12);
    expect(key).toMatch(/^[a-f0-9]+$/);
  });

  it('generates different keys for different refs', () => {
    const a: InstallSource = { type: 'git', repo: 'https://github.com/user/repo.git', ref: 'main' };
    const b: InstallSource = {
      type: 'git',
      repo: 'https://github.com/user/repo.git',
      ref: 'develop',
    };
    expect(generateSourceCacheKey(a)).not.toBe(generateSourceCacheKey(b));
  });

  it('generates key for npm source', () => {
    const source: InstallSource = { type: 'npm', package: '@example/agent' };
    const key = generateSourceCacheKey(source);
    expect(key).toHaveLength(12);
  });

  it('generates different keys for different versions', () => {
    const unversioned: InstallSource = { type: 'npm', package: '@example/agent' };
    const versioned: InstallSource = { type: 'npm', package: '@example/agent', version: '1.0.0' };
    expect(generateSourceCacheKey(unversioned)).not.toBe(generateSourceCacheKey(versioned));
  });

  it('generates key for binary source', () => {
    const source: InstallSource = {
      type: 'binary',
      url: 'https://example.com/agent',
    };
    const key = generateSourceCacheKey(source);
    expect(key).toHaveLength(12);
  });

  it('returns "local" for local source', () => {
    const source: InstallSource = { type: 'local' };
    expect(generateSourceCacheKey(source)).toBe('local');
  });
});

describe('cache utilities', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('getSourcesDir returns correct path', () => {
    expect(getSourcesDir(tempDir)).toBe(path.join(tempDir, '.bunsen', 'sources'));
  });

  it('getCachedSourcePath returns correct path', () => {
    const cachePath = getCachedSourcePath('abc123', tempDir);
    expect(cachePath).toBe(path.join(tempDir, '.bunsen', 'sources', 'abc123'));
  });

  it('isSourceCached returns false for non-existent cache', () => {
    expect(isSourceCached('nonexistent', tempDir)).toBe(false);
  });

  it('isSourceCached returns true for local', () => {
    expect(isSourceCached('local', tempDir)).toBe(true);
  });

  it('isSourceCached returns true when cache exists with agent.yaml', () => {
    const cacheDir = path.join(tempDir, '.bunsen', 'sources', 'test123');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'agent.yaml'), 'name: test');
    expect(isSourceCached('test123', tempDir)).toBe(true);
  });

  it('isSourceCached returns false when cache exists without agent.yaml', () => {
    const cacheDir = path.join(tempDir, '.bunsen', 'sources', 'test456');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'other.txt'), 'content');
    expect(isSourceCached('test456', tempDir)).toBe(false);
  });

  it('clearSourceCache removes all cached sources', () => {
    const sourcesDir = path.join(tempDir, '.bunsen', 'sources');
    fs.mkdirSync(path.join(sourcesDir, 'cache1'), { recursive: true });
    fs.mkdirSync(path.join(sourcesDir, 'cache2'), { recursive: true });
    clearSourceCache(tempDir);
    expect(fs.existsSync(sourcesDir)).toBe(false);
  });

  it('listCachedSources returns empty array when no cache', () => {
    expect(listCachedSources(tempDir)).toEqual([]);
  });

  it('listCachedSources returns cached directories', () => {
    const sourcesDir = path.join(tempDir, '.bunsen', 'sources');
    fs.mkdirSync(path.join(sourcesDir, 'cache1'), { recursive: true });
    fs.mkdirSync(path.join(sourcesDir, 'cache2'), { recursive: true });
    const cached = listCachedSources(tempDir);
    expect(cached).toHaveLength(2);
    expect(cached).toContain('cache1');
    expect(cached).toContain('cache2');
  });
});

describe('resolveAgentSource', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns original path for local source', async () => {
    const agent = makeAgent({
      install: { source: { type: 'local' } },
    });
    const result = await resolveAgentSource(agent, tempDir);
    expect(result).toBe('/path/to/agent');
  });

  it('uses cached source if available', async () => {
    const source: InstallSource = {
      type: 'git',
      repo: 'https://example.com/repo.git',
    };
    const agent = makeAgent({ install: { source } });

    // Pre-populate the cache.
    const cacheKey = generateSourceCacheKey(source);
    const cacheDir = getCachedSourcePath(cacheKey, tempDir);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'agent.yaml'), 'name: cached-agent');

    const result = await resolveAgentSource(agent, tempDir);
    expect(result).toBe(cacheDir);
  });

  it('uses the variant-applied source.ref to pick a different cache entry', async () => {
    const defaultSource: InstallSource = {
      type: 'git',
      repo: 'https://example.com/repo.git',
    };
    const variantSource: InstallSource = {
      type: 'git',
      repo: 'https://example.com/repo.git',
      ref: 'feature-branch',
    };

    const defaultKey = generateSourceCacheKey(defaultSource);
    const variantKey = generateSourceCacheKey(variantSource);
    expect(defaultKey).not.toBe(variantKey);

    const defaultCache = getCachedSourcePath(defaultKey, tempDir);
    const variantCache = getCachedSourcePath(variantKey, tempDir);
    fs.mkdirSync(defaultCache, { recursive: true });
    fs.writeFileSync(path.join(defaultCache, 'agent.yaml'), 'name: default');
    fs.mkdirSync(variantCache, { recursive: true });
    fs.writeFileSync(path.join(variantCache, 'agent.yaml'), 'name: variant');

    const base = makeAgent({ install: { source: defaultSource } });
    const variant = makeAgent({ install: { source: variantSource }, variant: 'experimental' });

    expect(await resolveAgentSource(base, tempDir)).toBe(defaultCache);
    expect(await resolveAgentSource(variant, tempDir)).toBe(variantCache);
  });
});

describe('resolveAgentSource — host-side resolution hardening', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-test-'));
    mockExecFileSync.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('git sources', () => {
    it('rejects a shell-injection ref instead of executing it', async () => {
      const marker = path.join(tempDir, 'pwned');
      const agent = makeAgent({
        install: {
          source: {
            type: 'git',
            repo: 'https://example.com/repo.git',
            ref: `main; touch ${marker} #`,
          },
        },
      });

      await expect(resolveAgentSource(agent, tempDir)).rejects.toThrow(/invalid git ref/i);
      // Nothing was ever spawned, so nothing could have run.
      expect(mockExecFileSync).not.toHaveBeenCalled();
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('rejects an ext:: transport repo URL (git remote-helper RCE vector)', async () => {
      const agent = makeAgent({
        install: { source: { type: 'git', repo: "ext::sh -c 'touch /tmp/pwned'" } },
      });

      await expect(resolveAgentSource(agent, tempDir)).rejects.toThrow(
        /unsupported or unsafe git repo/i
      );
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('clones a valid source via an argv array (no shell string)', async () => {
      const source: InstallSource = {
        type: 'git',
        repo: 'https://example.com/repo.git',
        ref: 'main',
      };
      const cacheDir = getCachedSourcePath(generateSourceCacheKey(source), tempDir);
      const agent = makeAgent({ install: { source } });

      const result = await resolveAgentSource(agent, tempDir);

      expect(result).toBe(cacheDir);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        [
          'clone',
          '--depth',
          '1',
          '--branch',
          'main',
          '--',
          'https://example.com/repo.git',
          cacheDir,
        ],
        expect.objectContaining({ stdio: 'pipe' })
      );
    });

    it('accepts an scp-style remote but rejects the look-alike double-colon helper', async () => {
      const scp = makeAgent({
        install: { source: { type: 'git', repo: 'git@github.com:user/repo.git' } },
      });
      await expect(resolveAgentSource(scp, tempDir)).resolves.toBeTypeOf('string');

      const helper = makeAgent({
        install: { source: { type: 'git', repo: 'fd::17' } },
      });
      await expect(resolveAgentSource(helper, tempDir)).rejects.toThrow(
        /unsupported or unsafe git repo/i
      );
    });
  });

  describe('npm sources', () => {
    function simulateNpmInstall(installedPackage: string): void {
      mockExecFileSync.mockImplementation(((
        _file: string,
        _args: string[],
        opts: { cwd: string }
      ) => {
        const segments = installedPackage.startsWith('@')
          ? installedPackage.split('/')
          : [installedPackage];
        const pkgDir = path.join(opts.cwd, 'node_modules', ...segments);
        fs.mkdirSync(pkgDir, { recursive: true });
        fs.writeFileSync(path.join(pkgDir, 'agent.yaml'), 'name: installed-agent');
        return Buffer.from('');
      }) as unknown as typeof execFileSync);
    }

    it('installs with --ignore-scripts so a postinstall cannot run on the host', async () => {
      simulateNpmInstall('example-agent');
      const agent = makeAgent({ install: { source: { type: 'npm', package: 'example-agent' } } });

      await resolveAgentSource(agent, tempDir);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'npm',
        expect.arrayContaining(['install', '--ignore-scripts', 'example-agent']),
        expect.objectContaining({ stdio: 'pipe' })
      );
    });

    it('passes a scoped package@version as a single argv token', async () => {
      simulateNpmInstall('@example/agent');
      const agent = makeAgent({
        install: { source: { type: 'npm', package: '@example/agent', version: '1.2.3' } },
      });

      await resolveAgentSource(agent, tempDir);

      const [, args] = mockExecFileSync.mock.calls[0];
      expect(args).toContain('@example/agent@1.2.3');
      expect(args).toContain('--ignore-scripts');
    });

    it('rejects a package name with shell metacharacters', async () => {
      const agent = makeAgent({
        install: { source: { type: 'npm', package: 'pkg; rm -rf /' } },
      });
      await expect(resolveAgentSource(agent, tempDir)).rejects.toThrow(/invalid npm package/i);
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('rejects an injection in the version specifier', async () => {
      const agent = makeAgent({
        install: { source: { type: 'npm', package: 'example-agent', version: '1.0.0 && touch x' } },
      });
      await expect(resolveAgentSource(agent, tempDir)).rejects.toThrow(/invalid npm version/i);
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });
  });

  describe('binary sources', () => {
    it('downloads via an argv array with curl pinned to http(s)', async () => {
      mockExecFileSync.mockImplementation(((
        _file: string,
        _args: string[],
        opts: { cwd: string }
      ) => {
        fs.writeFileSync(path.join(opts.cwd, 'agent-binary'), 'binary');
        return Buffer.from('');
      }) as unknown as typeof execFileSync);

      const agent = makeAgent({
        install: { source: { type: 'binary', url: 'https://example.com/agent' } },
      });

      await resolveAgentSource(agent, tempDir);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'curl',
        [
          '-fsSL',
          '--proto',
          '=http,https',
          '--proto-redir',
          '=http,https',
          '-o',
          'agent-binary',
          'https://example.com/agent',
        ],
        expect.objectContaining({ stdio: 'pipe' })
      );
    });

    it('rejects a non-http(s) binary URL', async () => {
      const agent = makeAgent({
        install: { source: { type: 'binary', url: 'file:///etc/passwd' } },
      });
      await expect(resolveAgentSource(agent, tempDir)).rejects.toThrow(/only http\(s\)/i);
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('rejects a malformed binary URL', async () => {
      const agent = makeAgent({
        install: { source: { type: 'binary', url: 'not a url' } },
      });
      await expect(resolveAgentSource(agent, tempDir)).rejects.toThrow(
        /invalid binary source url/i
      );
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });
  });
});
