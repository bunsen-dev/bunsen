// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect } from 'bun:test';
import { buildAgentModels, type AgentModelTally } from './agent-model.js';

function tallies(entries: Record<string, AgentModelTally>): Map<string, AgentModelTally> {
  return new Map(Object.entries(entries));
}

const t = (
  calls: number,
  input_tokens = 0,
  output_tokens = 0,
  cost_usd = 0,
): AgentModelTally => ({ calls, input_tokens, output_tokens, cost_usd });

describe('buildAgentModels', () => {
  it('returns an empty array for an empty map', () => {
    expect(buildAgentModels(new Map())).toEqual([]);
  });

  it('carries through per-model counts and cost', () => {
    const [only] = buildAgentModels(tallies({ 'claude-opus-4-7': t(3, 900, 90, 7.21) }));
    expect(only).toEqual({
      model: 'claude-opus-4-7',
      calls: 3,
      input_tokens: 900,
      output_tokens: 90,
      cost_usd: 7.21,
    });
  });

  it('sorts highest-cost first, even when a cheaper model out-calls it', () => {
    // The Claude Code shape: a cheap background model fires many calls while a
    // pricier reasoning model fires fewer but carries the run's cost. Cost wins.
    const result = buildAgentModels(
      tallies({
        'claude-haiku-4-5': t(15, 5000, 2000, 0.021),
        'claude-opus-4-8': t(7, 3000, 1500, 0.263),
      }),
    );
    expect(result.map((m) => m.model)).toEqual(['claude-opus-4-8', 'claude-haiku-4-5']);
  });

  it('breaks cost ties by output tokens', () => {
    const result = buildAgentModels(
      tallies({
        'gpt-5.4-mini': t(3, 900, 100, 0.5),
        'gpt-5.5': t(3, 100, 900, 0.5),
      }),
    );
    expect(result.map((m) => m.model)).toEqual(['gpt-5.5', 'gpt-5.4-mini']);
  });

  it('breaks cost + output-token ties by call count', () => {
    const result = buildAgentModels(
      tallies({
        'model-few': t(2, 0, 50, 0.1),
        'model-many': t(9, 0, 50, 0.1),
      }),
    );
    expect(result.map((m) => m.model)).toEqual(['model-many', 'model-few']);
  });

  it('breaks full ties lexically, independent of insertion order', () => {
    const a = buildAgentModels(
      new Map([
        ['zzz-model', t(1, 10, 5, 0.1)],
        ['aaa-model', t(1, 10, 5, 0.1)],
      ]),
    );
    const b = buildAgentModels(
      new Map([
        ['aaa-model', t(1, 10, 5, 0.1)],
        ['zzz-model', t(1, 10, 5, 0.1)],
      ]),
    );
    expect(a.map((m) => m.model)).toEqual(['aaa-model', 'zzz-model']);
    expect(b.map((m) => m.model)).toEqual(['aaa-model', 'zzz-model']);
  });
});
