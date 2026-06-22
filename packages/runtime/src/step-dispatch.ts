// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Step dispatcher for `install.configure` and `workspace.setup`.
 *
 * Walks a {@link StepConfig} list and executes each step against a running
 * container. Steps come in two shapes:
 *
 * - `RunStep` (`{ run: <shell> }`): runs the shell command.
 * - `WriteFileStep` (`{ writeFile: <path>, from? | content? }`): drops a file
 *   at the target path using a base64-piped script (no heredoc shell-quoting
 *   risk). See "why we don't call `writeFileInContainer` directly" below.
 *
 * Batching: consecutive `run` steps that share the same effective `as:` user
 * are batched into a single shell invocation so they share shell state (env
 * exports, set -e, etc.) — matching the historical single-script semantics
 * for all-run configure lists. A `writeFile` step OR a change in `as:` breaks
 * the batch.
 *
 * Per-step semantics:
 * - `step.as` overrides {@link StepDispatchOptions.defaultAs} (per-phase
 *   default execution user). When `as: 'user'` lands inside a container that
 *   was set up with a non-root `bunsen` user, the dispatcher hands the script
 *   to `options.wrapAs` so the caller can `su bunsen -c <file>` it.
 * - `step.timeout` (duration string) overrides
 *   {@link StepDispatchOptions.defaultRunTimeoutMs} for run batches (taken as
 *   the max across the batch) and the 30s writeFile default.
 *
 * Why we don't reuse `writeFileInContainer` directly: that helper does
 * `base64 -d > '<absolute-path>'` with single-quoted paths, which prevents
 * shell variable expansion. We want `writeFile: $BUNSEN_AGENT_HOME/...` to
 * expand at execution time, so the target path is embedded in a
 * double-quoted bash assignment (with `\`, `"`, and backtick escaped) and
 * `mkdir -p $(dirname "$TARGET")` runs in the container shell. The base64
 * payload itself is still byte-exact regardless of content — same safety
 * property as `writeFileInContainer`, just adapted for variable expansion in
 * the target.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  StepConfig,
  RunStep,
  WriteFileStep,
  ExecutionUser,
} from '@bunsen-dev/types';
import { parseOptionalDuration } from '@bunsen-dev/types';
import {
  execShellInContainer,
  type PersistentContainer,
} from './container.js';

/**
 * Wrap a script body for execution as the requested user. The dispatcher
 * calls this for every batch / writeFile step it dispatches. The caller
 * decides what to do based on `asUser` and the container's setup — typically:
 *
 * - `asUser: 'root'`: return the script unchanged (container exec runs as
 *   root by default).
 * - `asUser: 'user'` in a container with a non-root `bunsen` user: write the
 *   script to a per-batch temp file and return `su bunsen -c <path>` so it
 *   runs with the user's HOME / PATH / ownership.
 * - `asUser: 'user'` in a container without a non-root user (root-only run):
 *   return the script unchanged (fall back to root).
 *
 * `batchIdx` is a monotonically increasing index across the phase. Use it in
 * temp-script filenames so a mid-phase failure leaves all prior scripts
 * intact for post-mortem inspection (see Polish 3 in `REVIEW.md`).
 */
export type WrapAsFn = (
  script: string,
  asUser: ExecutionUser,
  batchIdx: number,
) => Promise<string> | string;

export interface StepDispatchOptions {
  /** Absolute path to the source directory used to resolve `from:` references. */
  sourceDir: string;
  /** Shell snippet prepended to each batched `run` invocation (e.g. PATH exports). */
  preScript?: string;
  env?: Record<string, string>;
  workdir?: string;
  /**
   * Default timeout (ms) for run batches when no step in the batch specifies
   * `timeout:`. Write steps use a 30s default unless `step.timeout` is set.
   */
  defaultRunTimeoutMs?: number;
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /**
   * Per-phase default execution user. `install.configure` is `'root'`;
   * `workspace.setup` is `'user'`. Per-step `as:` overrides this. Defaults
   * to `'user'` if unset.
   */
  defaultAs?: ExecutionUser;
  /** See {@link WrapAsFn}. Omit when the container's default user matches
   *  every step's `as:` and no wrapping is needed. */
  wrapAs?: WrapAsFn;
  /** Human-readable phase name used in error messages. */
  phaseLabel: string;
}

/**
 * Dispatch a list of steps against a container.
 *
 * Throws on the first failure with an exit-code-tagged message.
 */
export async function dispatchSteps(
  container: PersistentContainer,
  steps: StepConfig[],
  options: StepDispatchOptions,
): Promise<void> {
  const defaultAs: ExecutionUser = options.defaultAs ?? 'user';
  let i = 0;
  let batchIdx = 0;
  while (i < steps.length) {
    const step = steps[i];
    if (isWriteFileStep(step)) {
      const asUser = step.as ?? defaultAs;
      await executeWriteFileStep(container, step, asUser, batchIdx, options);
      batchIdx++;
      i++;
      continue;
    }
    if (isRunStep(step)) {
      const batchAs = step.as ?? defaultAs;
      const batch: RunStep[] = [];
      while (i < steps.length && isRunStep(steps[i])) {
        const next = steps[i] as RunStep;
        if ((next.as ?? defaultAs) !== batchAs) break;
        batch.push(next);
        i++;
      }
      await executeRunBatch(container, batch, batchAs, batchIdx, options);
      batchIdx++;
      continue;
    }
    // Malformed step — neither `run` nor `writeFile`. Loaders reject this at
    // parse time, but programmatically-constructed step arrays (SDK, tests,
    // future codegen) are unguarded.
    throw new Error(
      `${options.phaseLabel}: step at index ${i} must have 'run' or 'writeFile'.`,
    );
  }
}

function isWriteFileStep(step: StepConfig): step is WriteFileStep {
  return 'writeFile' in step;
}

function isRunStep(step: StepConfig): step is RunStep {
  return 'run' in step;
}

async function executeRunBatch(
  container: PersistentContainer,
  batch: RunStep[],
  asUser: ExecutionUser,
  batchIdx: number,
  options: StepDispatchOptions,
): Promise<void> {
  if (batch.length === 0) return;
  const lines = batch.map((step) => step.run);
  const script = options.preScript
    ? [options.preScript, ...lines].join('\n')
    : lines.join('\n');
  const finalScript = options.wrapAs
    ? await options.wrapAs(script, asUser, batchIdx)
    : script;
  const timeoutMs = computeBatchTimeout(batch, options.defaultRunTimeoutMs);
  const result = await execShellInContainer(container, finalScript, {
    env: options.env,
    workdir: options.workdir,
    timeout: timeoutMs,
    onOutput: options.onOutput,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${options.phaseLabel} failed with exit code ${result.exitCode}: ${result.stderr}`,
    );
  }
}

async function executeWriteFileStep(
  container: PersistentContainer,
  step: WriteFileStep,
  asUser: ExecutionUser,
  batchIdx: number,
  options: StepDispatchOptions,
): Promise<void> {
  const content = resolveWriteFileContent(step, options.sourceDir, options.phaseLabel);
  const safeTarget = escapeForDoubleQuotes(step.writeFile);
  const encodedContent = Buffer.from(content, 'utf-8').toString('base64');
  const script = [
    `set -e`,
    `__bunsen_target="${safeTarget}"`,
    `mkdir -p "$(dirname "$__bunsen_target")"`,
    `printf '%s' '${encodedContent}' | base64 -d > "$__bunsen_target"`,
    `chmod 644 "$__bunsen_target"`,
  ].join('\n');
  const finalScript = options.wrapAs
    ? await options.wrapAs(script, asUser, batchIdx)
    : script;
  const timeoutMs = parseOptionalDuration(step.timeout) ?? 30_000;
  const result = await execShellInContainer(container, finalScript, {
    env: options.env,
    workdir: options.workdir,
    timeout: timeoutMs,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${options.phaseLabel} writeFile ${JSON.stringify(step.writeFile)} failed with exit code ${result.exitCode}: ${result.stderr}`,
    );
  }
}

/**
 * Pick the max per-step timeout in a batch (parsed to ms), falling back to
 * the phase-level default when no step in the batch sets one.
 */
function computeBatchTimeout(
  batch: RunStep[],
  defaultMs: number | undefined,
): number | undefined {
  let maxMs = 0;
  for (const step of batch) {
    const ms = parseOptionalDuration(step.timeout);
    if (ms !== undefined && ms > maxMs) maxMs = ms;
  }
  if (maxMs > 0) return maxMs;
  return defaultMs;
}

/**
 * Escape a string so it can safely sit inside a bash double-quoted literal
 * while still allowing `$VAR` expansion. Escapes backslash, double quote,
 * and backtick — leaves `$` alone so `$BUNSEN_AGENT_HOME` etc. expand.
 */
function escapeForDoubleQuotes(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`');
}

/**
 * Resolve a writeFile step's content. For inline `content:`, returns the
 * literal string. For `from:`, reads the file from `sourceDir/from` after a
 * path-safety check that the resolved path stays within `sourceDir`.
 */
export function resolveWriteFileContent(
  step: WriteFileStep,
  sourceDir: string,
  phaseLabel: string,
): string {
  if (step.content !== undefined) return step.content;
  if (step.from === undefined) {
    throw new Error(
      `${phaseLabel} writeFile ${JSON.stringify(step.writeFile)}: must set 'from' or 'content'.`,
    );
  }
  const resolved = path.resolve(sourceDir, step.from);
  const relative = path.relative(sourceDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `${phaseLabel} writeFile ${JSON.stringify(step.writeFile)}: 'from' must be inside the source directory (got ${JSON.stringify(step.from)}).`,
    );
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `${phaseLabel} writeFile ${JSON.stringify(step.writeFile)}: 'from' file not found at ${resolved}.`,
    );
  }
  return fs.readFileSync(resolved, 'utf-8');
}

/**
 * Re-export for callers that need to detect the writeFile shape without
 * importing the type guard.
 */
export { isWriteFileStep, isRunStep };
