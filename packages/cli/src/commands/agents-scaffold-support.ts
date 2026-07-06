// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Pure support helpers for `bn agents scaffold` (see `agents-scaffold.ts`).
 *
 * Kept separate from the command handler so they can be unit-tested without
 * importing `@bunsen-dev/agents` (which pulls in the Anthropic SDK): the model
 * call lives in the handler; everything deterministic lives here.
 */

import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  splitInterpreterCommand,
  expandInvokeTemplate,
  formatInvocationForLog,
  STABLE_PATHS,
} from '@bunsen-dev/runtime';
import type { Entrypoint } from '@bunsen-dev/types';

/** Marker embedded in the comment we write, used to recognize (and replace) our own line on re-runs. */
export const SCAFFOLD_COMMENT_MARKER = 'bn agents scaffold';

/**
 * Render an `invoke` template as a YAML flow sequence. Each token is
 * double-quoted (JSON string form, a subset of YAML) so `{prompt}` is never
 * misread as a flow mapping and metacharacters stay literal.
 */
export function formatInvokeFlow(invoke: string[]): string {
  if (invoke.length === 0) return '[]';
  return `[${invoke.map((t) => JSON.stringify(t)).join(', ')}]`;
}

export interface SpliceResult {
  text: string;
  action: 'inserted' | 'replaced';
}

/**
 * Surgically insert (or, on `--force`, replace) an `invoke:` line inside the
 * `entrypoint:` block of an agent.yaml, preserving all surrounding comments and
 * formatting so the write lands as a clean, reviewable diff.
 *
 * - No existing `invoke:` → insert `invoke: <flow>` (with the comment above it)
 *   immediately after the `command:` line.
 * - Existing `invoke:` → replace that key (and any block-sequence continuation
 *   lines, plus a preceding scaffold-generated comment) in place.
 *
 * Throws if `entrypoint:` isn't a block-style mapping (the exotic flow-mapping
 * form is left for the author to edit by hand).
 */
export function spliceInvokeIntoAgentYaml(
  raw: string,
  invoke: string[],
  opts: { comment?: string } = {},
): SpliceResult {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);

  const entrypointIdx = lines.findIndex((l) => /^entrypoint:[ \t]*(#.*)?$/.test(l));
  if (entrypointIdx === -1) {
    throw new Error(
      'Could not find a block-style `entrypoint:` mapping in agent.yaml — add `invoke` by hand.',
    );
  }

  // Walk the entrypoint block: find the child indent and where the block ends
  // (the next line at top-level indent). Blank/comment lines never end a block.
  let childIndent: string | null = null;
  let blockEnd = lines.length;
  for (let i = entrypointIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '' || /^[ \t]*#/.test(line)) continue;
    const indent = /^([ \t]*)/.exec(line)![1]!;
    if (indent.length === 0) {
      blockEnd = i;
      break;
    }
    if (childIndent === null) childIndent = indent;
  }
  if (childIndent === null) childIndent = '  ';

  const flow = formatInvokeFlow(invoke);
  const insertLines: string[] = [];
  if (opts.comment) insertLines.push(`${childIndent}# ${opts.comment}`);
  insertLines.push(`${childIndent}invoke: ${flow}`);

  const childKeyPrefix = `${childIndent}`;
  const isChildKey = (line: string, key: string): boolean =>
    line.startsWith(`${childKeyPrefix}${key}:`) &&
    // Ensure exact child indent (not a deeper-nested key that happens to share the prefix).
    /^[ \t]*/.exec(line)![0] === childIndent;

  // Existing invoke child?
  let invokeIdx = -1;
  for (let i = entrypointIdx + 1; i < blockEnd; i++) {
    if (isChildKey(lines[i]!, 'invoke')) {
      invokeIdx = i;
      break;
    }
  }

  if (invokeIdx !== -1) {
    // Replace: drop the invoke key + its full value (inline flow, a block
    // sequence at the same OR a deeper indent, or a block scalar), plus a
    // preceding scaffold comment if present.
    let start = invokeIdx;
    if (
      start > entrypointIdx + 1 &&
      /^[ \t]*#/.test(lines[start - 1]!) &&
      lines[start - 1]!.includes(SCAFFOLD_COMMENT_MARKER)
    ) {
      start -= 1;
    }
    const end = blockChildValueEndIndex(lines, invokeIdx, childIndent, blockEnd);
    lines.splice(start, end - start, ...insertLines);
    return { text: lines.join(eol), action: 'replaced' };
  }

  // Insert after the command line AND its full value (a block-scalar `command`
  // spans several lines), or, failing that, as the first block child.
  let commandIdx = -1;
  for (let i = entrypointIdx + 1; i < blockEnd; i++) {
    if (isChildKey(lines[i]!, 'command')) {
      commandIdx = i;
      break;
    }
  }
  const insertAt =
    commandIdx !== -1
      ? blockChildValueEndIndex(lines, commandIdx, childIndent, blockEnd)
      : entrypointIdx + 1;
  lines.splice(insertAt, 0, ...insertLines);
  return { text: lines.join(eol), action: 'inserted' };
}

/**
 * Index one past the full value of the block-mapping child at `keyIdx`.
 * Consumes the key's continuation lines: any line more indented than the key (a
 * block scalar, nested mapping, or deeper block-sequence items) and
 * block-sequence items at the SAME indent as the key (`- item`, a valid and
 * common YAML style). Stops at the first sibling key, comment, blank line, or
 * dedent — so replacing/inserting around the key never orphans its value lines.
 */
function blockChildValueEndIndex(
  lines: string[],
  keyIdx: number,
  childIndent: string,
  blockEnd: number,
): number {
  let end = keyIdx + 1;
  while (end < blockEnd) {
    const line = lines[end]!;
    if (line.trim() === '') break;
    const indent = /^([ \t]*)/.exec(line)![1]!;
    if (indent.length > childIndent.length) {
      end += 1; // deeper: block scalar / nested mapping / deeper sequence item
      continue;
    }
    if (indent.length === childIndent.length && line.slice(childIndent.length).startsWith('- ')) {
      end += 1; // block-sequence item at the same indent as the key
      continue;
    }
    break; // sibling key, comment, or dedent
  }
  return end;
}

/**
 * Whether agent.yaml uses a block-style `entrypoint:` mapping that
 * {@link spliceInvokeIntoAgentYaml} can edit. A flow-style
 * `entrypoint: { … }` returns false — callers should fail fast with a typed
 * error rather than spend a model call and then hit the splice throw.
 */
export function hasBlockStyleEntrypoint(raw: string): boolean {
  return raw.split(/\r?\n/).some((l) => /^entrypoint:[ \t]*(#.*)?$/.test(l));
}

// ---------------------------------------------------------------------------
// Host `--help` capture (best-effort)
// ---------------------------------------------------------------------------

export interface HostHelpPlan {
  /** Executable to verify on PATH before running anything. */
  executable: string;
  /** The shell command run to print help. */
  command: string;
  /**
   * For an interpreter form (`python <script>` / `node <script>`), the script
   * argument as authored (unresolved). The caller must verify this file exists
   * on the host before running help: an agent whose `command` points at an
   * in-container path (`python /agent/main.py`) has the interpreter on PATH but
   * no script on the host, so `--help` would print an interpreter error that
   * must NOT be mistaken for help text. Absent for a bare command.
   */
  scriptArg?: string;
}

/**
 * Decide what to run to capture `--help` on the host. The executable checked on
 * PATH is the first token of `entrypoint.command` (the interpreter for a
 * `python <script>` / `node <script>` form, else the bare command). The help
 * command is the declared `entrypoint.help` if set, else `<command> --help`.
 * For interpreter forms, {@link HostHelpPlan.scriptArg} carries the script the
 * caller must confirm exists on the host.
 */
export function hostHelpPlan(entrypoint: Pick<Entrypoint, 'command' | 'help'>): HostHelpPlan {
  const raw = entrypoint.command.trim();
  const tokens = raw.split(/\s+/);
  const executable = tokens[0] ?? raw;
  const command = entrypoint.help?.trim() ? entrypoint.help.trim() : `${raw} --help`;
  const scriptArg = executable === 'python' || executable === 'node' ? tokens[1] : undefined;
  return { executable, command, ...(scriptArg !== undefined && { scriptArg }) };
}

export interface ExecutableProbeOptions {
  pathEnv?: string;
  pathExt?: string;
  platform?: NodeJS.Platform;
  existsSync?: (p: string) => boolean;
}

/**
 * Whether `executable` resolves to a real file — a path is checked directly, a
 * bare name is searched across `PATH` (honoring `PATHEXT` on Windows). This
 * gates host help-running so we never blindly execute a declared `help` string
 * whose command isn't even installed.
 */
export function isExecutableOnPath(executable: string, opts: ExecutableProbeOptions = {}): boolean {
  const platform = opts.platform ?? process.platform;
  const exists = opts.existsSync ?? fs.existsSync;
  const hasSep = executable.includes('/') || (platform === 'win32' && executable.includes('\\'));
  if (hasSep) return exists(executable);

  const pathEnv = opts.pathEnv ?? process.env.PATH ?? '';
  const sep = platform === 'win32' ? ';' : ':';
  // Join with the TARGET platform's separator, not the host's, so a
  // platform-parameterized probe is correct off its native OS.
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const exts =
    platform === 'win32'
      ? (opts.pathExt ?? process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .map((e) => e.trim())
          .filter(Boolean)
      : [''];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (exists(join(dir, executable + ext))) return true;
    }
  }
  return false;
}

export interface HostHelpResult {
  ok: boolean;
  /** Combined stdout+stderr when ok. */
  output?: string;
  /** Why help couldn't be captured, when not ok. */
  reason?: string;
}

type SpawnFn = typeof spawnSync;

/**
 * Run a help command, capturing stdout+stderr with a timeout. `--help` commonly
 * exits non-zero yet still prints usage, so success is gauged by non-empty
 * output rather than exit code.
 */
export function runHostHelp(
  plan: HostHelpPlan,
  opts: { cwd?: string; timeoutMs?: number; spawn?: SpawnFn } = {},
): HostHelpResult {
  const spawn = opts.spawn ?? spawnSync;
  const spawnOpts: SpawnSyncOptions = {
    shell: true,
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? 5000,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    // Never let the help command read the terminal / hang on stdin.
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  const res = spawn(plan.command, spawnOpts);
  if (res.error) {
    return { ok: false, reason: res.error.message };
  }
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  if (!output) {
    return { ok: false, reason: 'the help command produced no output' };
  }
  return { ok: true, output };
}

// ---------------------------------------------------------------------------
// Composed-argv preview
// ---------------------------------------------------------------------------

/**
 * Render the argv a run would compose for `samplePrompt` with the given
 * `invoke`, so the author can eyeball the placement before committing. Mirrors
 * the runtime composer's order: interpreter split → expanded invoke →
 * guaranteed `entrypoint.args`. An empty `invoke` yields no prompt token (a
 * wrapper command that reads the task file itself) — shown as-is, not defaulted.
 */
export function composeInvokePreview(
  entrypoint: Pick<Entrypoint, 'command' | 'args'>,
  invoke: string[],
  samplePrompt: string,
): string {
  const { command, argvPrefix } = splitInterpreterCommand(entrypoint.command);
  const promptTokens = expandInvokeTemplate(invoke, {
    prompt: samplePrompt,
    promptFile: STABLE_PATHS.taskFile,
  });
  const args = [...argvPrefix, ...promptTokens, ...(entrypoint.args ?? [])];
  return formatInvocationForLog({ command, args });
}
