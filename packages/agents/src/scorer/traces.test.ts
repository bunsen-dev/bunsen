import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  formatThreadsForPrompt,
  loadThreadHeadTail,
  loadThreadTurns,
  loadThreadsIndex,
  renderThreadTurns,
} from './traces.js';
import { PROMPT_THREAD_HEAD_TURNS, PROMPT_THREAD_TAIL_TURNS } from './config.js';

/** The fixture mirrors the on-disk layout `streamProcessTraces` writes. */
const CONTEXT_DIR = fileURLToPath(new URL('./__fixtures__', import.meta.url));

describe('loadThreadsIndex', () => {
  it('reads the index', () => {
    const index = loadThreadsIndex(CONTEXT_DIR);
    expect(index?.summary.threadCount).toBe(2);
    expect(index?.threads.map((thread) => thread.threadId)).toEqual(['thread-1', 'thread-2']);
  });

  it('returns null when a run captured nothing', () => {
    expect(loadThreadsIndex('/nonexistent/run')).toBeNull();
  });
});

describe('loadThreadTurns', () => {
  it('reads every turn by default', () => {
    expect(loadThreadTurns(CONTEXT_DIR, 'thread-1')).toHaveLength(40);
  });

  it('slices [start, end) with an exclusive end', () => {
    const turns = loadThreadTurns(CONTEXT_DIR, 'thread-1', 2, 5);
    expect(turns.map((turn) => turn.turnIndex)).toEqual([2, 3, 4]);
  });

  it('skips malformed lines instead of failing the read', () => {
    expect(loadThreadTurns(CONTEXT_DIR, 'thread-2')).toHaveLength(2);
  });

  it('returns nothing for an unknown thread', () => {
    expect(loadThreadTurns(CONTEXT_DIR, 'thread-404')).toEqual([]);
  });
});

describe('loadThreadHeadTail', () => {
  it('samples head and tail on a long thread', () => {
    const turns = loadThreadHeadTail(CONTEXT_DIR, 'thread-1', 40, 2, 3);
    expect(turns.map((turn) => turn.turnIndex)).toEqual([0, 1, 37, 38, 39]);
  });

  it('returns the whole thread when it already fits', () => {
    const turns = loadThreadHeadTail(CONTEXT_DIR, 'thread-2', 2, 5, 10);
    expect(turns.map((turn) => turn.turnIndex)).toEqual([0, 1]);
  });
});

describe('renderThreadTurns', () => {
  it('caps each turn body head+tail', () => {
    const [longTurn] = loadThreadTurns(CONTEXT_DIR, 'thread-1', 3, 4);
    const rendered = renderThreadTurns([longTurn], 100);

    expect(rendered).toContain('#### Turn 3');
    expect(rendered).toContain('[turn truncated: 3,000 chars total');
    expect(rendered.length).toBeLessThan(1000);
  });
});

describe('formatThreadsForPrompt', () => {
  it('summarizes every thread with a head/tail sample', () => {
    const formatted = formatThreadsForPrompt(CONTEXT_DIR) ?? '';

    expect(formatted).toContain('42 model calls across 2 thread(s)');
    expect(formatted).toContain('### Thread thread-1 — anthropic/claude-sonnet-4-6');
    expect(formatted).toContain(
      `40 turns; showing ${PROMPT_THREAD_HEAD_TURNS + PROMPT_THREAD_TAIL_TURNS} (head and tail).`,
    );
    expect(formatted).toContain('### Thread thread-2 — openai/gpt-5.5');
    expect(formatted).toContain('2 turns.');
    // The sampled window skips the middle of the long thread.
    expect(formatted).not.toContain('#### Turn 8');
  });

  it('returns null when nothing was captured', () => {
    expect(formatThreadsForPrompt('/nonexistent/run')).toBeNull();
  });
});
