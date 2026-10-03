import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildScorerContainerEnv,
  buildScorerContainerMounts,
  buildScorerExecOptions,
  collectScriptResultArtifacts,
  interpretScorerExec,
  parseResultJson,
  resolveScore,
  resolveScorerPath,
  resolveSummary,
  resolveTimeoutOutput,
  slugifyCriterion,
  SCORER_FALLBACK_PATH,
  SCRIPT_SCORER_ENV,
} from './scorer-container.js';
import { ExecTimeoutError } from './container.js';
import { STABLE_PATHS } from './runtime-contract.js';
import { RUN_PATHS } from './storage.js';

// =============================================================================
// resolveScorerPath
// =============================================================================

describe('resolveScorerPath', () => {
  it('prepends /bunsen/bin to the image PATH', () => {
    expect(resolveScorerPath('/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin')).toBe(
      '/bunsen/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin'
    );
  });

  it('preserves toolchain dirs outside /usr/{local/,}bin (the golang/rust image case)', () => {
    const golangPath = '/usr/local/go/bin:/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    const resolved = resolveScorerPath(golangPath);
    expect(resolved.split(':')).toContain('/usr/local/go/bin');
    expect(resolved.split(':')[0]).toBe('/bunsen/bin');
  });

  it('falls back to the pinned default when the image declares no PATH', () => {
    expect(resolveScorerPath(undefined)).toBe(SCORER_FALLBACK_PATH);
    expect(SCORER_FALLBACK_PATH.split(':')[0]).toBe('/bunsen/bin');
  });

  it('does not double-prepend when the image PATH already contains /bunsen/bin', () => {
    const withBunsen = '/bunsen/bin:/usr/local/bin:/usr/bin';
    expect(resolveScorerPath(withBunsen)).toBe(withBunsen);
  });

  it('keeps /bunsen/bin first so Bunsen helpers win over image binaries', () => {
    const adversarial = '/opt/tools/bin:/usr/bin';
    expect(resolveScorerPath(adversarial).split(':')[0]).toBe('/bunsen/bin');
  });
});

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
// resolveTimeoutOutput — partial credit on criterion timeout
// =============================================================================

describe('resolveTimeoutOutput', () => {
  it('honors a valid result.json written before the timeout', () => {
    const result = resolveTimeoutOutput('{ "score": 0.5, "summary": "212/424 passed" }', null, 60);
    expect(result.score).toBe(0.5);
    expect(result.summary).toBe(
      'Timed out after 60s; scored from last written result.json: 212/424 passed'
    );
    expect(result.parsed?.score).toBe(0.5);
  });

  it('always surfaces the timeout in the summary even when result.json has none', () => {
    const result = resolveTimeoutOutput('{ "score": 0.25 }', null, 30);
    expect(result.score).toBe(0.25);
    expect(result.summary).toContain('Timed out after 30s');
  });

  it('falls back to the score file when result.json is torn (killed mid-write)', () => {
    const result = resolveTimeoutOutput('{ "score": 0.', '0.4\n', 60);
    expect(result.score).toBe(0.4);
    expect(result.summary).toBe('Timed out after 60s; scored from last written score file (0.4)');
    expect(result.parsed).toBeUndefined();
  });

  it('uses the score file when no result.json exists', () => {
    const result = resolveTimeoutOutput(null, '0.75\n', 120);
    expect(result.score).toBe(0.75);
    expect(result.summary).toContain('score file (0.75)');
  });

  it('scores 0 with a bare timeout summary when the script wrote nothing', () => {
    expect(resolveTimeoutOutput(null, null, 60)).toEqual({
      score: 0,
      summary: 'Timed out after 60s',
    });
  });

  it('scores 0 when both result.json and the score file are invalid', () => {
    const result = resolveTimeoutOutput('not json', 'garbage', 60);
    expect(result.score).toBe(0);
    expect(result.summary).toBe('Timed out after 60s');
  });

  it('result.json wins over the score file (same precedence as a clean exit)', () => {
    const result = resolveTimeoutOutput('{ "score": 0.9 }', '0.1\n', 60);
    expect(result.score).toBe(0.9);
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
// buildScorerContainerEnv — the dedicated container's key-free base env
// =============================================================================

describe('buildScorerContainerEnv', () => {
  it('carries the script-scorer contract and the resolved PATH', () => {
    const env = buildScorerContainerEnv({ imageEnvPath: '/usr/local/go/bin:/usr/bin' });
    expect(env).toMatchObject(SCRIPT_SCORER_ENV);
    expect(env.PATH).toBe('/bunsen/bin:/usr/local/go/bin:/usr/bin');
  });

  it('falls back to the default PATH when the image declares none', () => {
    expect(buildScorerContainerEnv({}).PATH).toBe(SCORER_FALLBACK_PATH);
  });

  it('merges reserved run/suite context', () => {
    const env = buildScorerContainerEnv({
      reservedEnv: { BUNSEN_RUN_ID: 'run-1', BUNSEN_EXPERIMENT: 'demo' },
    });
    expect(env.BUNSEN_RUN_ID).toBe('run-1');
    expect(env.BUNSEN_EXPERIMENT).toBe('demo');
  });

  it('contains no provider API key — script criteria must never see one', () => {
    // The whole point of per-exec key delivery (DESIGN.md D3): creation-time
    // env is visible to every exec, including user-authored verifier scripts.
    const env = buildScorerContainerEnv({
      reservedEnv: { BUNSEN_RUN_ID: 'run-1' },
      imageEnvPath: '/usr/bin',
    });
    expect(Object.keys(env).filter((k) => /_API_KEY$/.test(k))).toEqual([]);
  });
});

// =============================================================================
// interpretScorerExec — LLM scorer outcome → verdict or structured failure
// =============================================================================

describe('interpretScorerExec', () => {
  const ok = (stdout: string) =>
    interpretScorerExec({ exitCode: 0, stdout, stderr: '', timeoutMs: 600_000 });

  it('parses a verdict from stdout', () => {
    const run = ok(JSON.stringify({ score: 0.5, summary: 'Half credit.' }));
    expect(run).toEqual({ ok: true, output: { score: 0.5, summary: 'Half credit.' } });
  });

  it('keeps a null score (the report step scores nothing)', () => {
    const run = ok(JSON.stringify({ score: null, summary: 'Wrote it up.', report: '# Report' }));
    expect(run).toEqual({
      ok: true,
      output: { score: null, summary: 'Wrote it up.', report: '# Report' },
    });
  });

  it('defaults a missing score to null rather than 0', () => {
    const run = ok(JSON.stringify({ summary: 'No score field.' }));
    expect(run).toEqual({ ok: true, output: { score: null, summary: 'No score field.' } });
  });

  it('carries screenshots and artifacts through', () => {
    const run = ok(
      JSON.stringify({
        score: 1,
        summary: 'Looks right.',
        screenshots: ['home.png', 'about.png'],
        artifacts: [{ path: 'out.json', mediaType: 'application/json' }],
      }),
    );
    expect(run.ok && run.output.screenshots).toEqual(['home.png', 'about.png']);
    expect(run.ok && run.output.artifacts).toEqual([
      { path: 'out.json', mediaType: 'application/json' },
    ]);
  });

  it('reports a timeout as timedOut, in seconds', () => {
    const run = interpretScorerExec({
      error: new ExecTimeoutError(600_000, { stdout: '', stderr: '', durationMs: 600_000 }),
      timeoutMs: 600_000,
    });
    expect(run).toEqual({ ok: false, timedOut: true, error: 'Scorer timed out after 600s' });
  });

  it('reports a non-timeout exec error verbatim', () => {
    const run = interpretScorerExec({ error: new Error('container is gone'), timeoutMs: 1000 });
    expect(run).toEqual({ ok: false, timedOut: false, error: 'container is gone' });
  });

  it('handles a thrown non-Error', () => {
    const run = interpretScorerExec({ error: 'boom', timeoutMs: 1000 });
    expect(run).toEqual({ ok: false, timedOut: false, error: 'boom' });
  });

  it('reports a non-zero exit with the tail of stderr', () => {
    const run = interpretScorerExec({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: no verdict\n',
      timeoutMs: 1000,
    });
    expect(run).toEqual({ ok: false, timedOut: false, error: 'Scorer exited 1: Error: no verdict' });
  });

  it('truncates a very long reason line', () => {
    const run = interpretScorerExec({
      exitCode: 2,
      stdout: '',
      stderr: 'x'.repeat(2000),
      timeoutMs: 1000,
    });
    expect(run.ok).toBe(false);
    if (!run.ok) {
      expect(run.error).toStartWith('Scorer exited 2: xxxx');
      expect(run.error).toEndWith('…');
      expect(run.error.length).toBeLessThan(600);
    }
  });

  it("uses the bundle's `Scoring failed:` line as the reason, not the stack that follows it", () => {
    const stderr = [
      '[scorer] judge "Page quality" (page-quality) on openai/gpt-5.6; tools: none',
      'Scoring failed: Incorrect API key provided: sk-proj-****. You can find your API key at https://platform.openai.com/account/api-keys.',
      'AI_APICallError: Incorrect API key provided',
      '    at /bunsen/lib/scorer.cjs:16197:14',
      '    at async postToApi (/bunsen/lib/scorer.cjs:15855:28)',
      '    at async retryWithExponentialBackoffInternal (/bunsen/lib/scorer.cjs:16051:12)',
      '',
    ].join('\n');
    const run = interpretScorerExec({ exitCode: 1, stdout: '', stderr, timeoutMs: 1000 });
    expect(run).toEqual({
      ok: false,
      timedOut: false,
      error:
        'Scorer exited 1: Scoring failed: Incorrect API key provided: sk-proj-****. You can find your API key at https://platform.openai.com/account/api-keys.',
    });
  });

  it('falls back to the last non-stack line when the bundle printed no `Scoring failed:` line', () => {
    const stderr = 'TypeError: boom\n    at x (/bunsen/lib/scorer.cjs:1:1)\n    at y (/bunsen/lib/scorer.cjs:2:2)\n';
    expect(scorerFailureReason(stderr)).toBe('TypeError: boom');
  });

  it('reports a non-zero exit with no stderr at all', () => {
    const run = interpretScorerExec({ exitCode: 137, stdout: '', stderr: '', timeoutMs: 1000 });
    expect(run).toEqual({ ok: false, timedOut: false, error: 'Scorer exited 137' });
  });

  it('reports empty stdout as no verdict', () => {
    expect(ok('   \n ')).toEqual({
      ok: false,
      timedOut: false,
      error: 'Scorer produced no verdict (no output)',
    });
  });

  it('reports unparseable stdout as no verdict, quoting it', () => {
    const run = ok('not json at all');
    expect(run.ok).toBe(false);
    if (!run.ok) {
      expect(run.error).toBe(
        'Scorer produced no verdict (unparseable output: not json at all)',
      );
      expect(run.timedOut).toBe(false);
    }
  });

  it('rejects valid JSON that is not an object', () => {
    const run = ok('[1, 2, 3]');
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.error).toContain('expected a JSON object');
  });

  it('rejects a verdict with no summary', () => {
    expect(ok(JSON.stringify({ score: 1 }))).toEqual({
      ok: false,
      timedOut: false,
      error: 'Scorer produced no verdict (output has no "summary")',
    });
  });

  it('rejects a non-numeric score', () => {
    const run = ok(JSON.stringify({ score: 'high', summary: 'ok' }));
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.error).toBe('Scorer produced no verdict (invalid "score": "high")');
  });

  it('never resolves a failure to score 0', () => {
    // DESIGN.md D6: a 0 is a claim about the agent; a broken scorer has no
    // evidence for it.
    const failures = [
      interpretScorerExec({ error: new Error('x'), timeoutMs: 1 }),
      interpretScorerExec({ exitCode: 1, stderr: 'nope', timeoutMs: 1 }),
      ok(''),
      ok('{}'),
    ];
    for (const run of failures) {
      expect(run.ok).toBe(false);
      expect(run).not.toHaveProperty('output');
    }
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

    it(`mounts the run context readonly at ${STABLE_PATHS.runDir} (script scorers read agent logs there)`, () => {
      // Script scorers read agent stdout/stderr from the run context —
      // saveLogs() writes `RUN_PATHS.logs` into the host run dir, which this
      // mount exposes inside the scorer container. The `bn init --example`
      // scorer greps that exact path, so if this mount target or the logs
      // filename ever moves, this pin and the init scaffold test break loudly.
      const mounts = buildScorerContainerMounts(baseOptions);
      const runMount = mounts.find((m) => m.target === STABLE_PATHS.runDir);
      expect(runMount).toEqual({
        source: baseOptions.runDir,
        target: STABLE_PATHS.runDir,
        readonly: true,
      });
      expect(`${STABLE_PATHS.runDir}/${RUN_PATHS.logs}`).toBe('/bunsen/run/logs.txt');
    });

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

// =============================================================================
// redactSecrets — the criterion log must never carry a key the host handed out
// =============================================================================

import { redactSecrets, scorerFailureReason } from './scorer-container.js';

describe('redactSecrets', () => {
  it('replaces every occurrence of each known secret', () => {
    const key = 'sk-ant-api03-abcdefghijklmnop';
    const text = `export ANTHROPIC_API_KEY="${key}"\n[scorer] run_command → ${key} again`;
    const out = redactSecrets(text, [key, 'sk-proj-zyxwvutsrqponmlk']);
    expect(out).not.toContain(key);
    expect(out).toBe('export ANTHROPIC_API_KEY="[redacted]"\n[scorer] run_command → [redacted] again');
  });

  it('ignores empty and short values so ordinary words are not mangled', () => {
    const text = 'the key is set; done';
    expect(redactSecrets(text, ['', 'key', 'set', 'done'])).toBe(text);
  });

  it('is a no-op with no secrets', () => {
    expect(redactSecrets('anything', [])).toBe('anything');
  });
});

// =============================================================================
// createStreamScrubber — the live echo must not leak a secret split across chunks
// =============================================================================

import { createStreamScrubber, scorerExecScript, SCORER_PGID_FILE } from './scorer-container.js';

describe('createStreamScrubber', () => {
  const key = 'sk-ant-api03-SECRETVALUE12345';

  it('redacts a secret that straddles two chunks and never emits a fragment of it', () => {
    const s = createStreamScrubber([key]);
    const a = s.push('export KEY="sk-ant-api03-SEC');
    const b = s.push('RETVALUE12345" done\n');
    const out = a + b + s.flush();
    expect(out).toBe('export KEY="[redacted]" done\n');
    expect(a).not.toContain('sk-ant');
    expect(a + b).not.toContain('SECRET');
  });

  it('holds back a chunk tail that could begin a secret, then releases it when it does not', () => {
    const s = createStreamScrubber([key]);
    const a = s.push('value is sk-ant');
    expect(a).toBe('value is ');
    const b = s.push('-not-the-key actually\n');
    expect(a + b + s.flush()).toBe('value is sk-ant-not-the-key actually\n');
  });

  it('passes ordinary text through unchanged, chunk by chunk', () => {
    const s = createStreamScrubber([key]);
    expect(s.push('[scorer] step 1: read_file\n') + s.push('[scorer]   read_file → ok\n') + s.flush()).toBe(
      '[scorer] step 1: read_file\n[scorer]   read_file → ok\n',
    );
  });

  it('flush redacts whatever was still pending', () => {
    const s = createStreamScrubber([key]);
    const a = s.push(`tail ${key.slice(0, 10)}`);
    expect(a).toBe('tail ');
    expect(s.push(key.slice(10)) + s.flush()).toBe('[redacted]');
  });
});

describe('scorerExecScript', () => {
  it('records the process group before exec-ing the bundle', () => {
    const script = scorerExecScript('/bunsen/runtime/node', '/bunsen/scorer-output/scorer-config.json');
    expect(script).toContain(`> ${SCORER_PGID_FILE}`);
    expect(script).toContain("/proc/$$/stat");
    expect(script).toEndWith("exec '/bunsen/runtime/node' /bunsen/lib/scorer.cjs --config '/bunsen/scorer-output/scorer-config.json'");
  });
});
