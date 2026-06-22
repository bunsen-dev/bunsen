// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Traces command - Show AI traces for a run
 */

import chalk from 'chalk';
import { loadTraces, loadTracesSummary } from '@bunsen-dev/runtime';

/**
 * Extract text preview from response content (handles various provider formats)
 */
function extractTextPreview(content: unknown): string {
  // Anthropic format: array of content blocks
  if (Array.isArray(content)) {
    const texts = content
      .filter((b): b is { type: string; text?: string } =>
        typeof b === 'object' && b !== null && b.type === 'text' && typeof b.text === 'string'
      )
      .map((b) => b.text);
    return texts.join(' ') || JSON.stringify(content);
  }

  // OpenAI format: message object with content + tool_calls
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.content === 'string') {
      return obj.content;
    }
    // Google format
    if (obj.parts && Array.isArray(obj.parts)) {
      const texts = (obj.parts as Array<{ text?: string }>)
        .filter((p) => typeof p.text === 'string')
        .map((p) => p.text);
      return texts.join(' ') || JSON.stringify(content);
    }
  }

  return JSON.stringify(content);
}

interface TracesOptions {
  full?: boolean;
}

export async function tracesCommand(runId: string, options: TracesOptions): Promise<void> {
  try {
    const traces = loadTraces(runId);
    const summary = loadTracesSummary(runId);

    if (!traces || traces.length === 0) {
      console.log(chalk.dim('No AI traces found for this run'));
      return;
    }

    // Print summary
    if (summary) {
      const agent = summary.bySource?.agent;
      const platform = summary.bySource?.platform;

      console.log();
      console.log(chalk.bold('AI Traces Summary'));
      console.log(chalk.dim('═'.repeat(50)));

      // Show agent stats as the headline (or totals if no source breakdown)
      const calls = agent?.calls ?? summary.totalCalls;
      const inputTokens = agent?.inputTokens ?? summary.totalInputTokens;
      const outputTokens = agent?.outputTokens ?? summary.totalOutputTokens;
      const cost = agent?.costUsd ?? summary.estimatedTotalCostUsd;

      console.log(`Total Calls:    ${calls}`);
      console.log(`Input Tokens:   ${inputTokens.toLocaleString()}`);
      console.log(`Output Tokens:  ${outputTokens.toLocaleString()}`);
      console.log(`Estimated Cost: $${cost.toFixed(4)}`);

      if (platform && platform.calls > 0) {
        console.log();
        console.log(chalk.dim(`Platform overhead: $${platform.costUsd.toFixed(4)} (${platform.calls} calls)`));
      }
    }

    console.log();
    console.log(chalk.bold('Traces'));
    console.log(chalk.dim('═'.repeat(50)));

    for (let i = 0; i < traces.length; i++) {
      const trace = traces[i];
      console.log();
      console.log(chalk.bold(`[${i + 1}] ${trace.provider} / ${trace.model}`));
      console.log(chalk.dim(`    ${trace.timestamp} • ${trace.latencyMs}ms • $${trace.estimatedCostUsd.toFixed(4)}`));

      if (options.full) {
        console.log();
        console.log(chalk.dim('Request:'));
        console.log(JSON.stringify(trace.request, null, 2));
        console.log();
        console.log(chalk.dim('Response:'));
        console.log(JSON.stringify(trace.response, null, 2));
      } else {
        // Show truncated content - extract text from structured responses
        const responseContent = extractTextPreview(trace.response.content);

        if (responseContent) {
          const preview = responseContent.length > 200
            ? responseContent.slice(0, 200) + '...'
            : responseContent;
          console.log(chalk.dim(`    ${preview.replace(/\n/g, ' ')}`));
        }
      }
    }

    console.log();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Error: ${message}`));
    process.exit(1);
  }
}
