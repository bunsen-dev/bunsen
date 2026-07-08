// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect } from 'bun:test';
import yaml from 'js-yaml';
import {
  formatInvokeFlow,
  spliceInvokeIntoAgentYaml,
  hasBlockStyleEntrypoint,
  hostHelpPlan,
  isExecutableOnPath,
  runHostHelp,
  composeInvokePreview,
  INFER_INVOKE_COMMENT_MARKER,
} from './agents-infer-invoke-support.js';

describe('formatInvokeFlow', () => {
  it('renders a YAML flow sequence with double-quoted tokens', () => {
    expect(formatInvokeFlow(['exec', '{prompt}'])).toBe('["exec", "{prompt}"]');
    expect(formatInvokeFlow(['{prompt}'])).toBe('["{prompt}"]');
    expect(formatInvokeFlow([])).toBe('[]');
  });

  it('escapes tokens so YAML never reinterprets braces/quotes', () => {
    expect(formatInvokeFlow(['--task={prompt}'])).toBe('["--task={prompt}"]');
    // Round-trips through js-yaml as the exact tokens.
    // (double-quoted JSON is a subset of YAML)
  });
});

describe('spliceInvokeIntoAgentYaml', () => {
  const base = [
    '$schema: https://schemas.bunsen.dev/agent.v1.json',
    'version: v1',
    'name: codex-cli',
    'install:',
    '  source:',
    '    type: local',
    'entrypoint:',
    '  command: codex',
    '  args: [--sandbox, danger-full-access]',
    'interaction:',
    '  mode: direct',
    '',
  ].join('\n');

  it('inserts invoke immediately after command, with the generated comment', () => {
    const { text, action } = spliceInvokeIntoAgentYaml(base, ['exec', '{prompt}'], {
      comment: `${INFER_INVOKE_COMMENT_MARKER}: review me`,
    });
    expect(action).toBe('inserted');
    const lines = text.split('\n');
    const cmdIdx = lines.indexOf('  command: codex');
    expect(lines[cmdIdx + 1]).toBe(`  # ${INFER_INVOKE_COMMENT_MARKER}: review me`);
    expect(lines[cmdIdx + 2]).toBe('  invoke: ["exec", "{prompt}"]');
    // args untouched, still present after invoke.
    expect(text).toContain('  args: [--sandbox, danger-full-access]');
  });

  it('preserves all other lines and the trailing newline', () => {
    const { text } = spliceInvokeIntoAgentYaml(base, ['{prompt}']);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('name: codex-cli');
    expect(text).toContain('  mode: direct');
  });

  it('replaces an existing single-line invoke on force, dropping the old generated comment', () => {
    const withInvoke = [
      'entrypoint:',
      '  command: codex',
      `  # ${INFER_INVOKE_COMMENT_MARKER}: old note`,
      '  invoke: ["{prompt}"]',
      '  args: [--sandbox]',
      'interaction:',
      '  mode: direct',
      '',
    ].join('\n');
    const { text, action } = spliceInvokeIntoAgentYaml(withInvoke, ['exec', '{prompt}'], {
      comment: `${INFER_INVOKE_COMMENT_MARKER}: new note`,
    });
    expect(action).toBe('replaced');
    // Exactly one invoke line, the new one.
    expect(text.match(/^[ \t]*invoke:/gm)?.length).toBe(1);
    expect(text).toContain('  invoke: ["exec", "{prompt}"]');
    expect(text).toContain(`  # ${INFER_INVOKE_COMMENT_MARKER}: new note`);
    expect(text).not.toContain('old note');
    // Sibling keys survive.
    expect(text).toContain('  args: [--sandbox]');
    expect(text).toContain('  mode: direct');
  });

  it('replaces a block-sequence invoke (multi-line) on force', () => {
    const blockInvoke = [
      'entrypoint:',
      '  command: codex',
      '  invoke:',
      '    - exec',
      '    - "{prompt}"',
      '  args: [--sandbox]',
      'interaction:',
      '  mode: direct',
      '',
    ].join('\n');
    const { text } = spliceInvokeIntoAgentYaml(blockInvoke, ['{prompt}']);
    expect(text.match(/^[ \t]*invoke:/gm)?.length).toBe(1);
    expect(text).toContain('  invoke: ["{prompt}"]');
    // The old block items are gone.
    expect(text).not.toMatch(/^\s+- exec$/m);
    expect(text).toContain('  args: [--sandbox]');
    expect(text).toContain('  mode: direct');
  });

  it('throws on a non-block entrypoint', () => {
    const flow = 'entrypoint: { command: codex }\ninteraction:\n  mode: direct\n';
    expect(() => spliceInvokeIntoAgentYaml(flow, ['{prompt}'])).toThrow(/block-style `entrypoint:`/);
  });

  it('inserts as first child when there is no command line found (defensive)', () => {
    // Degenerate block (command written unusually) — still lands inside entrypoint.
    const weird = 'entrypoint:\n  help: codex --help\ninteraction:\n  mode: direct\n';
    const { text } = spliceInvokeIntoAgentYaml(weird, ['{prompt}']);
    const lines = text.split('\n');
    const epIdx = lines.indexOf('entrypoint:');
    expect(lines[epIdx + 1]).toBe('  invoke: ["{prompt}"]');
  });

  // Regression: a block-sequence invoke whose items sit at the SAME indent as
  // the key is valid YAML; replacing it must consume those `- ` items, not
  // orphan them into invalid YAML.
  it('replaces a same-indent block-sequence invoke into valid YAML (regression)', () => {
    const sameIndent = [
      'name: x',
      'entrypoint:',
      '  command: claude',
      '  invoke:',
      '  - "{prompt}"',
      '  - "--print"',
      '  args: [-x]',
      'interaction:',
      '  mode: direct',
      '',
    ].join('\n');
    const { text, action } = spliceInvokeIntoAgentYaml(sameIndent, ['exec', '{prompt}']);
    expect(action).toBe('replaced');
    expect(text.match(/^[ \t]*invoke:/gm)?.length).toBe(1);
    // Must parse cleanly and carry the new template — no orphaned `- ` items.
    const doc = yaml.load(text) as { entrypoint: { invoke: string[]; args: string[] } };
    expect(doc.entrypoint.invoke).toEqual(['exec', '{prompt}']);
    expect(doc.entrypoint.args).toEqual(['-x']);
  });

  // Regression: a block-scalar `command` value spans multiple lines; the new
  // invoke must land AFTER the folded body, not split the scalar.
  it('inserts after a block-scalar command into valid YAML (regression)', () => {
    const blockScalar = [
      'entrypoint:',
      '  command: >',
      '    claude',
      '    --foo',
      '  args: ["-x"]',
      'interaction:',
      '  mode: direct',
      '',
    ].join('\n');
    const { text } = spliceInvokeIntoAgentYaml(blockScalar, ['{prompt}']);
    const doc = yaml.load(text) as { entrypoint: { command: string; invoke: string[] } };
    expect(doc.entrypoint.invoke).toEqual(['{prompt}']);
    expect(doc.entrypoint.command.trim()).toBe('claude --foo');
  });
});

describe('hasBlockStyleEntrypoint', () => {
  it('accepts a block-style entrypoint mapping', () => {
    expect(hasBlockStyleEntrypoint('entrypoint:\n  command: codex\n')).toBe(true);
    expect(hasBlockStyleEntrypoint('entrypoint:  # note\n  command: codex\n')).toBe(true);
  });
  it('rejects a flow-style entrypoint', () => {
    expect(hasBlockStyleEntrypoint('entrypoint: { command: codex }\n')).toBe(false);
  });
});

describe('hostHelpPlan', () => {
  it('uses the declared help command when present', () => {
    expect(hostHelpPlan({ command: 'codex', help: 'codex --help' })).toEqual({
      executable: 'codex',
      command: 'codex --help',
    });
  });

  it('defaults to `<command> --help` and derives the interpreter as the executable', () => {
    expect(hostHelpPlan({ command: 'codex' })).toEqual({
      executable: 'codex',
      command: 'codex --help',
    });
    expect(hostHelpPlan({ command: 'python src/main.py' })).toEqual({
      executable: 'python',
      command: 'python src/main.py --help',
      scriptArg: 'src/main.py',
    });
  });

  it('surfaces the script arg for interpreter forms (so the caller can gate on its existence)', () => {
    expect(hostHelpPlan({ command: 'python /agent/main.py' }).scriptArg).toBe('/agent/main.py');
    expect(hostHelpPlan({ command: 'node /agent/dist/index.js' }).scriptArg).toBe('/agent/dist/index.js');
    // Bare commands have no script to gate on.
    expect(hostHelpPlan({ command: 'codex' }).scriptArg).toBeUndefined();
    expect(hostHelpPlan({ command: 'gemini' }).scriptArg).toBeUndefined();
  });
});

describe('isExecutableOnPath', () => {
  const existsIn = (present: string[]) => (p: string) => present.includes(p);

  it('searches PATH for a bare name (posix)', () => {
    expect(
      isExecutableOnPath('codex', {
        platform: 'linux',
        pathEnv: '/usr/bin:/opt/bin',
        existsSync: existsIn(['/opt/bin/codex']),
      }),
    ).toBe(true);
    expect(
      isExecutableOnPath('missing', {
        platform: 'linux',
        pathEnv: '/usr/bin:/opt/bin',
        existsSync: existsIn(['/opt/bin/codex']),
      }),
    ).toBe(false);
  });

  it('checks a path-bearing executable directly', () => {
    expect(
      isExecutableOnPath('/agent/bin/tool', {
        platform: 'linux',
        existsSync: existsIn(['/agent/bin/tool']),
      }),
    ).toBe(true);
  });

  it('honors PATHEXT on windows', () => {
    expect(
      isExecutableOnPath('codex', {
        platform: 'win32',
        pathEnv: 'C:\\bin',
        pathExt: '.EXE;.CMD',
        existsSync: existsIn(['C:\\bin\\codex.CMD']),
      }),
    ).toBe(true);
  });
});

describe('runHostHelp', () => {
  it('returns captured stdout+stderr on success (non-zero exit still counts if output exists)', () => {
    const fakeSpawn = (() => ({ status: 1, stdout: 'usage: codex exec <PROMPT>', stderr: '' })) as never;
    const res = runHostHelp({ executable: 'codex', command: 'codex --help' }, { spawn: fakeSpawn });
    expect(res.ok).toBe(true);
    expect(res.output).toContain('usage: codex exec');
  });

  it('fails when the process errored (e.g. timeout / ENOENT)', () => {
    const fakeSpawn = (() => ({ error: new Error('ETIMEDOUT'), stdout: '', stderr: '' })) as never;
    const res = runHostHelp({ executable: 'codex', command: 'codex --help' }, { spawn: fakeSpawn });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('ETIMEDOUT');
  });

  it('fails when there is no output', () => {
    const fakeSpawn = (() => ({ status: 0, stdout: '   ', stderr: '' })) as never;
    const res = runHostHelp({ executable: 'codex', command: 'codex --help' }, { spawn: fakeSpawn });
    expect(res.ok).toBe(false);
  });
});

describe('composeInvokePreview', () => {
  it('mirrors the runtime composer: interpreter split → invoke → guaranteed args', () => {
    const preview = composeInvokePreview(
      { command: 'codex', args: ['--sandbox', 'danger-full-access'] },
      ['exec', '{prompt}'],
      'Fix the bug',
    );
    expect(preview).toBe("codex exec 'Fix the bug' --sandbox danger-full-access");
  });

  it('splits an interpreter command and rewrites a relative script under /agent', () => {
    const preview = composeInvokePreview({ command: 'python src/main.py' }, ['{prompt}'], 'Do it');
    expect(preview).toBe("python /agent/src/main.py 'Do it'");
  });

  it('emits no prompt token for an empty invoke (wrapper reads the task file)', () => {
    const preview = composeInvokePreview({ command: 'run.sh', args: ['--yes'] }, [], 'Do it');
    expect(preview).toBe('run.sh --yes');
  });
});
