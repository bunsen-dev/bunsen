// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for environment variable utilities
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  parseEnvContent,
  parseEnvFile,
  parseEnvFlag,
  parseEnvFlags,
  loadEnvFromSources,
  loadProjectEnv,
  mergeRunEnvironment,
  type RunEnvSource,
} from './env.js';
import { clearProjectCache } from './project-loader.js';

describe('parseEnvContent', () => {
  it('parses simple KEY=value pairs', () => {
    const content = `
FOO=bar
BAZ=qux
`;
    expect(parseEnvContent(content)).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('ignores comments and empty lines', () => {
    const content = `
# This is a comment
FOO=bar

# Another comment
BAZ=qux
`;
    expect(parseEnvContent(content)).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('handles quoted values', () => {
    const content = `
DOUBLE="hello world"
SINGLE='hello world'
`;
    expect(parseEnvContent(content)).toEqual({
      DOUBLE: 'hello world',
      SINGLE: 'hello world',
    });
  });

  it('handles inline comments for unquoted values', () => {
    const content = `
FOO=bar # this is a comment
BAZ=qux
`;
    expect(parseEnvContent(content)).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('preserves inline content in quoted values', () => {
    const content = `
FOO="bar # not a comment"
`;
    expect(parseEnvContent(content)).toEqual({
      FOO: 'bar # not a comment',
    });
  });

  it('handles empty values', () => {
    const content = `
EMPTY=
`;
    expect(parseEnvContent(content)).toEqual({
      EMPTY: '',
    });
  });

  it('handles values with equals signs', () => {
    const content = `
URL=https://example.com?foo=bar
`;
    expect(parseEnvContent(content)).toEqual({
      URL: 'https://example.com?foo=bar',
    });
  });

  it('skips invalid key names', () => {
    const content = `
VALID=yes
123INVALID=no
-ALSO-INVALID=no
valid_underscore=yes
`;
    expect(parseEnvContent(content)).toEqual({
      VALID: 'yes',
      valid_underscore: 'yes',
    });
  });
});

describe('parseEnvFile', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-env-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true });
  });

  it('parses a .env file', () => {
    const envPath = path.join(tempDir, '.env');
    fs.writeFileSync(envPath, 'FOO=bar\nBAZ=qux\n');

    expect(parseEnvFile(envPath)).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('throws for non-existent file', () => {
    expect(() => parseEnvFile('/nonexistent/.env')).toThrow('not found');
  });
});

describe('parseEnvFlag', () => {
  it('parses VAR=value format', () => {
    expect(parseEnvFlag('FOO=bar')).toEqual({ key: 'FOO', value: 'bar' });
  });

  it('handles empty value', () => {
    expect(parseEnvFlag('FOO=')).toEqual({ key: 'FOO', value: '' });
  });

  it('handles value with equals signs', () => {
    expect(parseEnvFlag('URL=https://example.com?foo=bar')).toEqual({
      key: 'URL',
      value: 'https://example.com?foo=bar',
    });
  });

  it('passes through host env var when no =', () => {
    const originalEnv = process.env.TEST_VAR;
    process.env.TEST_VAR = 'host-value';

    expect(parseEnvFlag('TEST_VAR')).toEqual({ key: 'TEST_VAR', value: 'host-value' });

    if (originalEnv === undefined) {
      delete process.env.TEST_VAR;
    } else {
      process.env.TEST_VAR = originalEnv;
    }
  });

  it('returns null for unset host env var', () => {
    delete process.env.DEFINITELY_NOT_SET_VAR;
    expect(parseEnvFlag('DEFINITELY_NOT_SET_VAR')).toBeNull();
  });

  it('returns null for empty key', () => {
    expect(parseEnvFlag('=value')).toBeNull();
  });
});

describe('parseEnvFlags', () => {
  it('parses multiple flags', () => {
    expect(parseEnvFlags(['FOO=bar', 'BAZ=qux'])).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('later flags override earlier ones', () => {
    expect(parseEnvFlags(['FOO=first', 'FOO=second'])).toEqual({
      FOO: 'second',
    });
  });
});

describe('loadEnvFromSources', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-env-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true });
  });

  it('loads multiple env files in order', () => {
    const file1 = path.join(tempDir, 'base.env');
    const file2 = path.join(tempDir, 'override.env');
    fs.writeFileSync(file1, 'A=base\nB=base\n');
    fs.writeFileSync(file2, 'B=override\nC=override\n');

    expect(loadEnvFromSources({ envFiles: [file1, file2] })).toEqual({
      A: 'base',
      B: 'override',
      C: 'override',
    });
  });

  it('env flags override files', () => {
    const file = path.join(tempDir, 'base.env');
    fs.writeFileSync(file, 'A=file\nB=file\n');

    expect(
      loadEnvFromSources({
        envFiles: [file],
        envFlags: ['B=flag', 'C=flag'],
      }),
    ).toEqual({
      A: 'file',
      B: 'flag',
      C: 'flag',
    });
  });

  it('rejects reserved BUNSEN_* env keys from CLI flags', () => {
    expect(() => loadEnvFromSources({ envFlags: ['BUNSEN_RUN_ID=nope'] })).toThrow(/reserved/);
  });

  it('rejects reserved BUNSEN_* keys from env files', () => {
    const file = path.join(tempDir, '.env');
    fs.writeFileSync(file, 'BUNSEN_PLATFORM=linux/amd64\n');
    expect(() => loadEnvFromSources({ envFiles: [file] })).toThrow(/reserved/);
  });

  it('returns empty when given no sources', () => {
    expect(loadEnvFromSources({})).toEqual({});
  });
});

describe('loadProjectEnv', () => {
  let tempDir: string;
  let originalCwd: string;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    originalCwd = process.cwd();

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-project-env-test-'));
    fs.mkdirSync(path.join(tempDir, '.git'));

    process.chdir(tempDir);

    clearProjectCache();
  });

  afterEach(() => {
    process.chdir(originalCwd);

    fs.rmSync(tempDir, { recursive: true });

    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    clearProjectCache();
  });

  it('loads env files declared in bunsen.config.yaml defaults.envFiles', () => {
    originalEnv['TEST_PROJECT_VAR'] = process.env.TEST_PROJECT_VAR;
    delete process.env.TEST_PROJECT_VAR;

    fs.writeFileSync(
      path.join(tempDir, 'bunsen.config.yaml'),
      `version: v1\ndefaults:\n  envFiles:\n    - .env\n`,
    );
    fs.writeFileSync(path.join(tempDir, '.env'), 'TEST_PROJECT_VAR=from_project\n');

    const loaded = loadProjectEnv();

    expect(loaded).toEqual({ TEST_PROJECT_VAR: 'from_project' });
    // bun-types narrows unknown process.env keys to `undefined`; widen for the
    // assertion (the var is set above and present at runtime).
    expect(process.env.TEST_PROJECT_VAR as string | undefined).toBe('from_project');
  });

  it('returns empty when no bunsen.config.yaml is present', () => {
    // Even with a .env at project root, nothing is auto-loaded without a
    // bunsen.config.yaml opting in via defaults.envFiles.
    fs.writeFileSync(path.join(tempDir, '.env'), 'SHOULD_NOT_LOAD=implicit\n');

    const loaded = loadProjectEnv();
    expect(loaded).toEqual({});
    expect(process.env.SHOULD_NOT_LOAD).toBeUndefined();
  });

  it('returns empty when envFiles is not declared', () => {
    fs.writeFileSync(
      path.join(tempDir, 'bunsen.config.yaml'),
      `version: v1\nname: no-env-files\n`,
    );
    fs.writeFileSync(path.join(tempDir, '.env'), 'SHOULD_NOT_LOAD=no\n');

    const loaded = loadProjectEnv();
    expect(loaded).toEqual({});
    expect(process.env.SHOULD_NOT_LOAD).toBeUndefined();
  });

  it('does not override existing env vars', () => {
    originalEnv['TEST_EXISTING_VAR'] = process.env.TEST_EXISTING_VAR;
    process.env.TEST_EXISTING_VAR = 'existing_value';

    fs.writeFileSync(
      path.join(tempDir, 'bunsen.config.yaml'),
      `version: v1\ndefaults:\n  envFiles:\n    - .env\n`,
    );
    fs.writeFileSync(path.join(tempDir, '.env'), 'TEST_EXISTING_VAR=new_value\n');

    const loaded = loadProjectEnv();

    expect(loaded).toEqual({ TEST_EXISTING_VAR: 'new_value' });
    expect(process.env.TEST_EXISTING_VAR).toBe('existing_value');
  });

  it('silently skips envFiles that do not exist', () => {
    fs.writeFileSync(
      path.join(tempDir, 'bunsen.config.yaml'),
      `version: v1\ndefaults:\n  envFiles:\n    - .env\n    - missing.env\n`,
    );
    fs.writeFileSync(path.join(tempDir, '.env'), 'FROM_REAL=yes\n');

    delete process.env.FROM_REAL;

    const loaded = loadProjectEnv();
    expect(loaded).toEqual({ FROM_REAL: 'yes' });
  });
});

describe('mergeRunEnvironment (8-source order)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-merge-env-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true });
  });

  function sources(record: Record<string, RunEnvSource['env']>): RunEnvSource[] {
    return Object.entries(record).map(([label, env]) => ({ label, env }));
  }

  it('applies sources in order — later slots win over earlier ones', () => {
    const merged = mergeRunEnvironment({
      sources: [
        { label: 'project', env: { SHARED: '1-project', A: 'project' } },
        { label: 'agent', env: { SHARED: '2-agent', B: 'agent' } },
        { label: 'experiment', env: { SHARED: '3-experiment', C: 'experiment' } },
        { label: 'agent-variant', env: { SHARED: '4-agent-var' } },
        { label: 'experiment-variant', env: { SHARED: '5-experiment-var' } },
      ],
    });
    expect(merged).toEqual({
      A: 'project',
      B: 'agent',
      C: 'experiment',
      SHARED: '5-experiment-var',
    });
  });

  it('CLI --env-file wins over all 5 config sources', () => {
    const file = path.join(tempDir, 'base.env');
    fs.writeFileSync(file, 'SHARED=6-env-file\n');
    const merged = mergeRunEnvironment({
      sources: sources({
        project: { SHARED: '1' },
        agent: { SHARED: '2' },
      }),
      cliEnvFiles: [file],
    });
    expect(merged.SHARED).toBe('6-env-file');
  });

  it('CLI --env wins over CLI --env-file', () => {
    const file = path.join(tempDir, 'base.env');
    fs.writeFileSync(file, 'SHARED=file\n');
    const merged = mergeRunEnvironment({
      cliEnvFiles: [file],
      cliEnvFlags: ['SHARED=flag'],
    });
    expect(merged.SHARED).toBe('flag');
  });

  it('reserved BUNSEN_* wins over everything and must use the BUNSEN_ prefix', () => {
    const merged = mergeRunEnvironment({
      sources: sources({ project: { OTHER: 'x' } }),
      reserved: { BUNSEN_RUN_ID: 'abc123', BUNSEN_WORKSPACE_DIR: '/workspace' },
    });
    expect(merged.BUNSEN_RUN_ID).toBe('abc123');
    expect(merged.BUNSEN_WORKSPACE_DIR).toBe('/workspace');
    expect(merged.OTHER).toBe('x');
  });

  it('throws when a user source tries to set a BUNSEN_* key', () => {
    expect(() =>
      mergeRunEnvironment({
        sources: [{ label: 'agent defaults', env: { BUNSEN_TASK_FILE: '/x' } }],
        reserved: { BUNSEN_RUN_ID: 'r' },
      }),
    ).toThrow(/reserved/);
  });

  it('throws when reserved contains a non-BUNSEN_ key (developer mistake)', () => {
    expect(() =>
      mergeRunEnvironment({ reserved: { PLAIN_KEY: 'x' } }),
    ).toThrow(/does not use the BUNSEN_ prefix/);
  });

  it('host passthrough via passEnv is weakest — user sources win', () => {
    const merged = mergeRunEnvironment({
      sources: [
        { label: 'project', passEnv: ['HOST_KEY'] },
        { label: 'agent', env: { HOST_KEY: 'from-agent' } },
      ],
      hostEnv: { HOST_KEY: 'from-host' },
    });
    expect(merged.HOST_KEY).toBe('from-agent');
  });

  it('passEnv pulls from host when no user source sets the key', () => {
    const merged = mergeRunEnvironment({
      sources: [{ label: 'agent', passEnv: ['ONLY_HOST'] }],
      hostEnv: { ONLY_HOST: 'value' },
    });
    expect(merged.ONLY_HOST).toBe('value');
  });

  it('passEnv silently drops host entries that are unset', () => {
    const merged = mergeRunEnvironment({
      sources: [{ label: 'agent', passEnv: ['NOT_ON_HOST'] }],
      hostEnv: {},
    });
    expect(merged.NOT_ON_HOST).toBeUndefined();
  });

  it('CLI --pass-env contributes to the passEnv allowlist', () => {
    const merged = mergeRunEnvironment({
      cliPassEnv: ['CLI_ONLY'],
      hostEnv: { CLI_ONLY: 'from-host' },
    });
    expect(merged.CLI_ONLY).toBe('from-host');
  });

  it('deduplicates passEnv across sources', () => {
    const merged = mergeRunEnvironment({
      sources: [
        { label: 'project', passEnv: ['DUP'] },
        { label: 'agent', passEnv: ['DUP'] },
      ],
      cliPassEnv: ['DUP'],
      hostEnv: { DUP: 'once' },
    });
    expect(merged.DUP).toBe('once');
  });

  it('rejects a passEnv entry in the reserved BUNSEN_ namespace', () => {
    expect(() =>
      mergeRunEnvironment({
        sources: [{ label: 'agent', passEnv: ['BUNSEN_RUN_ID'] }],
        hostEnv: { BUNSEN_RUN_ID: 'x' },
      }),
    ).toThrow(/reserved/);
  });

  it('covers all 8 sources end-to-end in precedence order', () => {
    const envFile = path.join(tempDir, 'cli.env');
    fs.writeFileSync(envFile, 'S=6-env-file\n');

    const merged = mergeRunEnvironment({
      sources: [
        { label: 'project', env: { S: '1-project' }, passEnv: ['HOST_KEY'] },
        { label: 'agent', env: { S: '2-agent' } },
        { label: 'experiment', env: { S: '3-experiment' } },
        { label: 'agent-variant', env: { S: '4-agent-variant' } },
        { label: 'experiment-variant', env: { S: '5-experiment-variant' } },
      ],
      cliEnvFiles: [envFile],
      cliEnvFlags: ['S=7-cli-env'],
      reserved: { BUNSEN_RUN_ID: '8-reserved' },
      hostEnv: { HOST_KEY: '0-host' },
    });

    // Host passthrough is weakest: its value survives because no user source overrides HOST_KEY.
    expect(merged.HOST_KEY).toBe('0-host');
    // Each later source wins for S.
    expect(merged.S).toBe('7-cli-env');
    // Reserved wins independently.
    expect(merged.BUNSEN_RUN_ID).toBe('8-reserved');
  });
});
