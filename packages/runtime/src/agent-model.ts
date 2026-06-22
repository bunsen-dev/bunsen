// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Building a run's per-model usage breakdown — the `agent.models` list that
 * lands on the manifest and is projected into the run index's
 * `run_agent_models` child table.
 *
 * The breakdown is observed-only: it is computed from the agent-under-test's
 * captured traces, never from declared config. A run that captured no agent
 * calls simply has no breakdown — that is the honest answer, not a guess from
 * the configured `*_MODEL` env var. Two classes of trace are filtered upstream
 * (in `tallyAgentModel`) before they reach here: platform calls (orchestrator,
 * supervisor, scorer), and errored (non-2xx) calls — a model that only ever
 * returned errors ran no inference and must not headline the run.
 *
 * `models[0]` (after sorting) is the run's headline/primary model — the
 * highest-cost model, i.e. the one that carried the run's compute.
 */

import type { AgentModelUsage } from '@bunsen-dev/types';

/**
 * Mutable per-model accumulator. Folded over a run's agent traces, then
 * frozen into the sorted `AgentModelUsage[]` by {@link buildAgentModels}.
 */
export interface AgentModelTally {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

/**
 * Freeze per-model tallies into the sorted breakdown stored on the manifest.
 *
 * Order is highest-cost first: by `cost_usd` descending. Total cost is the best
 * single proxy for "which model carried the run's compute" — it already folds
 * in tokens × per-model rate, so a cheap background model that fires many calls
 * (titles, summaries, classifications) still ranks below the pricier reasoning
 * model that did the actual work. Ties broken by output tokens descending, then
 * call count descending, then lexically by model id — deterministic regardless
 * of the order models first appeared in the trace stream. `result[0]` is the
 * run's primary model.
 */
export function buildAgentModels(tallies: Map<string, AgentModelTally>): AgentModelUsage[] {
  const entries: AgentModelUsage[] = Array.from(tallies.entries()).map(([model, t]) => ({
    model,
    calls: t.calls,
    input_tokens: t.input_tokens,
    output_tokens: t.output_tokens,
    cost_usd: t.cost_usd,
  }));
  entries.sort((a, b) => {
    if (a.cost_usd !== b.cost_usd) return b.cost_usd - a.cost_usd;
    if (a.output_tokens !== b.output_tokens) return b.output_tokens - a.output_tokens;
    if (a.calls !== b.calls) return b.calls - a.calls;
    return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
  });
  return entries;
}
