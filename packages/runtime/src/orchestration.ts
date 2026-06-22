// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Orchestration helpers used by the executor.
 *
 * Public-API parity:
 *   `OrchestrationResult` is the contract between the orchestrator bundle and
 *   the executor (see `packages/types/src/orchestration.ts`). These helpers
 *   render and validate that contract; they never reinterpret task text
 *   through bash.
 */

import type { OrchestrationResult } from '@bunsen-dev/types';
import type { ResolvedAgent, ResolvedExperiment } from './config.js';

export interface ArgvInvocation {
  command: string;
  args: string[];
}

/**
 * Split an interpreter-style command (`python <script>` / `node <script>`) into
 * the interpreter executable plus the leading argv tokens (the script path,
 * rewritten under `/agent` if relative, then any further tokens). Any other
 * command — a single executable like `claude`, or an absolute path — is
 * returned unchanged with an empty prefix.
 *
 * Shared by the default-invocation builder and the orchestrated path so both
 * handle multi-word interpreter entrypoints identically: a multi-word `command`
 * can never name a real executable, so the orchestrator returning
 * `"python /agent/main.py"` (the model failing to split it) is repaired here the
 * same way the no-LLM path would have built it.
 */
export function splitInterpreterCommand(command: string): {
  command: string;
  argvPrefix: string[];
} {
  if (command.startsWith('python ') || command.startsWith('node ')) {
    const [interpreter, ...rest] = command.split(/\s+/);
    const argvPrefix: string[] = [];
    if (rest.length > 0) {
      const scriptPath = rest[0]!;
      const rewrittenScript = scriptPath.startsWith('/') ? scriptPath : `/agent/${scriptPath}`;
      argvPrefix.push(rewrittenScript, ...rest.slice(1));
    }
    return { command: interpreter!, argvPrefix };
  }
  return { command, argvPrefix: [] };
}

/**
 * Default invocation used when orchestration is skipped. Mirrors the no-LLM
 * path: invoke the agent's entrypoint with the task prompt as the first arg
 * and any additional CLI args appended.
 *
 * If `agent.entrypoint.command` is a bare relative executable like `my-agent`,
 * it is rewritten to `/agent/my-agent`. Interpreter-style entrypoints
 * (`python <script>`, `node <script>`) get the script path rewritten the same
 * way; further tokens after the script become argv elements.
 *
 * No shell escaping happens here — the executor renders the result via
 * {@link renderArgvInvocation} (POSIX single-quoting) so task text reaches
 * the agent verbatim regardless of which metacharacters it contains.
 */
export function buildDefaultArgvInvocation(
  agent: ResolvedAgent,
  experiment: ResolvedExperiment,
  args: string[],
): ArgvInvocation {
  const entrypoint = agent.entrypoint.command;
  const { command: interpreter, argvPrefix } = splitInterpreterCommand(entrypoint);

  let command: string;
  if (interpreter !== entrypoint) {
    // Interpreter-style entrypoint: already split into interpreter + script.
    command = interpreter;
  } else if (entrypoint.startsWith('/')) {
    command = entrypoint;
  } else {
    command = `/agent/${entrypoint}`;
  }

  return {
    command,
    args: [...argvPrefix, experiment.task.prompt, ...args],
  };
}

/**
 * Render an argv invocation as a shell command line by single-quoting each
 * token. POSIX single-quote escaping is sufficient and bash-compatible: the
 * only character that cannot appear inside `'…'` is a literal `'`, which we
 * encode as `'\''`. So task text containing backticks, dollar signs, double
 * quotes, backslashes, and newlines all reach the agent verbatim with no
 * shell reinterpretation.
 */
export function renderArgvInvocation(invocation: ArgvInvocation): string {
  return [invocation.command, ...invocation.args].map(shellSingleQuote).join(' ');
}

export function shellSingleQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * Human-readable rendering of an argv invocation. Quotes only tokens that
 * actually need it (whitespace, shell metacharacters, or embedded quotes).
 * Multiline tokens get their newlines collapsed to a `↵` glyph so a long
 * task prompt does not visually break the displayed command line.
 *
 * Display-only — never feed this back into a shell. Use {@link
 * renderArgvInvocation} when composing the actual agent script.
 */
export function formatInvocationForLog(invocation: ArgvInvocation): string {
  return [invocation.command, ...invocation.args].map(displayQuote).join(' ');
}

function displayQuote(token: string): string {
  const collapsed = token.includes('\n') ? token.replace(/\n/g, '↵') : token;
  // Plain shell-safe identifiers don't need quotes for display.
  if (/^[A-Za-z0-9_+,.\-/:=@%]+$/.test(collapsed)) {
    return collapsed;
  }
  // If the token has no single quotes, single-quote it as one block.
  if (!collapsed.includes("'")) {
    return `'${collapsed}'`;
  }
  // Mixed-quote token: prefer double-quotes if no shell-active chars are
  // present, otherwise fall back to escaped single quotes (still display-only).
  if (!/[$`"\\]/.test(collapsed)) {
    return `"${collapsed}"`;
  }
  return `'${collapsed.replace(/'/g, `'\\''`)}'`;
}

/**
 * Parse and shape-validate the JSON the orchestrator bundle writes to stdout.
 * Throws with a precise reason if any field is missing or the wrong type —
 * we never want a malformed orchestration to silently miscompose the agent
 * script.
 */
export function parseOrchestrationResult(stdout: string): OrchestrationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new Error(`orchestrator stdout is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`orchestrator result is not an object: ${typeof parsed}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.setupCommands) || !obj.setupCommands.every((c) => typeof c === 'string')) {
    throw new Error(`orchestrator result missing or invalid "setupCommands": expected string[]`);
  }
  if (!obj.invocation || typeof obj.invocation !== 'object') {
    throw new Error(`orchestrator result missing "invocation" object`);
  }
  const inv = obj.invocation as Record<string, unknown>;
  if (typeof inv.command !== 'string' || inv.command.length === 0) {
    throw new Error(`orchestrator result invocation.command must be a non-empty string`);
  }
  if (!Array.isArray(inv.args) || !inv.args.every((a) => typeof a === 'string')) {
    throw new Error(`orchestrator result invocation.args must be string[]`);
  }
  // Repair a multi-word interpreter command (e.g. the model returned
  // "python /agent/main.py" as a single `command` instead of splitting it).
  // A command with whitespace can never name a real executable, so applying the
  // same split the no-LLM path uses can only fix it. Single-token commands
  // (`claude`, `codex`) pass through unchanged.
  const { command, argvPrefix } = splitInterpreterCommand(inv.command);
  return {
    setupCommands: obj.setupCommands as string[],
    invocation: { command, args: [...argvPrefix, ...(inv.args as string[])] },
  };
}
