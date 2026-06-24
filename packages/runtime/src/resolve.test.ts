// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for experiment/agent name resolution against `bunsen.config.yaml`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  resolveExperiment,
  resolveAgent,
  describeSearchedLocations,
  findAllExperiments,
  findAllAgents,
  clearProjectInfoCache,
} from './resolve.js';
import { loadProject, clearProjectCache } from './project-loader.js';

function v1Config(body = ''): string {
  return `$schema: https://schemas.bunsen.dev/project.v1.json\nversion: v1\n${body}`;
}

function setupTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-resolve-test-'));
}

describe('resolveExperiment', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = setupTempDir();
    clearProjectInfoCache();
    clearProjectCache();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves direct path', () => {
    const expDir = path.join(tempDir, 'my-exp');
    fs.mkdirSync(expDir, { recursive: true });
    fs.writeFileSync(path.join(expDir, 'experiment.yaml'), 'name: test');

    const project = loadProject(tempDir);
    const result = resolveExperiment(expDir, project);

    expect(result).not.toBeNull();
    expect(result?.path).toBe(expDir);
    expect(result?.source).toBe('direct');
  });

  it('resolves from default search paths', () => {
    fs.mkdirSync(path.join(tempDir, '.git'));
    const expDir = path.join(tempDir, 'experiments', 'test-exp');
    fs.mkdirSync(expDir, { recursive: true });
    fs.writeFileSync(path.join(expDir, 'experiment.yaml'), 'name: test');

    const project = loadProject(tempDir);
    const result = resolveExperiment('test-exp', project);

    expect(result).not.toBeNull();
    expect(result?.path).toBe(expDir);
    expect(result?.source).toBe('default');
  });

  it('resolves from configured search paths', () => {
    fs.writeFileSync(
      path.join(tempDir, 'bunsen.config.yaml'),
      v1Config('paths:\n  experiments:\n    - custom-experiments\n'),
    );
    const expDir = path.join(tempDir, 'custom-experiments', 'my-exp');
    fs.mkdirSync(expDir, { recursive: true });
    fs.writeFileSync(path.join(expDir, 'experiment.yaml'), 'name: test');

    const project = loadProject(tempDir);
    const result = resolveExperiment('my-exp', project);

    expect(result).not.toBeNull();
    expect(result?.path).toBe(expDir);
    expect(result?.source).toBe('config');
  });

  it('returns null when experiment not found', () => {
    fs.mkdirSync(path.join(tempDir, '.git'));
    const project = loadProject(tempDir);
    const result = resolveExperiment('nonexistent', project);

    expect(result).toBeNull();
  });

  it('finds nested experiment by basename', () => {
    fs.mkdirSync(path.join(tempDir, '.git'));
    const expDir = path.join(tempDir, 'experiments', 'fix-bugs', 'anthropic-stream-errors');
    fs.mkdirSync(expDir, { recursive: true });
    fs.writeFileSync(path.join(expDir, 'experiment.yaml'), 'name: test');

    const project = loadProject(tempDir);
    const result = resolveExperiment('anthropic-stream-errors', project);

    expect(result?.path).toBe(expDir);
  });

  it('throws on ambiguous basename match across nested folders', () => {
    fs.mkdirSync(path.join(tempDir, '.git'));
    // Two nested folders with the same basename — neither sits directly
    // under `experiments/<name>`, so recursive basename search kicks in
    // and both should be found.
    for (const parent of ['fix-bugs', 'zero-to-one']) {
      const dir = path.join(tempDir, 'experiments', parent, 'duplicate');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'experiment.yaml'), 'name: duplicate');
    }

    const project = loadProject(tempDir);
    expect(() => resolveExperiment('duplicate', project)).toThrow(/Ambiguous/);
  });
});

describe('resolveAgent', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = setupTempDir();
    clearProjectInfoCache();
    clearProjectCache();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves by agent.yaml `name` field', () => {
    fs.mkdirSync(path.join(tempDir, '.git'));
    const agentDir = path.join(tempDir, 'agents', 'test-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'agent.yaml'), 'name: test-agent');

    const project = loadProject(tempDir);
    const result = resolveAgent('test-agent', project);

    expect(result).not.toBeNull();
    expect(result?.path).toBe(agentDir);
    expect(result?.source).toBe('default');
  });

  it('resolves when folder name differs from yaml name', () => {
    // The yaml `name` is the canonical identifier; the folder is incidental
    // (e.g. a locally-renamed clone of a shared agent).
    fs.mkdirSync(path.join(tempDir, '.git'));
    const agentDir = path.join(tempDir, 'agents', 'on-disk-folder');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'agent.yaml'), 'name: published-name');

    const project = loadProject(tempDir);
    expect(resolveAgent('published-name', project)?.path).toBe(agentDir);
    expect(resolveAgent('on-disk-folder', project)).toBeNull();
  });

  it('resolves a direct path even when the yaml name differs from the folder', () => {
    fs.mkdirSync(path.join(tempDir, '.git'));
    const agentDir = path.join(tempDir, 'agents', 'on-disk-folder');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'agent.yaml'), 'name: published-name');

    const project = loadProject(tempDir);
    const result = resolveAgent(agentDir, project);
    expect(result?.path).toBe(agentDir);
    expect(result?.source).toBe('direct');
  });

  it('throws on ambiguous yaml-name match', () => {
    fs.mkdirSync(path.join(tempDir, '.git'));
    for (const folder of ['copy-a', 'copy-b']) {
      const dir = path.join(tempDir, 'agents', folder);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'agent.yaml'), 'name: shared');
    }
    const project = loadProject(tempDir);
    expect(() => resolveAgent('shared', project)).toThrow(/Ambiguous/);
  });
});

describe('describeSearchedLocations', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = setupTempDir();
    clearProjectInfoCache();
    clearProjectCache();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('describes default search paths when no config', () => {
    fs.mkdirSync(path.join(tempDir, '.git'));
    const project = loadProject(tempDir);

    const description = describeSearchedLocations('experiment', project);

    expect(description).toContain('default paths');
    expect(description).toContain('experiments');
  });

  it('describes configured search paths', () => {
    fs.writeFileSync(
      path.join(tempDir, 'bunsen.config.yaml'),
      v1Config('paths:\n  experiments:\n    - custom/experiments\n'),
    );
    const project = loadProject(tempDir);

    const description = describeSearchedLocations('experiment', project);

    expect(description).toContain('bunsen.config.yaml');
    expect(description).toContain('custom/experiments');
  });
});

describe('findAllExperiments', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = setupTempDir();
    clearProjectInfoCache();
    clearProjectCache();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds experiments in default search paths', () => {
    fs.mkdirSync(path.join(tempDir, '.git'));

    const exp1Dir = path.join(tempDir, 'experiments', 'exp1');
    fs.mkdirSync(exp1Dir, { recursive: true });
    fs.writeFileSync(path.join(exp1Dir, 'experiment.yaml'), 'name: exp1');

    const exp2Dir = path.join(tempDir, 'experiments', 'exp2');
    fs.mkdirSync(exp2Dir, { recursive: true });
    fs.writeFileSync(path.join(exp2Dir, 'experiment.yaml'), 'name: exp2');

    const project = loadProject(tempDir);
    const results = findAllExperiments(project);

    expect(results).toHaveLength(2);
    expect(results).toContain(exp1Dir);
    expect(results).toContain(exp2Dir);
  });

  it('finds experiments in configured search paths', () => {
    fs.writeFileSync(
      path.join(tempDir, 'bunsen.config.yaml'),
      v1Config('paths:\n  experiments:\n    - custom/experiments\n'),
    );

    const expDir = path.join(tempDir, 'custom', 'experiments', 'my-exp');
    fs.mkdirSync(expDir, { recursive: true });
    fs.writeFileSync(path.join(expDir, 'experiment.yaml'), 'name: my-exp');

    const project = loadProject(tempDir);
    const results = findAllExperiments(project);

    expect(results).toHaveLength(1);
    expect(results[0]).toBe(expDir);
  });

  it('ignores directories without experiment.yaml', () => {
    fs.mkdirSync(path.join(tempDir, '.git'));

    const expDir = path.join(tempDir, 'experiments', 'valid-exp');
    fs.mkdirSync(expDir, { recursive: true });
    fs.writeFileSync(path.join(expDir, 'experiment.yaml'), 'name: valid');

    const noConfigDir = path.join(tempDir, 'experiments', 'no-config');
    fs.mkdirSync(noConfigDir, { recursive: true });

    const project = loadProject(tempDir);
    const results = findAllExperiments(project);

    expect(results).toHaveLength(1);
    expect(results[0]).toBe(expDir);
  });
});

describe('suite-aware experiment resolution', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = setupTempDir();
    clearProjectInfoCache();
    clearProjectCache();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function setupSuite(opts: { manifestRoots?: string[]; alias?: string } = {}): void {
    const cacheDir = path.join(
      tempDir,
      '.bunsen',
      'suites',
      'github.com__cursiv__terminal-bench',
    );
    fs.mkdirSync(cacheDir, { recursive: true });
    if (opts.manifestRoots) {
      fs.writeFileSync(
        path.join(cacheDir, 'bunsen-suite.yaml'),
        `version: v1\nname: TB\nexperiments:\n${opts.manifestRoots.map((r) => `  - ${r}`).join('\n')}\n`,
      );
    } else {
      fs.writeFileSync(
        path.join(cacheDir, 'bunsen-suite.yaml'),
        `version: v1\nname: TB\nexperiments:\n  - tasks\n`,
      );
    }
    const expDir = path.join(cacheDir, 'tasks', 'hello-world');
    fs.mkdirSync(expDir, { recursive: true });
    fs.writeFileSync(path.join(expDir, 'experiment.yaml'), 'name: hello-world');

    const aliasLine = opts.alias ? `\n    as: ${opts.alias}` : '';
    fs.writeFileSync(
      path.join(tempDir, 'bunsen.config.yaml'),
      v1Config(
        `suites:\n  - source:\n      type: git\n      url: https://github.com/cursiv/terminal-bench.git${aliasLine}\n`,
      ),
    );
  }

  it('resolves an experiment by alias prefix', () => {
    setupSuite({ alias: 'terminal-bench' });
    const project = loadProject(tempDir);
    const result = resolveExperiment('terminal-bench/hello-world', project);
    expect(result?.source).toBe('suite');
    expect(result?.suiteId).toBe('github.com/cursiv/terminal-bench');
    expect(result?.suiteRelative).toBe(path.join('tasks', 'hello-world'));
  });

  it('resolves with the full canonical id', () => {
    setupSuite();
    const project = loadProject(tempDir);
    const result = resolveExperiment(
      'github.com/cursiv/terminal-bench/hello-world',
      project,
    );
    expect(result?.source).toBe('suite');
    expect(result?.suiteId).toBe('github.com/cursiv/terminal-bench');
  });

  it('resolves with the github.com short form', () => {
    setupSuite();
    const project = loadProject(tempDir);
    const result = resolveExperiment('cursiv/terminal-bench/hello-world', project);
    expect(result?.source).toBe('suite');
    expect(result?.suiteId).toBe('github.com/cursiv/terminal-bench');
  });

  it('resolves an unqualified basename via recursive search across suites', () => {
    setupSuite();
    const project = loadProject(tempDir);
    const result = resolveExperiment('hello-world', project);
    expect(result?.source).toBe('suite');
    expect(result?.suiteId).toBe('github.com/cursiv/terminal-bench');
  });

  it('returns null when alias prefix matches but the experiment is missing', () => {
    setupSuite({ alias: 'terminal-bench' });
    const project = loadProject(tempDir);
    const result = resolveExperiment('terminal-bench/no-such-task', project);
    expect(result).toBeNull();
  });

  it('local prefix match wins over suite match for shadowed names', () => {
    // Per docs/SUITES.md, unqualified refs resolve
    // local-first; the suite is only reached when no local match exists.
    setupSuite();
    const localDir = path.join(tempDir, 'experiments', 'hello-world');
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, 'experiment.yaml'), 'name: hello-world');
    const project = loadProject(tempDir);
    const result = resolveExperiment('hello-world', project);
    expect(result?.path).toBe(localDir);
    expect(result?.source).not.toBe('suite');
  });

  it('describes suite search locations', () => {
    setupSuite({ alias: 'terminal-bench' });
    const project = loadProject(tempDir);
    const out = describeSearchedLocations('experiment', project);
    expect(out).toMatch(/suite github\.com\/cursiv\/terminal-bench/);
    expect(out).toMatch(/alias: terminal-bench/);
  });

  it('findAllExperiments includes suite experiments', () => {
    setupSuite();
    const localDir = path.join(tempDir, 'experiments', 'local-exp');
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, 'experiment.yaml'), 'name: local');
    fs.mkdirSync(path.join(tempDir, '.git'));
    const project = loadProject(tempDir);
    const all = findAllExperiments(project);
    expect(all).toHaveLength(2);
    expect(all.some((p) => p.endsWith(path.join('local-exp')))).toBe(true);
    expect(all.some((p) => p.endsWith(path.join('hello-world')))).toBe(true);
  });
});

describe('findAllAgents', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = setupTempDir();
    clearProjectInfoCache();
    clearProjectCache();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds agents in default search paths', () => {
    fs.mkdirSync(path.join(tempDir, '.git'));

    const agentDir = path.join(tempDir, 'agents', 'my-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'agent.yaml'), 'name: my-agent');

    const project = loadProject(tempDir);
    const results = findAllAgents(project);

    expect(results).toHaveLength(1);
    expect(results[0]).toBe(agentDir);
  });
});
