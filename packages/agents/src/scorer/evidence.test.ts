import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDiff, loadLogs, loadTaskPrompt, truncateHeadTail } from './evidence.js';
import { MAX_TASK_PROMPT_CHARS } from './config.js';

let contextDir: string;

beforeEach(() => {
  contextDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorer-evidence-'));
});

afterEach(() => {
  fs.rmSync(contextDir, { recursive: true, force: true });
});

function write(relative: string, content: string): void {
  const target = path.join(contextDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

describe('truncateHeadTail', () => {
  it('leaves text under the cap alone', () => {
    expect(truncateHeadTail('short', 100, 'thing')).toBe('short');
  });

  it('keeps the head and the tail and says what it dropped', () => {
    const text = `${'a'.repeat(500)}${'b'.repeat(500)}`;
    const result = truncateHeadTail(text, 100, 'logs');

    expect(result.startsWith('a'.repeat(50))).toBe(true);
    expect(result.endsWith('b'.repeat(50))).toBe(true);
    expect(result).toContain('[logs truncated: 1,000 chars total; showing the first 50 and the last 50]');
    // Only the notice is added on top of the budget.
    expect(result.length).toBeLessThan(100 + 200);
  });
});

describe('loadTaskPrompt', () => {
  it('returns null when the run captured no task prompt', () => {
    expect(loadTaskPrompt(contextDir)).toBeNull();
  });

  it('returns null for an empty prompt file', () => {
    write('task/prompt.md', '   \n');
    expect(loadTaskPrompt(contextDir)).toBeNull();
  });

  it('reads the prompt and truncates a pathological one', () => {
    write('task/prompt.md', 'Fix the failing test.');
    expect(loadTaskPrompt(contextDir)).toBe('Fix the failing test.');

    write('task/prompt.md', 'z'.repeat(MAX_TASK_PROMPT_CHARS + 10));
    const truncated = loadTaskPrompt(contextDir);
    expect(truncated).toContain('[task prompt truncated');
  });
});

describe('loadDiff', () => {
  it('returns null when no diff was captured', () => {
    expect(loadDiff(contextDir)).toBeNull();
  });

  it('distinguishes "no diff" from "the agent changed nothing"', () => {
    write('workspace/diff.patch', '');
    expect(loadDiff(contextDir)).toBe('');
  });

  it('filters lockfile sections before truncating', () => {
    write(
      'workspace/diff.patch',
      [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '+const answer = 42;',
        'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
        '--- a/pnpm-lock.yaml',
        '+++ b/pnpm-lock.yaml',
        '+lockfileVersion: 9.0',
      ].join('\n'),
    );

    const diff = loadDiff(contextDir);
    expect(diff).toContain('src/app.ts');
    expect(diff).not.toContain('pnpm-lock.yaml');
  });

  it('reports a lockfile-only diff as empty rather than as noise', () => {
    write(
      'workspace/diff.patch',
      ['diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml', '+lockfileVersion: 9.0'].join('\n'),
    );
    expect(loadDiff(contextDir)).toBe('');
  });
});

describe('loadLogs', () => {
  it('returns null when absent or empty', () => {
    expect(loadLogs(contextDir)).toBeNull();
    write('logs.txt', '');
    expect(loadLogs(contextDir)).toBeNull();
  });

  it('reads the logs', () => {
    write('logs.txt', 'running tests\n3 passed\n');
    expect(loadLogs(contextDir)).toBe('running tests\n3 passed\n');
  });
});
