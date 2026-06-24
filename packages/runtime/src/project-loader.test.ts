// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for `bunsen.config.yaml` v1 parser and project discovery.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  parseProjectConfig,
  loadProject,
  findProjectRoot,
  resolveStoragePaths,
  getExperimentSearchPaths,
  getAgentSearchPaths,
  clearProjectCache,
  assertNoReservedEnvKeys,
  isReservedEnvKey,
  ProjectConfigError,
} from './project-loader.js';

function mkTemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-project-test-'));
}

describe('parseProjectConfig', () => {
  it('accepts the minimal v1 config', () => {
    const cfg = parseProjectConfig('version: v1\n');
    expect(cfg).toEqual({ version: 'v1' });
  });

  it('parses the full v1 shape from the design doc', () => {
    const src = `
$schema: https://schemas.bunsen.dev/project.v1.json
version: v1
name: agent-lab

paths:
  experiments:
    - examples/experiments
    - suites/terminal-bench
  agents:
    - examples/agents
  precedence: local

suites:
  - source:
      type: git
      url: https://github.com/cursiv/terminal-bench.git
      ref: v2.1.0
    as: terminal-bench
    cacheDir: .bunsen/suites/terminal-bench

storage:
  root: .bunsen

defaults:
  run:
    timeout: 15m
    platform: auto
    capture:
      traces: true
      recording: false
    supervisor:
      stallTimeout: 5s
      maxCheckInterval: 30s
  env:
    NODE_ENV: development
  passEnv:
    - ANTHROPIC_API_KEY
    - OPENAI_API_KEY
  envFiles:
    - .env

registries:
  images:
    headless: bunsen/headless
    browser: bunsen/visual
`;
    const cfg = parseProjectConfig(src);
    expect(cfg.name).toBe('agent-lab');
    expect(cfg.paths).toEqual({
      experiments: ['examples/experiments', 'suites/terminal-bench'],
      agents: ['examples/agents'],
      precedence: 'local',
    });
    expect(cfg.suites?.[0]).toEqual({
      source: {
        type: 'git',
        url: 'https://github.com/cursiv/terminal-bench.git',
        ref: 'v2.1.0',
      },
      as: 'terminal-bench',
      cacheDir: '.bunsen/suites/terminal-bench',
    });
    expect(cfg.storage).toEqual({ root: '.bunsen' });
    expect(cfg.defaults?.run?.timeout).toBe('15m');
    expect(cfg.defaults?.run?.platform).toBe('auto');
    expect(cfg.defaults?.run?.capture).toEqual({ traces: true, recording: false });
    expect(cfg.defaults?.run?.supervisor).toEqual({
      stallTimeout: '5s',
      maxCheckInterval: '30s',
    });
    expect(cfg.defaults?.env).toEqual({ NODE_ENV: 'development' });
    expect(cfg.defaults?.passEnv).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
    expect(cfg.defaults?.envFiles).toEqual(['.env']);
    expect(cfg.registries?.images).toEqual({
      headless: 'bunsen/headless',
      browser: 'bunsen/visual',
    });
  });

  it('rejects missing version', () => {
    expect(() => parseProjectConfig('name: foo\n')).toThrow(/version/);
  });

  it('rejects empty file', () => {
    expect(() => parseProjectConfig('')).toThrow(ProjectConfigError);
  });

  it('rejects legacy top-level experiments key with migration hint', () => {
    const src = `version: v1\nexperiments:\n  - examples/experiments\n`;
    expect(() => parseProjectConfig(src)).toThrow(/paths\.experiments/);
  });

  it('rejects legacy top-level agents key with migration hint', () => {
    const src = `version: v1\nagents:\n  - examples/agents\n`;
    expect(() => parseProjectConfig(src)).toThrow(/paths\.agents/);
  });

  it('rejects unknown root-level field', () => {
    const src = `version: v1\nbogus: true\n`;
    expect(() => parseProjectConfig(src)).toThrow(/unknown field 'bogus'/);
  });

  it('rejects reserved BUNSEN_* env override in defaults.env', () => {
    const src = `version: v1\ndefaults:\n  env:\n    BUNSEN_RUN_ID: hacked\n`;
    expect(() => parseProjectConfig(src)).toThrow(/reserved/);
  });

  it('rejects reserved BUNSEN_* in defaults.passEnv', () => {
    const src = `version: v1\ndefaults:\n  passEnv:\n    - BUNSEN_PLATFORM\n`;
    expect(() => parseProjectConfig(src)).toThrow(/reserved/);
  });

  it('rejects duplicate passEnv entries', () => {
    const src = `version: v1\ndefaults:\n  passEnv:\n    - FOO\n    - FOO\n`;
    expect(() => parseProjectConfig(src)).toThrow(/duplicate/);
  });

  it('rejects absolute envFiles paths', () => {
    const src = `version: v1\ndefaults:\n  envFiles:\n    - /etc/env\n`;
    expect(() => parseProjectConfig(src)).toThrow(/project root/);
  });

  it('rejects envFiles paths that escape the project root', () => {
    const src = `version: v1\ndefaults:\n  envFiles:\n    - ../outside.env\n`;
    expect(() => parseProjectConfig(src)).toThrow(/escape/);
  });

  it('rejects legacy id field with migration hint', () => {
    const src =
      `version: v1\nsuites:\n  - id: terminal-bench\n    source:\n      type: git\n      url: https://x\n`;
    expect(() => parseProjectConfig(src)).toThrow(/derived from the source URL/);
  });

  it('rejects invalid suite alias pattern', () => {
    const src =
      `version: v1\nsuites:\n  - source:\n      type: git\n      url: https://x\n    as: Bad_Alias\n`;
    expect(() => parseProjectConfig(src)).toThrow(/kebab-case/);
  });

  it('rejects duplicate suite aliases', () => {
    const src =
      `version: v1\nsuites:\n  - source:\n      type: git\n      url: https://x\n    as: a\n  - source:\n      type: git\n      url: https://y\n    as: a\n`;
    expect(() => parseProjectConfig(src)).toThrow(/duplicate suite alias/);
  });

  it('rejects duplicate suite source URLs', () => {
    const src =
      `version: v1\nsuites:\n  - source:\n      type: git\n      url: https://x\n  - source:\n      type: git\n      url: https://x\n`;
    expect(() => parseProjectConfig(src)).toThrow(/duplicate suite source/);
  });

  it('rejects unknown suite source type', () => {
    const src =
      `version: v1\nsuites:\n  - source:\n      type: svn\n      url: https://x\n`;
    expect(() => parseProjectConfig(src)).toThrow(/'git'/);
  });

  it('rejects invalid platform', () => {
    const src = `version: v1\ndefaults:\n  run:\n    platform: windows\n`;
    expect(() => parseProjectConfig(src)).toThrow(/auto/);
  });

  it('rejects non-duration timeout', () => {
    const src = `version: v1\ndefaults:\n  run:\n    timeout: 15\n`;
    expect(() => parseProjectConfig(src)).toThrow(/duration/);
  });

  it('rejects invalid paths.precedence enum', () => {
    const src = `version: v1\npaths:\n  precedence: neither\n`;
    expect(() => parseProjectConfig(src)).toThrow(/local/);
  });

  it('reserves the top-level `remote:` namespace with a warning, not an error', () => {
    const src = `version: v1\nremote:\n  provider: bunsen-cloud\n  region: us-east-1\n`;
    const warnings: Array<{ code: string; message: string; path?: string }> = [];
    const cfg = parseProjectConfig(src, { warnings });
    expect(cfg.remote).toEqual({ provider: 'bunsen-cloud', region: 'us-east-1' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('project.remote.reserved');
    expect(warnings[0].path).toBe('remote');
    expect(warnings[0].message).toMatch(/reserved/i);
  });

  it('rejects a non-mapping `remote:` value', () => {
    const src = `version: v1\nremote: true\n`;
    expect(() => parseProjectConfig(src)).toThrow(/remote must be a mapping/);
  });
});

describe('findProjectRoot', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkTemp();
    clearProjectCache();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('prefers bunsen.config.yaml over .git when both exist', () => {
    // Nested .git lives at tempDir, but bunsen.config.yaml lives in a
    // subdirectory. The bunsen.config.yaml should win.
    fs.mkdirSync(path.join(tempDir, '.git'));
    const sub = path.join(tempDir, 'inner');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'bunsen.config.yaml'), 'version: v1\n');

    const deeper = path.join(sub, 'deep', 'deeper');
    fs.mkdirSync(deeper, { recursive: true });

    expect(findProjectRoot(deeper)).toBe(sub);
  });

  it('falls back to nearest .git when no bunsen.config.yaml', () => {
    fs.mkdirSync(path.join(tempDir, '.git'));
    const sub = path.join(tempDir, 'nested');
    fs.mkdirSync(sub, { recursive: true });

    expect(findProjectRoot(sub)).toBe(tempDir);
  });

  it('returns startDir when neither marker is found', () => {
    const sub = path.join(tempDir, 'solo');
    fs.mkdirSync(sub, { recursive: true });
    expect(findProjectRoot(sub)).toBe(sub);
  });

  it('does NOT treat package.json as a project marker', () => {
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
    const sub = path.join(tempDir, 'src');
    fs.mkdirSync(sub, { recursive: true });
    // With only package.json present, no marker is found — startDir wins.
    expect(findProjectRoot(sub)).toBe(sub);
  });
});

describe('resolveStoragePaths', () => {
  it('defaults to .bunsen under the project root', () => {
    const paths = resolveStoragePaths('/proj', { version: 'v1' });
    expect(paths.root).toBe(path.resolve('/proj/.bunsen'));
    expect(paths.runs).toBe(path.resolve('/proj/.bunsen/runs'));
    expect(paths.cache).toBe(path.resolve('/proj/.bunsen/cache'));
    expect(paths.suites).toBe(path.resolve('/proj/.bunsen/suites'));
    expect(paths.indexDb).toBe(path.resolve('/proj/.bunsen/index.sqlite'));
  });

  it('honors storage.root override (relative)', () => {
    const paths = resolveStoragePaths('/proj', {
      version: 'v1',
      storage: { root: 'custom-store' },
    });
    expect(paths.root).toBe(path.resolve('/proj/custom-store'));
    expect(paths.runs).toBe(path.resolve('/proj/custom-store/runs'));
  });

  it('honors storage.root override (absolute)', () => {
    const paths = resolveStoragePaths('/proj', {
      version: 'v1',
      storage: { root: '/abs/store' },
    });
    expect(paths.root).toBe(path.resolve('/abs/store'));
  });
});

describe('loadProject', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkTemp();
    clearProjectCache();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns a default config and resolved storage when no bunsen.config.yaml exists', () => {
    fs.mkdirSync(path.join(tempDir, '.git'));
    const project = loadProject(tempDir);

    expect(project.root).toBe(tempDir);
    expect(project.configPath).toBeUndefined();
    expect(project.config).toEqual({ version: 'v1' });
    expect(project.storage.root).toBe(path.join(tempDir, '.bunsen'));
    expect(project.storage.runs).toBe(path.join(tempDir, '.bunsen', 'runs'));
  });

  it('loads and validates bunsen.config.yaml', () => {
    fs.writeFileSync(
      path.join(tempDir, 'bunsen.config.yaml'),
      `version: v1\nname: my-project\npaths:\n  experiments:\n    - custom/experiments\n`,
    );
    const project = loadProject(tempDir);

    expect(project.config.name).toBe('my-project');
    expect(project.config.paths?.experiments).toEqual(['custom/experiments']);
    expect(project.configPath).toBe(path.join(tempDir, 'bunsen.config.yaml'));
  });

  it('caches by root — repeated loads return the same object', () => {
    fs.writeFileSync(
      path.join(tempDir, 'bunsen.config.yaml'),
      `version: v1\nname: cached\n`,
    );
    const a = loadProject(tempDir);
    const b = loadProject(tempDir);
    expect(a).toBe(b);
  });

  it('derives custom storage root from config', () => {
    fs.writeFileSync(
      path.join(tempDir, 'bunsen.config.yaml'),
      `version: v1\nstorage:\n  root: runs-and-stuff\n`,
    );
    const project = loadProject(tempDir);
    expect(project.storage.root).toBe(path.join(tempDir, 'runs-and-stuff'));
  });

  it('exposes parser warnings on the resolved project', () => {
    fs.writeFileSync(
      path.join(tempDir, 'bunsen.config.yaml'),
      `version: v1\nremote:\n  provider: bunsen-cloud\n`,
    );
    const project = loadProject(tempDir);
    expect(project.warnings).toHaveLength(1);
    expect(project.warnings[0].code).toBe('project.remote.reserved');
    expect(project.config.remote).toEqual({ provider: 'bunsen-cloud' });
  });

  it('returns an empty warnings array when nothing is flagged', () => {
    fs.writeFileSync(
      path.join(tempDir, 'bunsen.config.yaml'),
      `version: v1\nname: clean\n`,
    );
    const project = loadProject(tempDir);
    expect(project.warnings).toEqual([]);
  });
});

describe('getExperimentSearchPaths / getAgentSearchPaths', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkTemp();
    clearProjectCache();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('falls back to defaults when no paths configured', () => {
    fs.mkdirSync(path.join(tempDir, '.git'));
    const project = loadProject(tempDir);
    expect(getExperimentSearchPaths(project)).toEqual([path.join(tempDir, 'experiments')]);
    expect(getAgentSearchPaths(project)).toEqual([path.join(tempDir, 'agents')]);
  });

  it('returns configured absolute paths in order', () => {
    fs.writeFileSync(
      path.join(tempDir, 'bunsen.config.yaml'),
      `version: v1\npaths:\n  experiments:\n    - a\n    - b\n  agents:\n    - ag\n`,
    );
    const project = loadProject(tempDir);
    expect(getExperimentSearchPaths(project)).toEqual([
      path.join(tempDir, 'a'),
      path.join(tempDir, 'b'),
    ]);
    expect(getAgentSearchPaths(project)).toEqual([path.join(tempDir, 'ag')]);
  });
});

describe('assertNoReservedEnvKeys / isReservedEnvKey', () => {
  it('flags BUNSEN_* keys', () => {
    expect(isReservedEnvKey('BUNSEN_RUN_ID')).toBe(true);
    expect(isReservedEnvKey('BUNSEN_X')).toBe(true);
    expect(isReservedEnvKey('bunsen_run_id')).toBe(false);
    expect(isReservedEnvKey('OTHER_VAR')).toBe(false);
  });

  it('throws ProjectConfigError when a reserved key is present', () => {
    expect(() => assertNoReservedEnvKeys(['OK_VAR', 'BUNSEN_PLATFORM'], 'test')).toThrow(
      /reserved/,
    );
  });

  it('passes when no reserved keys are present', () => {
    expect(() =>
      assertNoReservedEnvKeys(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'], 'test'),
    ).not.toThrow();
  });
});
