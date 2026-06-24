// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  buildDefaultArgvInvocation,
  formatInvocationForLog,
  parseOrchestrationResult,
  renderArgvInvocation,
  shellSingleQuote,
} from './orchestration.js';
import type { ResolvedAgent } from './agent-loader.js';
import type { ResolvedExperiment } from './experiment-loader.js';

function makeAgent(entrypointCommand: string): ResolvedAgent {
  return {
    version: 'v1',
    name: 'fake-agent',
    install: { source: { type: 'local', path: '.' } },
    entrypoint: { command: entrypointCommand },
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

describe('buildDefaultArgvInvocation', () => {
  it('rewrites bare relative entrypoint to /agent/<cmd>', () => {
    const inv = buildDefaultArgvInvocation(makeAgent('my-agent'), makeExperiment('do it'), []);
    expect(inv.command).toBe('/agent/my-agent');
    expect(inv.args).toEqual(['do it']);
  });

  it('keeps absolute entrypoint as-is', () => {
    const inv = buildDefaultArgvInvocation(makeAgent('/usr/local/bin/claude'), makeExperiment('do it'), []);
    expect(inv.command).toBe('/usr/local/bin/claude');
    expect(inv.args).toEqual(['do it']);
  });

  it('splits python <script> entrypoints and rewrites the script path', () => {
    const inv = buildDefaultArgvInvocation(makeAgent('python src/main.py'), makeExperiment('go'), []);
    expect(inv.command).toBe('python');
    expect(inv.args).toEqual(['/agent/src/main.py', 'go']);
  });

  it('splits node <script> entrypoints and rewrites the script path', () => {
    const inv = buildDefaultArgvInvocation(makeAgent('node dist/index.js'), makeExperiment('go'), []);
    expect(inv.command).toBe('node');
    expect(inv.args).toEqual(['/agent/dist/index.js', 'go']);
  });

  it('appends extra CLI args after the task prompt', () => {
    const inv = buildDefaultArgvInvocation(
      makeAgent('claude'),
      makeExperiment('go'),
      ['--fast', '--model=haiku'],
    );
    expect(inv.args).toEqual(['go', '--fast', '--model=haiku']);
  });

  it('does not shell-escape the prompt — backticks/$ travel as-is in args', () => {
    const prompt = 'Use `grep $HOME` and "quotes"';
    const inv = buildDefaultArgvInvocation(makeAgent('claude'), makeExperiment(prompt), []);
    expect(inv.args[0]).toBe(prompt);
    // And it must round-trip through bash (bashArgv returns args only):
    expect(bashArgv(renderArgvInvocation(inv))).toEqual([prompt]);
  });
});

describe('parseOrchestrationResult', () => {
  it('parses a well-formed result', () => {
    const json = JSON.stringify({
      setupCommands: ['cd /workspace'],
      invocation: { command: 'claude', args: ['Fix the bug', '--fast'] },
    });
    const r = parseOrchestrationResult(json);
    expect(r.setupCommands).toEqual(['cd /workspace']);
    expect(r.invocation).toEqual({ command: 'claude', args: ['Fix the bug', '--fast'] });
  });

  it('repairs a multi-word interpreter command the model failed to split', () => {
    // The orchestrator (an LLM) sometimes returns the whole entrypoint as a
    // single `command` instead of command + args. A command with whitespace can
    // never name a real executable, so we split it the same way the no-LLM path
    // does — matching `buildDefaultArgvInvocation`.
    const json = JSON.stringify({
      setupCommands: [],
      invocation: { command: 'python /agent/main.py', args: ['Fix the bug'] },
    });
    const r = parseOrchestrationResult(json);
    expect(r.invocation).toEqual({
      command: 'python',
      args: ['/agent/main.py', 'Fix the bug'],
    });
  });

  it('repairs a multi-word node command and rewrites a relative script path', () => {
    const json = JSON.stringify({
      setupCommands: [],
      invocation: { command: 'node dist/index.js', args: ['go'] },
    });
    const r = parseOrchestrationResult(json);
    expect(r.invocation).toEqual({ command: 'node', args: ['/agent/dist/index.js', 'go'] });
  });

  it('leaves a single-token command untouched', () => {
    const json = JSON.stringify({
      setupCommands: [],
      invocation: { command: 'codex', args: ['exec', 'go'] },
    });
    const r = parseOrchestrationResult(json);
    expect(r.invocation).toEqual({ command: 'codex', args: ['exec', 'go'] });
  });

  it('leaves an already-correct interpreter invocation untouched (script in args)', () => {
    // The boundary case: a bare `python` command with the script already in
    // args is the correct structured form and must NOT be re-split. This is
    // what guards against the `startsWith('python ')` trailing space ever being
    // dropped — without it, a bare `python` would be wrongly mangled.
    const json = JSON.stringify({
      setupCommands: [],
      invocation: { command: 'python', args: ['/agent/main.py', 'Fix the bug'] },
    });
    const r = parseOrchestrationResult(json);
    expect(r.invocation).toEqual({ command: 'python', args: ['/agent/main.py', 'Fix the bug'] });
  });

  it('repairing a multi-word command is idempotent', () => {
    const lazy = { command: 'python /agent/main.py', args: ['Fix the bug'] };
    const once = parseOrchestrationResult(
      JSON.stringify({ setupCommands: [], invocation: lazy }),
    ).invocation;
    const twice = parseOrchestrationResult(
      JSON.stringify({ setupCommands: [], invocation: once }),
    ).invocation;
    expect(once).toEqual({ command: 'python', args: ['/agent/main.py', 'Fix the bug'] });
    expect(twice).toEqual(once);
  });

  it('rejects non-JSON', () => {
    expect(() => parseOrchestrationResult('not json')).toThrow(/not valid JSON/);
  });

  it('rejects missing setupCommands', () => {
    const json = JSON.stringify({ invocation: { command: 'c', args: [] } });
    expect(() => parseOrchestrationResult(json)).toThrow(/setupCommands/);
  });

  it('rejects non-string entries in setupCommands', () => {
    const json = JSON.stringify({
      setupCommands: ['ok', 5],
      invocation: { command: 'c', args: [] },
    });
    expect(() => parseOrchestrationResult(json)).toThrow(/setupCommands/);
  });

  it('rejects missing invocation', () => {
    const json = JSON.stringify({ setupCommands: [] });
    expect(() => parseOrchestrationResult(json)).toThrow(/invocation/);
  });

  it('rejects empty command', () => {
    const json = JSON.stringify({ setupCommands: [], invocation: { command: '', args: [] } });
    expect(() => parseOrchestrationResult(json)).toThrow(/command/);
  });

  it('rejects non-string args entries', () => {
    const json = JSON.stringify({
      setupCommands: [],
      invocation: { command: 'c', args: ['ok', 7] },
    });
    expect(() => parseOrchestrationResult(json)).toThrow(/args/);
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
