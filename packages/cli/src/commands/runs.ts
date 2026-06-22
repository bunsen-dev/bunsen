// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `bn runs list` — list runs from the SQLite index.
 *
 * Reads the SQLite run index, which is rebuilt on every manifest write.
 * Run dirs without a manifest don't appear here (they shouldn't exist —
 * every run is born with one); a manifest-less run dir means a partially
 * deleted run, recoverable via `bn index rebuild`.
 */

import * as fs from 'node:fs';
import chalk from 'chalk';
import {
  getRunIndexPath,
  listRunSummaries,
  openRunIndex,
  type RunFilter,
  type RunSummary,
} from '@bunsen-dev/runtime';
import { resolveFormat, isMachineFormat, renderMachine } from '../format.js';
import { formatModelCell } from './helpers/format-model-cell.js';
import { statusColor } from './helpers/status-color.js';
import { truncate } from './helpers/truncate.js';

interface RunsOptions {
  experiment?: string;
  agent?: string;
  last?: string;
  format?: string;
  idsOnly?: boolean;
}

interface DisplayRun {
  id: string;
  experimentId: string;
  agentId: string;
  variant?: string;
  agentModel?: string;
  agentModelCount?: number;
  status: string;
  exitCode?: number;
  startedAt: string;
  completedAt?: string;
  durationMs: number;
  weightedScore: number | null;
  totalAiCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadInputTokens?: number;
  totalCacheCreationInputTokens?: number;
  estimatedCostUsd: number;
  agentCostUsd?: number;
  platformCostUsd?: number;
  /** Calls priced with a coarse default (model not in the price table); part of
   * estimatedCostUsd is then a rough estimate. Present only when > 0. */
  pricingFallbackCalls?: number;
}

export async function runsCommand(options: RunsOptions): Promise<void> {
  const format = resolveFormat(options);
  const limit = parseInt(options.last || '10', 10);
  const runs = listForDisplay({
    experimentId: options.experiment,
    agentId: options.agent,
    limit,
  });

  if (options.idsOnly) {
    if (runs.length > 0) console.log(runs.map((r) => r.id).join(' '));
    return;
  }

  if (isMachineFormat(format)) {
    process.stdout.write(renderMachine({ runs }, format));
    return;
  }

  if (runs.length === 0) {
    console.log(chalk.dim('No runs found'));
    return;
  }

  // ID column fits a 26-char ULID with breathing room.
  const idWidth = 28;
  console.log();
  const modelWidth = 20;
  console.log(
    chalk.bold(
      padEnd('ID', idWidth) +
      padEnd('Experiment', 20) +
      padEnd('Agent', 15) +
      padEnd('Model', modelWidth) +
      padEnd('Status', 12) +
      padEnd('Score', 8) +
      padEnd('Duration', 12) +
      'Started'
    )
  );
  console.log(chalk.dim('─'.repeat(100 + (idWidth - 10) + modelWidth)));

  for (const run of runs) {
    const scoreStr = run.weightedScore !== null ? `${run.weightedScore}/1` : '-';
    const durationStr = run.durationMs > 0 ? `${(run.durationMs / 1000).toFixed(1)}s` : '-';
    const startedAt = new Date(run.startedAt).toLocaleString();
    // Pad the plain string before coloring so ANSI codes don't throw the
    // column width off (mirrors the status column below). Multi-model runs
    // get a "+N" suffix flagging the secondary models hidden in this view.
    const modelCell = run.agentModel
      ? padEnd(truncate(formatModelCell(run.agentModel, run.agentModelCount), modelWidth - 1), modelWidth)
      : chalk.dim(padEnd('-', modelWidth));
    console.log(
      padEnd(run.id, idWidth) +
      padEnd(truncate(run.experimentId, 18), 20) +
      padEnd(truncate(run.agentId, 13), 15) +
      modelCell +
      statusColor(run.status)(padEnd(run.status, 12)) +
      padEnd(scoreStr, 8) +
      padEnd(durationStr, 12) +
      chalk.dim(startedAt)
    );
  }

  console.log();
}

interface ListOptions {
  experimentId?: string;
  agentId?: string;
  limit: number;
}

function listForDisplay(opts: ListOptions): DisplayRun[] {
  // No index file yet — fresh project before any run has completed.
  if (!fs.existsSync(getRunIndexPath())) return [];
  const db = openRunIndex(process.cwd(), { readonly: true });
  try {
    const filter: RunFilter = { limit: opts.limit };
    if (opts.experimentId) filter.experimentId = opts.experimentId;
    if (opts.agentId) filter.agentId = opts.agentId;
    return listRunSummaries(db, filter).map(summaryToDisplay);
  } finally {
    db.close();
  }
}

function summaryToDisplay(s: RunSummary): DisplayRun {
  const out: DisplayRun = {
    id: s.runId,
    experimentId: s.experimentId,
    agentId: s.agentId,
    status: s.status,
    startedAt: s.startedAt,
    durationMs: s.durationMs,
    weightedScore: s.weightedScore,
    totalAiCalls: s.totalAiCalls,
    totalInputTokens: s.totalInputTokens,
    totalOutputTokens: s.totalOutputTokens,
    estimatedCostUsd: s.estimatedCostUsd,
  };
  if (s.agentVariant) out.variant = s.agentVariant;
  if (s.agentModel) out.agentModel = s.agentModel;
  if (s.agentModelCount !== undefined) out.agentModelCount = s.agentModelCount;
  if (s.exitCode !== undefined) out.exitCode = s.exitCode;
  if (s.completedAt) out.completedAt = s.completedAt;
  if (s.agentCostUsd !== undefined) out.agentCostUsd = s.agentCostUsd;
  if (s.platformCostUsd !== undefined) out.platformCostUsd = s.platformCostUsd;
  if (s.pricingFallbackCalls !== undefined) out.pricingFallbackCalls = s.pricingFallbackCalls;
  if (s.totalCacheReadInputTokens !== undefined) out.totalCacheReadInputTokens = s.totalCacheReadInputTokens;
  if (s.totalCacheCreationInputTokens !== undefined) out.totalCacheCreationInputTokens = s.totalCacheCreationInputTokens;
  return out;
}

function padEnd(str: string, len: number): string {
  return str.padEnd(len);
}
