/**
 * Evidence the scorer reads off disk: the task prompt, the workspace diff, and
 * the agent's logs.
 *
 * These files live in the run context dir that the runtime mounts into the
 * scorer container (`/bunsen/run`). The readers are inlined here rather than
 * imported from `@bunsen-dev/runtime`, which cannot be bundled (see
 * `packages/agents/CLAUDE.md`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { filterLockfilesFromDiff } from '@bunsen-dev/diff-filter';
import { MAX_EVIDENCE_CHARS, MAX_TASK_PROMPT_CHARS } from './config.js';

/** Thousands separators that do not move with the container's locale. */
function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * The one truncation helper in the bundle: keep the head and the tail, and say
 * in the middle what was dropped.
 *
 * Head+tail rather than head-only because the interesting part of a command's
 * output, a log, or a diff is as often at the end as at the start.
 */
export function truncateHeadTail(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text;
  const head = Math.ceil(maxChars / 2);
  const tail = maxChars - head;
  const notice =
    `\n\n... [${label} truncated: ${fmt(text.length)} chars total; ` +
    `showing the first ${fmt(head)} and the last ${fmt(tail)}] ...\n\n`;
  return text.slice(0, head) + notice + text.slice(text.length - tail);
}

function readIfPresent(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * The task the agent was given (`<contextDir>/task/prompt.md`).
 *
 * `null` when the run captured no task prompt. Every scorer type sees this:
 * grading a result without knowing what was asked is guesswork.
 */
export function loadTaskPrompt(contextDir: string): string | null {
  const content = readIfPresent(path.join(contextDir, 'task', 'prompt.md'));
  if (content === null || content.trim() === '') return null;
  return truncateHeadTail(content, MAX_TASK_PROMPT_CHARS, 'task prompt');
}

/**
 * The workspace diff (`<contextDir>/workspace/diff.patch`), with lockfiles
 * filtered out before truncation so they do not eat the budget.
 *
 * `null` means no diff was captured; `''` means the agent changed nothing (or
 * changed only lockfiles) — the two read very differently to an evaluator, so
 * the caller renders them differently.
 */
export function loadDiff(contextDir: string): string | null {
  const content = readIfPresent(path.join(contextDir, 'workspace', 'diff.patch'));
  if (content === null) return null;
  const filtered = filterLockfilesFromDiff(content);
  if (!filtered.trim()) return '';
  return truncateHeadTail(filtered, MAX_EVIDENCE_CHARS, 'diff');
}

/** The agent's stdout and stderr (`<contextDir>/logs.txt`). `null` when absent or empty. */
export function loadLogs(contextDir: string): string | null {
  const content = readIfPresent(path.join(contextDir, 'logs.txt'));
  if (content === null || content === '') return null;
  return truncateHeadTail(content, MAX_EVIDENCE_CHARS, 'logs');
}
