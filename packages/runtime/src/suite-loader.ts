// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `bunsen-suite.yaml` v1 parser, loader, and identity derivation.
 *
 * Responsibilities:
 *   - Parse and validate `bunsen-suite.yaml` against the v1 schema.
 *   - Derive a suite's canonical id from where it was cloned
 *     (`<host>/<org>/<repo>`) or from its on-disk path (`local/<dirname>`).
 *   - Resolve a suite's experiment roots into absolute filesystem paths.
 *   - Load suites declared in `bunsen.config.yaml#suites`, returning a
 *     `ResolvedSuite[]` keyed by canonical id with collision detection.
 *
 * Suite ids are intentionally derived rather than declared. See
 * `docs/SUITES.md`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import {
  parseSchemaMeta,
  type ResolvedSuite,
  type SuiteAggregation,
  type SuiteCompatibility,
  type SuiteManifestV1,
  type SuiteTrack,
  type SuiteWeightConfig,
  type ProjectSuiteEntry,
} from '@bunsen-dev/types';
import type { ResolvedProject } from './project-loader.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export class SuiteManifestError extends Error {
  readonly code: string;
  readonly path?: string;
  readonly resource?: string;

  constructor(code: string, message: string, options: { path?: string; resource?: string } = {}) {
    super(message);
    this.name = 'SuiteManifestError';
    this.code = code;
    this.path = options.path;
    this.resource = options.resource;
  }
}

const SUITE_FILE = 'bunsen-suite.yaml';

const VALID_AGGREGATE_FUNCTIONS: ReadonlySet<string> = new Set([
  'weighted_average',
  'all',
  'any',
  'min',
  'max',
  'mean',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string, p?: string): never {
  throw new SuiteManifestError(code, message, { path: p });
}

function requireString(
  value: unknown,
  field: string,
  code: string,
  opts: { minLength?: number } = {},
): string {
  if (typeof value !== 'string') {
    fail(code, `${field} must be a string.`, field);
  }
  if ((opts.minLength ?? 0) > 0 && value.length < (opts.minLength as number)) {
    fail(code, `${field} must be a non-empty string.`, field);
  }
  return value;
}

function ensureNoUnknownKeys(
  obj: Raw,
  allowed: ReadonlySet<string>,
  contextPath: string,
  code: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      fail(code, `${contextPath}: unknown field '${key}'.`, `${contextPath}.${key}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Manifest parser
// ---------------------------------------------------------------------------

/**
 * Parse a raw `bunsen-suite.yaml` document into a {@link SuiteManifestV1}.
 *
 * Accepts a parsed object or the raw YAML string. Validates the schema
 * version, top-level field names, and structured sub-blocks. Does not
 * resolve filesystem paths or derive identity — see {@link loadSuiteFromDir}.
 */
export function parseSuiteManifest(
  input: unknown | string,
  options: { source?: string } = {},
): SuiteManifestV1 {
  const resource = options.source;
  const raw = typeof input === 'string' ? yaml.load(input) : input;

  if (raw === null || raw === undefined) {
    throw new SuiteManifestError(
      'suite.root.empty',
      `${resource ? `${resource}: ` : ''}bunsen-suite.yaml is empty. A minimal manifest requires 'version: v1', 'name', and 'experiments'.`,
      { resource },
    );
  }

  if (!isRecord(raw)) {
    throw new SuiteManifestError(
      'suite.root.type',
      `${resource ? `${resource}: ` : ''}bunsen-suite.yaml must be a YAML mapping.`,
      { resource },
    );
  }

  if ('id' in raw) {
    throw new SuiteManifestError(
      'suite.id.removed',
      `${resource ? `${resource}: ` : ''}bunsen-suite.yaml: the 'id' field has been removed. ` +
        `A suite's canonical id is now derived from where it was cloned from (host/org/repo) ` +
        `or 'local/<dirname>' for on-disk suites — see docs/SUITES.md.`,
      { resource, path: 'id' },
    );
  }
  if ('provenance' in raw) {
    throw new SuiteManifestError(
      'suite.provenance.removed',
      `${resource ? `${resource}: ` : ''}bunsen-suite.yaml: the 'provenance' field has been removed. ` +
        `Suite source URL and commit are recorded automatically when Bunsen clones the suite.`,
      { resource, path: 'provenance' },
    );
  }

  parseSchemaMeta(raw, { resource: resource ?? SUITE_FILE });

  const name = requireString(raw.name, 'name', 'suite.name.required', { minLength: 1 });

  const description =
    raw.description === undefined
      ? undefined
      : requireString(raw.description, 'description', 'suite.description.type');
  const versionTag =
    raw.version_tag === undefined
      ? undefined
      : requireString(raw.version_tag, 'version_tag', 'suite.version_tag.type', { minLength: 1 });
  const license =
    raw.license === undefined
      ? undefined
      : requireString(raw.license, 'license', 'suite.license.type', { minLength: 1 });

  const experimentsRaw = raw.experiments;
  if (!Array.isArray(experimentsRaw) || experimentsRaw.length === 0) {
    fail(
      'suite.experiments.required',
      `experiments must be a non-empty array of directories that contain experiment.yaml files.`,
      'experiments',
    );
  }
  const experiments = experimentsRaw.map((item, i) => {
    if (typeof item !== 'string' || item.length === 0) {
      fail(
        'suite.experiments.item.type',
        `experiments[${i}] must be a non-empty string.`,
        `experiments[${i}]`,
      );
    }
    if (path.isAbsolute(item)) {
      fail(
        'suite.experiments.item.absolute',
        `experiments[${i}] must be relative to the suite repo root (got ${JSON.stringify(item)}).`,
        `experiments[${i}]`,
      );
    }
    const normalized = path.posix.normalize(item.replace(/\\/g, '/'));
    if (normalized === '..' || normalized.startsWith('../')) {
      fail(
        'suite.experiments.item.escape',
        `experiments[${i}] must not escape the suite repo root (got ${JSON.stringify(item)}).`,
        `experiments[${i}]`,
      );
    }
    return item;
  });

  const compatibility =
    raw.compatibility === undefined
      ? undefined
      : parseCompatibility(raw.compatibility, 'compatibility');
  const tags = raw.tags === undefined ? undefined : parseTags(raw.tags, 'tags');
  const tracks = raw.tracks === undefined ? undefined : parseTracks(raw.tracks, 'tracks');
  const aggregation =
    raw.aggregation === undefined ? undefined : parseAggregation(raw.aggregation, 'aggregation');

  const allowed: ReadonlySet<string> = new Set([
    '$schema',
    'version',
    'name',
    'description',
    'version_tag',
    'license',
    'compatibility',
    'experiments',
    'tags',
    'tracks',
    'aggregation',
  ]);
  ensureNoUnknownKeys(raw, allowed, '(root)', 'suite.unknown_field');

  const out: SuiteManifestV1 = { version: 'v1', name, experiments };
  if (typeof raw.$schema === 'string') out.$schema = raw.$schema;
  if (description !== undefined) out.description = description;
  if (versionTag !== undefined) out.version_tag = versionTag;
  if (license !== undefined) out.license = license;
  if (compatibility !== undefined) out.compatibility = compatibility;
  if (tags !== undefined) out.tags = tags;
  if (tracks !== undefined) out.tracks = tracks;
  if (aggregation !== undefined) out.aggregation = aggregation;
  return out;
}

function parseCompatibility(raw: unknown, ctx: string): SuiteCompatibility {
  if (!isRecord(raw)) fail('suite.compatibility.type', `${ctx} must be a mapping.`, ctx);
  const out: SuiteCompatibility = {};
  if (raw.min_bunsen_version !== undefined) {
    out.min_bunsen_version = requireString(
      raw.min_bunsen_version,
      `${ctx}.min_bunsen_version`,
      'suite.compatibility.min_bunsen_version.type',
      { minLength: 1 },
    );
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['min_bunsen_version']),
    ctx,
    'suite.compatibility.unknown_field',
  );
  return out;
}

function parseTags(raw: unknown, ctx: string): Record<string, string[]> {
  if (!isRecord(raw)) fail('suite.tags.type', `${ctx} must be a mapping.`, ctx);
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) {
      fail('suite.tags.value.type', `${ctx}.${key} must be an array of strings.`, `${ctx}.${key}`);
    }
    out[key] = value.map((item, i) => {
      if (typeof item !== 'string' || item.length === 0) {
        fail(
          'suite.tags.item.type',
          `${ctx}.${key}[${i}] must be a non-empty string.`,
          `${ctx}.${key}[${i}]`,
        );
      }
      return item;
    });
  }
  return out;
}

function parseTracks(raw: unknown, ctx: string): Record<string, SuiteTrack> {
  if (!isRecord(raw)) fail('suite.tracks.type', `${ctx} must be a mapping.`, ctx);
  const out: Record<string, SuiteTrack> = {};
  for (const [name, value] of Object.entries(raw)) {
    out[name] = parseTrack(value, `${ctx}.${name}`);
  }
  return out;
}

function parseTrack(raw: unknown, ctx: string): SuiteTrack {
  if (!isRecord(raw)) fail('suite.tracks.entry.type', `${ctx} must be a mapping.`, ctx);
  const out: SuiteTrack = {};
  if (raw.description !== undefined) {
    out.description = requireString(
      raw.description,
      `${ctx}.description`,
      'suite.tracks.description.type',
    );
  }
  if (raw.include !== undefined) {
    out.include = parseGlobList(raw.include, `${ctx}.include`, 'suite.tracks.include');
  }
  if (raw.exclude !== undefined) {
    out.exclude = parseGlobList(raw.exclude, `${ctx}.exclude`, 'suite.tracks.exclude');
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['description', 'include', 'exclude']),
    ctx,
    'suite.tracks.unknown_field',
  );
  return out;
}

function parseGlobList(raw: unknown, ctx: string, code: string): string[] {
  if (!Array.isArray(raw)) fail(`${code}.type`, `${ctx} must be an array of strings.`, ctx);
  return raw.map((item, i) => {
    if (typeof item !== 'string' || item.length === 0) {
      fail(`${code}.item.type`, `${ctx}[${i}] must be a non-empty string.`, `${ctx}[${i}]`);
    }
    return item;
  });
}

function parseAggregation(raw: unknown, ctx: string): SuiteAggregation {
  if (!isRecord(raw)) fail('suite.aggregation.type', `${ctx} must be a mapping.`, ctx);
  const out: SuiteAggregation = {};
  if (raw.default !== undefined) {
    if (typeof raw.default !== 'string' || !VALID_AGGREGATE_FUNCTIONS.has(raw.default)) {
      fail(
        'suite.aggregation.default.enum',
        `${ctx}.default must be one of: ${[...VALID_AGGREGATE_FUNCTIONS].join(', ')}.`,
        `${ctx}.default`,
      );
    }
    out.default = raw.default as SuiteAggregation['default'];
  }
  if (raw.weights !== undefined) {
    out.weights = parseWeightConfig(raw.weights, `${ctx}.weights`);
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['default', 'weights']),
    ctx,
    'suite.aggregation.unknown_field',
  );
  return out;
}

function parseWeightConfig(raw: unknown, ctx: string): SuiteWeightConfig {
  if (!isRecord(raw)) fail('suite.weights.type', `${ctx} must be a mapping.`, ctx);
  const out: SuiteWeightConfig = {};
  if (raw.by_tag !== undefined) {
    out.by_tag = parseNumericMap(raw.by_tag, `${ctx}.by_tag`, 'suite.weights.by_tag');
  }
  if (raw.by_experiment !== undefined) {
    out.by_experiment = parseNumericMap(
      raw.by_experiment,
      `${ctx}.by_experiment`,
      'suite.weights.by_experiment',
    );
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['by_tag', 'by_experiment']),
    ctx,
    'suite.weights.unknown_field',
  );
  return out;
}

function parseNumericMap(raw: unknown, ctx: string, code: string): Record<string, number> {
  if (!isRecord(raw)) fail(`${code}.type`, `${ctx} must be a mapping of string → number.`, ctx);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail(`${code}.value.type`, `${ctx}.${key} must be a finite number.`, `${ctx}.${key}`);
    }
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Identity derivation
// ---------------------------------------------------------------------------

/**
 * Derive the canonical suite id from a clone URL.
 *
 * Examples:
 *   - `https://github.com/cursiv/terminal-bench.git` → `github.com/cursiv/terminal-bench`
 *   - `git@github.com:cursiv/terminal-bench.git` → `github.com/cursiv/terminal-bench`
 *   - `https://gitlab.example.com/internal/eval-suite` → `gitlab.example.com/internal/eval-suite`
 *
 * Throws if the URL doesn't decompose into host + org + repo. Local suites
 * (no clone URL) use `localSuiteId` instead.
 */
export function suiteIdFromUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    throw new SuiteManifestError('suite.url.empty', `Suite URL must be non-empty.`);
  }

  // `file://` URLs have no host/org/repo to derive identity from — git
  // accepts them as clone URLs, but they're effectively local mirrors.
  // Route them to `local/<dirname>` so the canonical id matches the
  // on-disk suite identity used by `localSuiteId`.
  if (trimmed.startsWith('file://')) {
    return localSuiteId(localPathFromUrl(trimmed));
  }

  let host: string;
  let pathPart: string;

  // SSH form: git@host:org/repo(.git)
  const sshMatch = /^[^@]+@([^:]+):(.+)$/.exec(trimmed);
  if (sshMatch) {
    host = sshMatch[1];
    pathPart = sshMatch[2];
  } else {
    // HTTP(S) / git:// form
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new SuiteManifestError(
        'suite.url.unparseable',
        `Suite URL ${JSON.stringify(url)} could not be parsed as a git URL.`,
      );
    }
    host = parsed.host;
    pathPart = parsed.pathname.replace(/^\/+/, '');
  }

  if (host.length === 0) {
    throw new SuiteManifestError(
      'suite.url.no_host',
      `Suite URL ${JSON.stringify(url)} has no host component.`,
    );
  }

  // Strip trailing .git and any trailing slashes.
  const cleanedPath = pathPart.replace(/\.git\/?$/, '').replace(/\/+$/, '');
  const parts = cleanedPath.split('/').filter((p) => p.length > 0);
  if (parts.length < 2) {
    throw new SuiteManifestError(
      'suite.url.path',
      `Suite URL ${JSON.stringify(url)} must have at least <org>/<repo> in its path.`,
    );
  }

  // Lowercase the entire id so case-only URL variants (GitHub treats org/repo
  // case-insensitively) don't produce two distinct canonical ids — and
  // therefore two cache directories — for the same upstream.
  return `${host}/${parts.join('/')}`.toLowerCase();
}

/** Canonical id for an on-disk suite that has no clone URL. */
export function localSuiteId(suiteRoot: string): string {
  const base = path.basename(path.resolve(suiteRoot));
  // Strip a trailing `.git` so a bare repo path collapses onto its repo name.
  const cleaned = base.replace(/\.git$/, '');
  return `local/${cleaned}`;
}

function localPathFromUrl(input: string): string {
  if (input.startsWith('file://')) {
    try {
      const url = new URL(input);
      return decodeURIComponent(url.pathname);
    } catch {
      // Fall through to raw input.
    }
  }
  return input;
}

// ---------------------------------------------------------------------------
// Disk loading
// ---------------------------------------------------------------------------

/**
 * Load a suite from an on-disk directory.
 *
 * - Reads `bunsen-suite.yaml` if present and parses it.
 * - If absent, returns a manifest-less {@link ResolvedSuite} (the directory is
 *   still treated as a suite — see `docs/SUITES.md`).
 * - Identity is taken from `expectedId` if provided (the project config knows
 *   the clone URL); otherwise it falls back to {@link localSuiteId}.
 */
export function loadSuiteFromDir(
  suiteRoot: string,
  options: {
    /** Canonical id (from the clone URL). Falls back to `local/<dirname>` if omitted. */
    expectedId?: string;
    /** Optional alias from `bunsen.config.yaml#suites[].as`. */
    alias?: string;
    /** Source URL (only set for git-cloned suites). */
    sourceUrl?: string;
    /** Pinned ref (branch, tag, or sha) — used to resolve a commit sha. */
    ref?: string;
  } = {},
): ResolvedSuite {
  if (!fs.existsSync(suiteRoot) || !fs.statSync(suiteRoot).isDirectory()) {
    throw new SuiteManifestError(
      'suite.root.missing',
      `Suite directory does not exist: ${suiteRoot}`,
      { resource: suiteRoot },
    );
  }

  const manifestPath = path.join(suiteRoot, SUITE_FILE);
  let manifest: SuiteManifestV1 | undefined;
  if (fs.existsSync(manifestPath)) {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    manifest = parseSuiteManifest(raw, { source: manifestPath });
  }

  const id = options.expectedId ?? localSuiteId(suiteRoot);
  const out: ResolvedSuite = { id, root: path.resolve(suiteRoot) };
  if (manifest) out.manifest = manifest;
  if (options.alias) out.alias = options.alias;
  if (options.sourceUrl) out.source_url = options.sourceUrl;

  // Resolve the commit sha if we can. Best-effort — failures don't poison
  // the rest of the load (the suite may still be usable without provenance).
  if (options.sourceUrl) {
    const sha = readCommitSha(suiteRoot);
    if (sha) out.version = sha;
  }

  return out;
}

function readCommitSha(repoRoot: string): string | undefined {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{7,64}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Project-wide suite loading
// ---------------------------------------------------------------------------

/**
 * Resolve every suite declared in `bunsen.config.yaml#suites` against the
 * project's local cache directory.
 *
 * For each entry, this:
 *   - derives the canonical id from `source.url`,
 *   - locates the cached clone under `storage.suites/<sanitized-id>`
 *     (or the entry's `cacheDir` override),
 *   - parses the suite's `bunsen-suite.yaml` if the clone exists.
 *
 * Returns suites in the order declared in `bunsen.config.yaml`, plus
 * collision diagnostics so callers (`bn suites add`) can fail fast.
 */
export function loadProjectSuites(project: ResolvedProject): ResolvedSuite[] {
  const entries = project.config.suites ?? [];
  if (entries.length === 0) return [];

  const seenIds = new Map<string, number>();
  const seenAliases = new Map<string, number>();
  const out: ResolvedSuite[] = [];

  entries.forEach((entry, i) => {
    const id = suiteIdFromUrl(entry.source.url);

    const prevIdIdx = seenIds.get(id);
    if (prevIdIdx !== undefined) {
      throw new SuiteManifestError(
        'project.suites.id.collision',
        `bunsen.config.yaml#suites[${i}] resolves to canonical id ${JSON.stringify(id)}, ` +
          `which collides with suites[${prevIdIdx}]. Two clones of the same upstream cannot ` +
          `coexist; use a fork at a different URL or remove the duplicate.`,
        { path: `suites[${i}].source.url` },
      );
    }
    seenIds.set(id, i);

    if (entry.as !== undefined) {
      const prevAliasIdx = seenAliases.get(entry.as);
      if (prevAliasIdx !== undefined) {
        throw new SuiteManifestError(
          'project.suites.as.collision',
          `bunsen.config.yaml#suites[${i}].as: alias ${JSON.stringify(entry.as)} is already used by suites[${prevAliasIdx}].`,
          { path: `suites[${i}].as` },
        );
      }
      seenAliases.set(entry.as, i);
    }

    const cacheDir = resolveSuiteCacheDir(project, entry, id);
    if (!fs.existsSync(cacheDir) || !fs.existsSync(path.join(cacheDir, SUITE_FILE))) {
      // Clone hasn't been materialized yet — surface a record so the CLI
      // can suggest `bn suites update` without crashing project loading.
      const record: ResolvedSuite = { id, root: cacheDir };
      if (entry.as) record.alias = entry.as;
      record.source_url = entry.source.url;
      out.push(record);
      return;
    }

    out.push(
      loadSuiteFromDir(cacheDir, {
        expectedId: id,
        alias: entry.as,
        sourceUrl: entry.source.url,
        ref: entry.source.ref,
      }),
    );
  });

  return out;
}

/**
 * Detect whether `experimentDir` lives inside one of the project's
 * configured suites. When it does, returns provenance ready to stamp onto
 * a run manifest.
 *
 * Suite resolution is memoized per `ResolvedProject` so the work
 * (URL→id derivation, collision checks, `git rev-parse`) only runs once
 * per project for a given session.
 *
 * If suite resolution fails (malformed manifest, missing clone, etc.),
 * the failure is reported via `onWarn` rather than swallowed silently —
 * the run can still proceed without provenance, but the user sees that
 * something is off.
 */
export function detectSuiteProvenance(
  experimentDir: string,
  project: ResolvedProject,
  options: { onWarn?: (message: string) => void } = {},
): { id: string; version?: string; source_url?: string } | undefined {
  if (!project.config.suites?.length) return undefined;
  let suites: ResolvedSuite[];
  try {
    suites = getCachedProjectSuites(project);
  } catch (err) {
    options.onWarn?.(
      `Suite resolution failed; run will not record suite provenance. Reason: ${err instanceof Error ? err.message : err}`,
    );
    return undefined;
  }
  const expAbs = path.resolve(experimentDir);
  for (const suite of suites) {
    const suiteRootAbs = path.resolve(suite.root);
    const rel = path.relative(suiteRootAbs, expAbs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const out: { id: string; version?: string; source_url?: string } = { id: suite.id };
    if (suite.version) out.version = suite.version;
    if (suite.source_url) out.source_url = suite.source_url;
    return out;
  }
  return undefined;
}

const projectSuitesCache = new WeakMap<ResolvedProject, ResolvedSuite[]>();

function getCachedProjectSuites(project: ResolvedProject): ResolvedSuite[] {
  const cached = projectSuitesCache.get(project);
  if (cached) return cached;
  const fresh = loadProjectSuites(project);
  projectSuitesCache.set(project, fresh);
  return fresh;
}

/** Resolve the absolute cache directory for a project suite entry. */
export function resolveSuiteCacheDir(
  project: ResolvedProject,
  entry: ProjectSuiteEntry,
  derivedId: string,
): string {
  if (entry.cacheDir) {
    return path.isAbsolute(entry.cacheDir)
      ? entry.cacheDir
      : path.resolve(project.root, entry.cacheDir);
  }
  // Default location: <storage.suites>/<sanitized-id>. Slashes inside the id
  // are replaced with `__` so the cache layout is a single directory level
  // (avoids partial `host/org` directories with no repos under them).
  const sanitized = derivedId.replace(/[\\/]/g, '__');
  return path.join(project.storage.suites, sanitized);
}

// ---------------------------------------------------------------------------
// Experiment discovery within a suite
// ---------------------------------------------------------------------------

/**
 * Resolve a suite's `experiments:` roots into absolute filesystem paths.
 *
 * If the suite has no manifest, the suite root itself is returned as a single
 * search path (matches the "treat the repo as a directory of experiments"
 * fallback rule).
 */
export function getSuiteExperimentSearchPaths(suite: ResolvedSuite): string[] {
  if (!suite.manifest) return [suite.root];
  return suite.manifest.experiments.map((rel) => path.resolve(suite.root, rel));
}
