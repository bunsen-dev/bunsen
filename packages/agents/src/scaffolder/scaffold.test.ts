// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '@bunsen-dev/types';
import {
  validateInvokeTemplate,
  scaffoldBasis,
  buildScaffoldSystemPrompt,
  buildScaffoldUserPrompt,
  DEFAULT_SCAFFOLD_MODEL,
} from './scaffold.js';

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    version: 'v1',
    name: 'codex-cli',
    install: { source: { type: 'local' } },
    entrypoint: { command: 'codex' },
    interaction: { mode: 'direct' },
    ...overrides,
  };
}

describe('validateInvokeTemplate', () => {
  it('accepts the three canonical shapes plus the promptFile channel', () => {
    expect(() => validateInvokeTemplate(['{prompt}'])).not.toThrow();
    expect(() => validateInvokeTemplate(['exec', '{prompt}'])).not.toThrow();
    expect(() => validateInvokeTemplate(['-p', '{prompt}'])).not.toThrow();
    expect(() => validateInvokeTemplate(['--message-file', '{promptFile}'])).not.toThrow();
    expect(() => validateInvokeTemplate(['--task={prompt}'])).not.toThrow();
  });

  it('accepts an empty template (wrapper command reads the task itself)', () => {
    expect(() => validateInvokeTemplate([])).not.toThrow();
  });

  it('rejects a non-string-array', () => {
    expect(() => validateInvokeTemplate('nope')).toThrow(/array of strings/);
    expect(() => validateInvokeTemplate([1, 2])).toThrow(/array of strings/);
  });

  it('rejects unknown placeholders', () => {
    expect(() => validateInvokeTemplate(['{task}'])).toThrow(/unknown placeholder/);
    expect(() => validateInvokeTemplate(['exec', '{PROMPT}'])).toThrow(/unknown placeholder/);
  });

  it('rejects mixing placeholder kinds (single delivery channel)', () => {
    expect(() => validateInvokeTemplate(['{prompt}', '{promptFile}'])).toThrow(
      /at most one placeholder kind/,
    );
  });

  it('rejects a non-empty template with no prompt placeholder', () => {
    expect(() => validateInvokeTemplate(['exec'])).toThrow(/must contain a prompt placeholder/);
  });
});

describe('scaffoldBasis', () => {
  it('lists examples + help + command when all are present, most-informative first', () => {
    const a = agent({ examples: [{ prompt: 'x', invocation: 'codex exec "x"' }] });
    expect(scaffoldBasis(a, 'usage: codex …')).toEqual(['examples', 'help', 'command']);
  });

  it('falls back to command-only with no examples and no help', () => {
    expect(scaffoldBasis(agent(), undefined)).toEqual(['command']);
    expect(scaffoldBasis(agent(), '   ')).toEqual(['command']);
  });
});

describe('prompt design', () => {
  it('system prompt teaches the argv contract, the placeholders, and forces one tool call', () => {
    const sys = buildScaffoldSystemPrompt();
    expect(sys).toContain('submit_invoke_template EXACTLY ONCE');
    expect(sys).toContain('{prompt}');
    expect(sys).toContain('{promptFile}');
    // The three shapes it is choosing between.
    expect(sys).toContain('["{prompt}"]');
    expect(sys).toContain('["exec", "{prompt}"]');
    expect(sys).toContain('["-p", "{prompt}"]');
    // Must not repeat persistent args, and must not shell-quote.
    expect(sys).toContain('do NOT repeat them in invoke');
    expect(sys).toContain('NO shell quoting');
  });

  it('user prompt carries the command, args, examples, and captured help — but never a task/rubric', () => {
    const a = agent({
      description: 'OpenAI Codex CLI',
      entrypoint: { command: 'codex', args: ['--sandbox', 'danger-full-access'] },
      examples: [{ prompt: 'Fix the bug', invocation: 'codex exec "Fix the bug"' }],
    });
    const user = buildScaffoldUserPrompt(a, 'usage: codex exec <PROMPT>');
    expect(user).toContain('codex');
    expect(user).toContain('OpenAI Codex CLI');
    expect(user).toContain('--sandbox');
    expect(user).toContain('codex exec "Fix the bug"');
    expect(user).toContain('usage: codex exec <PROMPT>');
    // Pure function of the agent: no experiment/task/rubric surface.
    expect(user).not.toContain('Rubric');
    expect(user).not.toContain('Experiment');
  });

  it('user prompt notes the absence of examples so the model leans on help/convention', () => {
    const user = buildScaffoldUserPrompt(agent(), undefined);
    expect(user).toContain('No examples were provided');
  });

  it('truncates a runaway help dump', () => {
    const huge = 'x'.repeat(20000);
    const user = buildScaffoldUserPrompt(agent(), huge);
    expect(user).toContain('…(truncated)');
    expect(user.length).toBeLessThan(20000);
  });
});

describe('model default', () => {
  it('defaults to opus (quality over cost for a once-per-agent, human-reviewed tool)', () => {
    expect(DEFAULT_SCAFFOLD_MODEL).toBe('claude-opus-4-8');
  });
});
