// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for the v1 experiment.yaml loader (parser, variant merge, workspace
 * source resolution, criterion-graph validation).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'js-yaml';
import {
  parseExperimentConfig as parseV1,
  loadExperiment as loadV1,
  applyVariant,
  resolveWorkspaceSources,
  validateCriteriaGraph,
  ExperimentConfigError,
} from './experiment-loader.js';
import type { ExperimentConfig } from '@bunsen-dev/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseYaml(extra: Record<string, unknown> = {}): string {
  return yaml.dump({
    $schema: 'https://schemas.bunsen.dev/experiment.v1.json',
    version: 'v1',
    name: 'demo',
    description: 'A demo experiment',
    task: { prompt: 'Do the thing.' },
    environment: { image: { base: 'bunsen/headless' } },
    evaluation: {
      criteria: [
        {
          id: 'tests-pass',
          title: 'Tests Pass',
          type: 'script',
          run: 'pytest',
          scores: [0, 1],
        },
      ],
    },
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// parseExperimentConfig — happy path
// ---------------------------------------------------------------------------

describe('parseExperimentConfig', () => {
  it('parses a minimal v1 experiment', () => {
    const config = parseV1(baseYaml());
    expect(config.version).toBe('v1');
    expect(config.name).toBe('demo');
    expect(config.task.prompt).toBe('Do the thing.');
    expect(config.environment.image).toEqual({ base: 'bunsen/headless' });
    expect(config.evaluation.criteria).toHaveLength(1);
    expect(config.evaluation.criteria[0]).toMatchObject({
      id: 'tests-pass',
      title: 'Tests Pass',
      type: 'script',
      run: 'pytest',
    });
  });

  it('parses every criterion type', () => {
    const config = parseV1(
      yaml.dump({
        version: 'v1',
        name: 'full',
        task: { prompt: 'x' },
        environment: { image: { base: 'b' } },
        evaluation: {
          criteria: [
            { id: 's', title: 'Script', type: 'script', run: 'pytest' },
            {
              id: 'j',
              title: 'Judge',
              type: 'judge',
              instructions: 'review',
              evidence: ['diff', 'logs'],
            },
            { id: 'a', title: 'Agent', type: 'agent', instructions: 'run it' },
            {
              id: 'ba',
              title: 'Browser',
              type: 'browser-agent',
              instructions: 'browse it',
            },
            {
              id: 'agg',
              title: 'Agg',
              type: 'aggregate',
              needs: ['s', 'j'],
              aggregate: { function: 'min' },
            },
          ],
        },
      }),
    );
    expect(config.evaluation.criteria.map((c) => c.type)).toEqual([
      'script',
      'judge',
      'agent',
      'browser-agent',
      'aggregate',
    ]);
  });

  it('parses evaluation.report as a dedicated field', () => {
    const config = parseV1(
      baseYaml({
        evaluation: {
          criteria: [
            {
              id: 'tests-pass',
              title: 'Tests Pass',
              type: 'script',
              run: 'pytest',
            },
          ],
          report: {
            instructions: 'Summarize the run.',
            needs: 'all',
            model: 'claude-haiku-4-5',
          },
        },
      }),
    );
    expect(config.evaluation.report).toEqual({
      instructions: 'Summarize the run.',
      needs: 'all',
      model: 'claude-haiku-4-5',
    });
  });

  it('accepts both `environment.image.base` and `environment.image.dockerfile` individually', () => {
    const base = parseV1(
      baseYaml({ environment: { image: { base: 'x' } } }),
    );
    expect(base.environment.image).toEqual({ base: 'x' });

    const docker = parseV1(
      baseYaml({ environment: { image: { dockerfile: './Dockerfile' } } }),
    );
    expect(docker.environment.image).toEqual({ dockerfile: './Dockerfile' });
  });

  it('parses duration strings on run + workspace.setup + criterion', () => {
    const config = parseV1(
      baseYaml({
        workspace: {
          setup: [{ run: 'npm install', timeout: '5m' }],
        },
        run: { timeout: '15m', artifactCaptureTimeout: '2m' },
        evaluation: {
          criteria: [
            {
              id: 'tests-pass',
              title: 'Tests Pass',
              type: 'script',
              run: 'pytest',
              timeout: '180s',
            },
          ],
        },
      }),
    );
    expect(config.workspace?.setup?.[0].timeout).toBe('5m');
    expect(config.run?.timeout).toBe('15m');
    expect(config.run?.artifactCaptureTimeout).toBe('2m');
    expect(config.evaluation.criteria[0].timeout).toBe('180s');
  });

  it('accepts writeFile steps in workspace.setup', () => {
    const config = parseV1(
      baseYaml({
        workspace: {
          setup: [
            { run: 'mkdir -p /workspace/fixtures' },
            { writeFile: '/workspace/fixtures/sample.json', content: '{"k":1}' },
            { writeFile: '/workspace/fixtures/README.md', from: 'fixtures/seed.md' },
          ],
        },
      }),
    );
    expect(config.workspace?.setup).toEqual([
      { run: 'mkdir -p /workspace/fixtures' },
      { writeFile: '/workspace/fixtures/sample.json', content: '{"k":1}' },
      { writeFile: '/workspace/fixtures/README.md', from: 'fixtures/seed.md' },
    ]);
  });

  it('rejects a workspace.setup step that sets both run and writeFile', () => {
    expect(() =>
      parseV1(
        baseYaml({
          workspace: {
            setup: [{ run: 'echo', writeFile: '/tmp/x', content: 'y' }],
          },
        }),
      ),
    ).toThrow(/may set 'run' or 'writeFile', not both/);
  });

  it('rejects a workspace.setup writeFile step that has neither from nor content', () => {
    expect(() =>
      parseV1(baseYaml({ workspace: { setup: [{ writeFile: '/tmp/x' }] } })),
    ).toThrow(/must set either 'from'.*or 'content'/);
  });
});

// ---------------------------------------------------------------------------
// Legacy rejection
// ---------------------------------------------------------------------------

describe('legacy schema rejection', () => {
  const legacyYaml = `
name: legacy-exp
description: A legacy experiment
base: bunsen/headless
task: Do the thing
rubric:
  - criterion: Tests Pass
    code: pytest
    scores: [0, 1]
`;

  it('names the deprecated field and replacement on legacy top-level', () => {
    expect(() => parseV1(legacyYaml)).toThrow(/legacy experiment.yaml field 'base'/i);
    expect(() => parseV1(legacyYaml)).toThrow(/environment\.image\.base/);
  });

  it.each([
    ['base', 'environment.image.base'],
    ['rubric', 'evaluation.criteria'],
    ['requires_root', 'environment.user: root'],
    ['score_in_agent_container', 'evaluation.container: agent'],
    ['workspace_setup', 'workspace.setup'],
  ])('rejects legacy field %s with migration hint pointing to %s', (field, replacement) => {
    const bad = yaml.dump({ version: 'v1', name: 'x', [field]: 'ignored' });
    try {
      parseV1(bad);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ExperimentConfigError);
      expect((err as Error).message).toContain(field);
      expect((err as Error).message).toContain(replacement);
    }
  });

  it('rejects legacy criterion field (criterion:)', () => {
    const bad = baseYaml({
      evaluation: {
        criteria: [{ criterion: 'Tests Pass', code: 'pytest' }],
      },
    });
    expect(() => parseV1(bad)).toThrow(/legacy field 'criterion'/);
  });

  it('rejects legacy depends_on', () => {
    const bad = baseYaml({
      evaluation: {
        criteria: [
          {
            id: 'a',
            title: 'A',
            type: 'script',
            run: 'x',
          },
          {
            id: 'b',
            title: 'B',
            type: 'script',
            run: 'y',
            depends_on: ['a'],
          },
        ],
      },
    });
    expect(() => parseV1(bad)).toThrow(/legacy field 'depends_on'/);
  });
});

// ---------------------------------------------------------------------------
// Required fields and exactly-one-of
// ---------------------------------------------------------------------------

describe('required fields + exactly-one-of', () => {
  it('requires version', () => {
    expect(() => parseV1(yaml.dump({ name: 'x' }))).toThrow(/version/);
  });

  it('rejects unknown schema version', () => {
    expect(() => parseV1(yaml.dump({ version: 'v99', name: 'x' }))).toThrow(
      /Unsupported schema version/,
    );
  });

  it('requires name to be kebab-case', () => {
    const bad = yaml.dump({
      version: 'v1',
      name: 'BadName!',
      task: { prompt: 'x' },
      environment: { image: { base: 'b' } },
      evaluation: { criteria: [] },
    });
    expect(() => parseV1(bad)).toThrow(/kebab-case/);
  });

  it('requires task.prompt', () => {
    const bad = yaml.dump({
      version: 'v1',
      name: 'x',
      task: {},
      environment: { image: { base: 'b' } },
      evaluation: { criteria: [] },
    });
    expect(() => parseV1(bad)).toThrow(/task\.prompt/);
  });

  it('requires environment.image', () => {
    const bad = yaml.dump({
      version: 'v1',
      name: 'x',
      task: { prompt: 'x' },
      environment: {},
      evaluation: { criteria: [] },
    });
    expect(() => parseV1(bad)).toThrow(/environment\.image is required/);
  });

  it('enforces exactly-one-of environment.image.base | dockerfile', () => {
    const bad = yaml.dump({
      version: 'v1',
      name: 'x',
      task: { prompt: 'x' },
      environment: { image: { base: 'x', dockerfile: './Dockerfile' } },
      evaluation: { criteria: [] },
    });
    expect(() => parseV1(bad)).toThrow(/exactly one of 'base' or 'dockerfile'/);

    const bad2 = yaml.dump({
      version: 'v1',
      name: 'x',
      task: { prompt: 'x' },
      environment: { image: {} },
      evaluation: { criteria: [] },
    });
    expect(() => parseV1(bad2)).toThrow(/exactly one of 'base' or 'dockerfile'/);
  });

  it('enforces exactly-one-of workspace.source.path | imagePath', () => {
    const bad = baseYaml({
      workspace: { sources: [{ path: './x', imagePath: '/y' }] },
    });
    expect(() => parseV1(bad)).toThrow(/exactly one of 'path' or 'imagePath'/);
  });

  it('enforces per-type required fields on criteria', () => {
    const noRun = baseYaml({
      evaluation: {
        criteria: [{ id: 'x', title: 'X', type: 'script' }],
      },
    });
    expect(() => parseV1(noRun)).toThrow(/run must be a string|run.*required/i);

    const noInstructions = baseYaml({
      evaluation: {
        criteria: [{ id: 'j', title: 'Judge', type: 'judge' }],
      },
    });
    expect(() => parseV1(noInstructions)).toThrow(/instructions/);
  });

  it('rejects invalid durations', () => {
    const bad = baseYaml({ run: { timeout: 300 as unknown as string } });
    expect(() => parseV1(bad)).toThrow(/duration/i);
  });

  it('rejects unknown criterion type', () => {
    const bad = baseYaml({
      evaluation: {
        criteria: [{ id: 'x', title: 'X', type: 'supervisor', run: 'pytest' }],
      },
    });
    expect(() => parseV1(bad)).toThrow(/unknown type/);
  });
});

// ---------------------------------------------------------------------------
// Criterion dependency graph
// ---------------------------------------------------------------------------

describe('validateCriteriaGraph', () => {
  it('rejects duplicate criterion ids', () => {
    const bad = baseYaml({
      evaluation: {
        criteria: [
          { id: 'x', title: 'X', type: 'script', run: 'a' },
          { id: 'x', title: 'X2', type: 'script', run: 'b' },
        ],
      },
    });
    expect(() => parseV1(bad)).toThrow(/duplicate criterion id/);
  });

  it('rejects unknown needs references', () => {
    const bad = baseYaml({
      evaluation: {
        criteria: [
          { id: 'a', title: 'A', type: 'script', run: 'x' },
          {
            id: 'b',
            title: 'B',
            type: 'script',
            run: 'y',
            needs: ['missing'],
          },
        ],
      },
    });
    expect(() => parseV1(bad)).toThrow(/unknown criterion id.*missing/);
  });

  it('rejects forward-references in needs (cycle-avoidance: ordering only looks back)', () => {
    const bad = baseYaml({
      evaluation: {
        criteria: [
          {
            id: 'a',
            title: 'A',
            type: 'script',
            run: 'x',
            needs: ['b'],
          },
          { id: 'b', title: 'B', type: 'script', run: 'y' },
        ],
      },
    });
    expect(() => parseV1(bad)).toThrow(/appears later in the list/);
  });

  it('rejects report.needs referencing an unknown criterion', () => {
    const bad = baseYaml({
      evaluation: {
        criteria: [
          { id: 'a', title: 'A', type: 'script', run: 'x' },
        ],
        report: { instructions: 's', needs: ['missing'] },
      },
    });
    expect(() => parseV1(bad)).toThrow(/evaluation.report.needs.*missing/);
  });

  it('accepts validateCriteriaGraph on a synthetic config', () => {
    const config: ExperimentConfig = {
      version: 'v1',
      name: 'x',
      task: { prompt: 'x' },
      environment: { image: { base: 'b' } },
      evaluation: {
        container: 'dedicated',
        criteria: [
          { id: 'a', title: 'A', type: 'script', run: 'pytest' },
          {
            id: 'b',
            title: 'B',
            type: 'aggregate',
            needs: ['a'],
            aggregate: { function: 'all' },
          },
        ],
      },
    };
    expect(() => validateCriteriaGraph(config)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Workspace sources
// ---------------------------------------------------------------------------

describe('resolveWorkspaceSources', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-wss-'));
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns [] for undefined or empty sources', () => {
    expect(resolveWorkspaceSources(undefined, tempDir)).toEqual([]);
    expect(resolveWorkspaceSources([], tempDir)).toEqual([]);
  });

  it('resolves a path entry to an absolute source path', () => {
    const subdir = path.join(tempDir, 'workspace');
    fs.mkdirSync(subdir);
    fs.writeFileSync(path.join(subdir, 'README.md'), 'x');

    const resolved = resolveWorkspaceSources([{ path: './workspace' }], tempDir);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].type).toBe('path');
    expect(resolved[0].sourcePath).toBe(subdir);
  });

  it('errors on missing path', () => {
    expect(() =>
      resolveWorkspaceSources([{ path: './nope' }], tempDir),
    ).toThrow(/does not exist/);
  });

  it('assigns a default target=basename for file sources', () => {
    const f = path.join(tempDir, 'hello.txt');
    fs.writeFileSync(f, 'x');
    const resolved = resolveWorkspaceSources([{ path: './hello.txt' }], tempDir);
    expect(resolved[0].target).toBe('hello.txt');
  });

  it('passes through image sources verbatim', () => {
    const resolved = resolveWorkspaceSources(
      [{ imagePath: '/app/seed', target: 'seed' }],
      tempDir,
    );
    expect(resolved[0]).toMatchObject({
      type: 'image',
      sourcePath: '/app/seed',
      target: 'seed',
    });
  });

  it('detects same-target file collisions and names both sources', () => {
    const a = path.join(tempDir, 'a.txt');
    const b = path.join(tempDir, 'b.txt');
    fs.writeFileSync(a, 'a');
    fs.writeFileSync(b, 'b');

    expect(() =>
      resolveWorkspaceSources(
        [
          { path: './a.txt', target: 'shared.txt' },
          { path: './b.txt', target: 'shared.txt' },
        ],
        tempDir,
      ),
    ).toThrow(/collision/);
    try {
      resolveWorkspaceSources(
        [
          { path: './a.txt', target: 'shared.txt' },
          { path: './b.txt', target: 'shared.txt' },
        ],
        tempDir,
      );
    } catch (err) {
      expect((err as Error).message).toContain('./a.txt');
      expect((err as Error).message).toContain('./b.txt');
      expect((err as Error).message).toContain('shared.txt');
    }
  });

  it('detects two directory sources that both root-merge', () => {
    const a = path.join(tempDir, 'a');
    const b = path.join(tempDir, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    expect(() =>
      resolveWorkspaceSources([{ path: './a' }, { path: './b' }], tempDir),
    ).toThrow(/collision/);
  });
});

// ---------------------------------------------------------------------------
// Variant merge semantics
// ---------------------------------------------------------------------------

describe('applyVariant', () => {
  function withVariants(variants: Record<string, unknown>): ExperimentConfig {
    return parseV1(
      baseYaml({
        variants,
      }),
    );
  }

  it('errors on unknown variant', () => {
    const base = withVariants({});
    expect(() => applyVariant(base, 'nope')).toThrow(/unknown variant/i);
  });

  it('shallow-merges scalars and objects', () => {
    const base = withVariants({
      alt: {
        description: 'Overridden description',
        run: { timeout: '30m' },
      },
    });
    const merged = applyVariant(base, 'alt');
    expect(merged.description).toBe('Overridden description');
    expect(merged.run?.timeout).toBe('30m');
  });

  it('arrays replace wholesale except evaluation.criteria', () => {
    const base = withVariants({
      alt: {
        environment: { platforms: ['linux/arm64'] },
      },
    });
    const merged = applyVariant(base, 'alt');
    expect(merged.environment.platforms).toEqual(['linux/arm64']);
  });

  it('replaces a base criterion with a same-id override', () => {
    const base = withVariants({
      alt: {
        evaluation: {
          criteria: [
            {
              id: 'tests-pass',
              title: 'Tests Pass (alt)',
              type: 'script',
              run: 'pytest --hard',
            },
          ],
        },
      },
    });
    const merged = applyVariant(base, 'alt');
    expect(merged.evaluation.criteria).toHaveLength(1);
    expect(merged.evaluation.criteria[0]).toMatchObject({
      id: 'tests-pass',
      title: 'Tests Pass (alt)',
      type: 'script',
      run: 'pytest --hard',
    });
  });

  it('appends new criteria from variants', () => {
    const base = withVariants({
      alt: {
        evaluation: {
          criteria: [
            {
              id: 'extra',
              title: 'Extra',
              type: 'judge',
              instructions: 'look',
            },
          ],
        },
      },
    });
    const merged = applyVariant(base, 'alt');
    expect(merged.evaluation.criteria.map((c) => c.id)).toEqual([
      'tests-pass',
      'extra',
    ]);
  });

  it('variants cannot delete base criteria (still present after merge)', () => {
    const base = withVariants({
      alt: { evaluation: {} },
    });
    const merged = applyVariant(base, 'alt');
    expect(merged.evaluation.criteria.map((c) => c.id)).toContain('tests-pass');
  });

  it('drops variants from the merged config', () => {
    const base = withVariants({ alt: { description: 'z' } });
    const merged = applyVariant(base, 'alt');
    expect(merged.variants).toBeUndefined();
  });

  it('re-validates the criteria graph after applying a variant', () => {
    const base = withVariants({
      alt: {
        evaluation: {
          criteria: [
            {
              id: 'tests-pass',
              title: 'Tests Pass',
              type: 'script',
              run: 'x',
              needs: ['missing'],
            },
          ],
        },
      },
    });
    expect(() => applyVariant(base, 'alt')).toThrow(/unknown criterion id/);
  });

  it('merges variant env over base env, variant keys winning', () => {
    const base = withVariants({
      alt: { env: { SHARED: 'variant', VARIANT_ONLY: 'yes' } },
    });
    base.env = { SHARED: 'base', BASE_ONLY: 'yes' };
    const merged = applyVariant(base, 'alt');
    expect(merged.env).toEqual({
      SHARED: 'variant',
      BASE_ONLY: 'yes',
      VARIANT_ONLY: 'yes',
    });
  });

  it('merges variant passEnv with base passEnv, deduplicated', () => {
    const base = withVariants({
      alt: { passEnv: ['SHARED', 'VARIANT_ONLY'] },
    });
    base.passEnv = ['SHARED', 'BASE_ONLY'];
    const merged = applyVariant(base, 'alt');
    expect(merged.passEnv).toEqual(['SHARED', 'BASE_ONLY', 'VARIANT_ONLY']);
  });
});

// ---------------------------------------------------------------------------
// env + passEnv parsing
// ---------------------------------------------------------------------------

describe('experiment env / passEnv', () => {
  it('parses a top-level env map', () => {
    const config = parseV1(baseYaml({ env: { FOO: 'bar', BAZ: 'qux' } }));
    expect(config.env).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('parses a top-level passEnv list', () => {
    const config = parseV1(baseYaml({ passEnv: ['HOME', 'PATH'] }));
    expect(config.passEnv).toEqual(['HOME', 'PATH']);
  });

  it('rejects env values that are not strings', () => {
    expect(() => parseV1(baseYaml({ env: { N: 3 } }))).toThrow(/must be a string/);
  });

  it('rejects env keys in the reserved BUNSEN_ namespace', () => {
    expect(() => parseV1(baseYaml({ env: { BUNSEN_CUSTOM: 'x' } }))).toThrow(
      /reserved/,
    );
  });

  it('rejects passEnv entries in the reserved BUNSEN_ namespace', () => {
    expect(() => parseV1(baseYaml({ passEnv: ['BUNSEN_RUN_ID'] }))).toThrow(/reserved/);
  });

  it('rejects duplicate passEnv entries', () => {
    expect(() => parseV1(baseYaml({ passEnv: ['HOME', 'HOME'] }))).toThrow(/duplicate/);
  });

  it('parses env and passEnv inside a variant overlay', () => {
    const config = parseV1(
      baseYaml({
        variants: {
          alt: {
            env: { FOO: 'variant' },
            passEnv: ['VAR_HOST'],
          },
        },
      }),
    );
    expect(config.variants?.alt.env).toEqual({ FOO: 'variant' });
    expect(config.variants?.alt.passEnv).toEqual(['VAR_HOST']);
  });
});

// ---------------------------------------------------------------------------
// loadExperiment (filesystem-level)
// ---------------------------------------------------------------------------

describe('loadExperiment', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-load-'));
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('throws when experiment.yaml is missing', () => {
    expect(() => loadV1(tempDir)).toThrow(/experiment.yaml not found/);
  });

  it('loads a valid experiment with resolved workspace sources', () => {
    const dir = path.join(tempDir, 'exp');
    fs.mkdirSync(dir);
    fs.mkdirSync(path.join(dir, 'workspace'));
    fs.writeFileSync(path.join(dir, 'workspace', 'main.py'), 'print(1)');
    fs.writeFileSync(
      path.join(dir, 'experiment.yaml'),
      baseYaml({ workspace: { sources: [{ path: './workspace' }] } }),
    );

    const resolved = loadV1(dir);
    expect(resolved.name).toBe('demo');
    expect(resolved.workspaceSources).toHaveLength(1);
    expect(resolved.workspaceSources[0].sourcePath).toBe(
      path.join(dir, 'workspace'),
    );
    expect(resolved.hasDockerfile).toBe(false);
    expect(resolved.hasVerifiers).toBe(false);
  });

  it('detects Dockerfile + verifiers/', () => {
    const dir = path.join(tempDir, 'exp');
    fs.mkdirSync(dir);
    fs.mkdirSync(path.join(dir, 'verifiers'));
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM x');
    fs.writeFileSync(path.join(dir, 'experiment.yaml'), baseYaml());
    const resolved = loadV1(dir);
    expect(resolved.hasDockerfile).toBe(true);
    expect(resolved.hasVerifiers).toBe(true);
    expect(resolved.verifiersPath).toBe(path.join(dir, 'verifiers'));
  });

  it('applies a variant when requested', () => {
    const dir = path.join(tempDir, 'exp');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'experiment.yaml'),
      baseYaml({ variants: { alt: { description: 'alt run' } } }),
    );
    const resolved = loadV1(dir, 'alt');
    expect(resolved.variant).toBe('alt');
    expect(resolved.description).toBe('alt run');
  });
});

// ---------------------------------------------------------------------------
// In-repo experiment files load through the new parser
// ---------------------------------------------------------------------------

describe('in-repo experiments round-trip', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');

  function collect(dir: string, out: string[]): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(abs, out);
      else if (entry.isFile() && entry.name === 'experiment.yaml') out.push(abs);
    }
  }

  const yamlPaths: string[] = [];
  collect(path.join(repoRoot, 'examples/experiments'), yamlPaths);
  // Also exercise the external Terminal Bench suite from the standard
  // `bn suites` cache path. Skipped when the cache isn't materialized
  // (i.e., the developer hasn't run `bn suites update terminal-bench`).
  collect(
    path.join(
      repoRoot,
      '.bunsen',
      'suites',
      'github.com__bunsen-dev__terminal-bench',
      'experiments',
    ),
    yamlPaths,
  );

  it('found a non-zero set of experiments to exercise', () => {
    expect(yamlPaths.length).toBeGreaterThan(10);
  });

  it.each(yamlPaths)('parses %s through the v1 loader', (yamlPath) => {
    const source = fs.readFileSync(yamlPath, 'utf8');
    expect(() => parseV1(source, { source: yamlPath })).not.toThrow();
  });
});
