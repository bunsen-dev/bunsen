// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for `bunsen-suite.yaml` v1 parser, identity derivation, and
 * project-suite loading.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  parseSuiteManifest,
  loadSuiteFromDir,
  loadProjectSuites,
  detectSuiteProvenance,
  suiteIdFromUrl,
  localSuiteId,
  resolveSuiteCacheDir,
  getSuiteExperimentSearchPaths,
  SuiteManifestError,
} from './suite-loader.js';
import { loadProject, clearProjectCache } from './project-loader.js';
import type { ResolvedProject } from './project-loader.js';

function mkTemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-suite-test-'));
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('parseSuiteManifest', () => {
  it('accepts the minimal v1 manifest', () => {
    const m = parseSuiteManifest(`version: v1\nname: My Suite\nexperiments:\n  - tasks\n`);
    expect(m).toEqual({
      version: 'v1',
      name: 'My Suite',
      experiments: ['tasks'],
    });
  });

  it('parses the full v1 shape', () => {
    const src = `
$schema: https://schemas.bunsen.dev/suite.v1.json
version: v1
name: Terminal Bench
description: CLI agent benchmark
version_tag: 2.1.0
license: MIT

compatibility:
  min_bunsen_version: "0.3.0"

experiments:
  - tasks
  - tasks-extra

tags:
  domains: [cli, sysadmin]

tracks:
  default:
    description: Full suite
    include: ["**/*"]
  quick:
    description: Smoke tests
    include: ["tasks/cli-basics/**"]
    exclude: ["tasks/cli-basics/skip-me"]

aggregation:
  default: weighted_average
  weights:
    by_tag:
      hard: 2.0
    by_experiment:
      cli-basics-001: 1.5
`;
    const m = parseSuiteManifest(src);
    expect(m.name).toBe('Terminal Bench');
    expect(m.description).toBe('CLI agent benchmark');
    expect(m.version_tag).toBe('2.1.0');
    expect(m.license).toBe('MIT');
    expect(m.compatibility).toEqual({ min_bunsen_version: '0.3.0' });
    expect(m.experiments).toEqual(['tasks', 'tasks-extra']);
    expect(m.tags).toEqual({ domains: ['cli', 'sysadmin'] });
    expect(m.tracks?.default).toEqual({ description: 'Full suite', include: ['**/*'] });
    expect(m.tracks?.quick).toEqual({
      description: 'Smoke tests',
      include: ['tasks/cli-basics/**'],
      exclude: ['tasks/cli-basics/skip-me'],
    });
    expect(m.aggregation).toEqual({
      default: 'weighted_average',
      weights: {
        by_tag: { hard: 2.0 },
        by_experiment: { 'cli-basics-001': 1.5 },
      },
    });
  });

  it('rejects manifests with an id field, with migration hint', () => {
    const src = `version: v1\nid: terminal-bench\nname: TB\nexperiments: [tasks]\n`;
    expect(() => parseSuiteManifest(src)).toThrow(/derived from where it was cloned/);
  });

  it('rejects manifests with a provenance field', () => {
    const src =
      `version: v1\nname: TB\nexperiments: [tasks]\nprovenance:\n  source_url: https://x\n`;
    expect(() => parseSuiteManifest(src)).toThrow(/'provenance' field has been removed/);
  });

  it('rejects manifests with required_images', () => {
    const src =
      `version: v1\nname: TB\nexperiments: [tasks]\ncompatibility:\n  required_images:\n    - bunsen/headless\n`;
    expect(() => parseSuiteManifest(src)).toThrow(/unknown field/);
  });

  it('rejects missing name', () => {
    expect(() => parseSuiteManifest(`version: v1\nexperiments: [tasks]\n`)).toThrow(
      /name must be a string/,
    );
  });

  it('rejects empty experiments array', () => {
    expect(() => parseSuiteManifest(`version: v1\nname: x\nexperiments: []\n`)).toThrow(
      /non-empty array/,
    );
  });

  it('rejects absolute experiment paths', () => {
    const src = `version: v1\nname: x\nexperiments:\n  - /abs/path\n`;
    expect(() => parseSuiteManifest(src)).toThrow(/relative to the suite repo root/);
  });

  it('rejects experiment paths that escape the repo', () => {
    const src = `version: v1\nname: x\nexperiments:\n  - ../outside\n`;
    expect(() => parseSuiteManifest(src)).toThrow(/escape the suite repo root/);
  });

  it('rejects unknown root field', () => {
    const src = `version: v1\nname: x\nexperiments: [tasks]\nbogus: true\n`;
    expect(() => parseSuiteManifest(src)).toThrow(/unknown field 'bogus'/);
  });

  it('rejects invalid aggregation function', () => {
    const src =
      `version: v1\nname: x\nexperiments: [tasks]\naggregation:\n  default: bogus\n`;
    expect(() => parseSuiteManifest(src)).toThrow(/weighted_average/);
  });
});

describe('suiteIdFromUrl', () => {
  it('derives id from https github URL', () => {
    expect(suiteIdFromUrl('https://github.com/cursiv/terminal-bench.git')).toBe(
      'github.com/cursiv/terminal-bench',
    );
  });

  it('derives id from https URL without .git suffix', () => {
    expect(suiteIdFromUrl('https://github.com/cursiv/terminal-bench')).toBe(
      'github.com/cursiv/terminal-bench',
    );
  });

  it('derives id from ssh form', () => {
    expect(suiteIdFromUrl('git@github.com:cursiv/terminal-bench.git')).toBe(
      'github.com/cursiv/terminal-bench',
    );
  });

  it('preserves nested groups (e.g. GitLab subgroups)', () => {
    expect(suiteIdFromUrl('https://gitlab.com/group/sub/repo.git')).toBe(
      'gitlab.com/group/sub/repo',
    );
  });

  it('lowercases host and path so case-only URL variants resolve to the same id', () => {
    expect(suiteIdFromUrl('https://GitHub.com/CURSIV/Terminal-Bench.git')).toBe(
      'github.com/cursiv/terminal-bench',
    );
    expect(suiteIdFromUrl('https://github.com/cursiv/terminal-bench')).toBe(
      'github.com/cursiv/terminal-bench',
    );
  });

  it('rejects URLs without a host', () => {
    expect(() => suiteIdFromUrl('http://')).toThrow(/could not be parsed/);
  });

  it('rejects URLs without org/repo', () => {
    expect(() => suiteIdFromUrl('https://github.com/lonely')).toThrow(/<org>\/<repo>/);
  });

  it('rejects empty URLs', () => {
    expect(() => suiteIdFromUrl('   ')).toThrow(/non-empty/);
  });
});

describe('localSuiteId', () => {
  it('derives local/<dirname>', () => {
    expect(localSuiteId('/some/path/my-suite')).toBe('local/my-suite');
  });
});

describe('loadSuiteFromDir', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkTemp();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads a suite with a manifest', () => {
    writeFile(
      path.join(tempDir, 'bunsen-suite.yaml'),
      `version: v1\nname: TB\nexperiments:\n  - tasks\n`,
    );
    const s = loadSuiteFromDir(tempDir);
    expect(s.id).toBe(`local/${path.basename(tempDir)}`);
    expect(s.manifest?.name).toBe('TB');
    expect(s.root).toBe(path.resolve(tempDir));
  });

  it('uses expectedId when provided', () => {
    writeFile(
      path.join(tempDir, 'bunsen-suite.yaml'),
      `version: v1\nname: TB\nexperiments: [tasks]\n`,
    );
    const s = loadSuiteFromDir(tempDir, {
      expectedId: 'github.com/cursiv/terminal-bench',
      alias: 'terminal-bench',
      sourceUrl: 'https://github.com/cursiv/terminal-bench.git',
    });
    expect(s.id).toBe('github.com/cursiv/terminal-bench');
    expect(s.alias).toBe('terminal-bench');
    expect(s.source_url).toBe('https://github.com/cursiv/terminal-bench.git');
  });

  it('returns a manifest-less suite when bunsen-suite.yaml is missing', () => {
    fs.mkdirSync(path.join(tempDir, 'tasks'));
    const s = loadSuiteFromDir(tempDir);
    expect(s.manifest).toBeUndefined();
    expect(s.id).toBe(`local/${path.basename(tempDir)}`);
  });

  it('captures the commit sha when source_url is supplied and the dir is a git repo', () => {
    execFileSync('git', ['init', '-q', '-b', 'main', tempDir]);
    execFileSync('git', ['-C', tempDir, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', tempDir, 'config', 'user.name', 'Test']);
    writeFile(
      path.join(tempDir, 'bunsen-suite.yaml'),
      `version: v1\nname: TB\nexperiments: [tasks]\n`,
    );
    execFileSync('git', ['-C', tempDir, 'add', 'bunsen-suite.yaml']);
    execFileSync('git', ['-C', tempDir, 'commit', '-q', '-m', 'init']);

    const s = loadSuiteFromDir(tempDir, {
      expectedId: 'example.com/x/y',
      sourceUrl: 'https://example.com/x/y.git',
    });
    expect(s.version).toMatch(/^[0-9a-f]{7,64}$/);
  });

  it('throws when the directory does not exist', () => {
    expect(() => loadSuiteFromDir(path.join(tempDir, 'missing'))).toThrow(SuiteManifestError);
  });
});

describe('getSuiteExperimentSearchPaths', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkTemp();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns absolute paths for declared experiment roots', () => {
    writeFile(
      path.join(tempDir, 'bunsen-suite.yaml'),
      `version: v1\nname: TB\nexperiments:\n  - tasks\n  - extras/extra\n`,
    );
    const s = loadSuiteFromDir(tempDir);
    const paths = getSuiteExperimentSearchPaths(s);
    expect(paths).toEqual([
      path.resolve(tempDir, 'tasks'),
      path.resolve(tempDir, 'extras/extra'),
    ]);
  });

  it('falls back to the suite root when there is no manifest', () => {
    fs.mkdirSync(path.join(tempDir, 'tasks'));
    const s = loadSuiteFromDir(tempDir);
    expect(getSuiteExperimentSearchPaths(s)).toEqual([path.resolve(tempDir)]);
  });
});

describe('loadProjectSuites', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkTemp();
    clearProjectCache();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    clearProjectCache();
  });

  function setupProject(suitesYaml: string): ResolvedProject {
    writeFile(
      path.join(tempDir, 'bunsen.config.yaml'),
      `version: v1\nname: test\n${suitesYaml}\n`,
    );
    return loadProject(tempDir);
  }

  it('returns empty array when no suites are declared', () => {
    const project = setupProject('');
    expect(loadProjectSuites(project)).toEqual([]);
  });

  it('derives canonical ids from each entry', () => {
    const project = setupProject(
      `suites:\n  - source:\n      type: git\n      url: https://github.com/cursiv/terminal-bench.git\n    as: terminal-bench`,
    );
    const suites = loadProjectSuites(project);
    expect(suites).toHaveLength(1);
    expect(suites[0].id).toBe('github.com/cursiv/terminal-bench');
    expect(suites[0].alias).toBe('terminal-bench');
    expect(suites[0].source_url).toBe('https://github.com/cursiv/terminal-bench.git');
  });

  it('returns a manifest-less placeholder when a clone is not yet materialized', () => {
    const project = setupProject(
      `suites:\n  - source:\n      type: git\n      url: https://github.com/cursiv/terminal-bench.git`,
    );
    const suites = loadProjectSuites(project);
    expect(suites[0].manifest).toBeUndefined();
  });

  it('parses the manifest when the cache directory contains bunsen-suite.yaml', () => {
    const cacheDir = path.join(tempDir, '.bunsen', 'suites', 'github.com__cursiv__terminal-bench');
    writeFile(
      path.join(cacheDir, 'bunsen-suite.yaml'),
      `version: v1\nname: TB\nexperiments:\n  - tasks\n`,
    );
    const project = setupProject(
      `suites:\n  - source:\n      type: git\n      url: https://github.com/cursiv/terminal-bench.git`,
    );
    const suites = loadProjectSuites(project);
    expect(suites[0].manifest?.name).toBe('TB');
  });

  it('rejects two entries that resolve to the same canonical id', () => {
    const project = setupProject(
      `suites:\n  - source:\n      type: git\n      url: https://github.com/cursiv/terminal-bench.git\n  - source:\n      type: git\n      url: git@github.com:cursiv/terminal-bench.git`,
    );
    expect(() => loadProjectSuites(project)).toThrow(/collides with/);
  });

  it('honors a custom cacheDir override', () => {
    const project = setupProject(
      `suites:\n  - source:\n      type: git\n      url: https://github.com/cursiv/terminal-bench.git\n    cacheDir: vendor/tb`,
    );
    const entry = project.config.suites![0];
    const cache = resolveSuiteCacheDir(project, entry, 'github.com/cursiv/terminal-bench');
    expect(cache).toBe(path.resolve(tempDir, 'vendor/tb'));
  });
});

describe('detectSuiteProvenance', () => {
  let tempDir: string;
  let suiteRoot: string;

  beforeEach(() => {
    tempDir = mkTemp();
    clearProjectCache();
    // Materialize a suite at the conventional cacheDir so detection has
    // something to walk against.
    suiteRoot = path.join(tempDir, '.bunsen', 'suites', 'github.com__cursiv__terminal-bench');
    writeFile(
      path.join(suiteRoot, 'bunsen-suite.yaml'),
      `version: v1\nname: TB\nexperiments:\n  - tasks\n`,
    );
    fs.mkdirSync(path.join(suiteRoot, 'tasks', 'hello-world'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    clearProjectCache();
  });

  function setupProject(suitesYaml: string): ResolvedProject {
    writeFile(
      path.join(tempDir, 'bunsen.config.yaml'),
      `version: v1\nname: test\n${suitesYaml}\n`,
    );
    return loadProject(tempDir);
  }

  it('returns provenance when experiment lives inside a configured suite', () => {
    const project = setupProject(
      `suites:\n  - source:\n      type: git\n      url: https://github.com/cursiv/terminal-bench.git`,
    );
    const provenance = detectSuiteProvenance(
      path.join(suiteRoot, 'tasks', 'hello-world'),
      project,
    );
    expect(provenance?.id).toBe('github.com/cursiv/terminal-bench');
    expect(provenance?.source_url).toBe('https://github.com/cursiv/terminal-bench.git');
  });

  it('returns undefined when no suites are configured', () => {
    const project = setupProject('');
    expect(
      detectSuiteProvenance(path.join(suiteRoot, 'tasks', 'hello-world'), project),
    ).toBeUndefined();
  });

  it('returns undefined when experiment lives outside every configured suite', () => {
    const project = setupProject(
      `suites:\n  - source:\n      type: git\n      url: https://github.com/cursiv/terminal-bench.git`,
    );
    const outside = path.join(tempDir, 'examples', 'fix-bugs', 'hello');
    fs.mkdirSync(outside, { recursive: true });
    expect(detectSuiteProvenance(outside, project)).toBeUndefined();
  });

  it('reports a warning when suite resolution fails (e.g. duplicate URL)', () => {
    const project = setupProject(
      `suites:\n  - source:\n      type: git\n      url: https://x.example.com/o/r.git\n  - source:\n      type: git\n      url: git@x.example.com:o/r.git`,
    );
    const warnings: string[] = [];
    const result = detectSuiteProvenance(path.join(suiteRoot, 'tasks', 'hello-world'), project, {
      onWarn: (m) => warnings.push(m),
    });
    expect(result).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/collides|duplicate/);
  });

  it('memoizes suite resolution per ResolvedProject', () => {
    const project = setupProject(
      `suites:\n  - source:\n      type: git\n      url: https://github.com/cursiv/terminal-bench.git`,
    );
    // Second invocation should reuse the cached result. Verify by mutating
    // the manifest after the first call — if not memoized, the second call
    // would re-parse and either pick up the change or throw.
    const first = detectSuiteProvenance(
      path.join(suiteRoot, 'tasks', 'hello-world'),
      project,
    );
    fs.writeFileSync(
      path.join(suiteRoot, 'bunsen-suite.yaml'),
      `version: v1\nname: TB-renamed\nexperiments:\n  - tasks\n`,
    );
    const second = detectSuiteProvenance(
      path.join(suiteRoot, 'tasks', 'hello-world'),
      project,
    );
    expect(second).toEqual(first);
  });
});
