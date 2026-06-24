// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for the step dispatcher.
 *
 * Split into:
 * - Pure helpers (`resolveWriteFileContent`, type guards): exercised with
 *   no mocks.
 * - `dispatchSteps` behavior: exercised with `execShellInContainer` mocked
 *   to capture invocations without touching Docker. This is how we verify
 *   the things container-backed integration tests can't easily assert on
 *   (script body, exec order, per-step `as:` / `timeout:` routing, the
 *   malformed-step guard).
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { StepConfig, ExecutionUser } from '@bunsen-dev/types';

// Mock the container module so dispatchSteps doesn't try to talk to Docker.
vi.mock('./container.js', () => ({
  execShellInContainer: vi.fn(),
}));

import { execShellInContainer } from './container.js';
import {
  resolveWriteFileContent,
  isRunStep,
  isWriteFileStep,
  dispatchSteps,
  type StepDispatchOptions,
} from './step-dispatch.js';

const fakeContainer = {} as Parameters<typeof dispatchSteps>[0];
// bun:test has no `vi.mocked` helper; the imported binding already IS the mock.
const mockedExec = execShellInContainer as unknown as Mock<typeof execShellInContainer>;

interface ExecCall {
  script: string;
  options: Parameters<typeof execShellInContainer>[2];
}

function captureExecCalls(): ExecCall[] {
  const calls: ExecCall[] = [];
  mockedExec.mockImplementation(async (_container, script, options) => {
    calls.push({ script, options });
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 0 };
  });
  return calls;
}

describe('resolveWriteFileContent', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-writefile-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns inline content verbatim', () => {
    const content = '`backticks` $VARS\nEOF\nliteral\n';
    const result = resolveWriteFileContent(
      { writeFile: '/tmp/x', content },
      tempDir,
      'test',
    );
    expect(result).toBe(content);
  });

  it('reads from a file relative to the source directory', () => {
    const subdir = path.join(tempDir, 'prompts');
    fs.mkdirSync(subdir);
    fs.writeFileSync(path.join(subdir, 'cautious.md'), 'be careful');
    const result = resolveWriteFileContent(
      { writeFile: '/tmp/x', from: 'prompts/cautious.md' },
      tempDir,
      'test',
    );
    expect(result).toBe('be careful');
  });

  it('rejects from: paths that escape the source directory via ..', () => {
    expect(() =>
      resolveWriteFileContent(
        { writeFile: '/tmp/x', from: '../etc/passwd' },
        tempDir,
        'test',
      ),
    ).toThrow(/must be inside the source directory/);
  });

  it('rejects absolute from: paths that escape the source directory', () => {
    expect(() =>
      resolveWriteFileContent(
        { writeFile: '/tmp/x', from: '/etc/passwd' },
        tempDir,
        'test',
      ),
    ).toThrow(/must be inside the source directory/);
  });

  it('errors when from: file does not exist', () => {
    expect(() =>
      resolveWriteFileContent(
        { writeFile: '/tmp/x', from: 'missing.md' },
        tempDir,
        'test',
      ),
    ).toThrow(/'from' file not found/);
  });

  it('errors when neither from nor content is set', () => {
    expect(() =>
      resolveWriteFileContent({ writeFile: '/tmp/x' }, tempDir, 'test'),
    ).toThrow(/must set 'from' or 'content'/);
  });

  it('handles empty content as a literal empty string (not "missing")', () => {
    const result = resolveWriteFileContent(
      { writeFile: '/tmp/x', content: '' },
      tempDir,
      'test',
    );
    expect(result).toBe('');
  });

  it('reads UTF-8 content with non-ASCII characters correctly', () => {
    fs.writeFileSync(path.join(tempDir, 'unicode.md'), '日本語 🚀\n');
    const result = resolveWriteFileContent(
      { writeFile: '/tmp/x', from: 'unicode.md' },
      tempDir,
      'test',
    );
    expect(result).toBe('日本語 🚀\n');
  });
});

describe('step-type guards', () => {
  it('identifies a run step', () => {
    expect(isRunStep({ run: 'echo hi' })).toBe(true);
    expect(isWriteFileStep({ run: 'echo hi' })).toBe(false);
  });

  it('identifies a writeFile step', () => {
    expect(isWriteFileStep({ writeFile: '/tmp/x', content: '' })).toBe(true);
    expect(isRunStep({ writeFile: '/tmp/x', content: '' })).toBe(false);
  });
});

describe('dispatchSteps', () => {
  let tempDir: string;
  let baseOptions: StepDispatchOptions;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-dispatch-test-'));
    baseOptions = { sourceDir: tempDir, phaseLabel: 'test' };
    mockedExec.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('joins consecutive run steps into one exec call with shared shell state', async () => {
    const calls = captureExecCalls();
    const steps: StepConfig[] = [{ run: 'a' }, { run: 'b' }, { run: 'c' }];
    await dispatchSteps(fakeContainer, steps, baseOptions);
    expect(calls).toHaveLength(1);
    expect(calls[0].script).toBe('a\nb\nc');
  });

  it('breaks the batch at a writeFile step (state does not leak across it)', async () => {
    const calls = captureExecCalls();
    const steps: StepConfig[] = [
      { run: 'export FOO=bar' },
      { writeFile: '/tmp/x', content: 'y' },
      { run: 'echo $FOO' },
    ];
    await dispatchSteps(fakeContainer, steps, baseOptions);
    expect(calls).toHaveLength(3);
    expect(calls[0].script).toBe('export FOO=bar');
    expect(calls[1].script).toContain('__bunsen_target=');
    expect(calls[2].script).toBe('echo $FOO');
  });

  it('breaks the batch when consecutive run steps differ in `as:`', async () => {
    const calls = captureExecCalls();
    const steps: StepConfig[] = [
      { run: 'a', as: 'root' },
      { run: 'b', as: 'root' },
      { run: 'c', as: 'user' },
      { run: 'd', as: 'user' },
    ];
    const wrapAs = vi.fn((script: string, asUser: ExecutionUser, batchIdx: number) =>
      `[${asUser}#${batchIdx}] ${script}`,
    );
    await dispatchSteps(fakeContainer, steps, { ...baseOptions, defaultAs: 'root', wrapAs });
    expect(calls).toHaveLength(2);
    expect(calls[0].script).toBe('[root#0] a\nb');
    expect(calls[1].script).toBe('[user#1] c\nd');
  });

  it('routes writeFile through wrapAs with the step’s effective user', async () => {
    const calls = captureExecCalls();
    const steps: StepConfig[] = [
      { writeFile: '/tmp/x', content: 'y', as: 'user' },
    ];
    const wrapAs = vi.fn((script: string, asUser: ExecutionUser, batchIdx: number) =>
      `WRAP(${asUser},${batchIdx}):${script}`,
    );
    await dispatchSteps(fakeContainer, steps, { ...baseOptions, wrapAs });
    expect(wrapAs).toHaveBeenCalledTimes(1);
    expect(wrapAs.mock.calls[0][1]).toBe('user');
    expect(wrapAs.mock.calls[0][2]).toBe(0);
    expect(calls[0].script.startsWith('WRAP(user,0):')).toBe(true);
  });

  it('falls back to defaultAs when step.as is unset', async () => {
    captureExecCalls();
    const steps: StepConfig[] = [{ writeFile: '/tmp/x', content: 'y' }];
    const wrapAs = vi.fn(
      (script: string, _asUser: ExecutionUser, _batchIdx: number) => script,
    );
    await dispatchSteps(fakeContainer, steps, {
      ...baseOptions,
      defaultAs: 'root',
      wrapAs,
    });
    expect(wrapAs.mock.calls[0][1]).toBe('root');
  });

  it('writeFile defaultAs falls through to "user" when nothing specifies it', async () => {
    captureExecCalls();
    const steps: StepConfig[] = [{ writeFile: '/tmp/x', content: 'y' }];
    const wrapAs = vi.fn(
      (script: string, _asUser: ExecutionUser, _batchIdx: number) => script,
    );
    await dispatchSteps(fakeContainer, steps, { ...baseOptions, wrapAs });
    expect(wrapAs.mock.calls[0][1]).toBe('user');
  });

  it('per-batch indices increment across all dispatched scripts', async () => {
    captureExecCalls();
    const steps: StepConfig[] = [
      { run: 'a' },
      { writeFile: '/tmp/x', content: 'y' },
      { run: 'b' },
      { writeFile: '/tmp/z', content: 'w' },
    ];
    const seen: number[] = [];
    const wrapAs = vi.fn((script: string, _asUser, batchIdx: number) => {
      seen.push(batchIdx);
      return script;
    });
    await dispatchSteps(fakeContainer, steps, { ...baseOptions, wrapAs });
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it('honors step.timeout for run batches (max across batch wins)', async () => {
    const calls = captureExecCalls();
    const steps: StepConfig[] = [
      { run: 'a', timeout: '10s' },
      { run: 'b', timeout: '30s' },
      { run: 'c', timeout: '15s' },
    ];
    await dispatchSteps(fakeContainer, steps, {
      ...baseOptions,
      defaultRunTimeoutMs: 60_000,
    });
    expect(calls[0].options?.timeout).toBe(30_000);
  });

  it('falls back to defaultRunTimeoutMs when no step in the batch sets timeout', async () => {
    const calls = captureExecCalls();
    const steps: StepConfig[] = [{ run: 'a' }, { run: 'b' }];
    await dispatchSteps(fakeContainer, steps, {
      ...baseOptions,
      defaultRunTimeoutMs: 60_000,
    });
    expect(calls[0].options?.timeout).toBe(60_000);
  });

  it('honors step.timeout on a writeFile step', async () => {
    const calls = captureExecCalls();
    const steps: StepConfig[] = [
      { writeFile: '/tmp/x', content: 'y', timeout: '90s' },
    ];
    await dispatchSteps(fakeContainer, steps, baseOptions);
    expect(calls[0].options?.timeout).toBe(90_000);
  });

  it('defaults writeFile timeout to 30s when step.timeout is unset', async () => {
    const calls = captureExecCalls();
    const steps: StepConfig[] = [{ writeFile: '/tmp/x', content: 'y' }];
    await dispatchSteps(fakeContainer, steps, baseOptions);
    expect(calls[0].options?.timeout).toBe(30_000);
  });

  it('throws on a malformed step (neither run nor writeFile)', async () => {
    captureExecCalls();
    const steps = [{ as: 'root' }] as unknown as StepConfig[];
    await expect(
      dispatchSteps(fakeContainer, steps, baseOptions),
    ).rejects.toThrow(/must have 'run' or 'writeFile'/);
  });

  it('throws on the first non-zero exit code with the phase label', async () => {
    mockedExec.mockResolvedValueOnce({
      exitCode: 7,
      stdout: '',
      stderr: 'broken',
      durationMs: 0,
    });
    const steps: StepConfig[] = [{ run: 'oops' }];
    await expect(
      dispatchSteps(fakeContainer, steps, { ...baseOptions, phaseLabel: 'Test phase' }),
    ).rejects.toThrow(/Test phase failed with exit code 7: broken/);
  });

  it('embeds writeFile target inside double-quotes so $VARS expand', async () => {
    const calls = captureExecCalls();
    const steps: StepConfig[] = [
      { writeFile: '$BUNSEN_AGENT_HOME/.claude/CLAUDE.md', content: 'hi' },
    ];
    await dispatchSteps(fakeContainer, steps, baseOptions);
    // The dispatcher assigns target inside double quotes, leaving $VAR
    // expansion to the container shell.
    expect(calls[0].script).toContain(
      '__bunsen_target="$BUNSEN_AGENT_HOME/.claude/CLAUDE.md"',
    );
  });

  it('escapes backticks and double-quotes in writeFile target to prevent injection', async () => {
    const calls = captureExecCalls();
    const steps: StepConfig[] = [
      { writeFile: '/tmp/`evil`/"x"', content: 'y' },
    ];
    await dispatchSteps(fakeContainer, steps, baseOptions);
    expect(calls[0].script).toContain('__bunsen_target="/tmp/\\`evil\\`/\\"x\\""');
  });

  it('base64-encodes content so it stays byte-exact regardless of contents', async () => {
    const calls = captureExecCalls();
    const tricky = '`true` $X\nEOF\n';
    const steps: StepConfig[] = [{ writeFile: '/tmp/x', content: tricky }];
    await dispatchSteps(fakeContainer, steps, baseOptions);
    const expected = Buffer.from(tricky, 'utf-8').toString('base64');
    expect(calls[0].script).toContain(`'${expected}'`);
  });

  it('does nothing for an empty step list', async () => {
    const calls = captureExecCalls();
    await dispatchSteps(fakeContainer, [], baseOptions);
    expect(calls).toHaveLength(0);
  });

  it('forwards options.workdir to execShellInContainer for every dispatched step (run + writeFile, wrapped + bare)', async () => {
    // Regression guard for REVIEW_2.md: when a workspace.setup step opts
    // into `as: root`, it skips the bunsen wrapper. Workdir must still
    // come from options (the dispatcher contract), not from anything
    // inside the wrapper script. Otherwise `as: root` runs at the
    // dispatcher's default cwd (was '/' historically, broke relative
    // paths).
    const calls = captureExecCalls();
    const steps: StepConfig[] = [
      { run: 'echo a', as: 'root' },
      { run: 'echo b', as: 'user' },
      { writeFile: '/tmp/x', content: 'y', as: 'user' },
      { writeFile: '/tmp/z', content: 'w', as: 'root' },
    ];
    const wrapAs = vi.fn(
      (script: string, asUser: ExecutionUser) =>
        asUser === 'user' ? `WRAPPED:${script}` : script,
    );
    await dispatchSteps(fakeContainer, steps, {
      ...baseOptions,
      defaultAs: 'user',
      workdir: '/workspace',
      wrapAs,
    });
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.options?.workdir).toBe('/workspace');
    }
  });

  it('prepends preScript to each run batch but not to writeFile steps', async () => {
    const calls = captureExecCalls();
    const steps: StepConfig[] = [
      { run: 'echo a' },
      { writeFile: '/tmp/x', content: 'y' },
      { run: 'echo b' },
    ];
    await dispatchSteps(fakeContainer, steps, {
      ...baseOptions,
      preScript: 'export PATH=/extra:$PATH',
    });
    expect(calls[0].script).toBe('export PATH=/extra:$PATH\necho a');
    expect(calls[1].script).not.toContain('export PATH=/extra:$PATH');
    expect(calls[2].script).toBe('export PATH=/extra:$PATH\necho b');
  });
});
