// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `bn runs show` — display run summary.
 *
 * `--format json|yaml` returns the canonical `RunManifestV1`. The text view
 * is a human-friendly projection of the same shape.
 */

import chalk from 'chalk';
import * as path from 'node:path';
import {
  loadEvaluationResult,
  loadRunManifest,
  loadTracesSummary,
  getRunDir,
  formatInvocationForLog,
} from '@bunsen-dev/runtime';
import type { AgentModelUsage, RunManifestV1 } from '@bunsen-dev/types';
import { resolveFormat, isMachineFormat, renderMachine } from '../format.js';
import { formatCacheTokens } from './helpers/format-cache-tokens.js';
import { formatPricingFallbackWarning } from './helpers/format-pricing-fallback.js';
import { BunsenCliError } from '../errors.js';
import { EXIT_CODES } from '../exit-codes.js';

interface ShowOptions {
  format?: string;
}

export async function showCommand(runId: string, options: ShowOptions = {}): Promise<void> {
  const format = resolveFormat(options);
  const manifest = loadRunManifest(runId);
  if (!manifest) {
    throw new BunsenCliError('run_not_found', `Run not found: ${runId}`, {
      exitCode: EXIT_CODES.GENERIC,
      details: { run_id: runId },
    });
  }

  if (isMachineFormat(format)) {
    process.stdout.write(renderMachine(manifest, format));
    return;
  }

  renderText(manifest, runId);
}

function renderText(manifest: RunManifestV1, runId: string): void {
  console.log();
  console.log(chalk.bold(`Run: ${manifest.run_id}`));
  console.log(chalk.dim('═'.repeat(50)));

  const statusColor =
    manifest.status === 'succeeded' ? chalk.green :
    manifest.status === 'failed' ? chalk.red :
    manifest.status === 'canceled' ? chalk.magenta :
    chalk.yellow;
  console.log(`Status:     ${statusColor(manifest.status)}`);
  console.log(`Experiment: ${manifest.experiment.id}`);
  if (manifest.agent.variant) {
    console.log(`Agent:      ${manifest.agent.id}:${chalk.cyan(manifest.agent.variant)}`);
  } else {
    console.log(`Agent:      ${manifest.agent.id}`);
  }

  if (manifest.experiment.suite_id) {
    const sha = manifest.experiment.suite_version
      ? ` @ ${chalk.dim(manifest.experiment.suite_version.slice(0, 12))}`
      : '';
    console.log(`Suite:      ${manifest.experiment.suite_id}${sha}`);
    if (manifest.experiment.suite_source_url) {
      console.log(chalk.dim(`            ${manifest.experiment.suite_source_url}`));
    }
  }

  const args = manifest.agent.args ?? [];
  if (args.length > 0) {
    console.log(`Args:       ${args.join(' ')}`);
  }
  if (manifest.platform) {
    console.log(`Platform:   ${manifest.platform}`);
  }

  console.log();
  console.log(`Started:    ${new Date(manifest.started_at).toLocaleString()}`);
  if (manifest.completed_at) {
    console.log(`Completed:  ${new Date(manifest.completed_at).toLocaleString()}`);
  }
  console.log(`Duration:   ${(manifest.duration_ms / 1000).toFixed(1)}s`);

  if (manifest.exit_code !== undefined) {
    console.log(`Exit Code:  ${manifest.exit_code}`);
  }

  if (manifest.orchestration) {
    console.log();
    console.log(chalk.bold('Orchestration'));
    console.log(chalk.dim('─'.repeat(50)));
    console.log(chalk.cyan(`$ ${formatInvocationForLog(manifest.orchestration.invocation)}`));
  }

  const tracesSummary = loadTracesSummary(runId);
  if (manifest.usage.total_ai_calls > 0) {
    console.log();
    console.log(chalk.bold('AI Usage'));
    console.log(chalk.dim('─'.repeat(50)));
    console.log(`Calls:       ${manifest.usage.total_ai_calls}`);
    console.log(`Input:       ${manifest.usage.total_input_tokens.toLocaleString()} tokens`);
    console.log(`Output:      ${manifest.usage.total_output_tokens.toLocaleString()} tokens`);
    const cacheLine = formatCacheTokens(
      manifest.usage.total_cache_read_input_tokens ?? 0,
      manifest.usage.total_cache_creation_input_tokens ?? 0,
    );
    if (cacheLine) console.log(`Cache:       ${cacheLine}`);
    const headlineCost = tracesSummary?.bySource?.agent?.costUsd ?? manifest.usage.estimated_cost_usd;
    console.log(`Est. Cost:   $${headlineCost.toFixed(4)}`);
    if (manifest.usage.platform_cost_usd) {
      console.log(chalk.dim(`  + Platform: $${manifest.usage.platform_cost_usd.toFixed(4)}`));
    }
    const fallback = formatPricingFallbackWarning(
      manifest.usage.pricing_fallback_calls,
      manifest.usage.unpriced_models,
      '  ',
    );
    if (fallback) console.log(chalk.yellow(fallback));
    renderModelBreakdown(manifest.agent.models);
  } else if (manifest.usage.accounting_status === 'missing') {
    console.log();
    console.log(chalk.bold('AI Usage'));
    console.log(chalk.dim('─'.repeat(50)));
    console.log(chalk.yellow('No AI traces captured (degraded accounting).'));
    console.log(
      chalk.dim(
        'The proxy was active but recorded no calls. The agent may have ' +
          'bypassed the trace proxy (e.g., Node native fetch ignores HTTPS_PROXY). ' +
          'Reported totals are unreliable for this run.',
      ),
    );
  }

  const weightedScore = manifest.evaluation?.weighted_score ?? null;
  if (weightedScore !== null) {
    console.log();
    console.log(chalk.bold('Evaluation'));
    console.log(chalk.dim('─'.repeat(50)));
    console.log(`Weighted Score: ${weightedScore.toFixed(2)}`);

    const evaluation = loadEvaluationResult(runId);
    if (evaluation) {
      const runDir = getRunDir(runId);
      console.log();
      for (const criterion of evaluation.criteria) {
        const scoreStr = criterion.score !== null ? criterion.score.toFixed(2) : 'N/A';
        const weightStr = criterion.weight === 0 ? ' (observation only)' : '';
        console.log(`${criterion.id}: ${scoreStr}${weightStr}`);
        console.log(chalk.dim(`  ${criterion.summary}`));
        if (criterion.screenshots && criterion.screenshots.length > 0) {
          for (const screenshot of criterion.screenshots) {
            console.log(chalk.cyan(`  Screenshot: ${path.join(runDir, screenshot)}`));
          }
        }
      }
      if (evaluation.report) {
        console.log();
        console.log(chalk.bold('Report'));
        console.log(chalk.dim('─'.repeat(50)));
        console.log(evaluation.report);
      }
    }
  }

  if (manifest.artifacts && manifest.artifacts.length > 0) {
    console.log();
    console.log(chalk.bold('Artifacts'));
    console.log(chalk.dim('─'.repeat(50)));
    for (const artifact of manifest.artifacts) {
      console.log(`  ${artifact.rel_path ?? artifact.key}`);
    }
  }

  console.log();
  console.log(chalk.dim('Commands:'));
  console.log(chalk.dim(`  bn runs logs ${runId}      View logs`));
  console.log(chalk.dim(`  bn runs traces ${runId}    View AI traces`));
  console.log(chalk.dim(`  bn runs cost ${runId}      View cost breakdown`));
  console.log(chalk.dim(`  bn runs diff ${runId}      View workspace changes`));
  console.log(chalk.dim(`  bn eval show ${runId}      View evaluator scores`));
  console.log(chalk.dim(`  bn eval report ${runId}    View evaluation report`));
  console.log(chalk.dim(`  bn runs open ${runId}      Open in web viewer`));
  console.log();
}

/**
 * Render the per-model usage breakdown (most-used first) under AI Usage. Shows
 * each model's call count, share of agent calls, and cost. A single-model run
 * still prints one row — it's the honest, multi-model-ready shape. No-trace
 * runs have no breakdown and render nothing.
 */
function renderModelBreakdown(models: AgentModelUsage[] | undefined): void {
  if (!models || models.length === 0) return;
  const totalCalls = models.reduce((sum, m) => sum + m.calls, 0);
  const nameWidth = Math.max(...models.map((m) => m.model.length));
  console.log(`Models:`);
  for (const m of models) {
    const pct = totalCalls > 0 ? Math.round((m.calls / totalCalls) * 100) : 0;
    const calls = `${m.calls} call${m.calls === 1 ? '' : 's'}`;
    console.log(
      chalk.dim('  ') +
        chalk.cyan(m.model.padEnd(nameWidth)) +
        chalk.dim(`  ${calls.padStart(9)}  ${String(pct).padStart(3)}%  $${m.cost_usd.toFixed(4)}`),
    );
  }
}
