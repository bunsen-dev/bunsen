// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  buildArgvInvocation,
  expandInvokeTemplate,
  formatInvocationForLog,
  renderArgvInvocation,
  shellSingleQuote,
} from './orchestration.js';
import type { ResolvedAgent } from './agent-loader.js';
import type { ResolvedExperiment } from './experiment-loader.js';

/** The injected `BUNSEN_TASK_FILE` path that `{promptFile}` expands to. */
const TASK_FILE = '/bunsen/task/prompt.md';

function makeAgent(entrypointCommand: string, invoke?: string[]): ResolvedAgent {
  return {
    version: 'v1',
    name: 'fake-agent',
    install: { source: { type: 'local', path: '.' } },
    entrypoint: invoke
      ? { command: entrypointCommand, invoke }
      : { command: entrypointCommand },
    interaction: { mode: 'direct' },
    path: '/fake/agent',
    configPath: '/fake/agent/agent.yaml',
  } as ResolvedAgent;
}

function makeExperiment(prompt: string): ResolvedExperiment {
  return {
    version: 'v1',
    name: 'fake-exp',
    task: { prompt },
    environment: { image: { base: 'bunsen/headless' } },
    evaluation: { container: 'dedicated', criteria: [] },
    dir: '/fake/exp',
    configPath: '/fake/exp/experiment.yaml',
    workspaceSources: [],
    hasDockerfile: false,
    hasVerifiers: false,
  } as ResolvedExperiment;
}

/**
 * Run the rendered command line through `bash -c 'printf "%s\0" "$@"' _ …`
 * and parse the NUL-delimited argv that bash actually saw. This is the
 * truth-checker: it tells us what argv the *agent* would receive after bash
 * is done with the script. If POSIX-quoting is right, the parsed args must
 * exactly equal the input args we asked to pass.
 */
function bashArgv(rendered: string): string[] {
  // We pass `_` as $0 so the user args are $1..$N, then printf '%s\0' "$@"
  // emits each on its own NUL-delimited record.
  const out = execFileSync(
    'bash',
    ['-c', `${rendered.replace(/^[^ ]+/, "printf '%s\\0'")} `],
    { encoding: 'buffer' },
  );
  const records = out.toString('utf-8').split('\0');
  // Trailing NUL produces a final empty string — drop it.
  if (records[records.length - 1] === '') records.pop();
  return records;
}

describe('shellSingleQuote', () => {
  it('wraps plain text in single quotes', () => {
    expect(shellSingleQuote('hello')).toBe(`'hello'`);
  });

  it('escapes single quotes via the standard `\\\'` sequence', () => {
    expect(shellSingleQuote(`it's fine`)).toBe(`'it'\\''s fine'`);
  });

  it('does not touch other shell metacharacters', () => {
    // Inside '…' nothing else is special, so the output is just the input
    // sandwiched between single quotes.
    expect(shellSingleQuote('`echo $X` "quoted" \\n')).toBe(`'\`echo $X\` "quoted" \\n'`);
  });
});

describe('renderArgvInvocation', () => {
  it('quotes the command and every arg', () => {
    const rendered = renderArgvInvocation({
      command: 'claude',
      args: ['fix the bug', '--fast'],
    });
    expect(rendered).toBe(`'claude' 'fix the bug' '--fast'`);
  });

  it('round-trips backticks unchanged through bash', () => {
    const args = ['Use `grep -r` to find the bug'];
    const rendered = renderArgvInvocation({ command: 'claude', args });
    expect(bashArgv(rendered)).toEqual(args);
  });

  it('round-trips $VAR unchanged through bash', () => {
    const args = ['Set $HOME and $PATH variables'];
    const rendered = renderArgvInvocation({ command: 'claude', args });
    expect(bashArgv(rendered)).toEqual(args);
  });

  it('round-trips command substitution syntax unchanged', () => {
    const args = ['Output is $(date) — capture it'];
    const rendered = renderArgvInvocation({ command: 'claude', args });
    expect(bashArgv(rendered)).toEqual(args);
  });

  it('round-trips double quotes unchanged', () => {
    const args = ['She said "hello there" loudly'];
    const rendered = renderArgvInvocation({ command: 'claude', args });
    expect(bashArgv(rendered)).toEqual(args);
  });

  it('round-trips single quotes unchanged', () => {
    const args = [`it's a "quoted 'nested' thing"`];
    const rendered = renderArgvInvocation({ command: 'claude', args });
    expect(bashArgv(rendered)).toEqual(args);
  });

  it('round-trips backslashes unchanged', () => {
    const args = [`path is C:\\Users\\foo\\bar and \\n is not a newline here`];
    const rendered = renderArgvInvocation({ command: 'claude', args });
    expect(bashArgv(rendered)).toEqual(args);
  });

  it('round-trips multiline text unchanged', () => {
    const args = [`line one\nline two\n\nline four`];
    const rendered = renderArgvInvocation({ command: 'claude', args });
    expect(bashArgv(rendered)).toEqual(args);
  });

  it('round-trips a kitchen-sink prompt unchanged', () => {
    const args = [
      [
        '# Heading with `code` and $VAR',
        '',
        '```bash',
        `if [ "$x" = 'foo' ]; then echo \\"hi\\"; fi`,
        '```',
        '',
        `End: it's done — really`,
      ].join('\n'),
      '--fast',
      '--model=claude-haiku-4-5',
    ];
    const rendered = renderArgvInvocation({ command: 'claude', args });
    expect(bashArgv(rendered)).toEqual(args);
  });
});

describe('expandInvokeTemplate', () => {
  it('substitutes {prompt} as one token', () => {
    expect(expandInvokeTemplate(['{prompt}'], { prompt: 'do it', promptFile: TASK_FILE })).toEqual([
      'do it',
    ]);
  });

  it('substitutes {promptFile} with the task-file path', () => {
    expect(
      expandInvokeTemplate(['--message-file', '{promptFile}'], { prompt: 'x', promptFile: TASK_FILE }),
    ).toEqual(['--message-file', '/bunsen/task/prompt.md']);
  });

  it('does substring replacement inside a token (--task={prompt})', () => {
    expect(
      expandInvokeTemplate(['--task={prompt}'], { prompt: 'fix it', promptFile: TASK_FILE }),
    ).toEqual(['--task=fix it']);
  });

  it('leaves non-placeholder tokens untouched', () => {
    expect(expandInvokeTemplate(['exec', '{prompt}'], { prompt: 'go', promptFile: TASK_FILE })).toEqual([
      'exec',
      'go',
    ]);
  });

  it('does not re-expand a placeholder that appears inside the substituted prompt text', () => {
    // Single-pass expansion: task text containing the literal "{promptFile}"
    // must survive verbatim when the template delivers via {prompt}.
    expect(
      expandInvokeTemplate(['{prompt}'], {
        prompt: 'document the {promptFile} contract',
        promptFile: TASK_FILE,
      }),
    ).toEqual(['document the {promptFile} contract']);
  });
});

describe('buildArgvInvocation', () => {
  it('leaves a bare command untouched (resolves via PATH, not /agent/)', () => {
    // codex/claude/gemini install to /bunsen/artifacts/bin (on PATH). A bare
    // command must NOT be rewritten to /agent/<cmd> — that path does not exist.
    const inv = buildArgvInvocation(makeAgent('codex'), makeExperiment('do it'), []);
    expect(inv.command).toBe('codex');
    expect(inv.args).toEqual(['do it']);
  });

  it('keeps absolute entrypoint as-is', () => {
    const inv = buildArgvInvocation(makeAgent('/usr/local/bin/claude'), makeExperiment('do it'), []);
    expect(inv.command).toBe('/usr/local/bin/claude');
    expect(inv.args).toEqual(['do it']);
  });

  it('splits python <script> entrypoints and rewrites a relative script path', () => {
    const inv = buildArgvInvocation(makeAgent('python src/main.py'), makeExperiment('go'), []);
    expect(inv.command).toBe('python');
    expect(inv.args).toEqual(['/agent/src/main.py', 'go']);
  });

  it('splits node <script> entrypoints and keeps an absolute script path', () => {
    const inv = buildArgvInvocation(makeAgent('node /agent/dist/index.js'), makeExperiment('go'), []);
    expect(inv.command).toBe('node');
    expect(inv.args).toEqual(['/agent/dist/index.js', 'go']);
  });

  it('appends extra CLI args after the prompt', () => {
    const inv = buildArgvInvocation(
      makeAgent('claude'),
      makeExperiment('go'),
      ['--fast', '--model=haiku'],
    );
    expect(inv.args).toEqual(['go', '--fast', '--model=haiku']);
  });

  it('places the prompt after a subcommand via invoke (codex-style)', () => {
    const inv = buildArgvInvocation(
      makeAgent('codex', ['exec', '{prompt}']),
      makeExperiment('fix the bug'),
      [],
    );
    expect(inv).toEqual({ command: 'codex', args: ['exec', 'fix the bug'] });
  });

  it('places the prompt after a flag via invoke (gemini-style)', () => {
    const inv = buildArgvInvocation(
      makeAgent('gemini', ['-p', '{prompt}']),
      makeExperiment('fix the bug'),
      ['--extra'],
    );
    expect(inv).toEqual({ command: 'gemini', args: ['-p', 'fix the bug', '--extra'] });
  });

  it('supports a {promptFile}-based invoke', () => {
    const inv = buildArgvInvocation(
      makeAgent('mycli', ['--message-file', '{promptFile}']),
      makeExperiment('unused as text'),
      [],
    );
    expect(inv).toEqual({ command: 'mycli', args: ['--message-file', '/bunsen/task/prompt.md'] });
  });

  it('appends invoke prefix after an interpreter-split script', () => {
    const inv = buildArgvInvocation(
      makeAgent('python src/main.py', ['run', '{prompt}']),
      makeExperiment('go'),
      [],
    );
    expect(inv).toEqual({ command: 'python', args: ['/agent/src/main.py', 'run', 'go'] });
  });

  it('emits no prompt token for an empty invoke (wrapper reads the file)', () => {
    const inv = buildArgvInvocation(makeAgent('/agent/run.sh', []), makeExperiment('go'), ['--x']);
    expect(inv).toEqual({ command: '/agent/run.sh', args: ['--x'] });
  });

  it('does not shell-escape the prompt — backticks/$ travel as-is in args', () => {
    const prompt = 'Use `grep $HOME` and "quotes"';
    const inv = buildArgvInvocation(makeAgent('claude'), makeExperiment(prompt), []);
    expect(inv.args[0]).toBe(prompt);
    // And it must round-trip through bash (bashArgv returns args only):
    expect(bashArgv(renderArgvInvocation(inv))).toEqual([prompt]);
  });
});

describe('formatInvocationForLog (display-only)', () => {
  it('leaves shell-safe identifiers unquoted', () => {
    const out = formatInvocationForLog({
      command: 'claude',
      args: ['-p', '--fast', '--model=haiku-4.5'],
    });
    expect(out).toBe('claude -p --fast --model=haiku-4.5');
  });

  it('single-quotes tokens with whitespace or shell metacharacters', () => {
    const out = formatInvocationForLog({
      command: 'python',
      args: ['/agent/main.py', 'Fix the $VAR bug', '--flag'],
    });
    expect(out).toBe(`python /agent/main.py 'Fix the $VAR bug' --flag`);
  });

  it('uses double quotes when the token has a single quote but no shell-active chars', () => {
    const out = formatInvocationForLog({
      command: 'claude',
      args: [`it's fine`],
    });
    expect(out).toBe(`claude "it's fine"`);
  });

  it('escapes single quotes when the token has both a single quote and shell-active chars', () => {
    // Falls back to escaped single-quoting because " would also be active.
    const out = formatInvocationForLog({
      command: 'claude',
      args: [`it's $HOME`],
    });
    expect(out).toBe(`claude 'it'\\''s $HOME'`);
  });

  it('collapses newlines to ↵ for display', () => {
    const out = formatInvocationForLog({
      command: 'claude',
      args: ['line one\nline two'],
    });
    expect(out).toBe(`claude 'line one↵line two'`);
  });

  it('does not over-quote: a multi-arg invocation reads naturally', () => {
    // The exact case from the user report — should be readable.
    const out = formatInvocationForLog({
      command: 'claude',
      args: [
        "Fix the bug.\n\nIt's about pandas.",
        '-p',
        '--dangerously-skip-permissions',
      ],
    });
    // The token has a single quote and a `.`, but no $/`/"/\\, so it gets
    // double-quoted — easier on the eyes than escaped single quotes.
    expect(out).toBe(
      `claude "Fix the bug.↵↵It's about pandas." -p --dangerously-skip-permissions`,
    );
  });
});

describe('argv guaranteed-args appending semantics', () => {
  it('extending invocation.args is array-concat (no shell quoting at this layer)', () => {
    // This mirrors the executor: orchestration.invocation.args = [...args, ...guaranteedArgs]
    const inv = { command: 'claude', args: ['Do X with `weird` text'] };
    inv.args = [...inv.args, '--dangerously-skip-permissions', '--model=haiku 4.5'];

    expect(inv.args).toEqual([
      'Do X with `weird` text',
      '--dangerously-skip-permissions',
      '--model=haiku 4.5',
    ]);

    // And bash sees exactly those argv tokens after rendering (bashArgv
    // returns args only — the command becomes the script).
    expect(bashArgv(renderArgvInvocation(inv))).toEqual([
      'Do X with `weird` text',
      '--dangerously-skip-permissions',
      '--model=haiku 4.5',
    ]);
  });
});
