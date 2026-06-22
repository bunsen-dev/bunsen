// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Targeted, comment-preserving edits to `bunsen.config.yaml#suites`.
 *
 * The `bn suites add` / `bn suites remove` flow needs to mutate one section
 * of the project config while leaving the rest of the file (including user
 * comments) byte-for-byte intact. js-yaml's round-trip would discard
 * comments and re-quote scalars, so this module does a targeted block
 * replacement instead:
 *
 *  - Find the start/end of the top-level `suites:` block.
 *  - Regenerate just that block from the desired entry list.
 *  - Splice it back into the original text.
 *
 * Limitations:
 *  - Only the `suites:` block is rewritten; comments inside it are not
 *    preserved. Comments outside it stay exactly where the user put them.
 *  - We assume 2-space indentation for the regenerated block. The parser
 *    accepts any indentation, so reading still works regardless.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import type { ProjectSuiteEntry } from '@bunsen-dev/types';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ProjectConfigEditError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProjectConfigEditError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const CONFIG_FILE = 'bunsen.config.yaml';

/**
 * Locate the `bunsen.config.yaml` for a project root. Returns the absolute
 * path even if the file does not yet exist (callers may want to create it).
 */
export function getProjectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, CONFIG_FILE);
}

/**
 * Replace the `suites:` block in `rawYaml` with `entries`.
 *
 * - If `suites:` already exists at the top level, the block is replaced.
 * - If it doesn't, the new block is appended at end-of-file.
 * - Passing an empty array removes the existing `suites:` block entirely.
 */
export function replaceSuitesBlock(
  rawYaml: string,
  entries: ProjectSuiteEntry[],
): string {
  const block = renderSuitesBlock(entries);
  const region = findTopLevelKeyRegion(rawYaml, 'suites');
  if (region === null) {
    if (entries.length === 0) return rawYaml;
    // Append. Make sure we have exactly one trailing newline before, and end
    // with a newline.
    const sep = rawYaml.length === 0 || rawYaml.endsWith('\n') ? '' : '\n';
    return `${rawYaml}${sep}${block}`;
  }

  if (entries.length === 0) {
    // Remove the block entirely. Keep one separating newline if there's content
    // both before and after.
    return rawYaml.slice(0, region.start) + rawYaml.slice(region.end);
  }
  return rawYaml.slice(0, region.start) + block + rawYaml.slice(region.end);
}

/**
 * Read the project config, apply `mutate` to its `suites` array, and write
 * the result back to disk. Returns the new entry list.
 *
 * Creates the file with a minimal v1 header if it does not exist.
 */
export function updateProjectSuites(
  configPath: string,
  mutate: (entries: ProjectSuiteEntry[]) => ProjectSuiteEntry[],
): ProjectSuiteEntry[] {
  const exists = fs.existsSync(configPath);
  const raw = exists ? fs.readFileSync(configPath, 'utf8') : DEFAULT_CONFIG_TEMPLATE;
  const current = readSuitesFromYaml(raw);
  const updated = mutate(current);
  validateNoCollisions(updated);
  const next = replaceSuitesBlock(raw, updated);
  fs.writeFileSync(configPath, ensureTrailingNewline(next));
  return updated;
}

const DEFAULT_CONFIG_TEMPLATE = `version: v1\n`;

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface BlockRegion {
  /** Absolute string offset where the block begins. */
  start: number;
  /** Absolute string offset just past the block (exclusive). */
  end: number;
}

/**
 * Find the byte range of a top-level YAML mapping key (key + value).
 *
 * Boundaries:
 *   - Start: the first character of the key's line.
 *   - End: the first character of the next top-level key's line, or EOF.
 *
 * Returns `null` if the key isn't present at the top level.
 */
function findTopLevelKeyRegion(rawYaml: string, key: string): BlockRegion | null {
  // We split into lines but track absolute offsets so the slice is exact.
  // Top-level keys: line begins (column 0) with `key:` (optional whitespace
  // before colon, optional value after). Doc-separator `---` is treated as
  // a non-key line.
  const lineStarts: number[] = [0];
  for (let i = 0; i < rawYaml.length; i++) {
    if (rawYaml.charCodeAt(i) === 0x0a) lineStarts.push(i + 1);
  }
  const eof = rawYaml.length;

  const keyRe = new RegExp(`^${escapeRegExp(key)}\\s*:(?:\\s|$)`);

  let blockStart = -1;
  for (let i = 0; i < lineStarts.length; i++) {
    const start = lineStarts[i];
    const end = i + 1 < lineStarts.length ? lineStarts[i + 1] : eof;
    const line = rawYaml.slice(start, end);
    // Skip blank/comment/doc-separator lines.
    if (/^\s*(#|$)/.test(line) || /^---\s*$/.test(line.trimEnd())) continue;
    if (keyRe.test(line)) {
      blockStart = start;
      // Now find the first subsequent line that starts with a top-level key
      // OR a doc separator.
      for (let j = i + 1; j < lineStarts.length; j++) {
        const ns = lineStarts[j];
        const ne = j + 1 < lineStarts.length ? lineStarts[j + 1] : eof;
        const nline = rawYaml.slice(ns, ne);
        if (/^[A-Za-z_$][^:\s]*\s*:/.test(nline)) {
          // Top-level key candidate (column 0, alpha start).
          return { start: blockStart, end: ns };
        }
        if (/^---\s*$/.test(nline.trimEnd())) {
          return { start: blockStart, end: ns };
        }
      }
      return { start: blockStart, end: eof };
    }
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Render `entries` as the `suites:` block, including the leading `suites:`
 * key and a trailing newline. Returns a single empty string when entries
 * is empty (caller handles deletion separately).
 */
function renderSuitesBlock(entries: ProjectSuiteEntry[]): string {
  if (entries.length === 0) return '';
  const lines: string[] = ['suites:'];
  for (const entry of entries) {
    lines.push(`  - source:`);
    lines.push(`      type: ${quoteScalar(entry.source.type)}`);
    lines.push(`      url: ${quoteScalar(entry.source.url)}`);
    if (entry.source.ref !== undefined) {
      lines.push(`      ref: ${quoteScalar(entry.source.ref)}`);
    }
    if (entry.as !== undefined) {
      lines.push(`    as: ${quoteScalar(entry.as)}`);
    }
    if (entry.cacheDir !== undefined) {
      lines.push(`    cacheDir: ${quoteScalar(entry.cacheDir)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Conservatively quote scalars for safe round-trip through js-yaml.
 *
 * URLs, refs, and aliases used in practice are safe as bare scalars, but we
 * still defer to js-yaml's emitter for anything that could be ambiguous
 * (leading punctuation, special chars).
 */
function quoteScalar(value: string): string {
  if (value.length === 0) return '""';
  // A safe-bare scalar matches: alphanumeric, plus a small set of common
  // separators. Anything else gets the YAML emitter's quoting treatment.
  if (/^[A-Za-z0-9_./:@\-]+$/.test(value) && !/^[-?:!*&%@`#]/.test(value)) {
    return value;
  }
  // js-yaml's emitter handles escaping correctly for arbitrary strings.
  return yaml.dump(value, { lineWidth: -1 }).trimEnd();
}

/**
 * Re-read the suites array from a config string. Used to seed the mutate
 * callback with the current contents.
 *
 * Note: this is a *plain* yaml load, not the schema-validated parser. We
 * trust that the project config was already validated when last loaded; the
 * goal here is just to surface the `suites:` array shape so callers can
 * append/remove entries.
 */
function readSuitesFromYaml(raw: string): ProjectSuiteEntry[] {
  const doc = yaml.load(raw) as unknown;
  if (doc === null || doc === undefined || typeof doc !== 'object') return [];
  const obj = doc as Record<string, unknown>;
  const suites = obj.suites;
  if (!Array.isArray(suites)) return [];
  const out: ProjectSuiteEntry[] = [];
  for (const entry of suites) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const source = e.source;
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const s = source as Record<string, unknown>;
    if (s.type !== 'git' || typeof s.url !== 'string') continue;
    const norm: ProjectSuiteEntry = {
      source: { type: 'git', url: s.url },
    };
    if (typeof s.ref === 'string') norm.source.ref = s.ref;
    if (typeof e.as === 'string') norm.as = e.as;
    if (typeof e.cacheDir === 'string') norm.cacheDir = e.cacheDir;
    out.push(norm);
  }
  return out;
}

function validateNoCollisions(entries: ProjectSuiteEntry[]): void {
  const urls = new Set<string>();
  const aliases = new Set<string>();
  for (const entry of entries) {
    if (urls.has(entry.source.url)) {
      throw new ProjectConfigEditError(
        'suites.duplicate_url',
        `Duplicate suite URL ${JSON.stringify(entry.source.url)}.`,
      );
    }
    urls.add(entry.source.url);
    if (entry.as !== undefined) {
      if (aliases.has(entry.as)) {
        throw new ProjectConfigEditError(
          'suites.duplicate_alias',
          `Duplicate suite alias ${JSON.stringify(entry.as)}.`,
        );
      }
      aliases.add(entry.as);
    }
  }
}
