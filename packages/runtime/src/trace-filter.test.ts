// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for the in-memory thread detector + markdown formatter. The streaming
 * pipeline is exercised separately in `trace-stream.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import type { AITrace } from '@bunsen-dev/types';
import {
  filterTracesInMemory,
  formatThreadsForAgent,
} from './trace-filter.js';

function createTrace(
  overrides: Partial<AITrace> & { messages?: unknown[]; responseContent?: unknown }
): AITrace {
  const { messages, responseContent, ...rest } = overrides;
  return {
    provider: 'anthropic',
    model: 'claude-3-sonnet',
    endpoint: '/v1/messages',
    timestamp: new Date().toISOString(),
    latencyMs: 1000,
    request: {
      messages: messages || [{ role: 'user', content: 'Hello' }],
      system: 'You are helpful',
    },
    response: {
      content: (responseContent ?? 'Hello! How can I help?') as string,
      usage: { inputTokens: 100, outputTokens: 50 },
    },
    estimatedCostUsd: 0.001,
    ...rest,
  };
}

describe('filterTracesInMemory', () => {
  it('handles empty traces', () => {
    const { index, turnsByThread } = filterTracesInMemory([]);
    expect(index.summary.totalCalls).toBe(0);
    expect(index.summary.threadCount).toBe(0);
    expect(index.threads).toHaveLength(0);
    expect(index.timeline).toHaveLength(0);
    expect(turnsByThread.size).toBe(0);
  });

  it('creates a single thread for a single trace', () => {
    const traces = [
      createTrace({
        timestamp: '2024-01-15T12:00:00Z',
        messages: [{ role: 'user', content: 'Hello' }],
        responseContent: 'Hi there!',
      }),
    ];

    const { index, turnsByThread } = filterTracesInMemory(traces);

    expect(index.summary.totalCalls).toBe(1);
    expect(index.summary.threadCount).toBe(1);
    expect(index.threads).toHaveLength(1);
    expect(index.threads[0].threadId).toBe('thread-1');
    expect(index.threads[0].turnCount).toBe(1);
    expect(index.threads[0].context.model).toBe('claude-3-sonnet');
    expect(index.threads[0].context.provider).toBe('anthropic');
    expect(turnsByThread.get('thread-1')).toHaveLength(1);
  });

  it('processes multi-turn traces', () => {
    const traces = [
      createTrace({
        timestamp: '2024-01-15T12:00:00Z',
        messages: [{ role: 'user', content: 'Hello' }],
        responseContent: 'Hi there!',
      }),
      createTrace({
        timestamp: '2024-01-15T12:00:05Z',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
          { role: 'user', content: 'How are you?' },
        ],
        responseContent: 'I am doing well!',
      }),
    ];

    const { index, turnsByThread } = filterTracesInMemory(traces);

    expect(index.summary.totalCalls).toBe(2);
    expect(index.summary.threadCount).toBeGreaterThanOrEqual(1);
    let totalTurns = 0;
    for (const turns of turnsByThread.values()) totalTurns += turns.length;
    expect(totalTurns).toBe(2);
  });

  it('detects separate threads for unrelated conversations', () => {
    const traces = [
      createTrace({
        timestamp: '2024-01-15T12:00:00Z',
        messages: [{ role: 'user', content: 'Hello' }],
        responseContent: 'Hi there!',
      }),
      createTrace({
        timestamp: '2024-01-15T12:00:05Z',
        messages: [{ role: 'user', content: 'Different conversation' }],
        responseContent: 'Sure, how can I help?',
      }),
    ];

    const { index, turnsByThread } = filterTracesInMemory(traces);

    expect(index.summary.totalCalls).toBe(2);
    expect(index.summary.threadCount).toBe(2);
    expect(index.threads).toHaveLength(2);
    expect(turnsByThread.get('thread-1')).toHaveLength(1);
    expect(turnsByThread.get('thread-2')).toHaveLength(1);
  });

  it('builds timeline with correct ordering', () => {
    const traces = [
      createTrace({
        timestamp: '2024-01-15T12:00:00Z',
        messages: [{ role: 'user', content: 'Thread A start' }],
      }),
      createTrace({
        timestamp: '2024-01-15T12:00:01Z',
        messages: [{ role: 'user', content: 'Thread B start' }],
      }),
      createTrace({
        timestamp: '2024-01-15T12:00:02Z',
        messages: [{ role: 'user', content: 'Thread C start' }],
      }),
    ];

    const { index } = filterTracesInMemory(traces);

    expect(index.timeline).toHaveLength(3);
    const timestamps = index.timeline.map((e) => new Date(e.timestamp).getTime());
    expect(timestamps[0]).toBeLessThan(timestamps[1]);
    expect(timestamps[1]).toBeLessThan(timestamps[2]);
  });

  it('extracts thread context correctly', () => {
    const traces = [
      createTrace({
        timestamp: '2024-01-15T12:00:00Z',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    ];
    traces[0].request.system = 'You are a helpful assistant';
    traces[0].request.tools = [
      { name: 'search', description: 'Search the web' },
      { name: 'calculate', description: 'Do math' },
    ];

    const { index } = filterTracesInMemory(traces);

    expect(index.threads[0].context.systemPrompt).toBe('You are a helpful assistant');
    expect(index.threads[0].context.toolNames).toEqual(['search', 'calculate']);
  });

  it('flattens an array-form system prompt (Anthropic content blocks)', () => {
    const traces = [
      createTrace({
        timestamp: '2024-01-15T12:00:00Z',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    ];
    // Anthropic / Claude Code send `system` as an array of text content blocks.
    traces[0].request.system = [
      { type: 'text', text: 'You are a careful assistant.' },
      { type: 'text', text: 'Follow the rules.' },
    ] as unknown as string;

    const { index } = filterTracesInMemory(traces);

    expect(index.threads[0].context.systemPrompt).toBe(
      'You are a careful assistant.\nFollow the rules.'
    );
  });

  it('calculates summary statistics correctly', () => {
    const traces = [
      createTrace({ timestamp: '2024-01-15T12:00:00Z', latencyMs: 500 }),
      createTrace({ timestamp: '2024-01-15T12:00:01Z', latencyMs: 700 }),
    ];
    traces[0].response.usage = { inputTokens: 100, outputTokens: 50 };
    traces[0].estimatedCostUsd = 0.001;
    traces[1].response.usage = { inputTokens: 200, outputTokens: 100 };
    traces[1].estimatedCostUsd = 0.002;

    const { index } = filterTracesInMemory(traces);

    expect(index.summary.totalCalls).toBe(2);
    expect(index.summary.totalInputTokens).toBe(300);
    expect(index.summary.totalOutputTokens).toBe(150);
    expect(index.summary.estimatedCostUsd).toBeCloseTo(0.003, 5);
  });

  it('handles OpenAI provider traces', () => {
    const traces = [
      createTrace({
        provider: 'openai',
        model: 'gpt-4',
        timestamp: '2024-01-15T12:00:00Z',
        messages: [{ role: 'user', content: 'Hello' }],
        responseContent: 'Hi!',
      }),
    ];

    const { index } = filterTracesInMemory(traces);

    expect(index.threads[0].context.provider).toBe('openai');
    expect(index.threads[0].context.model).toBe('gpt-4');
  });
});

describe('formatThreadsForAgent', () => {
  it('formats single thread correctly', () => {
    const { index, turnsByThread } = filterTracesInMemory([
      createTrace({
        timestamp: '2024-01-15T12:00:00Z',
        messages: [{ role: 'user', content: 'Hello' }],
        responseContent: 'Hi there!',
      }),
    ]);

    const output = formatThreadsForAgent(index, turnsByThread);

    expect(output).toContain('# AI Trace Summary');
    expect(output).toContain('Total API calls: 1');
    expect(output).toContain('Conversation threads: 1');
    expect(output).toContain('## thread-1');
    expect(output).toContain('claude-3-sonnet');
  });

  it('includes timeline for multiple threads', () => {
    const { index, turnsByThread } = filterTracesInMemory([
      createTrace({
        timestamp: '2024-01-15T12:00:00Z',
        messages: [{ role: 'user', content: 'Thread A' }],
      }),
      createTrace({
        timestamp: '2024-01-15T12:00:01Z',
        messages: [{ role: 'user', content: 'Thread B' }],
      }),
    ]);

    const output = formatThreadsForAgent(index, turnsByThread);

    expect(output).toContain('## Execution Timeline');
    expect(output).toContain('thread-1');
    expect(output).toContain('thread-2');
  });

  it('handles empty traces', () => {
    const { index, turnsByThread } = filterTracesInMemory([]);
    const output = formatThreadsForAgent(index, turnsByThread);

    expect(output).toContain('Total API calls: 0');
    expect(output).toContain('Conversation threads: 0');
  });
});

describe('malformed request message handling', () => {
  // The generic/google extractors are the fallback when a request body is not
  // well-formed (e.g. a provider conversion throws, or an unknown provider).
  // They must not crash trace processing on null elements or missing content.

  it('skips null elements in a generic-provider message array', () => {
    const traces = [
      createTrace({
        provider: 'other', // routes to extractGenericMessages
        messages: [{ role: 'user', content: 'hello' }, null, { role: 'assistant', content: 'hi' }],
        responseContent: 'ok',
      }),
    ];

    expect(() => filterTracesInMemory(traces)).not.toThrow();
    const { index } = filterTracesInMemory(traces);
    expect(index.summary.totalCalls).toBe(1);
  });

  it('coerces missing/object content to a string (no fingerprint crash)', () => {
    const traces = [
      createTrace({
        provider: 'other',
        // first message has no `content` field; second has object content
        messages: [{ role: 'user' }, { role: 'assistant', content: { parts: ['x'] } }],
        responseContent: 'ok',
      }),
    ];

    expect(() => filterTracesInMemory(traces)).not.toThrow();
    const { turnsByThread } = filterTracesInMemory(traces);
    const turns = turnsByThread.get('thread-1') ?? [];
    for (const turn of turns) {
      for (const msg of turn.messages) {
        // content is always present; never the literal `undefined` value
        expect(msg.content).toBeDefined();
      }
    }
  });

  it('skips null elements in a google message array', () => {
    const traces = [
      createTrace({
        provider: 'google',
        messages: [{ role: 'user', parts: [{ text: 'hello' }] }, null],
        responseContent: { parts: [{ text: 'hi' }] },
      }),
    ];

    expect(() => filterTracesInMemory(traces)).not.toThrow();
    const { index } = filterTracesInMemory(traces);
    expect(index.summary.totalCalls).toBe(1);
  });
});
