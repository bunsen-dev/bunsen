// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Deterministic agent-invocation composer used by the executor.
 *
 * The agent invocation is a pure function of committed config — no model in
 * the invocation path. {@link buildArgvInvocation} composes the argv from the
 * agent's declared `entrypoint` (`command` + `invoke` template + `args`) and
 * the experiment's task prompt. These helpers produce a structured
 * command + argv array so dynamic task text never has to survive shell
 * reinterpretation; {@link renderArgvInvocation} POSIX-single-quotes each
 * token when the invocation is finally rendered into the agent script.
 */

import type { ResolvedAgent, ResolvedExperiment } from './config.js';
import { STABLE_PATHS } from './runtime-contract.js';

export interface ArgvInvocation {
  command: string;
  args: string[];
}

/**
 * Default `entrypoint.invoke` template when the agent omits it: a bare
 * positional prompt. This is what makes an agent with no `invoke` field (the
 * common case) invoke exactly as `<command> <prompt> <args>`.
 */
export const DEFAULT_INVOKE: readonly string[] = ['{prompt}'];

/**
 * Split an interpreter-style command (`python <script>` / `node <script>`) into
 * the interpreter executable plus the leading argv tokens (the script path,
 * rewritten under `/agent` if relative, then any further tokens). Any other
 * command — a single executable like `claude`, or an absolute path — is
 * returned unchanged with an empty prefix.
 *
 * This is what lets an author write `entrypoint.command: "python /agent/main.py"`
 * (a natural, readable string) and still get a correctly structured argv: a
 * multi-word `command` can never name a real executable on its own, so the
 * interpreter and script are separated into distinct argv tokens here.
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
 * Expand an `entrypoint.invoke` template into concrete argv tokens.
 *
 * Substring replacement (not whole-token-only) so both `{prompt}` and
 * `--flag={prompt}` forms work. Values are literal argv tokens — no shell, no
 * escaping. Expansion is a single left-to-right pass so substituted content is
 * never re-scanned: if the task prompt itself contains the literal text
 * `{promptFile}`, expanding a `{prompt}` token does not then re-expand that
 * substring. The agent loader has already validated that only known
 * placeholders appear and at most one kind is used.
 */
export function expandInvokeTemplate(
  invoke: readonly string[],
  ctx: { prompt: string; promptFile: string },
): string[] {
  return invoke.map((token) =>
    token.replace(/\{prompt\}|\{promptFile\}/g, (match) =>
      match === '{prompt}' ? ctx.prompt : ctx.promptFile,
    ),
  );
}

/**
 * Compose the agent invocation deterministically from committed config.
 *
 * The executable and any leading interpreter tokens come from
 * {@link splitInterpreterCommand} (so `python <script>` / `node <script>`
 * entrypoints split correctly and a relative script path is rewritten under
 * `/agent`); a bare command like `codex` or an absolute path is used verbatim
 * and resolves via `PATH` (Bunsen puts `/bunsen/artifacts/bin` on `PATH`). The
 * prompt slot comes from expanding `entrypoint.invoke` (default `["{prompt}"]`),
 * followed by the caller-supplied CLI passthrough args. Guaranteed args
 * (`entrypoint.args` + variant args) are appended by the executor afterwards.
 *
 * No shell escaping happens here — the executor renders the result via
 * {@link renderArgvInvocation} (POSIX single-quoting) so task text reaches the
 * agent verbatim regardless of which metacharacters it contains.
 */
export function buildArgvInvocation(
  agent: ResolvedAgent,
  experiment: ResolvedExperiment,
  cliArgs: string[],
): ArgvInvocation {
  const { command, argvPrefix } = splitInterpreterCommand(agent.entrypoint.command);
  const promptTokens = expandInvokeTemplate(agent.entrypoint.invoke ?? DEFAULT_INVOKE, {
    prompt: experiment.task.prompt,
    promptFile: STABLE_PATHS.taskFile,
  });
  return {
    command,
    args: [...argvPrefix, ...promptTokens, ...cliArgs],
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
