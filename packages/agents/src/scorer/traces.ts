/**
 * Readers for the agent-under-test's captured model conversations.
 *
 * The on-disk layout is the one `streamProcessTraces` in `@bunsen-dev/runtime`
 * writes: `<contextDir>/traces/threads/index.json` plus one
 * `<threadId>.jsonl` per thread, one turn per line. Inlined here (rather than
 * imported) because the bundle cannot depend on `@bunsen-dev/runtime`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { truncateHeadTail } from './evidence.js';
import {
  MAX_THREAD_TURN_CHARS,
  PROMPT_THREAD_HEAD_TURNS,
  PROMPT_THREAD_TAIL_TURNS,
  MAX_EVIDENCE_CHARS,
} from './config.js';

export interface ThreadTurn {
  turnIndex: number;
  timestamp: string;
  latencyMs: number;
  messages: Array<{ role: string; content: string | unknown[] }>;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  stopReason: string;
}

export interface ThreadIndexEntry {
  threadId: string;
  context: { systemPrompt: string; toolNames: string[]; model: string; provider: string };
  timeRange: { start: string; end: string };
  turnCount: number;
  stats: {
    totalInputTokens: number;
    totalOutputTokens: number;
    estimatedCostUsd: number;
    durationMs: number;
  };
}

export interface ThreadsIndex {
  summary: {
    totalCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    estimatedCostUsd: number;
    durationMs: number;
    threadCount: number;
  };
  threads: ThreadIndexEntry[];
  timeline: Array<{ threadId: string; turnIndex: number; timestamp: string; latencyMs: number }>;
}

const THREADS_DIRNAME = path.join('traces', 'threads');

/** The per-run thread index, or `null` when no conversations were captured. */
export function loadThreadsIndex(contextDir: string): ThreadsIndex | null {
  const indexPath = path.join(contextDir, THREADS_DIRNAME, 'index.json');
  if (!fs.existsSync(indexPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as ThreadsIndex;
  } catch {
    return null;
  }
}

/**
 * Turns `[start, end)` of one thread (0-indexed, `end` exclusive). Malformed
 * lines are skipped rather than failing the read.
 */
export function loadThreadTurns(
  contextDir: string,
  threadId: string,
  start?: number,
  end?: number,
): ThreadTurn[] {
  const filePath = path.join(contextDir, THREADS_DIRNAME, `${threadId}.jsonl`);
  if (!fs.existsSync(filePath)) return [];
  const startIdx = start ?? 0;
  const turns: ThreadTurn[] = [];
  let i = 0;
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    if (i < startIdx) {
      i++;
      continue;
    }
    if (end !== undefined && i >= end) break;
    try {
      turns.push(JSON.parse(line) as ThreadTurn);
    } catch {
      // skip malformed
    }
    i++;
  }
  return turns;
}

/**
 * A bounded head + tail of a thread, for inlining into a prompt. A scorer that
 * cannot call tools can't usefully read a 400-turn thread, so the sample is
 * capped regardless of how long the run was.
 */
export function loadThreadHeadTail(
  contextDir: string,
  threadId: string,
  turnCount: number,
  headCount: number,
  tailCount: number,
): ThreadTurn[] {
  if (turnCount <= headCount + tailCount) {
    return loadThreadTurns(contextDir, threadId);
  }
  return [
    ...loadThreadTurns(contextDir, threadId, 0, headCount),
    ...loadThreadTurns(contextDir, threadId, turnCount - tailCount, turnCount),
  ];
}

/**
 * Render turns as markdown, capping each message body. Shared by the inlined
 * evidence block and the `read_thread_turns` tool so both read the same way.
 */
export function renderThreadTurns(turns: ThreadTurn[], perTurnChars = MAX_THREAD_TURN_CHARS): string {
  const lines: string[] = [];
  for (const turn of turns) {
    lines.push(`#### Turn ${turn.turnIndex}`);
    for (const message of turn.messages) {
      const content =
        typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content, null, 2);
      lines.push(`**${message.role}**: ${truncateHeadTail(content, perTurnChars, 'turn')}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Markdown summary of every captured thread for inlining as evidence
 * (`evidence: [traces]`). `null` when nothing was captured.
 */
export function formatThreadsForPrompt(contextDir: string): string | null {
  const index = loadThreadsIndex(contextDir);
  if (!index || index.threads.length === 0) return null;

  const parts: string[] = [
    `${index.summary.totalCalls} model calls across ${index.summary.threadCount} thread(s); ` +
      `${index.summary.totalInputTokens} input / ${index.summary.totalOutputTokens} output tokens.`,
    '',
  ];

  for (const thread of index.threads) {
    const turns = loadThreadHeadTail(
      contextDir,
      thread.threadId,
      thread.turnCount,
      PROMPT_THREAD_HEAD_TURNS,
      PROMPT_THREAD_TAIL_TURNS,
    );
    parts.push(`### Thread ${thread.threadId} — ${thread.context.provider}/${thread.context.model}`);
    parts.push(
      turns.length < thread.turnCount
        ? `${thread.turnCount} turns; showing ${turns.length} (head and tail).`
        : `${thread.turnCount} turns.`,
    );
    parts.push('');
    parts.push(renderThreadTurns(turns, MAX_THREAD_TURN_CHARS));
    parts.push('');
  }

  // The same per-block cap as the diff and logs: thread count is unbounded.
  return truncateHeadTail(parts.join('\n').trimEnd(), MAX_EVIDENCE_CHARS, 'conversations');
}
