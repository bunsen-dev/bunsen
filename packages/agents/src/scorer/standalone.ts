#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Standalone entry point for the scorer.
 *
 * This is the entry point for the scorer bundle. It reads configuration from
 * a JSON file, runs the appropriate scorer type, and outputs the result as
 * JSON to stdout.
 *
 * Usage:
 *   node /bunsen/lib/scorer.cjs --config /tmp/criterion-config.json
 *
 * Environment variables:
 *   BUNSEN_ANTHROPIC_API_KEY - API key for Claude (required)
 *
 * Input (JSON config file):
 *   {
 *     "criterion": "Tests Pass",
 *     "instructions": "Do all tests pass?",
 *     "type": "llm" | "agent" | "visual" | "report" | "aggregate" | "code",
 *     "contextDir": "/bunsen/run",
 *     "workspacePath": "/workspace",
 *     ...
 *   }
 *
 * Output (JSON to stdout):
 *   {
 *     "score": 0.8,
 *     "summary": "17 of 20 tests pass.",
 *     "report": "..." // Only for report type
 *   }
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient } from '../common/anthropic-client.js';
import { filterLockfilesFromDiff } from '@bunsen-dev/diff-filter';
import type {
  ScorerConfig,
  ScorerOutput,
} from '@bunsen-dev/types';
import { createAgent, tool, type ToolWithFunc } from '../common/index.js';
import {
  buildLLMJudgeSystemPrompt,
  buildAgenticScorerSystemPrompt,
  buildVisualScorerSystemPrompt,
  buildReportScorerSystemPrompt,
  buildInitialPrompt,
  buildAgenticInitialPrompt,
  buildReportInitialPrompt,
} from './prompts.js';

// =============================================================================
// Types
// =============================================================================

interface ScorerState {
  score: number | null;
  summary: string | null;
  report: string | null;
  done: boolean;
  submitted: boolean;
}

interface ScorerContext {
  config: ScorerConfig;
  contextDir: string;
  workspacePath: string;
}

/** Writable output directory for scorer artifacts (screenshots, etc.) */
const SCORER_OUTPUT_DIR = '/bunsen/scorer-output';

// =============================================================================
// Inline file access (avoids bundling @bunsen-dev/runtime)
// =============================================================================

// Max characters per context/tool-result chunk (~25K tokens at ~4 chars/token).
// Agentic scorers make multiple tool calls, so each must stay small enough that
// the full conversation fits within the 200K token model limit.
const MAX_CONTEXT_CHARS = 100_000;

function truncateWithNotice(content: string, maxChars: number, label: string): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + `\n\n... [${label} truncated: ${content.length.toLocaleString()} chars, showing first ${maxChars.toLocaleString()}]`;
}

function loadDiff(contextDir: string): string | null {
  const diffPath = path.join(contextDir, 'workspace', 'diff.patch');
  if (!fs.existsSync(diffPath)) return null;
  const content = fs.readFileSync(diffPath, 'utf-8');
  if (!content.trim()) return null;
  // Filter lockfiles before truncation so they don't consume context window quota
  const filtered = filterLockfilesFromDiff(content);
  if (!filtered.trim()) return null;
  return truncateWithNotice(filtered, MAX_CONTEXT_CHARS, 'diff');
}

function loadLogs(contextDir: string): string | null {
  const logsPath = path.join(contextDir, 'logs.txt');
  if (!fs.existsSync(logsPath)) return null;
  const content = fs.readFileSync(logsPath, 'utf-8');
  if (!content) return null;
  return truncateWithNotice(content, MAX_CONTEXT_CHARS, 'logs');
}

// ----------------------------------------------------------------------------
// Threaded trace readers — match the on-disk layout produced by
// `streamProcessTraces` in @bunsen-dev/runtime. Inlined here so the scorer bundle
// stays free of @bunsen-dev/runtime's Docker/SSH transitive deps.
// ----------------------------------------------------------------------------

interface ThreadTurn {
  turnIndex: number;
  timestamp: string;
  latencyMs: number;
  messages: Array<{ role: string; content: string | unknown[] }>;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  stopReason: string;
}

interface ThreadIndexEntry {
  threadId: string;
  context: { systemPrompt: string; toolNames: string[]; model: string; provider: string };
  timeRange: { start: string; end: string };
  turnCount: number;
  stats: { totalInputTokens: number; totalOutputTokens: number; estimatedCostUsd: number; durationMs: number };
}

interface ThreadsIndex {
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

function loadThreadsIndex(contextDir: string): ThreadsIndex | null {
  const indexPath = path.join(contextDir, THREADS_DIRNAME, 'index.json');
  if (!fs.existsSync(indexPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as ThreadsIndex;
  } catch {
    return null;
  }
}

function loadThreadTurns(
  contextDir: string,
  threadId: string,
  start?: number,
  end?: number,
): ThreadTurn[] {
  const filePath = path.join(contextDir, THREADS_DIRNAME, `${threadId}.jsonl`);
  if (!fs.existsSync(filePath)) return [];
  const turns: ThreadTurn[] = [];
  const startIdx = start ?? 0;
  const content = fs.readFileSync(filePath, 'utf-8');
  let i = 0;
  for (const line of content.split('\n')) {
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

/** Bounded head/tail of a thread for inclusion in an LLM prompt. */
function loadThreadHeadTail(
  contextDir: string,
  threadId: string,
  turnCount: number,
  headCount: number,
  tailCount: number,
): ThreadTurn[] {
  if (turnCount <= headCount + tailCount) {
    return loadThreadTurns(contextDir, threadId);
  }
  const head = loadThreadTurns(contextDir, threadId, 0, headCount);
  const tail = loadThreadTurns(contextDir, threadId, turnCount - tailCount, turnCount);
  return [...head, ...tail];
}

/**
 * Build a markdown trace summary for the LLM-judge prompt.
 *
 * Reads the small index plus a bounded head + tail of each thread. The
 * single-shot LLM-judge can't usefully consume more than this regardless of
 * how long the run was, so capping here keeps the prompt size bounded.
 */
const LLM_JUDGE_HEAD_TURNS = 5;
const LLM_JUDGE_TAIL_TURNS = 10;
const LLM_JUDGE_PER_TURN_CAP = 2000;

function formatThreadsForLLMJudge(contextDir: string): string | null {
  const index = loadThreadsIndex(contextDir);
  if (!index || index.threads.length === 0) return null;

  const parts: string[] = [];
  parts.push('## AI Conversation Summary');
  parts.push(`Total calls: ${index.summary.totalCalls}`);
  parts.push(`Total tokens: ${index.summary.totalInputTokens} in, ${index.summary.totalOutputTokens} out`);
  parts.push(`Threads: ${index.summary.threadCount}`);
  parts.push('');

  for (const thread of index.threads) {
    const turns = loadThreadHeadTail(
      contextDir,
      thread.threadId,
      thread.turnCount,
      LLM_JUDGE_HEAD_TURNS,
      LLM_JUDGE_TAIL_TURNS,
    );
    parts.push(`### Thread: ${thread.threadId}`);
    parts.push(`Model: ${thread.context.model}`);
    parts.push(`Turns: ${thread.turnCount}`);
    if (turns.length < thread.turnCount) {
      parts.push(`*Showing ${turns.length} of ${thread.turnCount} turns (head/tail sampled).*`);
    }
    parts.push('');

    for (const turn of turns) {
      parts.push(`#### Turn ${turn.turnIndex}`);
      for (const msg of turn.messages) {
        const content = typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content, null, 2);
        const truncated = content.length > LLM_JUDGE_PER_TURN_CAP
          ? content.slice(0, LLM_JUDGE_PER_TURN_CAP) + '...[truncated]'
          : content;
        parts.push(`**${msg.role}**: ${truncated}`);
      }
      parts.push('');
    }
  }

  return parts.join('\n');
}

// =============================================================================
// Aggregate scorer (no LLM needed)
// =============================================================================

function runAggregateScorer(config: ScorerConfig): ScorerOutput {
  if (!config.dependencyScores) {
    throw new Error('Aggregate scorer requires dependencyScores');
  }
  if (!config.aggregate) {
    throw new Error('Aggregate scorer requires aggregate function');
  }

  const deps = config.dependencyScores;
  const aggregate = config.aggregate;

  // Filter to valid scores (non-null)
  const validScores: { name: string; score: number }[] = [];
  for (const [name, data] of Object.entries(deps)) {
    if (data.score !== null) {
      validScores.push({ name, score: data.score });
    }
  }

  if (validScores.length === 0) {
    throw new Error('No valid scores to aggregate');
  }

  let score: number;
  let summary: string;

  switch (aggregate) {
    case 'weighted_average': {
      // Simple average (weights are handled by coordinator)
      const avg = validScores.reduce((sum, v) => sum + v.score, 0) / validScores.length;
      score = avg;
      summary = `Average of ${validScores.length} criteria: ${score.toFixed(2)}`;
      break;
    }

    case 'all': {
      const allPerfect = validScores.every((v) => v.score === 1);
      score = allPerfect ? 1 : 0;
      summary = allPerfect
        ? `All ${validScores.length} criteria scored 1.0`
        : `Not all criteria scored 1.0`;
      break;
    }

    case 'any': {
      const anyPass = validScores.some((v) => v.score > 0.5);
      score = anyPass ? 1 : 0;
      summary = anyPass
        ? `At least one criterion scored > 0.5`
        : `No criterion scored > 0.5`;
      break;
    }

    case 'min': {
      score = Math.min(...validScores.map((v) => v.score));
      const minCriterion = validScores.find((v) => v.score === score);
      summary = `Minimum score: ${score.toFixed(2)} (${minCriterion?.name})`;
      break;
    }

    case 'max': {
      score = Math.max(...validScores.map((v) => v.score));
      const maxCriterion = validScores.find((v) => v.score === score);
      summary = `Maximum score: ${score.toFixed(2)} (${maxCriterion?.name})`;
      break;
    }

    default:
      throw new Error(`Unknown aggregate function: ${aggregate}`);
  }

  return { score, summary };
}

// =============================================================================
// LLM-as-Judge scorer (single LLM call, no tools)
// =============================================================================

async function runLLMJudgeScorer(
  config: ScorerConfig,
  apiKey: string
): Promise<ScorerOutput> {
  const client = createAnthropicClient(apiKey);

  // Load context based on config.context (default: ['diff'] for LLM-judge)
  const contextTypes = new Set(config.context || ['diff']);

  const diff = contextTypes.has('diff') ? loadDiff(config.contextDir) : null;
  const logs = contextTypes.has('logs') ? loadLogs(config.contextDir) : null;
  const traces = contextTypes.has('traces')
    ? formatThreadsForLLMJudge(config.contextDir) ?? undefined
    : undefined;

  // Build prompts
  const systemPrompt = buildLLMJudgeSystemPrompt(config);
  const userPrompt = buildInitialPrompt(config, { diff: diff || undefined, logs: logs || undefined, traces });

  // Make single LLM call
  const response = await client.messages.create({
    model: config.model || 'claude-sonnet-4-6',
    max_tokens: 1024,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  // Parse response
  const textContent = response.content.find((c) => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('No text response from LLM');
  }

  // Extract JSON from response
  const text = textContent.text;
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*"score"[\s\S]*"summary"[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error(`Failed to parse LLM response as JSON: ${text}`);
  }

  const jsonStr = jsonMatch[1] || jsonMatch[0];
  const result = JSON.parse(jsonStr);

  if (typeof result.score !== 'number' || typeof result.summary !== 'string') {
    throw new Error(`Invalid LLM response format: ${JSON.stringify(result)}`);
  }

  // Validate score is in range
  if (result.score < 0 || result.score > 1) {
    throw new Error(`Score out of range: ${result.score}`);
  }

  // Validate against allowed scores if specified
  if (config.scores) {
    const allowedValues = Array.isArray(config.scores)
      ? config.scores
      : Object.keys(config.scores).map(parseFloat);

    // Find closest allowed value
    const closest = allowedValues.reduce((prev, curr) =>
      Math.abs(curr - result.score) < Math.abs(prev - result.score) ? curr : prev
    );

    if (Math.abs(closest - result.score) > 0.01) {
      console.error(`Warning: Score ${result.score} snapped to ${closest}`);
      result.score = closest;
    }
  }

  return {
    score: result.score,
    summary: result.summary,
  };
}

// =============================================================================
// Agentic scorer tools
// =============================================================================

function createSubmitScoreTool(state: ScorerState): ToolWithFunc {
  const schema = z.object({
    score: z.number().min(0).max(1).nullable(),
    summary: z.string().describe('Brief explanation of the score'),
    report: z.string().optional().describe('Full report (for report scorer only)'),
  });

  return tool({
    name: 'submit_score',
    description: 'Submit your evaluation score and summary.',
    schema,
    func: (input: z.infer<typeof schema>): string => {
      console.error(`[scorer] submit_score called: score=${input.score}, summary="${input.summary.slice(0, 100)}..."`);
      state.score = input.score;
      state.summary = input.summary;
      state.report = input.report || null;
      state.done = true;
      state.submitted = true;
      return 'Score submitted successfully';
    },
  });
}

/** Counter for background process output files */
let bgProcessCounter = 0;

// Max characters for direct command output before requiring run_in_background.
// ~12K tokens — keeps individual tool results well within model context limits.
const MAX_DIRECT_OUTPUT_CHARS = 50_000;

function createRunCommandTool(ctx: ScorerContext): ToolWithFunc {
  const schema = z.object({
    command: z.string().describe('The shell command to execute'),
    timeout: z.number().optional().default(30000).describe('Timeout in milliseconds'),
    run_in_background: z.boolean().optional().default(false).describe(
      'Run the command in the background. Returns immediately with PID and output file path. ' +
      'Use this for commands with large output (like test suites) or long-running processes like servers. ' +
      'Then use read_file to read the output file.'
    ),
  });

  return tool({
    name: 'run_command',
    description:
      'Execute a shell command in the workspace. For commands that produce large output (test suites, builds), ' +
      'use run_in_background=true and then read_file to inspect the output.',
    schema,
    func: (input: z.infer<typeof schema>): string => {
      if (input.run_in_background) {
        try {
          const outputFile = `/tmp/bg-process-${++bgProcessCounter}.log`;
          const child = spawn('sh', ['-c', `${input.command} > ${outputFile} 2>&1`], {
            cwd: ctx.workspacePath,
            detached: true,
            stdio: 'ignore',
          });
          child.unref();
          const pid = child.pid;
          console.error(`[run_command] Background process started: PID=${pid}, output=${outputFile}`);
          return `Background process started.\nPID: ${pid}\nOutput file: ${outputFile}\n\nUse read_file with the output file path to check results. Use start_line=-100 to see the last 100 lines.`;
        } catch (error) {
          return `Error starting background process: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      try {
        const result = execSync(input.command, {
          cwd: ctx.workspacePath,
          timeout: input.timeout,
          maxBuffer: 2 * 1024 * 1024,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const output = result || '(Command completed with no output)';
        if (output.length > MAX_DIRECT_OUTPUT_CHARS) {
          return `Error: Command output too large (${output.length.toLocaleString()} chars). ` +
            `Re-run with run_in_background=true, then use read_file with start_line=-200 to read the end of the output file.`;
        }
        return output;
      } catch (error) {
        if (error instanceof Error) {
          const execError = error as Error & { stdout?: string; stderr?: string; status?: number };
          const parts: string[] = [];
          if (execError.status !== undefined) parts.push(`Exit code: ${execError.status}`);
          if (execError.stdout) parts.push(`stdout:\n${execError.stdout}`);
          if (execError.stderr) parts.push(`stderr:\n${execError.stderr}`);
          const output = parts.length > 0 ? parts.join('\n\n') : error.message;
          if (output.length > MAX_DIRECT_OUTPUT_CHARS) {
            // For errors, include exit code and tail of output
            const exitInfo = execError.status !== undefined ? `Exit code: ${execError.status}\n\n` : '';
            return `${exitInfo}Error: Command output too large (${output.length.toLocaleString()} chars). ` +
              `Re-run with run_in_background=true, then use read_file with start_line=-200 to read the end of the output file.`;
          }
          return output;
        }
        return `Error: ${String(error)}`;
      }
    },
  });
}

function createReadFileTool(ctx: ScorerContext): ToolWithFunc {
  const schema = z.object({
    path: z.string().describe(
      'Path to file. Relative paths are resolved from the workspace root. ' +
      'Absolute paths (e.g., /tmp/bg-process-1.log, /bunsen/run/workspace/diff.patch) are used as-is.'
    ),
    start_line: z.number().optional().describe(
      'First line to read (1-indexed). Negative values count from end: -100 means last 100 lines. ' +
      'Omit to start from beginning.'
    ),
    end_line: z.number().optional().describe(
      'Last line to read (1-indexed, inclusive). Omit to read to end of file.'
    ),
  });

  // Max lines to return without an explicit range
  const MAX_LINES_WITHOUT_RANGE = 2000;

  return tool({
    name: 'read_file',
    description:
      'Read a file or a range of lines from a file. Works with workspace files (relative paths), ' +
      'command output files (/tmp/...), diffs (/bunsen/run/workspace/diff.patch), and logs (/bunsen/run/logs.txt). ' +
      'For large files, specify start_line/end_line. Use start_line=-N to read the last N lines.',
    schema,
    func: (input: z.infer<typeof schema>): string => {
      // Resolve path: relative = workspace, absolute = as-is
      const fullPath = input.path.startsWith('/')
        ? input.path
        : path.join(ctx.workspacePath, input.path);

      if (!fs.existsSync(fullPath)) {
        return `Error: File not found: ${input.path}`;
      }

      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        const totalLines = lines.length;

        // If no range specified and file is too large, return error with guidance
        if (input.start_line === undefined && input.end_line === undefined) {
          if (totalLines > MAX_LINES_WITHOUT_RANGE) {
            return `Error: File is too large (${totalLines.toLocaleString()} lines). ` +
              `Specify a line range: use start_line and end_line to read a portion, ` +
              `or start_line=-200 to read the last 200 lines.`;
          }
          return content;
        }

        // Resolve start_line
        let start: number;
        if (input.start_line !== undefined) {
          if (input.start_line < 0) {
            // Negative: count from end
            start = Math.max(0, totalLines + input.start_line);
          } else {
            start = Math.max(0, input.start_line - 1); // Convert 1-indexed to 0-indexed
          }
        } else {
          start = 0;
        }

        // Resolve end_line
        let end: number;
        if (input.end_line !== undefined) {
          end = Math.min(totalLines, input.end_line); // 1-indexed inclusive
        } else {
          end = totalLines;
        }

        const selectedLines = lines.slice(start, end);
        const header = `[Lines ${start + 1}-${end} of ${totalLines}]\n`;
        return header + selectedLines.join('\n');
      } catch (error) {
        return `Error reading file: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}

function createListFilesTool(ctx: ScorerContext): ToolWithFunc {
  const schema = z.object({
    path: z.string().optional().default('.').describe(
      'Directory path (relative to workspace root, or absolute)'
    ),
  });

  return tool({
    name: 'list_files',
    description: 'List files in a directory.',
    schema,
    func: (input: z.infer<typeof schema>): string => {
      const fullPath = input.path.startsWith('/')
        ? input.path
        : path.join(ctx.workspacePath, input.path);
      if (!fs.existsSync(fullPath)) {
        return `Error: Directory not found: ${input.path}`;
      }
      try {
        const entries = fs.readdirSync(fullPath, { withFileTypes: true });
        return entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .join('\n');
      } catch (error) {
        return `Error listing directory: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}

// ----------------------------------------------------------------------------
// Trace-navigation tools — let the agent walk a multi-thread, possibly very
// long, conversation history without trying to load the whole thing at once.
// ----------------------------------------------------------------------------

function createListThreadsTool(ctx: ScorerContext): ToolWithFunc {
  const schema = z.object({});
  return tool({
    name: 'list_threads',
    description:
      'List the agent-under-test conversation threads captured during the run, with per-thread context (model, system prompt summary, turn count, token totals). Use this first to see what threads exist before reading their turns.',
    schema,
    func: (): string => {
      const index = loadThreadsIndex(ctx.contextDir);
      if (!index || index.threads.length === 0) {
        return 'No agent traces captured for this run.';
      }
      const lines: string[] = [];
      lines.push(`Run summary: ${index.summary.totalCalls} calls, ${index.summary.threadCount} thread(s), ${index.summary.totalInputTokens} in / ${index.summary.totalOutputTokens} out tokens, $${index.summary.estimatedCostUsd.toFixed(4)}.`);
      lines.push('');
      for (const thread of index.threads) {
        lines.push(`- ${thread.threadId} — ${thread.context.provider}/${thread.context.model}, ${thread.turnCount} turns, $${thread.stats.estimatedCostUsd.toFixed(4)}`);
        if (thread.context.systemPrompt) {
          const sp = thread.context.systemPrompt.length > 200
            ? thread.context.systemPrompt.slice(0, 200) + '...'
            : thread.context.systemPrompt;
          lines.push(`    system: ${sp.replace(/\n/g, ' ')}`);
        }
      }
      return lines.join('\n');
    },
  });
}

function createReadThreadTurnsTool(ctx: ScorerContext): ToolWithFunc {
  const schema = z.object({
    thread_id: z.string().describe('Thread identifier from list_threads (e.g. "thread-1").'),
    start: z.number().optional().describe('First turn index to include (0-based, inclusive). Defaults to 0.'),
    end: z.number().optional().describe('One past the last turn index to include. Defaults to all remaining turns. Reads are bounded — large slices return an error suggesting a smaller range.'),
  });

  const MAX_TURNS_PER_READ = 30;
  const MAX_CHARS_PER_READ = 100_000;

  return tool({
    name: 'read_thread_turns',
    description:
      'Read a slice of conversation turns from a thread. Each turn includes only the new messages relative to the previous turn (the runtime deduplicates re-sent history). Pair with list_threads to discover thread IDs and turn counts.',
    schema,
    func: (input: z.infer<typeof schema>): string => {
      const index = loadThreadsIndex(ctx.contextDir);
      const indexEntry = index?.threads.find((t) => t.threadId === input.thread_id);
      if (!indexEntry) {
        return `Error: thread "${input.thread_id}" not found. Use list_threads to see available threads.`;
      }
      const start = input.start ?? 0;
      const requestedEnd = input.end ?? indexEntry.turnCount;
      const end = Math.min(requestedEnd, indexEntry.turnCount);
      if (end - start > MAX_TURNS_PER_READ) {
        return `Error: requested ${end - start} turns; max ${MAX_TURNS_PER_READ} per call. Read a narrower range and call again.`;
      }
      const turns = loadThreadTurns(ctx.contextDir, input.thread_id, start, end);
      const payload = JSON.stringify({ threadId: input.thread_id, turnCount: indexEntry.turnCount, range: { start, end }, turns }, null, 2);
      if (payload.length > MAX_CHARS_PER_READ) {
        return `Error: response exceeded ${MAX_CHARS_PER_READ.toLocaleString()} chars (${payload.length.toLocaleString()}). Read a narrower range and call again.`;
      }
      return payload;
    },
  });
}

// =============================================================================
// Screenshot tool for visual scorer (uses Playwright)
// =============================================================================

interface ScreenshotState {
  screenshots: Array<{ url: string; base64: string }>;
  savedPaths: string[];  // Paths to saved screenshot files (relative to screenshots dir)
  browser: import('playwright').Browser | null;
}

/**
 * Convert criterion name to a filesystem-safe slug
 */
function slugifyCriterion(criterion: string): string {
  return criterion
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function createScreenshotTool(
  ctx: ScorerContext,
  screenshotState: ScreenshotState
): Promise<ToolWithFunc> {
  const schema = z.object({
    url: z.string().describe('URL to navigate to and capture (e.g., http://localhost:3000)'),
    fullPage: z.boolean().optional().default(false).describe('Capture full page scroll'),
    viewport: z
      .object({
        width: z.number().optional().default(1280),
        height: z.number().optional().default(720),
      })
      .optional()
      .describe('Viewport size for the screenshot'),
    waitForSelector: z.string().optional().describe('CSS selector to wait for before capturing'),
    delay: z.number().optional().default(1000).describe('Delay in ms before taking screenshot'),
  });

  return tool({
    name: 'screenshot',
    description:
      'Take a screenshot of a running web application. Start the dev server first if needed. The screenshot will be included in your conversation so you can analyze it visually.',
    schema,
    func: async (input: z.infer<typeof schema>): Promise<string> => {
      try {
        // Load Playwright from global modules (SEA can't use dynamic imports)
        // Try multiple paths where Playwright might be installed
        let chromium: typeof import('playwright').chromium | undefined;
        const playwrightPaths = [
          '/usr/lib/node_modules/playwright',  // npm install -g on Linux
          '/usr/local/lib/node_modules/playwright',  // alternative global path
          'playwright',  // fallback to normal resolution
        ];

        for (const pwPath of playwrightPaths) {
          try {
            const require = createRequire(import.meta.url);
            const pw = require(pwPath);
            chromium = pw.chromium;
            break;
          } catch {
            continue;
          }
        }

        if (!chromium) {
          // Last resort: try dynamic import (works in non-SEA contexts)
          const pw = await import('playwright');
          chromium = pw.chromium;
        }

        if (!chromium) {
          throw new Error('Could not load Playwright from any known path');
        }

        // Launch browser if not already running
        if (!screenshotState.browser) {
          screenshotState.browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
          });
        }

        const page = await screenshotState.browser.newPage({
          viewport: {
            width: input.viewport?.width || 1280,
            height: input.viewport?.height || 720,
          },
        });

        try {
          // Navigate to URL with timeout
          await page.goto(input.url, { timeout: 30000, waitUntil: 'networkidle' });

          // Wait for specific selector if requested
          if (input.waitForSelector) {
            await page.waitForSelector(input.waitForSelector, { timeout: 10000 });
          }

          // Wait additional delay for dynamic content
          if (input.delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, input.delay));
          }

          // Take screenshot
          const screenshotBuffer = await page.screenshot({
            fullPage: input.fullPage,
            type: 'png',
          });

          const base64 = screenshotBuffer.toString('base64');

          // Store for later use in conversation
          screenshotState.screenshots.push({ url: input.url, base64 });

          // Save screenshot to disk (use scorer output dir which is writable)
          const screenshotsDir = path.join(SCORER_OUTPUT_DIR, 'screenshots');
          fs.mkdirSync(screenshotsDir, { recursive: true });

          const criterionSlug = slugifyCriterion(ctx.config.criterion);
          const sequenceNum = screenshotState.savedPaths.length + 1;
          const filename = `${criterionSlug}-${sequenceNum}.png`;
          const filepath = path.join(screenshotsDir, filename);

          fs.writeFileSync(filepath, screenshotBuffer);
          screenshotState.savedPaths.push(filename);

          console.error(`[screenshot] Saved to ${filepath}`);

          return `Screenshot captured and saved as ${filename} (${screenshotState.screenshots.length} total). The image will be included in your next message for visual analysis.`;
        } finally {
          await page.close();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('Executable doesn\'t exist') || message.includes('browserType.launch')) {
          return `Error: Playwright browsers not installed. Run 'npx playwright install chromium' in the container. Original error: ${message}`;
        }
        return `Error taking screenshot: ${message}`;
      }
    },
  });
}

/**
 * Create a tool for running arbitrary Playwright scripts
 * Allows the visual scorer to perform browser interactions like clicks, typing, hovering, etc.
 */
async function createRunPlaywrightScriptTool(
  ctx: ScorerContext,
  screenshotState: ScreenshotState
): Promise<ToolWithFunc> {
  const schema = z.object({
    code: z.string().describe(
      'JavaScript code to execute. Available: `page` (Playwright Page), ' +
      '`browser` (Browser), `screenshot(options?)` to capture screenshots. ' +
      'Code runs as async function body.'
    ),
    timeout: z.number().optional().default(60000).describe('Max execution time in ms'),
    viewport: z.object({
      width: z.number().optional().default(1280),
      height: z.number().optional().default(720),
    }).optional(),
    url: z.string().optional().describe('URL to navigate to before executing script'),
  });

  return tool({
    name: 'run_playwright_script',
    description:
      'Execute Playwright JavaScript for browser interactions. ' +
      'Use for clicking, typing, hovering, mouse movements, etc.',
    schema,
    func: async (input: z.infer<typeof schema>): Promise<string> => {
      // Load Playwright (same logic as screenshot tool)
      let chromium: typeof import('playwright').chromium | undefined;
      const playwrightPaths = [
        '/usr/lib/node_modules/playwright',
        '/usr/local/lib/node_modules/playwright',
        'playwright',
      ];

      for (const pwPath of playwrightPaths) {
        try {
          const require = createRequire(import.meta.url);
          const pw = require(pwPath);
          chromium = pw.chromium;
          break;
        } catch {
          continue;
        }
      }

      if (!chromium) {
        try {
          const pw = await import('playwright');
          chromium = pw.chromium;
        } catch {
          // Will throw below
        }
      }

      if (!chromium) {
        return JSON.stringify({
          success: false,
          error: 'Could not load Playwright from any known path',
          screenshotCount: 0,
          consoleOutput: [],
        });
      }

      // Launch browser if not already running
      if (!screenshotState.browser) {
        screenshotState.browser = await chromium.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
      }

      const viewportWidth = input.viewport?.width || 1280;
      const viewportHeight = input.viewport?.height || 720;
      const page = await screenshotState.browser.newPage({
        viewport: { width: viewportWidth, height: viewportHeight },
      });

      const consoleOutput: string[] = [];
      let screenshotCountBefore = screenshotState.screenshots.length;

      try {
        // Navigate to URL if specified
        if (input.url) {
          await page.goto(input.url, { timeout: 30000, waitUntil: 'networkidle' });
        }

        // Create screenshot helper function
        const screenshot = async (options?: { fullPage?: boolean; delay?: number }) => {
          if (options?.delay && options.delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, options.delay));
          }

          const screenshotBuffer = await page.screenshot({
            fullPage: options?.fullPage || false,
            type: 'png',
          });

          const base64 = screenshotBuffer.toString('base64');
          const currentUrl = page.url();

          // Store for conversation
          screenshotState.screenshots.push({ url: currentUrl, base64 });

          // Save to disk
          // Save to scorer output dir (writable)
          const screenshotsDir = path.join(SCORER_OUTPUT_DIR, 'screenshots');
          fs.mkdirSync(screenshotsDir, { recursive: true });

          const criterionSlug = slugifyCriterion(ctx.config.criterion);
          const sequenceNum = screenshotState.savedPaths.length + 1;
          const filename = `${criterionSlug}-${sequenceNum}.png`;
          const filepath = path.join(screenshotsDir, filename);

          fs.writeFileSync(filepath, screenshotBuffer);
          screenshotState.savedPaths.push(filename);

          console.error(`[run_playwright_script] Screenshot saved: ${filename}`);
          return filename;
        };

        // Create mock console for capturing output
        const mockConsole = {
          log: (...args: unknown[]) => {
            const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
            consoleOutput.push(msg);
            console.error(`[script console.log] ${msg}`);
          },
          error: (...args: unknown[]) => {
            const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
            consoleOutput.push(`[error] ${msg}`);
            console.error(`[script console.error] ${msg}`);
          },
          warn: (...args: unknown[]) => {
            const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
            consoleOutput.push(`[warn] ${msg}`);
            console.error(`[script console.warn] ${msg}`);
          },
        };

        // Execute the code with timeout
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
        const fn = new AsyncFunction('page', 'browser', 'screenshot', 'console', input.code);

        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Script execution timed out after ${input.timeout}ms`)), input.timeout);
        });

        const result = await Promise.race([
          fn(page, screenshotState.browser, screenshot, mockConsole),
          timeoutPromise,
        ]);

        const screenshotsTaken = screenshotState.screenshots.length - screenshotCountBefore;

        return JSON.stringify({
          success: true,
          screenshotCount: screenshotsTaken,
          consoleOutput,
          returnValue: result !== undefined ? result : null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const screenshotsTaken = screenshotState.screenshots.length - screenshotCountBefore;

        return JSON.stringify({
          success: false,
          error: message,
          screenshotCount: screenshotsTaken,
          consoleOutput,
        });
      } finally {
        await page.close();
      }
    },
  });
}

async function cleanupScreenshotState(screenshotState: ScreenshotState): Promise<void> {
  if (screenshotState.browser) {
    try {
      await screenshotState.browser.close();
    } catch {
      // Ignore cleanup errors
    }
    screenshotState.browser = null;
  }
}

// =============================================================================
// Agentic scorer
// =============================================================================

async function runAgenticScorer(
  config: ScorerConfig,
  apiKey: string
): Promise<ScorerOutput> {
  const state: ScorerState = { score: null, summary: null, report: null, done: false, submitted: false };
  const ctx: ScorerContext = {
    config,
    contextDir: config.contextDir,
    workspacePath: config.workspacePath,
  };

  const tools: ToolWithFunc[] = [
    createSubmitScoreTool(state),
    createRunCommandTool(ctx),
    createReadFileTool(ctx),
    createListFilesTool(ctx),
    createListThreadsTool(ctx),
    createReadThreadTurnsTool(ctx),
  ];

  const systemPrompt = buildAgenticScorerSystemPrompt(config);
  const userPrompt = buildAgenticInitialPrompt(config);

  const agent = createAgent({
    model: config.model || 'claude-sonnet-4-6',
    tools,
    system: systemPrompt,
    apiKey,
    temperature: 0,
  });

  await agent.runTools([{ role: 'user', content: userPrompt }]);

  if (!state.done || state.summary === null) {
    throw new Error('Scorer did not submit evaluation');
  }

  return {
    score: state.score,
    summary: state.summary,
    report: state.report || undefined,
  };
}

// =============================================================================
// Report scorer
// =============================================================================

async function runReportScorer(
  config: ScorerConfig,
  apiKey: string
): Promise<ScorerOutput> {
  const state: ScorerState = { score: null, summary: null, report: null, done: false, submitted: false };
  const ctx: ScorerContext = {
    config,
    contextDir: config.contextDir,
    workspacePath: config.workspacePath,
  };

  const tools: ToolWithFunc[] = [
    createSubmitScoreTool(state),
    createRunCommandTool(ctx),
    createReadFileTool(ctx),
    createListFilesTool(ctx),
    createListThreadsTool(ctx),
    createReadThreadTurnsTool(ctx),
  ];

  const systemPrompt = buildReportScorerSystemPrompt(config);
  const userPrompt = buildReportInitialPrompt(config.dependencyScores || {});

  const agent = createAgent({
    model: config.model || 'claude-sonnet-4-6',
    tools,
    system: systemPrompt,
    apiKey,
    temperature: 0,
  });

  await agent.runTools([{ role: 'user', content: userPrompt }]);

  if (!state.done || state.summary === null) {
    throw new Error('Report scorer did not submit evaluation');
  }

  return {
    score: null, // Reports don't have a score
    summary: state.summary,
    report: state.report || undefined,
  };
}

// =============================================================================
// Visual scorer (with Playwright screenshot support)
// Hand-rolled native Anthropic loop (vision support via image content blocks)
// =============================================================================

async function runVisualScorer(
  config: ScorerConfig,
  apiKey: string
): Promise<ScorerOutput> {
  const state: ScorerState = { score: null, summary: null, report: null, done: false, submitted: false };
  const ctx: ScorerContext = {
    config,
    contextDir: config.contextDir,
    workspacePath: config.workspacePath,
  };

  // Screenshot state for tracking captured images
  const screenshotState: ScreenshotState = {
    screenshots: [],
    savedPaths: [],
    browser: null,
  };

  try {
    const screenshotTool = await createScreenshotTool(ctx, screenshotState);
    const playwrightScriptTool = await createRunPlaywrightScriptTool(ctx, screenshotState);

    const tools: ToolWithFunc[] = [
      createSubmitScoreTool(state),
      screenshotTool,
      playwrightScriptTool,
      createRunCommandTool(ctx),
      createReadFileTool(ctx),
      createListFilesTool(ctx),
      createListThreadsTool(ctx),
      createReadThreadTurnsTool(ctx),
    ];

    const systemPrompt = buildVisualScorerSystemPrompt(config);
    const userPrompt = buildAgenticInitialPrompt(config);

    // Create client
    const client = createAnthropicClient(apiKey);

    // Tool definitions are already native Anthropic tools
    const anthropicTools = tools.map((t) => t.definition);

    // Create tool lookup
    const toolFuncs = new Map(tools.map((t) => [t.definition.name, t.func]));

    // Native Anthropic message history
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userPrompt }];

    // Run agent loop with vision support
    const maxTurns = 70;
    let lastStopReason: string | null = null;
    let completedTurns = 0;
    for (let turn = 0; turn < maxTurns && !state.done; turn++) {
      completedTurns = turn + 1;
      console.error(`[visual-scorer] Turn ${turn + 1}/${maxTurns}`);

      // Make API call
      const response = await client.messages.create({
        model: config.model || 'claude-sonnet-4-6',
        max_tokens: 4096,
        temperature: 0,
        system: systemPrompt,
        tools: anthropicTools,
        messages,
      });

      lastStopReason = response.stop_reason;

      // Add the assistant response to history verbatim
      messages.push({ role: 'assistant', content: response.content });

      // Check for tool use in the response
      const toolCalls = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
      );

      if (toolCalls.length === 0) {
        // No tool calls, check if done
        if (response.stop_reason === 'end_turn') {
          // Log the assistant's final text response
          const textBlocks = response.content.filter(
            (block): block is Anthropic.TextBlock => block.type === 'text'
          );
          if (textBlocks.length > 0) {
            console.error(`[visual-scorer] Assistant ended without tool call. Text: ${textBlocks.map(b => b.text).join(' ').slice(0, 500)}`);
          }
          break;
        }
        continue;
      }

      // Log tool calls and any assistant reasoning/text
      const textBlocks = response.content.filter(
        (block): block is Anthropic.TextBlock => block.type === 'text'
      );
      if (textBlocks.length > 0) {
        const text = textBlocks.map(b => b.text).join(' ');
        console.error(`[visual-scorer] Assistant: ${text.slice(0, 300)}${text.length > 300 ? '...' : ''}`);
      }
      console.error(`[visual-scorer] Tool calls: ${toolCalls.map(t => t.name).join(', ')}`);

      // Execute tools and build native tool_result blocks. Tool results and any
      // screenshots captured this turn go back in a single user message —
      // Anthropic requires tool_result blocks to lead that message.
      const userContent: Anthropic.ContentBlockParam[] = [];

      for (const toolCall of toolCalls) {
        const func = toolFuncs.get(toolCall.name);
        if (!func) {
          const errorOutput = `Error: Unknown tool ${toolCall.name}`;
          console.error(`[visual-scorer] ${toolCall.name} result: ${errorOutput}`);
          userContent.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: errorOutput,
            is_error: true,
          });
          continue;
        }

        try {
          const result = await func(toolCall.input);
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
          // Log truncated result
          console.error(`[visual-scorer] ${toolCall.name} result: ${resultStr.slice(0, 200)}${resultStr.length > 200 ? '...' : ''}`);
          userContent.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: resultStr,
          });
        } catch (error) {
          const errorOutput = `Error: ${error instanceof Error ? error.message : String(error)}`;
          console.error(`[visual-scorer] ${toolCall.name} result: ${errorOutput}`);
          userContent.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: errorOutput,
            is_error: true,
          });
        }
      }

      // Append any screenshots captured during this turn as image blocks
      if (screenshotState.screenshots.length > 0) {
        for (const screenshot of screenshotState.screenshots) {
          userContent.push({
            type: 'text',
            text: `\n[Screenshot of ${screenshot.url}]:`,
          });
          userContent.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: screenshot.base64,
            },
          });
        }
        // Clear screenshots after including them
        screenshotState.screenshots = [];
      }

      messages.push({ role: 'user', content: userContent });
    }

    // If loop ended without submission, force a final submission call
    if (!state.submitted) {
      const reason = completedTurns >= maxTurns
        ? `reached max turns (${maxTurns})`
        : `stopped early (stop_reason: ${lastStopReason}, turns: ${completedTurns})`;
      console.error(`[visual-scorer] Loop ended without submission: ${reason}. Forcing submit_score call.`);

      // Make one final API call with forced tool choice
      const forcedResponse = await client.messages.create({
        model: config.model || 'claude-sonnet-4-6',
        max_tokens: 4096,
        temperature: 0,
        system: systemPrompt + '\n\nIMPORTANT: You must now submit your evaluation immediately using submit_score. Based on everything you have observed, provide your best assessment. If you could not evaluate properly, submit score 0 with an explanation.',
        tools: anthropicTools,
        messages,
        tool_choice: { type: 'tool', name: 'submit_score' },
      });

      // Find and execute the forced submit_score call
      const forcedToolCall = forcedResponse.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === 'submit_score'
      );

      if (forcedToolCall) {
        console.error(`[visual-scorer] Forced submit_score with input: ${JSON.stringify(forcedToolCall.input).slice(0, 200)}`);
        const submitFunc = toolFuncs.get('submit_score');
        if (submitFunc) {
          await submitFunc(forcedToolCall.input);
        }
      }

      // If still not submitted, throw error
      if (!state.submitted) {
        throw new Error(`Visual scorer did not submit evaluation even after forced tool_choice: ${reason}`);
      }
    }

    // At this point, submission is guaranteed - just need to satisfy TypeScript
    if (state.summary === null) {
      throw new Error('Visual scorer submitted but summary is null (should not happen)');
    }

    return {
      score: state.score,
      summary: state.summary,
      report: state.report || undefined,
      screenshots: screenshotState.savedPaths.length > 0 ? screenshotState.savedPaths : undefined,
    };
  } finally {
    // Cleanup browser
    await cleanupScreenshotState(screenshotState);
  }
}

// =============================================================================
// Main
// =============================================================================

function parseArgs(): { configPath: string } {
  const args = process.argv.slice(2);
  let configPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) {
      configPath = args[i + 1];
      i++;
    }
  }

  if (!configPath) {
    console.error('Usage: scorer --config <path-to-config.json>');
    process.exit(1);
  }

  return { configPath };
}

async function main(): Promise<void> {
  const apiKey = process.env.BUNSEN_ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Error: BUNSEN_ANTHROPIC_API_KEY environment variable is required');
    process.exit(1);
  }

  const { configPath } = parseArgs();

  // Load configuration
  let config: ScorerConfig;
  try {
    const configContent = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(configContent);
  } catch (error) {
    console.error(`Error loading config from ${configPath}:`, error);
    process.exit(1);
  }

  console.error(`Scoring criterion: ${config.criterion}`);
  console.error(`  Type: ${config.type}`);
  console.error(`  Context: ${config.contextDir}`);
  console.error(`  Workspace: ${config.workspacePath}`);

  let result: ScorerOutput;

  switch (config.type) {
    case 'aggregate':
      result = runAggregateScorer(config);
      break;

    case 'llm':
      result = await runLLMJudgeScorer(config, apiKey);
      break;

    case 'agent':
      result = await runAgenticScorer(config, apiKey);
      break;

    case 'visual':
      result = await runVisualScorer(config, apiKey);
      break;

    case 'report':
      result = await runReportScorer(config, apiKey);
      break;

    default:
      throw new Error(`Unknown scorer type: ${config.type}`);
  }

  // Output result as JSON to stdout
  console.log(JSON.stringify(result));
}

main().catch((error) => {
  console.error('Scoring failed:', error);
  process.exit(1);
});
