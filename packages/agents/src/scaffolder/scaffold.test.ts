import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { AgentConfig } from '@bunsen-dev/types';

// `scaffoldInvokeTemplate` builds its model from `<provider>/<model>` + a key;
// stubbing the one factory lets the loop run against a mock model with no key.
const { createModelMock } = vi.hoisted(() => ({ createModelMock: vi.fn() }));
vi.mock('../common/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../common/index.js')>()),
  createModel: createModelMock,
}));

import {
  validateInvokeTemplate,
  scaffoldBasis,
  scaffoldInvokeTemplate,
  buildScaffoldSystemPrompt,
  buildScaffoldUserPrompt,
  DEFAULT_SCAFFOLD_MODEL,
} from './scaffold.js';
import { parseModelRef } from '../common/model.js';

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
    expect(DEFAULT_SCAFFOLD_MODEL).toBe('anthropic/claude-opus-4-8');
  });

  it('is a parseable <provider>/<model> reference', () => {
    expect(() => parseModelRef(DEFAULT_SCAFFOLD_MODEL)).not.toThrow();
  });
});

// =============================================================================
// The model loop, driven by a mock model (no API key, no network)
// =============================================================================

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
} as const;

/** A model that answers with one `submit_invoke_template` tool call. */
function toolCallModel(input: unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [
        {
          type: 'tool-call' as const,
          toolCallId: 'c1',
          toolName: 'submit_invoke_template',
          input: JSON.stringify(input),
        },
      ],
      finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' },
      usage: USAGE,
      warnings: [],
    }),
  });
}

/** A model that ignores the forced tool choice and answers with prose. */
function textModel(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text }],
      finishReason: { unified: 'stop' as const, raw: 'end_turn' },
      usage: USAGE,
      warnings: [],
    }),
  });
}

describe('scaffoldInvokeTemplate', () => {
  beforeEach(() => {
    createModelMock.mockReset();
  });

  it('returns the submitted template, its reasoning, and the basis', async () => {
    const model = toolCallModel({
      invoke: ['exec', '{prompt}'],
      reasoning: 'The examples pass the prompt positionally after `exec`.',
    });
    createModelMock.mockReturnValue(model);

    const result = await scaffoldInvokeTemplate({
      agent: agent({ examples: [{ prompt: 'Fix the bug', invocation: 'codex exec "Fix the bug"' }] }),
      helpText: 'usage: codex exec <PROMPT>',
      apiKey: 'sk-test',
    });

    expect(result).toEqual({
      invoke: ['exec', '{prompt}'],
      reasoning: 'The examples pass the prompt positionally after `exec`.',
      basis: ['examples', 'help', 'command'],
    });
    // Default model, host key — and nothing else is invented.
    expect(createModelMock).toHaveBeenCalledWith(DEFAULT_SCAFFOLD_MODEL, { apiKey: 'sk-test' });
  });

  it('forces the submit tool, caps the step budget, and sends no sampling parameters', async () => {
    const model = toolCallModel({ invoke: ['{prompt}'], reasoning: 'Bare positional.' });
    createModelMock.mockReturnValue(model);

    await scaffoldInvokeTemplate({ agent: agent(), apiKey: 'sk-test', model: 'openai/gpt-5.5' });

    expect(createModelMock).toHaveBeenCalledWith('openai/gpt-5.5', { apiKey: 'sk-test' });
    expect(model.doGenerateCalls).toHaveLength(1);
    const call = model.doGenerateCalls[0];
    expect(call.toolChoice).toEqual({ type: 'tool', toolName: 'submit_invoke_template' });
    expect(call.tools?.map((t) => t.name)).toEqual(['submit_invoke_template']);
    expect(call.maxOutputTokens).toBe(2048);
    expect(call.temperature).toBeUndefined();
    expect(call.topP).toBeUndefined();
  });

  it('rejects a template the runtime loader would reject, naming the reason', async () => {
    createModelMock.mockReturnValue(
      toolCallModel({ invoke: ['exec'], reasoning: 'Forgot the prompt slot.' }),
    );

    await expect(
      scaffoldInvokeTemplate({ agent: agent(), apiKey: 'sk-test' }),
    ).rejects.toThrow(/did not return a valid submit_invoke_template call: .*must contain a prompt placeholder/);
  });

  it('fails loudly when the model answers with prose instead of the tool call', async () => {
    createModelMock.mockReturnValue(textModel('I think you should run `codex exec "<prompt>"`.'));

    await expect(scaffoldInvokeTemplate({ agent: agent(), apiKey: 'sk-test' })).rejects.toThrow(
      'The scaffolder model did not return a submit_invoke_template tool call.',
    );
  });

  it('never calls a model without a key', async () => {
    await expect(scaffoldInvokeTemplate({ agent: agent(), apiKey: '' })).rejects.toThrow(
      /API key is required/,
    );
    expect(createModelMock).not.toHaveBeenCalled();
  });
});
