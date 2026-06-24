// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildScorerContainerMounts,
  buildScorerExecOptions,
  collectScriptResultArtifacts,
  parseResultJson,
  resolveScore,
  resolveSummary,
  slugifyCriterion,
  SCRIPT_SCORER_ENV,
} from './scorer-container.js';

// =============================================================================
// resolveScore
// =============================================================================

describe('resolveScore', () => {
  it('returns score from file when valid float', () => {
    expect(resolveScore('0.75\n', 0)).toEqual({ score: 0.75 });
  });

  it('returns score 0 for score file content 0', () => {
    expect(resolveScore('0\n', 0)).toEqual({ score: 0 });
  });

  it('returns score 1 for score file content 1', () => {
    expect(resolveScore('1\n', 0)).toEqual({ score: 1 });
  });

  it('trims whitespace from score file', () => {
    expect(resolveScore('  0.5  \n', 0)).toEqual({ score: 0.5 });
  });

  it('returns error for non-numeric score file', () => {
    const result = resolveScore('abc\n', 0);
    expect(result.score).toBe(0);
    expect(result.error).toContain('Invalid score file content');
  });

  it('returns error for empty score file', () => {
    const result = resolveScore('\n', 0);
    expect(result.score).toBe(0);
    expect(result.error).toContain('Invalid score file content');
  });

  it('returns error for score below 0', () => {
    const result = resolveScore('-0.5\n', 0);
    expect(result.score).toBe(0);
    expect(result.error).toContain('Score out of range');
  });

  it('returns error for score above 1', () => {
    const result = resolveScore('1.5\n', 0);
    expect(result.score).toBe(0);
    expect(result.error).toContain('Score out of range');
  });

  it('returns 1.0 when no score file and exit code 0', () => {
    expect(resolveScore(null, 0)).toEqual({ score: 1.0 });
  });

  it('returns 0.0 when no score file and non-zero exit code', () => {
    expect(resolveScore(null, 1)).toEqual({ score: 0.0 });
  });

  it('returns 0.0 when no score file and exit code 127', () => {
    expect(resolveScore(null, 127)).toEqual({ score: 0.0 });
  });

  it('score file takes precedence over exit code', () => {
    // Score file says 0.8, but exit code is non-zero
    expect(resolveScore('0.8\n', 1)).toEqual({ score: 0.8 });
  });
});

// =============================================================================
// resolveSummary
// =============================================================================

describe('resolveSummary', () => {
  it('returns summary file content when present', () => {
    expect(resolveSummary('All tests passed\n', null, 0)).toBe('All tests passed');
  });

  it('trims whitespace from summary file', () => {
    expect(resolveSummary('  Custom summary  \n', null, 0)).toBe('Custom summary');
  });

  it('falls back to score value when summary file is empty', () => {
    expect(resolveSummary('\n', '0.75\n', 0)).toBe('Score: 0.75');
  });

  it('falls back to score value when no summary file but score file exists', () => {
    expect(resolveSummary(null, '0.5\n', 0)).toBe('Score: 0.5');
  });

  it('returns Passed when no files and exit 0', () => {
    expect(resolveSummary(null, null, 0)).toBe('Passed');
  });

  it('returns Failed with exit code when no files and non-zero exit', () => {
    expect(resolveSummary(null, null, 1)).toBe('Failed (exit code 1)');
  });

  it('returns Failed with specific exit code', () => {
    expect(resolveSummary(null, null, 127)).toBe('Failed (exit code 127)');
  });

  it('summary file takes precedence over score file', () => {
    expect(resolveSummary('My summary\n', '0.5\n', 0)).toBe('My summary');
  });

  it('summary file takes precedence over exit code', () => {
    expect(resolveSummary('Custom\n', null, 1)).toBe('Custom');
  });
});

// =============================================================================
// slugifyCriterion
// =============================================================================

describe('slugifyCriterion', () => {
  it('converts simple name to lowercase', () => {
    expect(slugifyCriterion('Tests')).toBe('tests');
  });

  it('replaces spaces with hyphens', () => {
    expect(slugifyCriterion('Unit Tests')).toBe('unit-tests');
  });

  it('replaces special characters with hyphens', () => {
    expect(slugifyCriterion('code_quality (lint)')).toBe('code-quality-lint');
  });

  it('removes leading and trailing hyphens', () => {
    expect(slugifyCriterion('--hello--')).toBe('hello');
  });

  it('collapses multiple non-alphanumeric chars to single hyphen', () => {
    expect(slugifyCriterion('a   b___c')).toBe('a-b-c');
  });

  it('handles all uppercase', () => {
    expect(slugifyCriterion('ALL CAPS')).toBe('all-caps');
  });

  it('handles single word', () => {
    expect(slugifyCriterion('correctness')).toBe('correctness');
  });
});

// =============================================================================
// SCRIPT_SCORER_ENV — reserved env vars injected for script criteria
// =============================================================================

describe('SCRIPT_SCORER_ENV', () => {
  it('exposes the full v1 reserved env vars for script criteria', () => {
    expect(SCRIPT_SCORER_ENV).toEqual({
      BUNSEN_SCORE_FILE: '/bunsen/scorer-output/score',
      BUNSEN_SUMMARY_FILE: '/bunsen/scorer-output/summary',
      BUNSEN_SCORER_OUTPUT: '/bunsen/scorer-output',
      BUNSEN_EVAL_RESULT: '/bunsen/scorer-output/result.json',
      BUNSEN_WORKSPACE_DIR: '/workspace',
      BUNSEN_WORKSPACE_SOURCE_DIR: '/workspace-source',
    });
  });

  it('is frozen so callers cannot mutate it', () => {
    expect(Object.isFrozen(SCRIPT_SCORER_ENV)).toBe(true);
  });
});

// =============================================================================
// parseResultJson — structured result resolution (priority 1)
// =============================================================================

describe('parseResultJson', () => {
  it('parses minimal payload with just a score', () => {
    expect(parseResultJson('{ "score": 1 }')).toEqual({
      score: 1,
      summary: undefined,
      artifacts: [],
    });
  });

  it('parses fractional scores', () => {
    expect(parseResultJson('{ "score": 0.42 }').score).toBe(0.42);
  });

  it('keeps summary when present and non-empty', () => {
    const result = parseResultJson('{ "score": 1, "summary": "Coverage 90%" }');
    expect(result.summary).toBe('Coverage 90%');
  });

  it('drops blank summaries (whitespace-only)', () => {
    const result = parseResultJson('{ "score": 1, "summary": "   " }');
    expect(result.summary).toBeUndefined();
  });

  it('parses artifact metadata', () => {
    const result = parseResultJson(
      JSON.stringify({
        score: 1,
        artifacts: [
          { path: 'coverage/report.txt', mediaType: 'text/plain' },
          { path: 'screenshots/diag.png' },
        ],
      })
    );
    expect(result.artifacts).toEqual([
      { path: 'coverage/report.txt', mediaType: 'text/plain' },
      { path: 'screenshots/diag.png' },
    ]);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseResultJson('not json')).toThrow(/Invalid result.json: not valid JSON/);
  });

  it('rejects non-object roots', () => {
    expect(() => parseResultJson('[1, 2, 3]')).toThrow(/expected a JSON object/);
  });

  it('rejects missing score', () => {
    expect(() => parseResultJson('{}')).toThrow(/"score" must be a number/);
  });

  it('rejects out-of-range scores', () => {
    expect(() => parseResultJson('{ "score": 1.5 }')).toThrow(/out of range: 1.5/);
    expect(() => parseResultJson('{ "score": -0.1 }')).toThrow(/out of range: -0.1/);
  });

  it('rejects non-string summary', () => {
    expect(() => parseResultJson('{ "score": 1, "summary": 7 }')).toThrow(/"summary" must be a string/);
  });

  it('rejects non-array artifacts', () => {
    expect(() => parseResultJson('{ "score": 1, "artifacts": {} }')).toThrow(/"artifacts" must be an array/);
  });

  it('rejects malformed artifact entries', () => {
    expect(() =>
      parseResultJson(JSON.stringify({ score: 1, artifacts: [{ path: '' }] }))
    ).toThrow(/artifacts\[0\].path must be a non-empty string/);
    expect(() =>
      parseResultJson(JSON.stringify({ score: 1, artifacts: [{ path: 'a', mediaType: 7 }] }))
    ).toThrow(/artifacts\[0\].mediaType must be a string/);
  });
});

// =============================================================================
// collectScriptResultArtifacts — copy artifacts into the run dir
// =============================================================================

describe('collectScriptResultArtifacts', () => {
  let scorerOutputDir: string;
  let runDir: string;

  beforeEach(() => {
    const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-artifact-test-'));
    scorerOutputDir = path.join(tempBase, 'scorer-output');
    runDir = path.join(tempBase, 'run');
    fs.mkdirSync(scorerOutputDir, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(path.dirname(scorerOutputDir), { recursive: true, force: true });
  });

  it('returns empty when no artifacts are declared', () => {
    const result = collectScriptResultArtifacts([], {
      scorerOutputDir,
      runDir,
      criterionSlug: 'tests',
    });
    expect(result.attached).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('copies declared artifacts into run dir under evaluation/criteria/<slug>/artifacts/', () => {
    fs.mkdirSync(path.join(scorerOutputDir, 'coverage'), { recursive: true });
    fs.writeFileSync(path.join(scorerOutputDir, 'coverage', 'report.txt'), 'hello');

    const result = collectScriptResultArtifacts(
      [{ path: 'coverage/report.txt', mediaType: 'text/plain' }],
      { scorerOutputDir, runDir, criterionSlug: 'unit-tests' }
    );

    expect(result.warnings).toEqual([]);
    expect(result.attached).toEqual([
      {
        path: 'evaluation/criteria/unit-tests/artifacts/coverage/report.txt',
        mediaType: 'text/plain',
      },
    ]);
    const copied = path.join(
      runDir,
      'evaluation',
      'criteria',
      'unit-tests',
      'artifacts',
      'coverage',
      'report.txt'
    );
    expect(fs.existsSync(copied)).toBe(true);
    expect(fs.readFileSync(copied, 'utf-8')).toBe('hello');
  });

  it('warns and skips artifacts whose path escapes scorer-output', () => {
    fs.writeFileSync(path.join(os.tmpdir(), 'unsafe-target.txt'), 'evil');
    const result = collectScriptResultArtifacts(
      [{ path: '../unsafe-target.txt' }],
      { scorerOutputDir, runDir, criterionSlug: 'tests' }
    );
    expect(result.attached).toEqual([]);
    expect(result.warnings[0]).toMatch(/escapes scorer-output/);
  });

  it('warns when the declared artifact is missing on disk', () => {
    const result = collectScriptResultArtifacts(
      [{ path: 'never-written.txt' }],
      { scorerOutputDir, runDir, criterionSlug: 'tests' }
    );
    expect(result.attached).toEqual([]);
    expect(result.warnings[0]).toMatch(/missing on disk/);
  });
});

describe('buildScorerExecOptions', () => {
  it('uses scorer exec user and merges exec env with scorer env', () => {
    const result = buildScorerExecOptions(
      {
        container: {} as never,
        outputDir: '/tmp/out',
        execUser: 'bunsen',
        execEnv: { HOME: '/home/bunsen', SHARED: 'from-container' },
      },
      {
        BUNSEN_SCORE_FILE: '/bunsen/scorer-output/score',
        SHARED: 'from-scorer',
      }
    );

    expect(result).toEqual({
      user: 'bunsen',
      env: {
        HOME: '/home/bunsen',
        SHARED: 'from-scorer',
        BUNSEN_SCORE_FILE: '/bunsen/scorer-output/score',
      },
    });
  });

  it('falls back to root/default execution when no scorer exec context is set', () => {
    const result = buildScorerExecOptions(
      {
        container: {} as never,
        outputDir: '/tmp/out',
      },
      {
        BUNSEN_SCORE_FILE: '/bunsen/scorer-output/score',
      }
    );

    expect(result).toEqual({
      user: undefined,
      env: {
        BUNSEN_SCORE_FILE: '/bunsen/scorer-output/score',
      },
    });
  });
});

// =============================================================================
// /workspace-source scorer contract — public guarantee that verifiers can
// reference /workspace-source uniformly across both scoring modes, regardless
// of whether the experiment declared workspace.sources[].
// =============================================================================

describe('/workspace-source scorer contract', () => {
  describe('dedicated scorer container (buildScorerContainerMounts)', () => {
    const baseOptions = {
      workspaceDir: '/host/workspace',
      runDir: '/host/run',
      outputDir: '/host/scorer-output',
    };

    it('mounts /workspace-source readonly when the extracted source dir is provided', () => {
      const mounts = buildScorerContainerMounts({
        ...baseOptions,
        workspaceSourceDir: '/host/workspace-source',
      });
      const wsSource = mounts.find((m) => m.target === '/workspace-source');
      expect(wsSource).toEqual({
        source: '/host/workspace-source',
        target: '/workspace-source',
        readonly: true,
      });
    });

    it('mounts /workspace-source even when the extracted source dir is empty', () => {
      // The executor extracts /workspace-source from the agent container
      // unconditionally — even with zero workspace.sources[] the dir exists
      // (proven by the assembly-script test). The mount must always be added
      // when the executor passes a path, so verifiers can reliably stat it.
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-empty-source-'));
      try {
        expect(fs.readdirSync(emptyDir)).toEqual([]);
        const mounts = buildScorerContainerMounts({
          ...baseOptions,
          workspaceSourceDir: emptyDir,
        });
        const wsSource = mounts.find((m) => m.target === '/workspace-source');
        expect(wsSource).toBeDefined();
        expect(wsSource!.source).toBe(emptyDir);
        expect(wsSource!.readonly).toBe(true);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('omits /workspace-source mount only when no source dir is provided at all', () => {
      const mounts = buildScorerContainerMounts(baseOptions);
      expect(mounts.find((m) => m.target === '/workspace-source')).toBeUndefined();
      // /workspace itself is always mounted, regardless.
      expect(mounts.find((m) => m.target === '/workspace')).toBeDefined();
    });

    it('keeps /workspace mutable and /workspace-source immutable', () => {
      const mounts = buildScorerContainerMounts({
        ...baseOptions,
        workspaceSourceDir: '/host/workspace-source',
      });
      const ws = mounts.find((m) => m.target === '/workspace')!;
      const wsSource = mounts.find((m) => m.target === '/workspace-source')!;
      expect(ws.readonly).toBe(false);
      expect(wsSource.readonly).toBe(true);
    });

    it('mounts the proxy-bootstrap bundle when the path is supplied', () => {
      const mounts = buildScorerContainerMounts({
        ...baseOptions,
        proxyBootstrapBundlePath: '/host/dist/proxy-bootstrap.cjs',
      });
      const bootstrap = mounts.find(
        (m) => m.target === '/bunsen/runtime/proxy-bootstrap.cjs',
      );
      expect(bootstrap).toEqual({
        source: '/host/dist/proxy-bootstrap.cjs',
        target: '/bunsen/runtime/proxy-bootstrap.cjs',
        readonly: true,
      });
    });

    it('omits the proxy-bootstrap mount when no path is supplied', () => {
      const mounts = buildScorerContainerMounts(baseOptions);
      expect(
        mounts.find((m) => m.target === '/bunsen/runtime/proxy-bootstrap.cjs'),
      ).toBeUndefined();
    });
  });

  describe('cross-mode parity (dedicated + agent-container scoring)', () => {
    it('SCRIPT_SCORER_ENV pins BUNSEN_WORKSPACE_SOURCE_DIR to /workspace-source', () => {
      // Both scoring paths converge on this constant — the dedicated scorer
      // container sets it via createScorerContainer's env, and the
      // agent-container scoring path injects it per-exec through
      // runCodeScorer -> buildScorerExecOptions(container, SCRIPT_SCORER_ENV).
      expect(SCRIPT_SCORER_ENV.BUNSEN_WORKSPACE_SOURCE_DIR).toBe('/workspace-source');
    });

    it('per-exec env injection (agent-container path) carries BUNSEN_WORKSPACE_SOURCE_DIR', () => {
      // runCodeScorer always merges SCRIPT_SCORER_ENV into the per-exec env,
      // which is what makes the contract uniform in agent-container scoring
      // mode where the scorer container's base env is the agent's env (which
      // does not pre-set BUNSEN_WORKSPACE_SOURCE_DIR).
      const agentMode = buildScorerExecOptions(
        {
          container: {} as never,
          outputDir: '/tmp/out',
          execUser: 'bunsen',
          execEnv: { HOME: '/home/bunsen' },
        },
        SCRIPT_SCORER_ENV
      );
      expect(agentMode.env.BUNSEN_WORKSPACE_SOURCE_DIR).toBe('/workspace-source');
      expect(agentMode.env.BUNSEN_WORKSPACE_DIR).toBe('/workspace');

      const dedicatedMode = buildScorerExecOptions(
        { container: {} as never, outputDir: '/tmp/out' },
        SCRIPT_SCORER_ENV
      );
      expect(dedicatedMode.env.BUNSEN_WORKSPACE_SOURCE_DIR).toBe('/workspace-source');
    });
  });
});
