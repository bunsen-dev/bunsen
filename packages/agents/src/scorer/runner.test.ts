import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APICallError, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import type { ScorerConfig } from '@bunsen-dev/types';

/**
 * The browser tools are stubbed: a unit test cannot launch Chromium, but the
 * wiring under test is how a browser result reaches the model, which is the
 * real `browserModelOutput`.
 */
vi.mock('./browser-tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browser-tools.js')>();
  return {
    ...actual,
    createScreenshotTool: (
      _ctx: import('./tools.js').ScorerContext,
      state: import('./tools.js').ScorerState,
    ) =>
      tool({
        description: 'stub screenshot',
        inputSchema: z.object({ url: z.string() }),
        execute: async (input) => {
          state.screenshots.push('looks-right-1.png');
          return {
            text: `Captured ${input.url} as looks-right-1.png.`,
            images: [{ filename: 'looks-right-1.png', base64: 'aGVsbG8=' }],
          };
        },
        toModelOutput: ({ output }) => actual.browserModelOutput(output),
      }),
  };
});

const { runScorer, ScorerError, transcriptForVerdictCall } = await import('./runner.js');
const { MAX_OUTPUT_TOKENS, MAX_REPORT_OUTPUT_TOKENS, MAX_STEPS } = await import('./config.js');

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

let callId = 0;

function callsTool(toolName: string, input: unknown): GenerateResult {
  return {
    content: [
      { type: 'tool-call', toolCallId: `call-${++callId}`, toolName, input: JSON.stringify(input) },
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool_use' },
    usage,
    warnings: [],
  };
}

function says(text: string): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'end_turn' },
    usage,
    warnings: [],
  };
}

/** A model that replies with the given results in order. */
function model(results: GenerateResult[]): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const result = results[index++];
      if (!result) throw new Error(`the scorer made more model calls than the test scripted (${index})`);
      return result;
    },
  });
}

let workspace: string;
let contextDir: string;
const logged: string[] = [];

function config(overrides: Partial<ScorerConfig> = {}): ScorerConfig {
  return {
    type: 'agent',
    id: 'tests-pass',
    title: 'Tests pass',
    instructions: 'Do the tests pass?',
    model: 'anthropic/claude-sonnet-5-5',
    contextDir,
    workspacePath: workspace,
    ...overrides,
  };
}

function run(cfg: ScorerConfig, mocked: MockLanguageModelV4) {
  return runScorer(cfg, { model: mocked, log: (line) => logged.push(line) });
}

function promptText(mocked: MockLanguageModelV4, index: number): string {
  return JSON.stringify(mocked.doGenerateCalls[index].prompt);
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scorer-runner-ws-'));
  contextDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorer-runner-ctx-'));
  fs.mkdirSync(path.join(contextDir, 'task'), { recursive: true });
  fs.writeFileSync(path.join(contextDir, 'task', 'prompt.md'), 'Make the failing test pass.');
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'nothing to see');
  logged.length = 0;
  callId = 0;
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(contextDir, { recursive: true, force: true });
});

describe('the judge', () => {
  it('makes exactly one call, offering submit_score and nothing else', async () => {
    const mocked = model([
      callsTool('submit_score', { summary: 'The diff adds the missing case.', score: 1 }),
    ]);

    const output = await run(config({ type: 'judge', scores: [0, 1] }), mocked);

    expect(output).toEqual({ score: 1, summary: 'The diff adds the missing case.' });
    expect(mocked.doGenerateCalls).toHaveLength(1);
    // Never forced: current Claude models reject `tool_choice: tool` / `any`.
    expect(mocked.doGenerateCalls[0].toolChoice).toEqual({ type: 'auto' });
    expect(mocked.doGenerateCalls[0].tools?.map((t) => t.name)).toEqual(['submit_score']);
  });

  it('gets one repair call when its verdict is rejected', async () => {
    const mocked = model([
      callsTool('submit_score', { summary: 'Half right.', score: 0.5 }),
      callsTool('submit_score', { summary: 'Half right, so it fails.', score: 0 }),
    ]);

    const output = await run(config({ type: 'judge', scores: [0, 1] }), mocked);

    expect(output.score).toBe(0);
    expect(mocked.doGenerateCalls).toHaveLength(2);
    expect(promptText(mocked, 1)).toContain('0.5 is not an allowed score for this criterion');
    expect(promptText(mocked, 1)).toContain('Submit now from what you have');
  });
});

describe('the agent loop', () => {
  it('submits on the first step', async () => {
    const mocked = model([callsTool('submit_score', { summary: 'Tests pass.', score: 1 })]);

    const output = await run(config({ scores: [0, 1] }), mocked);

    expect(output).toEqual({ score: 1, summary: 'Tests pass.' });
    expect(mocked.doGenerateCalls).toHaveLength(1);
    // The loop leaves the choice to the model, with every tool on offer.
    expect(mocked.doGenerateCalls[0].toolChoice).toEqual({ type: 'auto' });
  });

  it('explores, then submits', async () => {
    const mocked = model([
      callsTool('read_file', { path: 'notes.txt' }),
      callsTool('submit_score', { summary: 'notes.txt says nothing to see.', score: 1 }),
    ]);

    const output = await run(config({ scores: [0, 1] }), mocked);

    expect(output.score).toBe(1);
    expect(promptText(mocked, 1)).toContain('nothing to see');
    expect(logged.some((line) => line.startsWith('[scorer] step 1: read_file'))).toBe(true);
  });

  it('feeds a rejected score back and accepts the repair on the next step', async () => {
    const mocked = model([
      callsTool('submit_score', { summary: 'Partly.', score: 0.5 }),
      callsTool('submit_score', { summary: 'Partly, which this criterion calls a fail.', score: 0 }),
    ]);

    const output = await run(config({ scores: [0, 1] }), mocked);

    expect(output.score).toBe(0);
    expect(mocked.doGenerateCalls).toHaveLength(2);
    expect(promptText(mocked, 1)).toContain('0.5 is not an allowed score for this criterion');
    // The repair happened inside the loop, not via the verdict-only call.
    expect(promptText(mocked, 1)).not.toContain('Submit now from what you have');
  });

  it('asks again with submit_score as the only tool when the model stops without a verdict', async () => {
    const mocked = model([
      says('I think this looks fine.'),
      callsTool('submit_score', { summary: 'Looks fine from the diff.', score: 1 }),
    ]);

    const output = await run(config({ scores: [0, 1] }), mocked);

    expect(output.score).toBe(1);
    expect(mocked.doGenerateCalls).toHaveLength(2);
    // The loop offered the exploration tools; the verdict-only call withdraws them.
    expect(mocked.doGenerateCalls[0].tools?.map((t) => t.name)).toContain('read_file');
    expect(mocked.doGenerateCalls[1].tools?.map((t) => t.name)).toEqual(['submit_score']);
    expect(mocked.doGenerateCalls[1].toolChoice).toEqual({ type: 'auto' });
    expect(promptText(mocked, 1)).toContain(
      'Submit now from what you have. If you could not get the evidence this criterion needs',
    );
    expect(promptText(mocked, 1)).toContain('`submit_score` is the only tool available');
  });

  it('errors rather than inventing a score when even the verdict-only call submits nothing', async () => {
    const mocked = model([says('No comment.'), says('Still no comment.')]);

    await expect(run(config({ scores: [0, 1] }), mocked)).rejects.toBeInstanceOf(ScorerError);
  });

  it('stops at the step cap and then asks for the verdict with submit_score alone', async () => {
    const results: GenerateResult[] = Array.from({ length: MAX_STEPS }, () =>
      callsTool('read_file', { path: 'notes.txt' }),
    );
    results.push(callsTool('submit_score', { summary: 'Read enough.', score: 1 }));
    const mocked = model(results);

    const output = await run(config({ scores: [0, 1] }), mocked);

    expect(output.score).toBe(1);
    expect(mocked.doGenerateCalls).toHaveLength(MAX_STEPS + 1);
    expect(mocked.doGenerateCalls[MAX_STEPS].tools?.map((t) => t.name)).toEqual(['submit_score']);
    expect(mocked.doGenerateCalls[MAX_STEPS].toolChoice).toEqual({ type: 'auto' });
  });

  it('gives up cleanly when the first request already overflows (nothing to trim, no larger retry)', async () => {
    const mocked = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({
          message: 'prompt is too long: 250000 tokens > 200000 maximum',
          url: 'https://api.anthropic.com/v1/messages',
          requestBodyValues: {},
        });
      },
    });

    await expect(run(config({ scores: [0, 1] }), mocked)).rejects.toThrow(/evidence alone exceeds/);
    // A retry would resend the same prompt plus one message — strictly larger — so there is none.
    expect(mocked.doGenerateCalls).toHaveLength(1);
  });

  it('propagates a provider failure that is not a context-window error', async () => {
    const mocked = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({
          message: 'Internal server error',
          url: 'https://api.anthropic.com/v1/messages',
          requestBodyValues: {},
          isRetryable: false,
        });
      },
    });

    await expect(run(config(), mocked)).rejects.toThrow('Internal server error');
  });

  it('honors the tool allowlist', async () => {
    const mocked = model([callsTool('submit_score', { summary: 'Fine.', score: 1 })]);

    await run(config({ scores: [0, 1], tools: ['read_file'] }), mocked);

    expect(mocked.doGenerateCalls[0].tools?.map((t) => t.name).sort()).toEqual([
      'read_file',
      'submit_score',
    ]);
  });
});

describe('the browser-agent loop', () => {
  it('passes a screenshot back as an image content part and lists it in the output', async () => {
    const mocked = model([
      callsTool('screenshot', { url: 'http://localhost:3000' }),
      callsTool('submit_score', { summary: 'The header renders.', score: 1 }),
    ]);

    const output = await run(
      config({ type: 'browser-agent', id: 'looks-right', scores: [0, 1] }),
      mocked,
    );

    expect(output.screenshots).toEqual(['looks-right-1.png']);
    const secondPrompt = promptText(mocked, 1);
    expect(secondPrompt).toContain('"mediaType":"image/png"');
    expect(secondPrompt).toContain('aGVsbG8=');
  });
});

describe('the report step', () => {
  it('requires a report, returns a null score, and summarizes the first paragraph', async () => {
    const report = '# Evaluation report\n\nThe agent fixed the failing test and left the rest alone.\n\nMore detail.';
    const mocked = model([callsTool('submit_report', { report })]);

    const output = await run(
      config({ type: 'report', id: 'summary-report', title: 'Evaluation report' }),
      mocked,
    );

    expect(output.score).toBeNull();
    expect(output.report).toBe(report);
    expect(output.summary).toBe('The agent fixed the failing test and left the rest alone.');
    expect(mocked.doGenerateCalls[0].tools?.map((t) => t.name)).toContain('submit_report');
  });

  it('gets a larger output budget than a verdict loop', async () => {
    const reportModel = model([callsTool('submit_report', { report: 'A report.' })]);
    await run(config({ type: 'report', id: 'summary-report' }), reportModel);
    expect(reportModel.doGenerateCalls[0].maxOutputTokens).toBe(MAX_REPORT_OUTPUT_TOKENS);

    const judgeModel = model([callsTool('submit_score', { summary: 'Fine.', score: 1 })]);
    await run(config({ type: 'judge' }), judgeModel);
    expect(judgeModel.doGenerateCalls[0].maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
  });
});

describe('what the runner never sends', () => {
  it('sends no sampling parameters and sets no trace header of its own', async () => {
    const mocked = model([
      callsTool('read_file', { path: 'notes.txt' }),
      callsTool('submit_score', { summary: 'Fine.', score: 1 }),
    ]);

    await run(config({ scores: [0, 1] }), mocked);

    for (const call of mocked.doGenerateCalls) {
      expect(call.temperature).toBeUndefined();
      expect(call.topP).toBeUndefined();
      expect(call.topK).toBeUndefined();
      // `X-Bunsen-Source` belongs to the model the host builds, not to the runner.
      expect(call.headers?.['X-Bunsen-Source']).toBeUndefined();
    }
  });

  it('inlines the task prompt for every type', async () => {
    const mocked = model([callsTool('submit_score', { summary: 'Fine.', score: 1 })]);
    await run(config({ type: 'judge' }), mocked);
    expect(promptText(mocked, 0)).toContain('Make the failing test pass.');
  });
});

describe('redactSecretPatterns', () => {
  it('masks provider key shapes and bearer tokens but leaves ordinary text alone', async () => {
    const { redactSecretPatterns } = await import('./runner.js');
    const text =
      'export ANTHROPIC_API_KEY="sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" ' +
      'OPENAI_API_KEY=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef ' +
      'GEMINI_API_KEY=AIzaSyA1234567890abcdefghijklmnopqrstuvwx ' +
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc ' +
      'sk-short ok task-1 done';
    const out = redactSecretPatterns(text);
    expect(out).not.toContain('sk-ant-api03');
    expect(out).not.toContain('sk-proj-');
    expect(out).not.toContain('AIzaSy');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).toContain('ANTHROPIC_API_KEY="[redacted]"');
    expect(out).toContain('sk-short ok task-1 done');
  });
});


describe('transcriptForVerdictCall', () => {
  const assistantCall = (id: string) => ({
    role: 'assistant' as const,
    content: [{ type: 'tool-call' as const, toolCallId: id, toolName: 'read_file', input: { path: 'x' } }],
  });
  const toolResult = (id: string, size = 10) => ({
    role: 'tool' as const,
    content: [{ type: 'tool-result' as const, toolCallId: id, toolName: 'read_file', output: { type: 'text' as const, value: 'y'.repeat(size) } }],
  });
  const assistantText = (text: string) => ({ role: 'assistant' as const, content: text });

  it('drops a trailing assistant turn whose tool calls were never answered', () => {
    const transcript = [assistantCall('a'), toolResult('a'), assistantCall('b')];
    const out = transcriptForVerdictCall(transcript, { overflowed: false });
    expect(out.messages).toEqual([assistantCall('a'), toolResult('a')]);
    expect(out.dropped).toBe(1);
  });

  it('keeps an answered transcript intact when nothing overflowed', () => {
    const transcript = [assistantCall('a'), toolResult('a'), assistantText('done')];
    expect(transcriptForVerdictCall(transcript, { overflowed: false })).toEqual({ messages: transcript, dropped: 0 });
  });

  it('after an overflow keeps only the most recent messages within budget, cut at an assistant boundary', () => {
    const transcript = [
      assistantCall('a'), toolResult('a', 400),
      assistantCall('b'), toolResult('b', 400),
      assistantCall('c'), toolResult('c', 400),
    ];
    const out = transcriptForVerdictCall(transcript, { overflowed: true, budgetChars: 1100 });
    expect(out.messages[0]).toEqual(assistantCall('c'));
    expect(out.messages).toHaveLength(2);
    expect(out.dropped).toBe(4);
    // Never orphans a tool result: the kept slice starts with an assistant message.
    expect(out.messages.every((m, i) => i > 0 || m.role === 'assistant')).toBe(true);
  });
});

describe('runScorer — recovery paths', () => {
  it('after a context-window overflow the verdict-only call resends a SHORTER transcript and still records the verdict', async () => {
    // Five big tool results (each near the per-result cap) overflow the
    // verdict-call budget, so the recovery must drop the oldest ones.
    fs.writeFileSync(path.join(workspace, 'big.txt'), 'z'.repeat(40_000));
    let call = 0;
    const mocked = new MockLanguageModelV4({
      doGenerate: async () => {
        call += 1;
        if (call <= 5) return callsTool('read_file', { path: 'big.txt' });
        if (call === 6) {
          throw new APICallError({
            message: 'prompt is too long: 250000 tokens > 200000 maximum',
            url: 'https://api.anthropic.com/v1/messages',
            requestBodyValues: {},
          });
        }
        return callsTool('submit_score', { summary: 'Judged from what fit.', score: 1 });
      },
    });

    const output = await run(config({ scores: [0, 1] }), mocked);

    expect(output.score).toBe(1);
    expect(mocked.doGenerateCalls).toHaveLength(7);
    const overflowing = promptText(mocked, 5);
    const recovery = promptText(mocked, 6);
    expect(recovery.length).toBeLessThan(overflowing.length);
    expect(recovery).toContain('was dropped to fit the context window');
    expect(logged.some((l) => l.includes('dropped'))).toBe(true);
  });

  it('gives up cleanly when the evidence alone overflows (nothing to trim)', async () => {
    const mocked = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({
          message: 'prompt is too long: 250000 tokens > 200000 maximum',
          url: 'https://api.anthropic.com/v1/messages',
          requestBodyValues: {},
        });
      },
    });
    await expect(run(config({ type: 'judge', scores: [0, 1] }), mocked)).rejects.toThrow(/evidence alone exceeds/);
    expect(mocked.doGenerateCalls).toHaveLength(1);
  });

  it('a step that ends on `length` with an unexecuted tool call still reaches the verdict-only call', async () => {
    let call = 0;
    const mocked = new MockLanguageModelV4({
      doGenerate: async () => {
        call += 1;
        if (call === 1) {
          // A complete tool call, but the step ended on max_tokens: the SDK
          // executes nothing, so this assistant turn is never answered.
          return {
            ...callsTool('read_file', { path: 'notes.txt' }),
            finishReason: { unified: 'length', raw: 'max_tokens' },
          };
        }
        return callsTool('submit_score', { summary: 'From what I had.', score: 0 });
      },
    });

    const output = await run(config({ scores: [0, 1] }), mocked);

    expect(output.score).toBe(0);
    expect(mocked.doGenerateCalls).toHaveLength(2);
    // The unanswered assistant turn was dropped before the verdict-only call.
    expect(promptText(mocked, 1)).not.toContain('"toolName":"read_file"');
  });
});
