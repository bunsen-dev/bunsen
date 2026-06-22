// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Thread detection + per-turn formatting for AI traces.
 *
 * The runtime captures AI API calls into a single JSONL stream
 * (`traces/agent.jsonl`). Stateful chat agents re-send the full conversation
 * history each turn, so the raw stream is dominated by redundant content. This
 * module groups the stream into conversation threads and stores only the
 * new-message *delta* per turn.
 *
 * Two entry points:
 *
 * - `ThreadDetector` — incremental, streaming-friendly. The streaming writer
 *   in `trace-stream.ts` feeds traces in one at a time and writes turn deltas
 *   to per-thread JSONL files as they arrive. Memory is bounded by concurrent
 *   thread count, not file size.
 * - `filterTracesInMemory` — pure in-memory wrapper around the same algorithm,
 *   used by unit tests and other small-input callers.
 *
 * Provider normalization goes through lingua so anthropic / openai / google
 * traces collapse into a single `Message` shape for matching and display.
 */

import { createHash } from 'node:crypto';
import type { AITrace } from '@bunsen-dev/types';
import {
  anthropicMessagesToLingua,
  chatCompletionsMessagesToLingua,
  type Message,
  type AssistantContentPart,
  type UserContentPart,
  type ToolContentPart,
} from '@braintrust/lingua';

/**
 * The union of all content-part shapes. `@braintrust/lingua@0.1.0` does not
 * export a `ContentPart` alias (only the per-role parts), so reconstruct it
 * locally. Used only by `truncateContent` below.
 */
type ContentPart = AssistantContentPart | UserContentPart | ToolContentPart;

// ============================================================================
// Types — on-disk index shape
// ============================================================================

/** A single turn within a conversation thread. Persisted as one JSONL line. */
export interface ThreadTurn {
  turnIndex: number;
  timestamp: string;
  latencyMs: number;
  /** Only the *new* messages relative to the previous turn in this thread. */
  messages: Message[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  stopReason: string;
}

/** System context captured from the first trace in a thread. */
export interface ThreadContext {
  systemPrompt: string;
  toolNames: string[];
  model: string;
  provider: string;
}

/** Per-thread aggregate stats. */
export interface ThreadStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
}

/** Index entry for a thread. Body lives in `threads/<threadId>.jsonl`. */
export interface ThreadIndexEntry {
  threadId: string;
  context: ThreadContext;
  timeRange: { start: string; end: string };
  turnCount: number;
  stats: ThreadStats;
}

/** Timeline entry showing when a turn happened across the run. */
export interface TimelineEntry {
  threadId: string;
  turnIndex: number;
  timestamp: string;
  latencyMs: number;
}

/** Run-wide summary statistics for agent traces. */
export interface FilteredTraceSummary {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
  threadCount: number;
}

/**
 * The complete `traces/threads/index.json` payload — small enough to fit in
 * memory and an LLM prompt regardless of run size.
 */
export interface ThreadsIndex {
  summary: FilteredTraceSummary;
  threads: ThreadIndexEntry[];
  timeline: TimelineEntry[];
}

// ============================================================================
// Constants
// ============================================================================

/** Maximum length for text content before truncation. */
const MAX_TEXT_LENGTH = 5000;

/** Maximum length for tool output before truncation. */
const MAX_TOOL_OUTPUT_LENGTH = 2000;

/**
 * Soft cap on concurrent active threads. Pathological agents that spawn
 * thousands of independent sub-conversations would otherwise grow thread
 * state unboundedly. The detector emits one warning when the cap is
 * exceeded; subsequent traces still process.
 */
const MAX_ACTIVE_THREADS = 1000;

// ============================================================================
// ThreadDetector — incremental, streaming-friendly
// ============================================================================

/**
 * Per-message fingerprint kept in memory while the detector runs. Replaces
 * holding the full normalized `Message` so per-thread state scales with
 * unique-message count, not message bytes.
 */
interface MessageFingerprint {
  role: string;
  hash: string;
}

interface ActiveThread {
  threadId: string;
  context: ThreadContext;
  /** Fingerprints of all request messages seen so far in this thread. */
  fingerprints: MessageFingerprint[];
  turnCount: number;
  startTime: string;
  endTime: string;
  stats: ThreadStats;
}

/**
 * Result of feeding one trace into `ThreadDetector.processTrace`. The
 * streaming writer uses this to append a turn line to the thread's `.jsonl`
 * and update per-thread index entries.
 */
export interface ProcessTraceResult {
  threadId: string;
  turn: ThreadTurn;
  isNewThread: boolean;
}

/**
 * Streaming-friendly thread detector. Feed traces in via `processTrace`
 * (idempotent: same input produces same threadId / turnIndex), then call
 * `finalize()` to get the index entries + timeline.
 *
 * Important: traces must be fed in timestamp order. The streaming writer in
 * `trace-stream.ts` reads `agent.jsonl` in file order, which the proxy writes
 * in completion-time order — close enough for thread continuity (consecutive
 * turns within a thread serialize naturally).
 */
export class ThreadDetector {
  private threads: ActiveThread[] = [];
  private timeline: TimelineEntry[] = [];
  private nextThreadId = 1;
  private warnedThreadCap = false;

  processTrace(trace: AITrace): ProcessTraceResult {
    const normalizedMessages = normalizeMessages(trace);
    const responseMessages = normalizeResponse(trace);
    const requestFingerprints = normalizedMessages.map(messageFingerprint);

    let matched: ActiveThread | null = null;
    let bestMatchLength = 0;
    for (const thread of this.threads) {
      const matchLength = fingerprintPrefixLength(thread.fingerprints, requestFingerprints);
      if (matchLength === thread.fingerprints.length && matchLength > 0 && matchLength > bestMatchLength) {
        bestMatchLength = matchLength;
        matched = thread;
      }
    }

    let isNewThread = false;
    if (!matched) {
      if (this.threads.length >= MAX_ACTIVE_THREADS && !this.warnedThreadCap) {
        console.warn(
          `[trace-filter] Active thread count reached ${MAX_ACTIVE_THREADS}. ` +
            `Continuing, but this may indicate an agent that spawns many independent sub-conversations.`,
        );
        this.warnedThreadCap = true;
      }
      matched = {
        threadId: `thread-${this.nextThreadId++}`,
        context: extractThreadContext(trace),
        fingerprints: [],
        turnCount: 0,
        startTime: trace.timestamp,
        endTime: trace.timestamp,
        stats: { totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUsd: 0, durationMs: 0 },
      };
      this.threads.push(matched);
      isNewThread = true;
    }

    const newRequestMessages = normalizedMessages.slice(matched.fingerprints.length);
    const turnMessages = [...newRequestMessages, ...responseMessages];

    const inputTokens = trace.response.usage?.inputTokens || 0;
    const outputTokens = trace.response.usage?.outputTokens || 0;
    const turn: ThreadTurn = {
      turnIndex: matched.turnCount,
      timestamp: trace.timestamp,
      latencyMs: trace.latencyMs,
      messages: truncateMessages(turnMessages),
      usage: {
        inputTokens,
        outputTokens,
        costUsd: trace.estimatedCostUsd,
      },
      stopReason: (trace.response.stop_reason as string) || 'unknown',
    };

    matched.fingerprints = requestFingerprints;
    matched.turnCount++;
    matched.endTime = trace.timestamp;
    matched.stats.totalInputTokens += inputTokens;
    matched.stats.totalOutputTokens += outputTokens;
    matched.stats.estimatedCostUsd += trace.estimatedCostUsd;

    this.timeline.push({
      threadId: matched.threadId,
      turnIndex: turn.turnIndex,
      timestamp: trace.timestamp,
      latencyMs: trace.latencyMs,
    });

    return { threadId: matched.threadId, turn, isNewThread };
  }

  /**
   * Finalize the index. Computes durationMs per thread now that endTime is
   * known. The summary's totals are computed from active-thread state, so the
   * caller does not need to track them separately.
   */
  finalize(): ThreadsIndex {
    const indexEntries: ThreadIndexEntry[] = this.threads.map((t) => {
      const startMs = new Date(t.startTime).getTime();
      const endMs = new Date(t.endTime).getTime();
      const lastLatency = this.lastLatencyForThread(t.threadId);
      return {
        threadId: t.threadId,
        context: t.context,
        timeRange: { start: t.startTime, end: t.endTime },
        turnCount: t.turnCount,
        stats: {
          ...t.stats,
          durationMs: endMs - startMs + lastLatency,
        },
      };
    });

    const totalCalls = this.timeline.length;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let estimatedCostUsd = 0;
    for (const t of this.threads) {
      totalInputTokens += t.stats.totalInputTokens;
      totalOutputTokens += t.stats.totalOutputTokens;
      estimatedCostUsd += t.stats.estimatedCostUsd;
    }
    const sortedTimeline = [...this.timeline].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    const durationMs = sortedTimeline.length > 0
      ? new Date(sortedTimeline[sortedTimeline.length - 1].timestamp).getTime() -
        new Date(sortedTimeline[0].timestamp).getTime() +
        sortedTimeline[sortedTimeline.length - 1].latencyMs
      : 0;

    return {
      summary: {
        totalCalls,
        totalInputTokens,
        totalOutputTokens,
        estimatedCostUsd,
        durationMs,
        threadCount: this.threads.length,
      },
      threads: indexEntries,
      timeline: sortedTimeline,
    };
  }

  private lastLatencyForThread(threadId: string): number {
    for (let i = this.timeline.length - 1; i >= 0; i--) {
      if (this.timeline[i].threadId === threadId) return this.timeline[i].latencyMs;
    }
    return 0;
  }
}

// ============================================================================
// In-memory entry point (tests and small inputs)
// ============================================================================

/** Result of running the detector over an in-memory trace array. */
export interface FilteredTracesInMemory {
  index: ThreadsIndex;
  turnsByThread: Map<string, ThreadTurn[]>;
}

/**
 * Pure in-memory wrapper. Sorts traces by timestamp, runs the detector, and
 * returns both the index and the per-thread turn arrays. Use for unit tests
 * and other small-input callers; production trace finalize uses the streaming
 * pipeline in `trace-stream.ts` which never holds the full file in memory.
 */
export function filterTracesInMemory(traces: AITrace[]): FilteredTracesInMemory {
  const sorted = [...traces].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  const detector = new ThreadDetector();
  const turnsByThread = new Map<string, ThreadTurn[]>();
  for (const trace of sorted) {
    const { threadId, turn } = detector.processTrace(trace);
    let turns = turnsByThread.get(threadId);
    if (!turns) {
      turns = [];
      turnsByThread.set(threadId, turns);
    }
    turns.push(turn);
  }
  return { index: detector.finalize(), turnsByThread };
}

// ============================================================================
// Fingerprinting and normalization
// ============================================================================

function messageFingerprint(msg: Message): MessageFingerprint {
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  return {
    role: msg.role,
    hash: createHash('sha256').update(content).digest('hex'),
  };
}

function fingerprintPrefixLength(prefix: MessageFingerprint[], messages: MessageFingerprint[]): number {
  let len = 0;
  const max = Math.min(prefix.length, messages.length);
  for (let i = 0; i < max; i++) {
    if (prefix[i].role === messages[i].role && prefix[i].hash === messages[i].hash) {
      len++;
    } else {
      break;
    }
  }
  return len;
}

function normalizeMessages(trace: AITrace): Message[] {
  const rawMessages = trace.request.messages as unknown[];
  if (!rawMessages || !Array.isArray(rawMessages)) {
    return [];
  }
  try {
    switch (trace.provider) {
      case 'anthropic':
        return anthropicMessagesToLingua(rawMessages);
      case 'openai':
        return chatCompletionsMessagesToLingua(rawMessages);
      case 'google':
        return extractGoogleMessages(rawMessages);
      default:
        return extractGenericMessages(rawMessages);
    }
  } catch {
    return extractGenericMessages(rawMessages);
  }
}

function normalizeResponse(trace: AITrace): Message[] {
  try {
    const rawContent = trace.response.content;

    if (Array.isArray(rawContent)) {
      return [{ role: 'assistant', content: normalizeAnthropicContent(rawContent) }];
    }

    if (rawContent && typeof rawContent === 'object' && 'role' in rawContent) {
      const msg = rawContent as {
        role?: string;
        content?: string | null;
        tool_calls?: Array<{
          id: string;
          type: string;
          function: { name: string; arguments: string };
        }>;
      };

      const linguaContent: AssistantContentPart[] = [];
      if (msg.content) {
        linguaContent.push({ type: 'text', text: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = JSON.parse(tc.function.arguments);
          } catch {
            parsedArgs = { _raw: tc.function.arguments };
          }
          linguaContent.push({
            type: 'tool_call',
            tool_call_id: tc.id,
            tool_name: tc.function.name,
            arguments: { type: 'valid', value: parsedArgs },
          });
        }
      }
      if (linguaContent.length > 0) {
        return [{ role: 'assistant', content: linguaContent }];
      }
    }

    if (rawContent && typeof rawContent === 'object' && 'parts' in rawContent) {
      const content = rawContent as { role?: string; parts?: Array<{ text?: string }> };
      const text = content.parts
        ?.filter((p) => p.text)
        .map((p) => p.text)
        .join('\n');
      if (text) {
        return [{ role: 'assistant', content: text }];
      }
    }

    return [];
  } catch {
    return [];
  }
}

function normalizeAnthropicContent(blocks: unknown[]): AssistantContentPart[] {
  const linguaContent: AssistantContentPart[] = [];
  for (const block of blocks) {
    const b = block as {
      type?: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    };
    if (b.type === 'text' && b.text) {
      linguaContent.push({ type: 'text', text: b.text });
    } else if (b.type === 'thinking' && b.thinking) {
      linguaContent.push({ type: 'reasoning', text: b.thinking });
    } else if (b.type === 'tool_use' && b.name && b.id) {
      linguaContent.push({
        type: 'tool_call',
        tool_call_id: b.id,
        tool_name: b.name,
        arguments: { type: 'valid', value: b.input || {} },
      });
    }
  }
  return linguaContent.length > 0 ? linguaContent : [{ type: 'text', text: '' }];
}

function extractGoogleMessages(rawMessages: unknown[]): Message[] {
  const messages: Message[] = [];
  for (const msg of rawMessages) {
    if (!msg || typeof msg !== 'object') continue;
    const m = msg as { role?: string; parts?: Array<{ text?: string }> };
    if (m.role && m.parts) {
      const text = m.parts.filter((p) => p.text).map((p) => p.text).join('\n');
      if (text) {
        // Google roles are user/model only (never the tool role, which would
        // require array content), so string content is always valid here.
        messages.push({
          role: m.role === 'model' ? 'assistant' : (m.role as Message['role']),
          content: text,
        } as Message);
      }
    }
  }
  return messages;
}

function extractGenericMessages(rawMessages: unknown[]): Message[] {
  const messages: Message[] = [];
  for (const msg of rawMessages) {
    if (!msg || typeof msg !== 'object') continue;
    const m = msg as { role?: string; content?: unknown };
    if (!m.role) continue;
    // Generic fallback (also the catch-all when provider conversion throws on
    // malformed input): stringify content and coerce to a string, since
    // JSON.stringify(undefined) is itself undefined and would later crash the
    // fingerprint hash. The role is treated as a non-tool message — these are
    // used only for thread fingerprinting and display, never re-sent to a provider.
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content) ?? '';
    messages.push({ role: m.role as Message['role'], content } as Message);
  }
  return messages;
}

function extractThreadContext(trace: AITrace): ThreadContext {
  const systemPrompt = normalizeSystemPrompt(trace.request.system);
  const tools = trace.request.tools as Array<{ name: string }> | undefined;
  const toolNames = tools?.map((t) => t.name) || [];
  return {
    systemPrompt,
    toolNames,
    model: trace.model,
    provider: trace.provider,
  };
}

/**
 * The system prompt can be a plain string or — as Anthropic's API and Claude
 * Code send it — an array of `{ type: 'text', text }` content blocks. Flatten
 * the array form to text so the scorer context shows the prompt, not
 * `[object Object]`.
 */
function normalizeSystemPrompt(system: unknown): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && 'text' in block) {
          return (block as { text?: string }).text ?? '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

// ============================================================================
// Truncation
// ============================================================================

function truncateMessages(messages: Message[]): Message[] {
  return messages.map((msg) => ({
    ...msg,
    content: truncateContent(msg.content),
  })) as Message[];
}

function truncateContent(content: string | ContentPart[]): string | ContentPart[] {
  if (typeof content === 'string') {
    return truncateText(content);
  }
  return content.map((part) => {
    if (part.type === 'text' && 'text' in part) {
      return { ...part, text: truncateText(part.text) };
    }
    if (part.type === 'tool_result' && 'output' in part && typeof part.output === 'string') {
      return { ...part, output: truncateToolOutput(part.output) };
    }
    return part;
  }) as ContentPart[];
}

function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_LENGTH) return text;
  return text.slice(0, MAX_TEXT_LENGTH) + `\n[truncated: ${text.length - MAX_TEXT_LENGTH} chars]`;
}

function truncateToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_LENGTH) return output;
  return (
    output.slice(0, MAX_TOOL_OUTPUT_LENGTH) +
    `\n[truncated: ${output.length - MAX_TOOL_OUTPUT_LENGTH} chars]`
  );
}

// ============================================================================
// Markdown formatting (for LLM-judge prompts and the in-memory format helper)
// ============================================================================

/**
 * Format the index plus per-thread turns as a markdown blob suitable for
 * inclusion in an LLM prompt. Used by the LLM-judge scorer after it loads a
 * bounded head/tail of each thread.
 */
export function formatThreadsForAgent(
  index: ThreadsIndex,
  turnsByThread: Map<string, ThreadTurn[]>,
): string {
  const lines: string[] = [];

  lines.push('# AI Trace Summary');
  lines.push('');
  lines.push(`- Total API calls: ${index.summary.totalCalls}`);
  lines.push(`- Conversation threads: ${index.summary.threadCount}`);
  lines.push(
    `- Tokens: ${index.summary.totalInputTokens.toLocaleString()} in / ${index.summary.totalOutputTokens.toLocaleString()} out`,
  );
  lines.push(`- Estimated cost: $${index.summary.estimatedCostUsd.toFixed(4)}`);
  lines.push(`- Total duration: ${(index.summary.durationMs / 1000).toFixed(1)}s`);
  lines.push('');

  if (index.threads.length > 1) {
    lines.push('## Execution Timeline');
    lines.push('');
    lines.push('```');
    for (const entry of index.timeline) {
      const thread = index.threads.find((t) => t.threadId === entry.threadId);
      const time = new Date(entry.timestamp).toISOString().slice(11, 23);
      lines.push(
        `[${time}] ${entry.threadId} turn ${entry.turnIndex} (${entry.latencyMs}ms) - ${thread?.context.model || 'unknown'}`,
      );
    }
    lines.push('```');
    lines.push('');
  }

  for (const thread of index.threads) {
    const turns = turnsByThread.get(thread.threadId) ?? [];
    lines.push(`## ${thread.threadId}`);
    lines.push('');
    lines.push(`**Model:** ${thread.context.model} (${thread.context.provider})`);
    lines.push(
      `**Stats:** ${thread.turnCount} turns, ${thread.stats.totalInputTokens + thread.stats.totalOutputTokens} tokens, $${thread.stats.estimatedCostUsd.toFixed(4)}`,
    );
    if (turns.length < thread.turnCount) {
      lines.push(`*Showing ${turns.length} of ${thread.turnCount} turns (head/tail sampled).*`);
    }
    if (thread.context.toolNames.length > 0) {
      lines.push(`**Tools:** ${thread.context.toolNames.join(', ')}`);
    }
    lines.push('');

    if (thread.context.systemPrompt) {
      lines.push('<details><summary>System prompt</summary>');
      lines.push('');
      lines.push('```');
      lines.push(truncateText(thread.context.systemPrompt));
      lines.push('```');
      lines.push('</details>');
      lines.push('');
    }

    lines.push('### Conversation');
    lines.push('');

    for (const turn of turns) {
      const time = new Date(turn.timestamp).toISOString().slice(11, 23);
      lines.push(
        `#### Turn ${turn.turnIndex} [${time}] (${turn.latencyMs}ms, $${turn.usage.costUsd.toFixed(4)})`,
      );
      lines.push('');

      for (const msg of turn.messages) {
        lines.push(`**${msg.role}:**`);
        lines.push('');
        if (typeof msg.content === 'string') {
          lines.push('```');
          lines.push(msg.content);
          lines.push('```');
        } else {
          for (const part of msg.content as AssistantContentPart[]) {
            if (part.type === 'text') {
              lines.push('```');
              lines.push(part.text);
              lines.push('```');
            } else if (part.type === 'reasoning') {
              lines.push('*Thinking:*');
              lines.push('```');
              lines.push(part.text);
              lines.push('```');
            } else if (part.type === 'tool_call') {
              lines.push(`*Tool call: \`${part.tool_name}\` (${part.tool_call_id})*`);
              lines.push('```json');
              const args = part.arguments.value;
              lines.push(JSON.stringify(args, null, 2));
              lines.push('```');
            } else if (part.type === 'tool_result') {
              lines.push(`*Tool result: \`${part.tool_name}\` (${part.tool_call_id})*`);
              lines.push('```');
              lines.push(String(part.output));
              lines.push('```');
            }
          }
        }
        lines.push('');
      }

      lines.push(`*Stop reason: ${turn.stopReason}*`);
      lines.push('');
    }
  }

  return lines.join('\n');
}
