// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `bn runs compare` — side-by-side comparison of runs.
 *
 * Two shapes:
 *   - 1D (default): one column per run, rows for each scored criterion plus
 *     status / model / duration / cost. Columns are labeled by the *varying*
 *     dimension (agent when an experiment is fixed, experiment when an agent
 *     is fixed) so a cross-vendor sweep reads as a matrix instead of a wall of
 *     opaque run ids.
 *   - 2D (`--matrix`): experiments × agents, each cell a weighted score.
 *
 * Cohort selection (no explicit run ids) is "most recent run per agent" by
 * default — see `buildCohort`. That makes `--experiment X` render every agent
 * that ran X exactly once (newest run), which can't drop an agent (problem
 * with the old `--last 3` default) or pull a stale historical run (the dedup
 * key is the agent, so each column is by construction that agent's latest).
 */

import chalk from 'chalk';
import { listRuns, loadRunManifest } from '@bunsen-dev/runtime';
import type { RunManifestV1 } from '@bunsen-dev/types';
import { resolveFormat, isMachineFormat, renderMachine } from '../format.js';
import { formatModelCell } from './helpers/format-model-cell.js';
import { formatCost } from './helpers/format-cost.js';
import { shortRunId } from './helpers/short-id.js';
import { statusColor } from './helpers/status-color.js';
import { padCell } from './helpers/truncate.js';
import { BunsenCliError } from '../errors.js';
import { EXIT_CODES } from '../exit-codes.js';
import { parsePositiveInt } from './helpers/parse-positive-int.js';

interface CompareOptions {
  experiment?: string;
  agent?: string;
  since?: string;
  last?: string;
  annotate?: string[];
  matrix?: boolean;
  format?: string;
  json?: boolean;
}

/** Default cap on a pinned-cell cohort (`-e X -a Y`); `--last` overrides it. */
const CELL_CAP = 12;

export async function compareCommand(runIds: string[], options: CompareOptions): Promise<void> {
  const format = resolveFormat(options);

  if (options.matrix) {
    matrixMode(options, format);
    return;
  }

  const cohort = buildCohort(runIds, options);
  if (cohort.runs.length < 2) {
    throw new BunsenCliError(
      'compare_too_few_runs',
      `Need at least 2 runs to compare (matched ${cohort.runs.length}). ` +
        'Broaden with --since, drop a filter, pass explicit run IDs, or use --matrix.',
      { exitCode: EXIT_CODES.USAGE, details: { run_count: cohort.runs.length } },
    );
  }

  // Scores come from the manifest's evaluation projection — the single source
  // of truth — so the 1D table, the matrix, and `--format json` can never
  // disagree about a run's score, and we skip N evaluation/result.json reads.
  const runs = cohort.runs;
  const view = describeView(runs);

  if (isMachineFormat(format)) {
    process.stdout.write(renderMachine(buildMachinePayload(runs, cohort, view), format));
    return;
  }

  renderComparison(runs, cohort, view, options.annotate ?? []);
}

// ---------------------------------------------------------------------------
// Cohort selection (1D)
// ---------------------------------------------------------------------------

interface Cohort {
  runs: RunManifestV1[];
  /** Runs dropped by dedup or the `--last` cap. */
  hidden: number;
  /** Human note about what was collapsed/hidden, for the text view. */
  note?: string;
}

function buildCohort(runIds: string[], options: CompareOptions): Cohort {
  // Explicit ids win — used verbatim, in the order given, no filtering.
  if (runIds.length > 0) {
    return { runs: runIds.map(loadManifestOrThrow), hidden: 0 };
  }

  if (!options.experiment && !options.agent) {
    throw new BunsenCliError(
      'compare_missing_runs',
      'Provide run IDs, or filter with --experiment / --agent (optionally --since).',
      { exitCode: EXIT_CODES.USAGE },
    );
  }

  const sinceTs = options.since !== undefined ? parseSince(options.since) : undefined;
  const pool = listRuns().filter(
    (m) =>
      (!options.experiment || m.experiment.id === options.experiment) &&
      (!options.agent || matchesAgent(m, options.agent)) &&
      (sinceTs === undefined || new Date(m.started_at).getTime() >= sinceTs),
  );
  // listRuns() is newest-first, so "first seen" below is always the latest run.

  // `--last N`: raw N most-recent matching runs, no dedup. The escape hatch for
  // within-cell variance (an agent can legitimately repeat as a column).
  if (options.last !== undefined) {
    const n = parsePositiveInt(options.last, '--last', 'compare_bad_count');
    return cohortOf(pool, pool.slice(0, n), (shown, total) =>
      `showing ${shown} of ${total} matching runs (--last ${n})`,
    );
  }

  // Both filters pin a single cell — nothing varies to dedup on, so show the
  // runs of that cell (newest-first) for within-cell variance, capped so a
  // heavily-rerun cell doesn't render an unreadable wall of columns. `--last`
  // (handled above) overrides the cap.
  if (options.experiment && options.agent) {
    return cohortOf(pool, pool.slice(0, CELL_CAP), (shown, total) =>
      `showing ${shown} of ${total} runs of this cell (use --last to widen)`,
    );
  }

  // Default (Option A): most recent run per varying dimension. Exactly one
  // filter is set here (the both-set and no-filter cases already returned), so
  // a fixed experiment ⇒ columns vary by agent, and vice versa.
  const byAgent = !!options.experiment;
  const keyOf: (m: RunManifestV1) => string = byAgent ? agentKey : (m) => m.experiment.id;
  const seen = new Set<string>();
  const runs: RunManifestV1[] = [];
  for (const m of pool) {
    const key = keyOf(m);
    if (seen.has(key)) continue;
    seen.add(key);
    runs.push(m);
  }
  const dimension = byAgent ? 'agent' : 'experiment';
  return cohortOf(pool, runs, (shown, total) =>
    `newest run per ${dimension} · ${plural(total - shown, 'older run')} hidden (use --last to include)`,
  );
}

/**
 * Package a selected subset of `pool` into a Cohort: derive the hidden count
 * and apply `note` only when runs were actually dropped.
 */
function cohortOf(
  pool: RunManifestV1[],
  runs: RunManifestV1[],
  note: (shown: number, total: number) => string,
): Cohort {
  const hidden = pool.length - runs.length;
  return { runs, hidden, note: hidden > 0 ? note(runs.length, pool.length) : undefined };
}

function loadManifestOrThrow(id: string): RunManifestV1 {
  const manifest = loadRunManifest(id);
  if (!manifest) {
    throw new BunsenCliError('run_not_found', `Run not found: ${id}`, {
      exitCode: EXIT_CODES.GENERIC,
      details: { run_id: id },
    });
  }
  return manifest;
}

/** `agent.id` plus its variant, the stable key for an agent column. */
function agentKey(m: RunManifestV1): string {
  return m.agent.variant ? `${m.agent.id}:${m.agent.variant}` : m.agent.id;
}

/**
 * Does an agent-key satisfy a `--agent` token? Exact match, or a bare id token
 * matching any of its variants. An `id:variant` token only ever equals one key
 * (keys carry a single colon, so `id:variant:` is never a prefix), so this one
 * rule covers both the bare-id and exact-variant cases.
 */
function agentKeyMatches(key: string, token: string): boolean {
  return key === token || key.startsWith(`${token}:`);
}

function matchesAgent(m: RunManifestV1, value: string): boolean {
  return agentKeyMatches(agentKey(m), value);
}

function parseSince(value: string): number {
  // A bare `YYYY-MM-DD` is interpreted as LOCAL midnight — what a user means by
  // "on or after this day". `new Date('2026-05-26')` would otherwise be UTC
  // midnight and pull in the prior local day for negative-offset users. Full
  // timestamps (with a time or zone) parse as written.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const ts = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime()
    : new Date(value).getTime();
  if (Number.isNaN(ts)) {
    throw new BunsenCliError('compare_bad_since', `Invalid --since date: ${value}`, {
      exitCode: EXIT_CODES.USAGE,
      details: { since: value },
    });
  }
  return ts;
}

// ---------------------------------------------------------------------------
// View shape (what varies → how columns/title read)
// ---------------------------------------------------------------------------

type ViewMode = 'experiment' | 'agent' | 'cell' | 'mixed';

interface View {
  mode: ViewMode;
  experiment?: string;
  agent?: string;
}

function describeView(runs: RunManifestV1[]): View {
  const experiments = new Set(runs.map((m) => m.experiment.id));
  const agents = new Set(runs.map(agentKey));
  const oneExp = experiments.size === 1;
  const oneAgent = agents.size === 1;

  if (oneExp && oneAgent) {
    return { mode: 'cell', experiment: [...experiments][0], agent: [...agents][0] };
  }
  if (oneExp) return { mode: 'experiment', experiment: [...experiments][0] };
  if (oneAgent) return { mode: 'agent', agent: [...agents][0] };
  return { mode: 'mixed' };
}

/** The primary (bold) column header — the dimension that varies across columns. */
function columnLabel(m: RunManifestV1, mode: ViewMode): string {
  switch (mode) {
    case 'experiment':
    case 'mixed':
      return agentKey(m);
    case 'agent':
      return m.experiment.id;
    case 'cell':
      return shortRunId(m.run_id);
  }
}

/** The secondary (dim) column header — a cross-reference back to the run. */
function secondaryLabel(m: RunManifestV1, mode: ViewMode): string {
  // In cell mode the short id is already the primary; disambiguate by time.
  return mode === 'cell' ? new Date(m.started_at).toLocaleDateString() : shortRunId(m.run_id);
}

function titleText(view: View, count: number): string {
  switch (view.mode) {
    case 'experiment':
      return `${view.experiment} · ${count} agents`;
    case 'agent':
      return `${view.agent} · ${count} experiments`;
    case 'cell':
      return `${view.experiment} · ${view.agent} · ${count} runs`;
    case 'mixed':
      return `Run Comparison · ${count} runs`;
  }
}

// ---------------------------------------------------------------------------
// 1D rendering
// ---------------------------------------------------------------------------

function renderComparison(
  runs: RunManifestV1[],
  cohort: Cohort,
  view: View,
  annotations: string[],
): void {
  const criteria = unionCriteria(runs);

  const rowLabels = [
    'Weighted Score',
    'Status',
    'Model',
    'Duration',
    'Cost',
    ...annotations.map(annotationLabel),
    ...criteria,
  ];
  const criterionWidth = Math.max(20, ...rowLabels.map((l) => l.length));

  const colLabels = runs.map((m) => columnLabel(m, view.mode));
  const secondaryLabels = runs.map((m) => secondaryLabel(m, view.mode));
  const modelCells = runs.map((m) =>
    formatModelCell(m.agent.models?.[0]?.model, m.agent.models?.length),
  );
  // Every string that lands in a column feeds the width — including the
  // secondary header row (e.g. the cell-mode date), which would otherwise be
  // truncated since it isn't the primary label.
  const widest = Math.max(
    12,
    ...colLabels.map((s) => s.length),
    ...secondaryLabels.map((s) => s.length),
    ...modelCells.map((s) => s.length),
  );
  const colWidth = Math.min(Math.max(widest + 1, 16), 26);
  const pad = (s: string) => padCell(s, colWidth);
  const lineWidth = criterionWidth + 2 + colWidth * runs.length;

  const printRow = (label: string, cells: string[], styleLabel?: (s: string) => string): void => {
    const padded = label.padEnd(criterionWidth + 2);
    console.log((styleLabel ? styleLabel(padded) : padded) + cells.join(''));
  };

  console.log();
  console.log(chalk.bold(titleText(view, runs.length)));
  console.log(chalk.dim('═'.repeat(lineWidth)));

  // Two-line header: agent/experiment label, then a dim run-id cross-reference.
  printRow('', colLabels.map((label) => chalk.bold(pad(label))));
  printRow('', secondaryLabels.map((label) => chalk.dim(pad(label))));
  console.log(chalk.dim('─'.repeat(lineWidth)));

  // Criterion scores.
  for (const criterion of criteria) {
    printRow(
      criterion,
      runs.map((m) => {
        const c = m.evaluation?.criteria.find((x) => x.id === criterion);
        if (!c) return pad('-');
        return pad(c.score !== null ? c.score.toFixed(2) : 'N/A');
      }),
    );
  }
  if (criteria.length > 0) console.log(chalk.dim('─'.repeat(lineWidth)));

  // Weighted score.
  printRow(
    'Weighted Score',
    runs.map((m) => {
      const s = m.evaluation?.weighted_score;
      return chalk.bold(pad(typeof s === 'number' ? s.toFixed(2) : '-'));
    }),
    chalk.bold,
  );
  console.log(chalk.dim('─'.repeat(lineWidth)));

  // Status — the load-bearing row for failed runs (which have no scores).
  printRow(
    'Status',
    runs.map((m) => statusColor(m.status)(pad(m.status))),
  );

  // Model / Duration.
  printRow(
    'Model',
    modelCells.map((cell) => chalk.dim(pad(cell))),
  );
  printRow(
    'Duration',
    runs.map((m) => chalk.dim(pad(`${(m.duration_ms / 1000).toFixed(1)}s`))),
  );

  // Cost — a captured $0 (free vendor) must read differently from a run that
  // never reached an API call (failed/skipped → no accounting). A `*` + yellow
  // flags runs where some cost is a coarse-default estimate (model not in the
  // price table), so guessed and data-driven costs aren't compared as equals.
  const anyUncosted = runs.some((m) => m.usage.accounting_status !== 'captured');
  const anyFallback = runs.some((m) => m.usage.pricing_fallback_calls);
  printRow(
    'Cost',
    runs.map((m) => {
      if (m.usage.accounting_status !== 'captured') return chalk.dim(pad('—'));
      const fallback = !!m.usage.pricing_fallback_calls;
      const cell = pad(formatCost(m.usage.estimated_cost_usd) + (fallback ? '*' : ''));
      return fallback ? chalk.yellow(cell) : chalk.dim(cell);
    }),
  );

  // Arbitrary manifest fields requested via --annotate.
  for (const field of annotations) {
    printRow(
      annotationLabel(field),
      runs.map((m) => chalk.dim(pad(resolveAnnotation(m, field)))),
      chalk.dim,
    );
  }

  console.log();
  if (anyUncosted) {
    console.log(
      chalk.dim('—  no cost captured (run failed before any API call, or traces disabled)'),
    );
  }
  if (anyFallback) {
    console.log(
      chalk.yellow('*  cost includes calls priced with a coarse default (model not in the price table) — see `bn runs cost <id>`'),
    );
  }
  if (cohort.note) console.log(chalk.dim(`note: ${cohort.note}`));
  console.log();
}

function unionCriteria(runs: RunManifestV1[]): string[] {
  // First-seen order across all runs' criteria (dedupe preserves insertion order).
  return dedupe(runs.flatMap((m) => (m.evaluation?.criteria ?? []).map((c) => c.id)));
}

// ---------------------------------------------------------------------------
// Matrix (2D) rendering
// ---------------------------------------------------------------------------

function matrixMode(options: CompareOptions, format: ReturnType<typeof resolveFormat>): void {
  const sinceTs = options.since !== undefined ? parseSince(options.since) : undefined;
  // In matrix mode --experiment / --agent are comma-separated axis selectors.
  const expFilter = splitList(options.experiment);
  const agentFilter = splitList(options.agent);

  const pool = listRuns().filter(
    (m) =>
      (sinceTs === undefined || new Date(m.started_at).getTime() >= sinceTs) &&
      (!expFilter || expFilter.includes(m.experiment.id)) &&
      (!agentFilter || agentFilter.some((a) => matchesAgent(m, a))),
  );

  // Experiment ids are exact axis values (no variant), so an explicit list maps
  // straight through (deduped, caller order preserved); empty rows for ids with
  // no run are intentional. Agent axes are the exact agent-keys present, so a
  // bare `-a claude-code` EXPANDS to one column per variant (resolveAgentAxes)
  // rather than collapsing variants into a single mis-attributed column.
  const experiments = expFilter ? dedupe(expFilter) : distinctSorted(pool.map((m) => m.experiment.id));
  const agents = resolveAgentAxes(agentFilter, pool);

  // Index the newest run per (experiment, exact agent-key) cell in one pass.
  // pool is newest-first, so the first run seen for a key is the most recent.
  // Keying on the exact agentKey (not matchesAgent's by-id match) keeps each run
  // in exactly one cell — a `claude-code` run and a `claude-code:auto` run never
  // shadow or double-attribute into each other's column.
  const byCell = new Map<string, RunManifestV1>();
  for (const m of pool) {
    const key = cellKey(m.experiment.id, agentKey(m));
    if (!byCell.has(key)) byCell.set(key, m);
  }
  const cellRun = (exp: string, ag: string): RunManifestV1 | undefined =>
    byCell.get(cellKey(exp, ag));

  if (isMachineFormat(format)) {
    process.stdout.write(
      renderMachine(
        {
          axes: { experiments, agents },
          rows: experiments.map((exp) => ({
            experiment: exp,
            cells: agents.map((ag) => {
              const run = cellRun(exp, ag);
              return run
                ? {
                    agent: ag,
                    runId: run.run_id,
                    status: run.status,
                    weightedScore: run.evaluation?.weighted_score ?? null,
                    estimatedCostUsd: run.usage.estimated_cost_usd,
                    // Parity with the 1D payload: lets a consumer tell a real
                    // captured $0 from a run with no captured cost.
                    accountingStatus: run.usage.accounting_status ?? null,
                  }
                : { agent: ag, runId: null };
            }),
          })),
        },
        format,
      ),
    );
    return;
  }

  if (experiments.length === 0 || agents.length === 0) {
    console.log(chalk.dim('No runs match — nothing to build a matrix from.'));
    return;
  }

  const heads = agents.map(splitAgentKey);
  const labelWidth = Math.max(12, ...experiments.map((e) => e.length)) + 2;
  const colWidth = Math.min(
    Math.max(8, ...heads.flatMap(([id, suffix]) => [id.length, suffix.length])) + 1,
    18,
  );
  const pad = (s: string) => padCell(s, colWidth);
  const lineWidth = labelWidth + colWidth * agents.length;

  console.log();
  console.log(
    chalk.bold(
      `Run Matrix · ${plural(experiments.length, 'experiment')} × ${plural(agents.length, 'agent')}`,
    ),
  );
  console.log(chalk.dim('═'.repeat(lineWidth)));

  // Two-line agent header: id, then :variant (dim) when present.
  console.log(''.padEnd(labelWidth) + heads.map(([id]) => chalk.bold(pad(id))).join(''));
  console.log(''.padEnd(labelWidth) + heads.map(([, suffix]) => chalk.dim(pad(suffix))).join(''));
  console.log(chalk.dim('─'.repeat(lineWidth)));

  for (const exp of experiments) {
    const cells = agents.map((ag) => {
      const run = cellRun(exp, ag);
      if (!run) return chalk.dim(pad('·'));
      const score = run.evaluation?.weighted_score;
      if (score === undefined || score === null) return chalk.dim(pad('—'));
      return scoreColor(score)(pad(score.toFixed(2)));
    });
    console.log(padCell(exp, labelWidth) + cells.join(''));
  }

  console.log();
  console.log(chalk.dim('·  no run     —  ran, no score'));
  console.log();
}

/** Split an agent-key axis into its `[id, ":variant"]` header halves. */
function splitAgentKey(agentAxis: string): [string, string] {
  const i = agentAxis.indexOf(':');
  return i === -1 ? [agentAxis, ''] : [agentAxis.slice(0, i), agentAxis.slice(i)];
}

/** Stable composite matrix-cell key (NUL never appears in an id or variant). */
function cellKey(experimentId: string, agent: string): string {
  return `${experimentId} ${agent}`;
}

/** De-duplicate while preserving first-seen order. */
function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** `2 agents` / `1 agent` — count plus its correctly-pluralized noun. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Resolve the matrix agent axis to the exact agent-keys present in the pool.
 * With no `--agent`, that's every distinct key (sorted). With `--agent`, each
 * token is expanded in caller order: a bare id (`claude-code`) yields one column
 * per variant present (`claude-code`, `claude-code:auto`, …); an `id:variant`
 * token yields just that key. Deduped, so a repeated token can't double a
 * column. Expanding to exact keys is what lets cell lookup partition cleanly.
 */
function resolveAgentAxes(agentFilter: string[] | undefined, pool: RunManifestV1[]): string[] {
  const present = distinctSorted(pool.map(agentKey));
  if (!agentFilter) return present;
  // Each token expands (in caller order) to the present keys it matches; dedupe
  // so overlapping tokens can't double a column.
  return dedupe(agentFilter.flatMap((token) => present.filter((key) => agentKeyMatches(key, token))));
}

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function distinctSorted(values: string[]): string[] {
  return dedupe(values).sort();
}

// ---------------------------------------------------------------------------
// Machine payload (1D)
// ---------------------------------------------------------------------------

function buildMachinePayload(runs: RunManifestV1[], cohort: Cohort, view: View) {
  return {
    mode: view.mode,
    experiment: view.experiment ?? null,
    agent: view.agent ?? null,
    hidden: cohort.hidden,
    note: cohort.note ?? null,
    runs: runs.map((m) => {
      return {
        id: m.run_id,
        experimentId: m.experiment.id,
        agentId: m.agent.id,
        agentKey: agentKey(m),
        variant: m.agent.variant ?? null,
        model: m.agent.models?.[0]?.model ?? null,
        models: m.agent.models ?? null,
        status: m.status,
        accountingStatus: m.usage.accounting_status ?? null,
        startedAt: m.started_at,
        completedAt: m.completed_at ?? null,
        summary: {
          durationMs: m.duration_ms,
          totalAICalls: m.usage.total_ai_calls,
          totalInputTokens: m.usage.total_input_tokens,
          totalOutputTokens: m.usage.total_output_tokens,
          totalCacheReadInputTokens: m.usage.total_cache_read_input_tokens ?? null,
          totalCacheCreationInputTokens: m.usage.total_cache_creation_input_tokens ?? null,
          estimatedCostUsd: m.usage.estimated_cost_usd,
          // So `--format json` can tell a coarse-default-priced cost from a
          // data-driven one (the text view marks it with `*`).
          pricingFallbackCalls: m.usage.pricing_fallback_calls ?? null,
          unpricedModels: m.usage.unpriced_models ?? null,
          weightedScore: m.evaluation?.weighted_score ?? null,
        },
        evaluation: m.evaluation
          ? {
              weightedScore: m.evaluation.weighted_score,
              criteria: m.evaluation.criteria.map((c) => ({
                criterion: c.id,
                score: c.score,
                weight: c.weight,
                summary: c.summary,
              })),
            }
          : null,
      };
    }),
    criteria: unionCriteria(runs),
  };
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

/** Resolve a `--annotate` field to a per-run cell string. */
function resolveAnnotation(m: RunManifestV1, field: string): string {
  switch (field) {
    case 'model':
      return formatModelCell(m.agent.models?.[0]?.model, m.agent.models?.length);
    case 'cost-source':
      return m.usage.accounting_status ?? 'unknown';
    case 'started':
    case 'started-at':
      return new Date(m.started_at).toLocaleString();
    case 'completed':
    case 'completed-at':
      return m.completed_at ? new Date(m.completed_at).toLocaleString() : '-';
    case 'status':
      return m.status;
    case 'duration':
      return `${(m.duration_ms / 1000).toFixed(1)}s`;
    case 'exit-code':
      return m.exit_code !== undefined ? String(m.exit_code) : '-';
    case 'platform':
      return m.platform ?? '-';
    case 'run-id':
      return m.run_id;
    case 'variant':
      return m.agent.variant ?? '-';
    case 'calls':
      return String(m.usage.total_ai_calls);
    case 'cache-read':
      return (m.usage.total_cache_read_input_tokens ?? 0).toLocaleString();
    default: {
      const value = getPath(m, field);
      if (value === undefined || value === null) return '-';
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
  }
}

function annotationLabel(field: string): string {
  const spaced = field.replace(/[-_.]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, key) => {
    // Own-property check only, so `--annotate __proto__` / `constructor` resolve
    // to `undefined` (→ rendered as `-`) instead of leaking prototype internals.
    if (acc && typeof acc === 'object' && Object.prototype.hasOwnProperty.call(acc, key)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

// ---------------------------------------------------------------------------
// Shared formatting
// ---------------------------------------------------------------------------

function scoreColor(score: number): (s: string) => string {
  if (score >= 0.8) return chalk.green;
  if (score >= 0.4) return chalk.yellow;
  return chalk.red;
}
