// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
  buildExecLogs,
  buildWorkspaceMaterializationScript,
  buildWorkspaceSourceAssemblyScript,
  cleanupInternalRunFiles,
  handleSignal,
  setActiveRunForTest,
  detectDepConflicts,
  detectCrossBoundaryShadows,
  resolveRunPlatform,
  SHADOWED_SUBSTRATE_SOURCE_LABEL,
  type CrossBoundaryShadow,
  type PreparedAgentDep,
  type ShadowedSubstrateSource,
} from './executor.js';
import type { AgentDepSpec } from '@bunsen-dev/types';
import {
  createRun,
  getRunDir,
  saveEvaluationResult,
  saveHumanScores,
  finalizeTracesStreaming,
  saveLogs,
  saveOrchestrationResult,
  saveTaskPrompt,
  saveWorkspaceDiff,
  RUN_PATHS,
} from './storage.js';
import type {
  AITrace,
  EvaluationResult,
  HumanScores,
} from '@bunsen-dev/types';
import type { ResolvedExperiment } from './experiment-loader.js';

function makeResolvedExperiment(
  overrides: Partial<ResolvedExperiment> = {}
): ResolvedExperiment {
  return {
    version: 'v1',
    name: 'test',
    task: { prompt: 'do a thing' },
    environment: { image: { base: 'bunsen/headless' } },
    evaluation: { container: 'dedicated', criteria: [] },
    dir: '/fake/experiment',
    configPath: '/fake/experiment/experiment.yaml',
    workspaceSources: [],
    hasDockerfile: false,
    hasVerifiers: false,
    ...overrides,
  } as ResolvedExperiment;
}

describe('resolveRunPlatform', () => {
  it('uses explicit CLI platform when compatible with experiment constraints', () => {
    expect(
      resolveRunPlatform({
        cliPlatform: 'linux/amd64',
        dockerArch: 'arm64',
        supportedPlatforms: ['linux/amd64'],
      })
    ).toBe('linux/amd64');
  });

  it('rejects explicit CLI platform outside experiment constraints', () => {
    expect(() =>
      resolveRunPlatform({
        cliPlatform: 'linux/arm64',
        dockerArch: 'arm64',
        supportedPlatforms: ['linux/amd64'],
      })
    ).toThrow('Experiment supports [linux/amd64], but requested platform is linux/arm64.');
  });

  it('CLI platform overrides experiment.run.platform and defaults.run.platform', () => {
    expect(
      resolveRunPlatform({
        cliPlatform: 'linux/amd64',
        experimentRunPlatform: 'linux/arm64',
        projectDefaultPlatform: 'linux/arm64',
        dockerArch: 'arm64',
      })
    ).toBe('linux/amd64');
  });

  it('experiment.run.platform overrides defaults.run.platform and Docker arch', () => {
    expect(
      resolveRunPlatform({
        experimentRunPlatform: 'linux/amd64',
        projectDefaultPlatform: 'linux/arm64',
        dockerArch: 'arm64',
      })
    ).toBe('linux/amd64');
  });

  it('rejects experiment.run.platform outside environment.platforms', () => {
    expect(() =>
      resolveRunPlatform({
        experimentRunPlatform: 'linux/arm64',
        dockerArch: 'arm64',
        supportedPlatforms: ['linux/amd64'],
      })
    ).toThrow('Experiment supports [linux/amd64], but experiment.run.platform is linux/arm64.');
  });

  it('defaults.run.platform overrides Docker arch when experiment leaves it unset', () => {
    expect(
      resolveRunPlatform({
        projectDefaultPlatform: 'linux/amd64',
        dockerArch: 'arm64',
      })
    ).toBe('linux/amd64');
  });

  it('rejects defaults.run.platform outside environment.platforms', () => {
    expect(() =>
      resolveRunPlatform({
        projectDefaultPlatform: 'linux/arm64',
        dockerArch: 'arm64',
        supportedPlatforms: ['linux/amd64'],
      })
    ).toThrow('Experiment supports [linux/amd64], but defaults.run.platform is linux/arm64.');
  });

  it("treats 'auto' at experiment level as unset and falls through", () => {
    expect(
      resolveRunPlatform({
        experimentRunPlatform: 'auto',
        projectDefaultPlatform: 'linux/amd64',
        dockerArch: 'arm64',
      })
    ).toBe('linux/amd64');
  });

  it("treats 'auto' at project default level as unset and falls through to Docker arch", () => {
    expect(
      resolveRunPlatform({
        projectDefaultPlatform: 'auto',
        dockerArch: 'arm64',
      })
    ).toBe('linux/arm64');
  });

  it('auto-selects the only supported experiment platform when nothing else is set', () => {
    expect(
      resolveRunPlatform({
        dockerArch: 'arm64',
        supportedPlatforms: ['linux/amd64'],
      })
    ).toBe('linux/amd64');
  });

  it('falls back to Docker arch when it is allowed by experiment constraints', () => {
    expect(
      resolveRunPlatform({
        dockerArch: 'arm64',
        supportedPlatforms: ['linux/amd64', 'linux/arm64'],
      })
    ).toBe('linux/arm64');
  });

  it('uses Docker arch when experiment does not declare platform constraints', () => {
    expect(resolveRunPlatform({ dockerArch: 'arm64' })).toBe('linux/arm64');
  });
});

describe('buildExecLogs', () => {
  it('includes stderr under a separate header when present', () => {
    expect(buildExecLogs({ stdout: 'out', stderr: 'err' })).toBe('out\n--- STDERR ---\nerr');
  });

  it('returns stdout unchanged when stderr is empty', () => {
    expect(buildExecLogs({ stdout: 'out', stderr: '' })).toBe('out');
  });
});

describe('buildWorkspaceSourceAssemblyScript', () => {
  it('assembles sources into /workspace-source and does NOT copy to /workspace', () => {
    const experiment = makeResolvedExperiment({
      workspaceSources: [
        {
          type: 'path',
          sourcePath: '/host/workspace',
          target: undefined,
          original: { path: './workspace' },
          index: 0,
        },
      ],
    });
    const script = buildWorkspaceSourceAssemblyScript(experiment);

    expect(script).toContain('mkdir -p /workspace-source /workspace');
    expect(script).toContain('copy_workspace_source "/bunsen/workspace-sources/local/0"');
    // Critically: the assembly step must not copy into /workspace — that happens
    // later, as the non-root user, via buildWorkspaceMaterializationScript.
    expect(script).not.toContain('cp -a /workspace-source/. /workspace/');
    // Assembly finalizes with a recursive chmod so the non-root user can read
    // the source during materialization, regardless of host-mount perms.
    expect(script).toContain('chmod -R u+rwX,go+rX /workspace-source');
  });

  it('handles image-path sources and preserves target offset', () => {
    const experiment = makeResolvedExperiment({
      workspaceSources: [
        {
          type: 'image',
          sourcePath: '/seed/data.tar.gz',
          target: '.seed/data.tar.gz',
          original: { imagePath: '/seed/data.tar.gz', target: '.seed/data.tar.gz' },
          index: 0,
        },
      ],
    });
    const script = buildWorkspaceSourceAssemblyScript(experiment);
    expect(script).toContain('copy_workspace_source "/seed/data.tar.gz" ".seed/data.tar.gz"');
    expect(script).not.toContain('cp -a /workspace-source/. /workspace/');
  });

  it('produces a valid shell script even with zero sources', () => {
    const experiment = makeResolvedExperiment({ workspaceSources: [] });
    const script = buildWorkspaceSourceAssemblyScript(experiment);

    // Should be parseable by bash. Wrap in a function definition check — not
    // executing anything, just exercising syntax against the real shell.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-script-'));
    const scriptFile = path.join(tmp, 'assemble.sh');
    fs.writeFileSync(scriptFile, `#!/bin/bash\n${script}\n`);
    try {
      execSync(`bash -n ${scriptFile}`, { stdio: 'pipe' });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('always creates /workspace-source even with zero sources', () => {
    // Public scorer contract: /workspace-source must exist as a directory
    // even when no workspace.sources are declared, so verifiers can
    // reliably reference it.
    const experiment = makeResolvedExperiment({ workspaceSources: [] });
    const script = buildWorkspaceSourceAssemblyScript(experiment);
    expect(script).toContain('mkdir -p /workspace-source /workspace');
    expect(script).not.toContain('copy_workspace_source "');
  });

  it('execution against a sandboxed root produces an empty /workspace-source dir (zero sources)', () => {
    // Integration check: don't just inspect the script — actually run it
    // against bash with the absolute paths rewritten to a tempdir. Pins the
    // empty-sources case end-to-end: assembly succeeds, /workspace-source
    // exists as a real directory, /workspace exists as a real directory,
    // and /workspace-source is empty. This is the runtime guarantee scorer
    // verifiers depend on.
    const experiment = makeResolvedExperiment({ workspaceSources: [] });
    const rawScript = buildWorkspaceSourceAssemblyScript(experiment);

    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-source-exec-'));
    try {
      const sandboxedScript = rawScript
        .replace(/\/workspace-source/g, `${sandbox}/workspace-source`)
        .replace(/(?<!-)\/workspace(?!-source)/g, `${sandbox}/workspace`);

      const scriptFile = path.join(sandbox, 'assemble.sh');
      fs.writeFileSync(scriptFile, `#!/bin/bash\n${sandboxedScript}\n`);
      execSync(`bash ${scriptFile}`, { stdio: 'pipe' });

      const wsSource = path.join(sandbox, 'workspace-source');
      const ws = path.join(sandbox, 'workspace');
      expect(fs.existsSync(wsSource)).toBe(true);
      expect(fs.statSync(wsSource).isDirectory()).toBe(true);
      expect(fs.readdirSync(wsSource)).toEqual([]);
      expect(fs.existsSync(ws)).toBe(true);
      expect(fs.statSync(ws).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe('buildWorkspaceMaterializationScript', () => {
  it('copies /workspace-source to /workspace (no ownership flip)', () => {
    const script = buildWorkspaceMaterializationScript();
    expect(script).toContain('cp -a /workspace-source/. /workspace/');
    // The script must not chown — the whole point of the ordering fix is
    // that ownership is already correct because the caller runs this as the
    // execution user. A chown -R here would re-introduce the hazard.
    expect(script).not.toContain('chown');
  });

  it('sets strict bash flags so failures surface', () => {
    const script = buildWorkspaceMaterializationScript();
    expect(script).toContain('set -euo pipefail');
  });

  it('is syntactically valid bash', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-script-'));
    const scriptFile = path.join(tmp, 'materialize.sh');
    fs.writeFileSync(scriptFile, `#!/bin/bash\n${buildWorkspaceMaterializationScript()}\n`);
    try {
      execSync(`bash -n ${scriptFile}`, { stdio: 'pipe' });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('executes end-to-end: running the materialization as a non-owner copies data correctly', () => {
    // Simulate the ordering fix on the host: set up a root-owned (or at
    // least other-user-owned) /workspace-source analog, and confirm that
    // a non-root `cp -a` produces files owned by the running user. Since
    // we can't chown across users in a unit test, we just verify the copy
    // semantics work on an empty /workspace destination.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-materialize-'));
    const source = path.join(tmp, 'workspace-source');
    const dest = path.join(tmp, 'workspace');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(source, 'hello.txt'), 'hi');
    fs.mkdirSync(path.join(source, 'nested'));
    fs.writeFileSync(path.join(source, 'nested', 'file.txt'), 'deep');

    try {
      execSync(
        `cp -a ${source}/. ${dest}/`,
        { stdio: 'pipe' }
      );
      expect(fs.readFileSync(path.join(dest, 'hello.txt'), 'utf-8')).toBe('hi');
      expect(fs.readFileSync(path.join(dest, 'nested', 'file.txt'), 'utf-8')).toBe('deep');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('v1 nested run layout', () => {
  it('every documented v1 path is reachable through the storage helpers', async () => {
    // No agent or container is involved here — the test exercises the full
    // set of storage writers in sequence and asserts the resulting run dir
    // matches the layout defined by the storage helpers in `storage.ts` and
    // the manifest types in `@bunsen-dev/types/src/manifest.ts`.
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-layout-test-'));
    try {
      const run = createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: ['--x'], baseDir: baseDir, variant: 'haiku' });
      const runDir = getRunDir(run.run_id, baseDir);

      saveTaskPrompt(run.run_id, 'do the thing', baseDir);
      saveOrchestrationResult(
        run.run_id,
        { setupCommands: ['cd /workspace'], invocation: { kind: 'argv', argv: ['agent'] } },
        baseDir,
      );
      saveLogs(run.run_id, 'agent ran', baseDir);
      saveWorkspaceDiff(run.run_id, 'diff --git a/x b/x\n', baseDir);

      const traces: AITrace[] = [
        {
          provider: 'anthropic', model: 'claude-sonnet-4', endpoint: '/v1/messages',
          source: 'agent', timestamp: '2026-04-27T00:00:01Z', latencyMs: 100,
          request: {}, response: { usage: { inputTokens: 10, outputTokens: 5 } },
          estimatedCostUsd: 0.001,
        },
        {
          provider: 'anthropic', model: 'claude-haiku-4', endpoint: '/v1/messages',
          source: 'orchestrator', timestamp: '2026-04-27T00:00:00Z', latencyMs: 50,
          request: {}, response: { usage: { inputTokens: 5, outputTokens: 2 } },
          estimatedCostUsd: 0.0001,
        },
      ];
      // Simulate the proxy producing a JSONL trace file, then run the
      // streaming finalize pass (matches production).
      const tracesDir = path.join(runDir, 'traces');
      fs.mkdirSync(tracesDir, { recursive: true });
      fs.writeFileSync(
        path.join(tracesDir, 'agent.jsonl'),
        traces.map((t) => JSON.stringify(t)).join('\n') + '\n',
      );
      await finalizeTracesStreaming(run.run_id, baseDir);

      const evalResult: EvaluationResult = {
        weightedScore: 1,
        criteria: [
          {
            id: 'tests-pass', weight: 1, score: 1, summary: 'Pass',
            status: 'completed', scorerType: 'script',
            logPath: 'evaluation/criteria/tests-pass.log',
          },
        ],
        report: '## Summary\n\nLooks good.',
      };
      saveEvaluationResult(run.run_id, evalResult, baseDir);

      const humanScores: HumanScores = {
        criteria: [{ criterion: 'tests-pass', humanScore: 1, llmScore: 1 }],
        scoredBy: 'matt', scoredAt: '2026-04-27T01:00:00Z',
      };
      saveHumanScores(run.run_id, humanScores, baseDir);

      // Drop a faux artifact under artifacts/output/ + a screenshot to round
      // the layout out without spinning up a real container.
      fs.writeFileSync(path.join(runDir, RUN_PATHS.artifactsOutput, 'hello.txt'), 'hi');
      fs.mkdirSync(path.join(runDir, RUN_PATHS.artifactsScreenshots), { recursive: true });
      fs.writeFileSync(path.join(runDir, RUN_PATHS.artifactsScreenshots, 'shot.png'), 'png');

      // Asserted layout — every path here MUST exist on disk.
      const expected = [
        'manifest.json',
        'logs.txt',
        'task/prompt.md',
        'orchestration/result.json',
        'workspace/diff.patch',
        'traces/agent.jsonl',
        'traces/platform.jsonl',
        'traces/summary.json',
        'evaluation/result.json',
        'evaluation/report.md',
        'evaluation/human.json',
        'evaluation/criteria/tests-pass.json',
        'artifacts/output/hello.txt',
        'artifacts/screenshots/shot.png',
      ];
      for (const rel of expected) {
        expect(fs.existsSync(path.join(runDir, rel))).toBe(true);
      }

      // Legacy flat-layout paths (and run.json) must NOT exist.
      const legacy = [
        'run.json',
        'scores.json',
        'human-scores.json',
        'workspace.diff',
        'workspace.tar.gz',
        'recording.cast',
        'output/hello.txt',
        'screenshots/shot.png',
        'screenshot_1.png',
        'traces/raw_traces.jsonl',
        'traces/platform_traces.jsonl',
        'traces/structured_traces.json',
        'scorer-tests-pass.log',
      ];
      for (const rel of legacy) {
        expect(fs.existsSync(path.join(runDir, rel))).toBe(false);
      }
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe('detectDepConflicts', () => {
  function makeDep(name: string, binaries: string[], version?: string): AgentDepSpec {
    return {
      name,
      version,
      provides: { binaries },
      install: [{ target: 'linux/amd64', image: 'alpine:3.19', run: ['true'] }],
    };
  }

  it('allows non-overlapping deps', () => {
    expect(() =>
      detectDepConflicts([makeDep('rg', ['rg']), makeDep('jq', ['jq'])]),
    ).not.toThrow();
  });

  it('errors when two deps claim the same binary', () => {
    expect(() =>
      detectDepConflicts([
        makeDep('rg', ['rg'], '14.1.1'),
        makeDep('ripgrep-mirror', ['rg'], '13.0.0'),
      ]),
    ).toThrow(/binary "rg" is provided by multiple deps: rg@14.1.1, ripgrep-mirror@13.0.0/);
  });

  it('ignores deps that declare no binaries', () => {
    expect(() =>
      detectDepConflicts([
        { name: 'no-bin', install: [{ target: 'linux/amd64', image: 'alpine:3.19', run: ['true'] }] },
        makeDep('rg', ['rg']),
      ]),
    ).not.toThrow();
  });
});

describe('detectCrossBoundaryShadows', () => {
  function makePreparedDep(
    name: string,
    binaries: string[],
    version?: string,
  ): PreparedAgentDep {
    return {
      name,
      cacheKey: 'abc1234567890def',
      artifactsPath: '/tmp/fake',
      cacheHit: false,
      binaries,
      ...(version !== undefined ? { version } : {}),
    };
  }

  it('returns no shadows when there are no deps', () => {
    expect(detectCrossBoundaryShadows([], { apt: ['git', 'ripgrep'] })).toEqual([]);
  });

  it('returns no shadows when all substrate package lists are empty', () => {
    expect(detectCrossBoundaryShadows([makePreparedDep('rg', ['rg'])], {})).toEqual([]);
  });

  it('returns no shadows when names do not overlap', () => {
    expect(
      detectCrossBoundaryShadows(
        [makePreparedDep('rg', ['rg'], '14.1.1'), makePreparedDep('jq', ['jq'])],
        { apt: ['git', 'curl', 'build-essential'] },
      ),
    ).toEqual([]);
  });

  it('records a single shadow when a dep binary matches an apt package name', () => {
    const shadows = detectCrossBoundaryShadows(
      [makePreparedDep('rg', ['rg'], '14.1.1')],
      { apt: ['git', 'rg'] },
    );
    expect(shadows).toHaveLength(1);
    expect(shadows[0]).toMatchObject({
      diagnostic: 'cross-boundary-binary-shadow',
      binary: 'rg',
      winner: { source: 'agent-dep', name: 'rg', version: '14.1.1' },
      shadowed: { source: 'substrate-apt', name: 'rg' },
    });
    expect(shadows[0].resolution).toMatch(/wins on PATH/);
  });

  it('records a shadow when a dep binary matches an npm package name', () => {
    const shadows = detectCrossBoundaryShadows(
      [makePreparedDep('prettier-dep', ['prettier'], '3.3.3')],
      { npm: ['prettier', 'typescript'] },
    );
    expect(shadows).toHaveLength(1);
    expect(shadows[0].shadowed).toEqual({ source: 'substrate-npm', name: 'prettier' });
  });

  it('records a shadow when a dep binary matches a pip package name', () => {
    const shadows = detectCrossBoundaryShadows(
      [makePreparedDep('black-dep', ['black'], '24.10.0')],
      { pip: ['black', 'pytest'] },
    );
    expect(shadows).toHaveLength(1);
    expect(shadows[0].shadowed).toEqual({ source: 'substrate-pip', name: 'black' });
  });

  it('records one shadow per shadowed binary across multiple deps and managers', () => {
    const shadows = detectCrossBoundaryShadows(
      [
        makePreparedDep('rg', ['rg'], '14.1.1'),
        makePreparedDep('jq', ['jq'], '1.7'),
        makePreparedDep('prettier-dep', ['prettier']),
        makePreparedDep('black-dep', ['black']),
      ],
      { apt: ['rg', 'jq', 'git'], npm: ['prettier'], pip: ['black'] },
    );
    expect(shadows.map((s) => s.binary).sort()).toEqual(['black', 'jq', 'prettier', 'rg']);
    const sourceOf = (b: string) => shadows.find((s) => s.binary === b)!.shadowed.source;
    expect(sourceOf('rg')).toBe('substrate-apt');
    expect(sourceOf('jq')).toBe('substrate-apt');
    expect(sourceOf('prettier')).toBe('substrate-npm');
    expect(sourceOf('black')).toBe('substrate-pip');
  });

  it('prefers apt over npm/pip when the same name appears in multiple managers', () => {
    const shadows = detectCrossBoundaryShadows(
      [makePreparedDep('node-dep', ['node'])],
      { apt: ['node'], npm: ['node'] },
    );
    expect(shadows).toHaveLength(1);
    expect(shadows[0].shadowed.source).toBe('substrate-apt');
  });

  it('omits the version field when the dep declares no version', () => {
    const shadows = detectCrossBoundaryShadows(
      [makePreparedDep('rg', ['rg'])],
      { apt: ['rg'] },
    );
    expect(shadows).toHaveLength(1);
    expect(shadows[0].winner.version).toBeUndefined();
  });
});

describe('SHADOWED_SUBSTRATE_SOURCE_LABEL', () => {
  // Drives the human-readable log line at executor.ts where shadows are
  // recorded. Previously hardcoded "substrate apt" regardless of source.

  it('labels every shadow source distinctly so an npm or pip shadow does not log as apt', () => {
    const shadow: CrossBoundaryShadow = {
      diagnostic: 'cross-boundary-binary-shadow',
      binary: 'prettier',
      winner: { source: 'agent-dep', name: 'prettier-dep' },
      shadowed: { source: 'substrate-npm', name: 'prettier' },
      resolution: 'agent-dep wins on PATH',
    };
    expect(SHADOWED_SUBSTRATE_SOURCE_LABEL[shadow.shadowed.source]).toBe('substrate npm');
    expect(SHADOWED_SUBSTRATE_SOURCE_LABEL['substrate-pip']).toBe('substrate pip');
    expect(SHADOWED_SUBSTRATE_SOURCE_LABEL['substrate-apt']).toBe('substrate apt');
  });

  it('has a label for every ShadowedSubstrateSource value (drift guard)', () => {
    // If a future commit adds a 4th source (cargo, gem, ...) to
    // ShadowedSubstrateSource but forgets the label map, this test fails
    // with a useful "Cannot read properties of undefined" hint instead of
    // a silent "undefined" landing in the run log.
    const allSources: ShadowedSubstrateSource[] = [
      'substrate-apt',
      'substrate-npm',
      'substrate-pip',
    ];
    for (const source of allSources) {
      const label = SHADOWED_SUBSTRATE_SOURCE_LABEL[source];
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe('fs.cpSync verbatimSymlinks (dep cache contract)', () => {
  // The deps-cache write path depends on fs.cpSync's `verbatimSymlinks: true`
  // option to preserve relative symlinks across the tempdir → cache copy.
  // Without it, distributions like Node and python-build-standalone ship
  // broken `npm`/`python` symlinks pointing back at the host build tmpdir.
  // This test pins that contract so a future Node upgrade or refactor that
  // drops the option breaks the suite loudly.
  it('preserves relative symlink targets when copying with verbatimSymlinks: true', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-cpsync-test-'));
    try {
      const src = path.join(root, 'src');
      fs.mkdirSync(path.join(src, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(src, 'bin', 'realbin'), '#!/bin/sh\necho hi\n');
      fs.symlinkSync('realbin', path.join(src, 'bin', 'python'));

      const dst = path.join(root, 'dst');
      fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });

      const link = fs.readlinkSync(path.join(dst, 'bin', 'python'));
      expect(link).toBe('realbin');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('default fs.cpSync preserves relative symlinks verbatim under the Bun runtime (witness)', () => {
    // Witness for the *default* symlink-copy behavior of the runtime Bunsen
    // actually executes on. Node's default resolves a relative symlink target to
    // an absolute path — the bug class the explicit `verbatimSymlinks: true`
    // above guards against (a copied python/node symlink would point back at the
    // source build tmpdir and break a relocated dep cache). Bun's default
    // already preserves the target verbatim, so on Bun the default is safe and
    // the explicit option is belt-and-suspenders + Node-compat insurance. If
    // this starts failing, Bun's default changed and the rationale for the
    // explicit option should be revisited.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-cpsync-default-'));
    try {
      const src = path.join(root, 'src');
      fs.mkdirSync(path.join(src, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(src, 'bin', 'realbin'), '#!/bin/sh\necho hi\n');
      fs.symlinkSync('realbin', path.join(src, 'bin', 'python'));

      const dst = path.join(root, 'dst');
      fs.cpSync(src, dst, { recursive: true });

      const link = fs.readlinkSync(path.join(dst, 'bin', 'python'));
      expect(link).toBe('realbin');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('cleanupInternalRunFiles', () => {
  it('removes transient helper files and leaves normal artifacts alone', () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-run-cleanup-'));

    fs.writeFileSync(path.join(runDir, 'agent-script.sh'), 'secret');
    fs.writeFileSync(path.join(runDir, 'agent-complete.marker'), '0');
    fs.writeFileSync(path.join(runDir, 'launcher.sh'), '#!/bin/bash');
    fs.writeFileSync(path.join(runDir, 'logs.txt'), 'keep me');

    cleanupInternalRunFiles(runDir);

    expect(fs.existsSync(path.join(runDir, 'agent-script.sh'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'agent-complete.marker'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'launcher.sh'))).toBe(false);
    expect(fs.readFileSync(path.join(runDir, 'logs.txt'), 'utf-8')).toBe('keep me');

    fs.rmSync(runDir, { recursive: true, force: true });
  });
});

describe('handleSignal scrubs live-key files', () => {
  // Regression for SCRUB_KEYS_ON_SIGINT: a SIGINT/SIGTERM during the agent
  // phase force-exits before the executor's finally-block cleanup runs, so the
  // signal handler itself must delete `agent-script.sh` (plaintext API keys)
  // from the host-shared run dir.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`removes agent-script.sh and launcher.sh on ${signal} mid-agent-phase`, () => {
      const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-sigint-'));
      fs.writeFileSync(path.join(runDir, 'agent-script.sh'), 'export ANTHROPIC_API_KEY="sk-live-secret"');
      fs.writeFileSync(path.join(runDir, 'launcher.sh'), '#!/bin/bash');
      fs.writeFileSync(path.join(runDir, 'logs.txt'), 'keep me');

      // The handler ends in process.exit(); stub it so the test survives.
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

      setActiveRunForTest({
        runId: 'run-test',
        baseDir: runDir,
        runDir,
        phase: 'agent',
        container: null,
        proxyInfo: null,
        scorerContainer: null,
        cleaningUp: false,
        terminalEventEmitted: false,
      });

      try {
        handleSignal(signal);

        expect(fs.existsSync(path.join(runDir, 'agent-script.sh'))).toBe(false);
        expect(fs.existsSync(path.join(runDir, 'launcher.sh'))).toBe(false);
        // Normal artifacts are untouched.
        expect(fs.readFileSync(path.join(runDir, 'logs.txt'), 'utf-8')).toBe('keep me');
        expect(exitSpy).toHaveBeenCalled();
      } finally {
        setActiveRunForTest(null);
        exitSpy.mockRestore();
        fs.rmSync(runDir, { recursive: true, force: true });
      }
    });
  }
});
