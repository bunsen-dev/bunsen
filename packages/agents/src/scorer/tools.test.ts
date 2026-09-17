import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asSchema } from 'ai';
import type { ScorerConfig } from '@bunsen-dev/types';

// Partial mock so the real command still runs while the options are observable.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});
const { execFile } = await import('node:child_process');
const execFileMock = vi.mocked(execFile);

const {
  buildTools,
  childEnv,
  createListThreadsTool,
  createReadFileTool,
  createReadThreadTurnsTool,
  createRunCommandTool,
  createScorerContext,
  createScorerState,
  createSubmitReportTool,
  createSubmitScoreTool,
  explorationToolNames,
  verdictToolName,
} = await import('./tools.js');
const { DEFAULT_COMMAND_TIMEOUT_MS, MAX_TOOL_RESULT_CHARS } = await import('./config.js');
type ScorerTool = import('./tools.js').ScorerTool;
type ScorerContext = import('./tools.js').ScorerContext;
type ScorerState = import('./tools.js').ScorerState;

const TRACES_CONTEXT_DIR = fileURLToPath(new URL('./__fixtures__', import.meta.url));

let workspace: string;
let logged: string[];

function config(overrides: Partial<ScorerConfig> = {}): ScorerConfig {
  return {
    type: 'agent',
    id: 'tests-pass',
    title: 'Tests pass',
    instructions: 'Do the tests pass?',
    model: 'anthropic/claude-sonnet-4-6',
    contextDir: TRACES_CONTEXT_DIR,
    workspacePath: workspace,
    ...overrides,
  };
}

function context(overrides: Partial<ScorerConfig> = {}): ScorerContext {
  return createScorerContext(config(overrides), (line) => logged.push(line));
}

/** Call a tool the way `generateText` does. */
async function run(tool: ScorerTool, input: unknown): Promise<string> {
  const execute = tool.execute as (input: unknown, options: unknown) => unknown;
  const output = await execute(input, { toolCallId: 'call-1', messages: [] });
  return typeof output === 'string' ? output : JSON.stringify(output);
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scorer-tools-'));
  logged = [];
  execFileMock.mockClear();
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('childEnv', () => {
  it('strips every platform provider key', () => {
    const env = childEnv({
      PATH: '/usr/bin',
      BUNSEN_ANTHROPIC_API_KEY: 'sk-a',
      BUNSEN_OPENAI_API_KEY: 'sk-o',
      BUNSEN_GEMINI_API_KEY: 'sk-g',
      BUNSEN_RUN_ID: 'run-1',
      ANTHROPIC_BASE_URL: 'https://proxy',
    });

    expect(env).toEqual({
      PATH: '/usr/bin',
      BUNSEN_RUN_ID: 'run-1',
      ANTHROPIC_BASE_URL: 'https://proxy',
    });
  });
});

describe('run_command', () => {
  it('applies the documented default timeout when none is given', async () => {
    await run(createRunCommandTool(context()), { command: 'echo hi' });

    const options = execFileMock.mock.calls[0][2] as { timeout?: number; cwd?: string };
    expect(options.timeout).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
    expect(options.cwd).toBe(workspace);
  });

  it('honors an explicit timeout and reports the kill', async () => {
    const result = await run(createRunCommandTool(context()), {
      command: 'sleep 5',
      timeout_ms: 100,
    });

    expect((execFileMock.mock.calls[0][2] as { timeout?: number }).timeout).toBe(100);
    expect(result).toContain('Command timed out after 100ms');
  });

  it('runs in the workspace and returns stdout', async () => {
    fs.writeFileSync(path.join(workspace, 'marker.txt'), 'hello');
    const result = await run(createRunCommandTool(context()), { command: 'ls' });
    expect(result).toContain('marker.txt');
  });

  it('includes the exit code and stderr on failure', async () => {
    const result = await run(createRunCommandTool(context()), {
      command: 'echo boom >&2; exit 3',
    });
    expect(result).toContain('Exit code: 3');
    expect(result).toContain('boom');
  });

  it('never exposes a platform key to the command it spawns', async () => {
    const previous = process.env.BUNSEN_ANTHROPIC_API_KEY;
    process.env.BUNSEN_ANTHROPIC_API_KEY = 'sk-should-not-leak';
    try {
      const result = await run(createRunCommandTool(context()), {
        command: 'echo "[$BUNSEN_ANTHROPIC_API_KEY]"',
      });
      expect(result).toContain('[]');
      expect(result).not.toContain('sk-should-not-leak');
    } finally {
      if (previous === undefined) delete process.env.BUNSEN_ANTHROPIC_API_KEY;
      else process.env.BUNSEN_ANTHROPIC_API_KEY = previous;
    }
  });

  it('truncates a huge result head+tail instead of refusing it', async () => {
    fs.writeFileSync(path.join(workspace, 'big.txt'), `${'a'.repeat(20_000)}${'b'.repeat(20_000)}`);
    const result = await run(createRunCommandTool(context()), { command: 'cat big.txt' });

    expect(result).toContain('[command output truncated');
    expect(result).toContain('aaaa');
    expect(result).toContain('bbbb');
    expect(result.length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 500);
  });

  it('detaches a background command and returns its log path', async () => {
    const ctx = context();
    const first = await run(createRunCommandTool(ctx), {
      command: 'echo started',
      background: true,
    });
    expect(first).toContain('/tmp/bg-1.log');
    expect(logged.some((line) => line.includes('/tmp/bg-1.log'))).toBe(true);

    const second = await run(createRunCommandTool(ctx), { command: 'echo again', background: true });
    expect(second).toContain('/tmp/bg-2.log');
  });
});

describe('read_file', () => {
  it('reads a whole small file', async () => {
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'one\ntwo\n');
    expect(await run(createReadFileTool(context()), { path: 'a.txt' })).toBe('one\ntwo\n');
  });

  it('reads an inclusive 1-indexed range', async () => {
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'l1\nl2\nl3\nl4\nl5');
    const result = await run(createReadFileTool(context()), {
      path: 'a.txt',
      start_line: 2,
      end_line: 4,
    });
    expect(result).toBe('[Lines 2-4 of 5]\nl2\nl3\nl4');
  });

  it('counts a negative start_line from the end', async () => {
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'l1\nl2\nl3\nl4\nl5');
    const result = await run(createReadFileTool(context()), { path: 'a.txt', start_line: -2 });
    expect(result).toBe('[Lines 4-5 of 5]\nl4\nl5');
  });

  it('returns the first lines with a notice for a big file read with no range', async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(path.join(workspace, 'big.txt'), lines.join('\n'));

    const result = await run(createReadFileTool(context()), { path: 'big.txt' });
    expect(result).toContain('[Lines 1-2000 of 2500');
    expect(result).toContain('line 1\n');
    expect(result).not.toContain('line 2001');
  });

  it('lists a directory instead of failing on it', async () => {
    fs.mkdirSync(path.join(workspace, 'src'));
    fs.writeFileSync(path.join(workspace, 'README.md'), '# hi');

    const result = await run(createReadFileTool(context()), { path: '.' });
    expect(result).toContain('src/');
    expect(result).toContain('README.md');
  });

  it('resolves absolute paths as given and reports a missing file plainly', async () => {
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'x');
    expect(await run(createReadFileTool(context()), { path: path.join(workspace, 'a.txt') })).toBe('x');
    expect(await run(createReadFileTool(context()), { path: 'nope.txt' })).toContain(
      'No such file or directory',
    );
  });
});

describe('trace tools', () => {
  it('lists the captured threads', async () => {
    const result = await run(createListThreadsTool(context()), {});
    expect(result).toContain('42 calls across 2 thread(s)');
    expect(result).toContain('- thread-1 — anthropic/claude-sonnet-4-6, 40 turns');
    expect(result).toContain('system: You are a coding agent');
  });

  it('says so plainly when a run captured no conversations', async () => {
    const result = await run(createListThreadsTool(context({ contextDir: '/nonexistent' })), {});
    expect(result).toContain('No agent model conversations are available for this run');
  });

  it('reads a slice and clamps an over-wide one', async () => {
    const tool = createReadThreadTurnsTool(context());

    const slice = await run(tool, { thread_id: 'thread-1', start: 0, end: 2 });
    expect(slice).toContain('Thread thread-1 — turns 0–2 of 40.');
    expect(slice).toContain('#### Turn 0');
    expect(slice).not.toContain('#### Turn 2');

    const clamped = await run(tool, { thread_id: 'thread-1', start: 0, end: 999 });
    expect(clamped).toContain('Clamped to 30 turns per call');
  });

  it('truncates an enormous turn body rather than dropping it', async () => {
    const result = await run(createReadThreadTurnsTool(context()), {
      thread_id: 'thread-1',
      start: 3,
      end: 4,
    });
    expect(result).toContain('[turn truncated: 3,000 chars total');
  });

  it('points an unknown thread id back at list_threads', async () => {
    const result = await run(createReadThreadTurnsTool(context()), { thread_id: 'thread-404' });
    expect(result).toContain('Call list_threads');
  });
});

describe('submit_score', () => {
  function score(overrides: Partial<ScorerConfig> = {}): { tool: ScorerTool; state: ScorerState } {
    const state = createScorerState();
    return { tool: createSubmitScoreTool(config(overrides), state), state };
  }

  it('records a valid verdict', async () => {
    const { tool, state } = score({ scores: [0, 1] });
    expect(await run(tool, { summary: 'All 42 tests pass.', score: 1 })).toBe('Verdict recorded.');
    expect(state.verdict).toEqual({ score: 1, summary: 'All 42 tests pass.' });
  });

  it('rejects an off-scale discrete score with a repair message and records nothing', async () => {
    const { tool, state } = score({ scores: [0, 1] });
    const result = await run(tool, { summary: 'Partly there.', score: 0.5 });

    expect(result).toBe('0.5 is not an allowed score for this criterion; choose one of 0, 1');
    expect(state.verdict).toBeNull();
  });

  it('names the labels a labeled criterion allows', async () => {
    const { tool } = score({ scores: { 0: 'fail', 1: 'pass' } });
    expect(tool.description).toContain('Write the summary first');
    const schema = asSchema(tool.inputSchema).jsonSchema as {
      properties: { score: { description: string } };
    };
    expect(schema.properties.score.description).toContain('0 (fail) or 1 (pass)');
  });

  it('bounds a continuous criterion to 0..1 in execute (Google drops minimum/maximum)', async () => {
    const { tool, state } = score();
    expect(await run(tool, { summary: 'Great.', score: 1.5 })).toContain(
      'is not an allowed score for this criterion',
    );
    expect(state.verdict).toBeNull();

    expect(await run(tool, { summary: 'Mostly there.', score: 0.75 })).toBe('Verdict recorded.');
    expect(state.verdict).toEqual({ score: 0.75, summary: 'Mostly there.' });
  });

  it('asks again for an empty summary', async () => {
    const { tool, state } = score({ scores: [0, 1] });
    expect(await run(tool, { summary: '  ', score: 1 })).toContain('The summary is empty');
    expect(state.verdict).toBeNull();
  });
});

describe('submit_report', () => {
  it('records the report', async () => {
    const state = createScorerState();
    const tool = createSubmitReportTool(state);

    expect(await run(tool, { report: '# Report\n\nIt went well.' })).toBe('Report recorded.');
    expect(state.verdict).toEqual({ report: '# Report\n\nIt went well.' });
  });

  it('asks again for an empty report', async () => {
    const state = createScorerState();
    expect(await run(createSubmitReportTool(state), { report: '' })).toContain('The report is empty');
    expect(state.verdict).toBeNull();
  });
});

describe('buildTools', () => {
  const state = () => createScorerState();

  it('gives the judge only its verdict tool', () => {
    const tools = buildTools(config({ type: 'judge' }), state(), context({ type: 'judge' }));
    expect(Object.keys(tools)).toEqual(['submit_score']);
  });

  it('gives an agent the four exploration tools', () => {
    const tools = buildTools(config(), state(), context());
    expect(Object.keys(tools).sort()).toEqual([
      'list_threads',
      'read_file',
      'read_thread_turns',
      'run_command',
      'submit_score',
    ]);
  });

  it('adds the browser tools for a browser-agent', () => {
    const tools = buildTools(
      config({ type: 'browser-agent' }),
      state(),
      context({ type: 'browser-agent' }),
    );
    expect(Object.keys(tools)).toContain('screenshot');
    expect(Object.keys(tools)).toContain('run_playwright_script');
  });

  it('gives the report step the agent tools and submit_report', () => {
    const tools = buildTools(config({ type: 'report' }), state(), context({ type: 'report' }));
    expect(Object.keys(tools)).toContain('run_command');
    expect(Object.keys(tools)).toContain('submit_report');
    expect(Object.keys(tools)).not.toContain('submit_score');
  });

  it('narrows the exploration tools to the allowlist but keeps the verdict tool', () => {
    const narrowed = config({ tools: ['read_file'] });
    const tools = buildTools(narrowed, state(), context({ tools: ['read_file'] }));

    expect(Object.keys(tools).sort()).toEqual(['read_file', 'submit_score']);
    expect(explorationToolNames(tools)).toEqual(['read_file']);
  });

  it('names the verdict tool per type', () => {
    expect(verdictToolName('judge')).toBe('submit_score');
    expect(verdictToolName('browser-agent')).toBe('submit_score');
    expect(verdictToolName('report')).toBe('submit_report');
  });
});

describe('tool schemas', () => {
  it('never put a default on the wire (Google drops it)', () => {
    const tools = buildTools(
      config({ type: 'browser-agent' }),
      createScorerState(),
      context({ type: 'browser-agent' }),
    );

    for (const [name, tool] of Object.entries(tools)) {
      const json = JSON.stringify(asSchema(tool.inputSchema).jsonSchema);
      expect(json, `${name} must not declare a default`).not.toContain('"default"');
      expect(json, `${name} must not use $ref`).not.toContain('$ref');
    }
  });

  it('states each default in the description instead', () => {
    const schema = asSchema(createRunCommandTool(context()).inputSchema).jsonSchema as {
      properties: Record<string, { description: string }>;
    };
    expect(schema.properties.timeout_ms.description).toContain(String(DEFAULT_COMMAND_TIMEOUT_MS));
    expect(schema.properties.background.description).toContain('Defaults to false');
  });
});
