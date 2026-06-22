// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `bn runs cost` — detailed AI cost breakdown for a run.
 */

import chalk from 'chalk';
import { loadRunManifest, loadTracesSummary } from '@bunsen-dev/runtime';
import type { SourceCostBreakdown } from '@bunsen-dev/types';
import { resolveFormat, isMachineFormat, renderMachine } from '../format.js';
import { formatCost } from './helpers/format-cost.js';
import { formatCacheTokens } from './helpers/format-cache-tokens.js';
import { formatPricingFallbackWarning } from './helpers/format-pricing-fallback.js';
import { BunsenCliError } from '../errors.js';
import { EXIT_CODES } from '../exit-codes.js';

interface CostOptions {
  format?: string;
}

/**
 * Print a source's cache-token line under its fresh-token line, but only when
 * there's cache activity. Cache reads routinely dwarf fresh input on agent
 * loops, so this is the line that explains the bill. Guarded with `?? 0` so a
 * pre-cache-accounting `summary.json` on disk renders as "no cache" instead of
 * throwing.
 */
function printCacheLine(b: SourceCostBreakdown | undefined, indent: string): void {
  const line = formatCacheTokens(b?.cacheReadInputTokens ?? 0, b?.cacheCreationInputTokens ?? 0);
  if (line) console.log(chalk.dim(`${indent}cache  ${line}`));
}

function formatBreakdown(label: string, b: SourceCostBreakdown, indent = ''): void {
  console.log(`${indent}${label}`);
  console.log(chalk.dim(`${indent}  ${b.calls} calls  ${b.inputTokens.toLocaleString()} in / ${b.outputTokens.toLocaleString()} out  ${formatCost(b.costUsd)}`));
  printCacheLine(b, `${indent}  `);
}

export async function costCommand(runId: string, options: CostOptions = {}): Promise<void> {
  const format = resolveFormat(options);
  const manifest = loadRunManifest(runId);
  if (!manifest) {
    throw new BunsenCliError('run_not_found', `Run not found: ${runId}`, {
      exitCode: EXIT_CODES.GENERIC,
      details: { run_id: runId },
    });
  }
  const summary = loadTracesSummary(runId);

  if (isMachineFormat(format)) {
    process.stdout.write(
      renderMachine(
        {
          runId: manifest.run_id,
          usage: manifest.usage,
          summary,
        },
        format,
      ),
    );
    return;
  }

  console.log();
  console.log(chalk.bold(`Cost Breakdown: ${manifest.run_id}`));
  console.log(chalk.dim('═'.repeat(50)));

  if (!summary || summary.totalCalls === 0) {
    if (manifest.usage.accounting_status === 'missing') {
      console.log(chalk.yellow('No AI traces captured (degraded accounting).'));
      console.log(
        chalk.dim(
          'The proxy was active but recorded no calls. The agent may have ' +
            'bypassed the trace proxy (e.g., Node native fetch ignores HTTPS_PROXY).',
        ),
      );
    } else if (manifest.usage.accounting_status === 'skipped') {
      console.log(chalk.dim('Trace capture was disabled for this run (--skip-traces).'));
    } else {
      console.log(chalk.dim('No AI traces found for this run'));
    }
    console.log();
    return;
  }

  const bs = summary.bySource;

  console.log();
  const agentCost = bs?.agent?.costUsd ?? summary.estimatedTotalCostUsd;
  const agentCalls = bs?.agent?.calls ?? summary.totalCalls;
  const agentIn = bs?.agent?.inputTokens ?? summary.totalInputTokens;
  const agentOut = bs?.agent?.outputTokens ?? summary.totalOutputTokens;
  console.log(chalk.bold(`Agent:     ${formatCost(agentCost)}`));
  console.log(chalk.dim(`  ${agentCalls} calls  ${agentIn.toLocaleString()} in / ${agentOut.toLocaleString()} out`));
  printCacheLine(bs?.agent, '  ');

  if (bs?.platform && bs.platform.calls > 0) {
    console.log();
    console.log(chalk.bold(`Platform:  ${formatCost(bs.platform.costUsd)}`));
    // Aggregate platform cache, so a platform source with no orchestrator/
    // supervisor/scorer sub-breakdown still has its cache attributed here
    // rather than only folded into the run-wide rollup.
    printCacheLine(bs.platform, '  ');

    if (bs.orchestrator && bs.orchestrator.calls > 0) {
      formatBreakdown('Orchestrator', bs.orchestrator, '  ');
    }

    if (bs.supervisor && bs.supervisor.calls > 0) {
      formatBreakdown('Supervisor', bs.supervisor, '  ');
    }

    if (bs.scorers) {
      const entries = Object.entries(bs.scorers);
      const scorersTotal = entries.reduce((sum, [, b]) => sum + b.costUsd, 0);
      console.log(`  Scorers (${entries.length}) ${chalk.dim(`(${formatCost(scorersTotal)})`)}`);

      for (const [criterion, breakdown] of entries) {
        console.log(chalk.dim(`    ${criterion}: ${breakdown.calls} calls  ${breakdown.inputTokens.toLocaleString()} in / ${breakdown.outputTokens.toLocaleString()} out  ${formatCost(breakdown.costUsd)}`));
        printCacheLine(breakdown, '      ');
      }
    } else if (bs.scorer && bs.scorer.calls > 0) {
      formatBreakdown('Scorers', bs.scorer, '  ');
    }
  }

  console.log();
  console.log(chalk.dim('─'.repeat(50)));
  console.log(chalk.bold(`Total:     ${formatCost(summary.estimatedTotalCostUsd)}`));

  // Run-wide cache rollup. The "in" counts above are fresh-only (billed at the
  // full rate); cache read/created are disjoint buckets that usually dominate
  // the prompt size. Surfacing them here is what lets a reader explain the bill
  // without spelunking raw agent.jsonl.
  const runCache = formatCacheTokens(
    summary.totalCacheReadInputTokens ?? 0,
    summary.totalCacheCreationInputTokens ?? 0,
  );
  if (runCache) {
    console.log(chalk.dim(`Run cache: ${runCache}`));
    console.log(chalk.dim(`           run-wide; fresh input billed at full rate: ${summary.totalInputTokens.toLocaleString()}`));
  }

  // Flag any calls whose model wasn't in the pricing table: their cost is a
  // coarse default, not a data-driven rate, so it must not read as accurate.
  const fallback = formatPricingFallbackWarning(summary.pricingFallbackCalls, summary.unpricedModels);
  if (fallback) {
    console.log();
    console.log(chalk.yellow(fallback));
    console.log(
      chalk.dim(
        '  Cost for these is a rough estimate. If the model is current, refresh ' +
          'packages/runtime/src/proxy/model_prices.json (scripts/refresh_model_prices.py).',
      ),
    );
  }

  console.log();
}
