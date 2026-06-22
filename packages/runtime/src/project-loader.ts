// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `bunsen.config.yaml` v1 parser and loader.
 *
 * Reads the v1 schema (see `@bunsen-dev/types/schemas/project.v1.json` and the
 * Project Configuration section in `README.md`), validates required fields,
 * and derives storage paths and env policy.
 *
 * This is the single path for reading project YAML. There is no legacy
 * fallback — the old top-level `experiments:` / `agents:` shape is rejected
 * with a migration hint pointing at `paths.experiments` / `paths.agents`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import {
  parseSchemaMeta,
  parseDuration,
  InvalidDurationError,
  type ProjectConfig,
  type ProjectPaths,
  type ProjectSuiteEntry,
  type ProjectSuiteSource,
  type ProjectStorageConfig,
  type ProjectDefaults,
  type ProjectRunDefaults,
  type ProjectCaptureConfig,
  type ProjectSupervisorConfig,
  type ProjectRegistries,
  type ProjectImageRegistry,
  type RunPlatform,
} from '@bunsen-dev/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A loaded project config plus its filesystem context. The runtime, CLI, and
 * SDK consume this view; it is what {@link loadProject} produces.
 */
export interface ResolvedProject {
  /** Absolute path to the project root. */
  root: string;
  /** Absolute path to `bunsen.config.yaml`, or `undefined` if no config file exists. */
  configPath?: string;
  /** Parsed config. When no file exists, this is the v1 default shape. */
  config: ProjectConfig;
  /** Resolved storage paths derived from `storage.root`. */
  storage: ResolvedStoragePaths;
  /** Non-fatal validation warnings emitted during parsing. */
  warnings: ProjectConfigWarning[];
}

/** Resolved absolute paths under the project's storage root. */
export interface ResolvedStoragePaths {
  /** Absolute path to the storage root (defaults to `<root>/.bunsen`). */
  root: string;
  /** Where individual run directories live. */
  runs: string;
  /** Cache root for build artifacts, agent sources, etc. */
  cache: string;
  /** Where suite clones live. */
  suites: string;
  /** Path to the SQLite run index. */
  indexDb: string;
}

/**
 * Non-fatal validation warning surfaced during project load. The CLI prints
 * these on stderr at startup so users see them without needing to run a
 * dedicated validate command.
 */
export interface ProjectConfigWarning {
  code: string;
  message: string;
  path?: string;
}

/**
 * Structured error raised by the project loader.
 *
 * Callers can inspect `code` to build machine-readable diagnostics; `path` is
 * a dot-path into the project document for the offending field.
 */
export class ProjectConfigError extends Error {
  readonly code: string;
  readonly path?: string;
  readonly resource?: string;

  constructor(code: string, message: string, options: { path?: string; resource?: string } = {}) {
    super(message);
    this.name = 'ProjectConfigError';
    this.code = code;
    this.path = options.path;
    this.resource = options.resource;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIG_FILE = 'bunsen.config.yaml';
const DEFAULT_STORAGE_ROOT = '.bunsen';
const VALID_RUN_PLATFORMS: ReadonlySet<string> = new Set([
  'auto',
  'linux/amd64',
  'linux/arm64',
]);
const VALID_PRECEDENCE: ReadonlySet<string> = new Set(['local', 'suites']);
const RESERVED_ENV_PREFIX = 'BUNSEN_';

/**
 * Legacy top-level fields rejected with a migration hint instead of a generic
 * "unknown field" error.
 */
const LEGACY_FIELD_HINTS: Record<string, string> = {
  experiments: "moved to 'paths.experiments'",
  agents: "moved to 'paths.agents'",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string, p?: string): never {
  throw new ProjectConfigError(code, message, { path: p });
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

function requireDuration(value: unknown, field: string, code: string): string {
  if (typeof value !== 'string') {
    fail(
      code,
      `${field} must be a duration string like "5m", "300s", "1h" (got ${typeof value}).`,
      field,
    );
  }
  if (value.length === 0) {
    fail(code, `${field} must be a non-empty duration string.`, field);
  }
  try {
    parseDuration(value);
  } catch (err) {
    if (err instanceof InvalidDurationError) {
      fail(code, `${field}: ${err.message}`, field);
    }
    throw err;
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

function isReservedEnvKey(key: string): boolean {
  return key.startsWith(RESERVED_ENV_PREFIX);
}

// ---------------------------------------------------------------------------
// Top-level parser
// ---------------------------------------------------------------------------

/**
 * Parse raw YAML data into a {@link ProjectConfig}.
 *
 * Accepts either a parsed object or the raw YAML string. Validates the schema
 * version, top-level field names, and structured sub-blocks. Does **not**
 * resolve filesystem paths — use {@link loadProject} for that.
 */
export function parseProjectConfig(
  input: unknown | string,
  options: { source?: string; warnings?: ProjectConfigWarning[] } = {},
): ProjectConfig {
  const resource = options.source;
  const warnings = options.warnings;
  const raw = typeof input === 'string' ? yaml.load(input) : input;

  if (raw === null || raw === undefined) {
    throw new ProjectConfigError(
      'project.root.empty',
      `${resource ? `${resource}: ` : ''}bunsen.config.yaml is empty. A minimal config requires 'version: v1'.`,
      { resource },
    );
  }

  if (!isRecord(raw)) {
    throw new ProjectConfigError(
      'project.root.type',
      `${resource ? `${resource}: ` : ''}bunsen.config.yaml must be a YAML mapping.`,
      { resource },
    );
  }

  for (const [field, hint] of Object.entries(LEGACY_FIELD_HINTS)) {
    if (field in raw) {
      throw new ProjectConfigError(
        'project.legacy_field',
        `Legacy bunsen.config.yaml field '${field}' is no longer supported — ${hint}. ` +
          `See @bunsen-dev/types/schemas/project.v1.json for the new schema.`,
        { resource, path: field },
      );
    }
  }

  parseSchemaMeta(raw, { resource: resource ?? CONFIG_FILE });

  const name =
    raw.name === undefined ? undefined : requireString(raw.name, 'name', 'project.name.type');

  const paths = raw.paths === undefined ? undefined : parsePaths(raw.paths, 'paths');
  const suites = raw.suites === undefined ? undefined : parseSuites(raw.suites, 'suites');
  const storage =
    raw.storage === undefined ? undefined : parseStorage(raw.storage, 'storage');
  const defaults =
    raw.defaults === undefined ? undefined : parseDefaults(raw.defaults, 'defaults');
  const registries =
    raw.registries === undefined ? undefined : parseRegistries(raw.registries, 'registries');

  // `remote:` is a reserved namespace for the future remote-execution
  // provider config (roadmap item 11). The block is preserved as-is and we
  // emit a warning rather than failing.
  let remote: Record<string, unknown> | undefined;
  if (raw.remote !== undefined) {
    if (!isRecord(raw.remote)) {
      fail('project.remote.type', 'remote must be a mapping.', 'remote');
    }
    remote = { ...raw.remote };
    warnings?.push({
      code: 'project.remote.reserved',
      message:
        "'remote:' is a reserved namespace for future remote-execution config and has no effect today. " +
        'Remote execution is not implemented yet.',
      path: 'remote',
    });
  }

  const rootAllowed: ReadonlySet<string> = new Set([
    '$schema',
    'version',
    'name',
    'paths',
    'suites',
    'storage',
    'defaults',
    'registries',
    'remote',
  ]);
  ensureNoUnknownKeys(raw, rootAllowed, '(root)', 'project.unknown_field');

  const out: ProjectConfig = { version: 'v1' };
  if (typeof raw.$schema === 'string') out.$schema = raw.$schema;
  if (name !== undefined) out.name = name;
  if (paths !== undefined) out.paths = paths;
  if (suites !== undefined) out.suites = suites;
  if (storage !== undefined) out.storage = storage;
  if (defaults !== undefined) out.defaults = defaults;
  if (registries !== undefined) out.registries = registries;
  if (remote !== undefined) out.remote = remote;
  return out;
}

// ---------------------------------------------------------------------------
// Sub-parsers
// ---------------------------------------------------------------------------

function parsePaths(raw: unknown, ctx: string): ProjectPaths {
  if (!isRecord(raw)) {
    fail('project.paths.type', `${ctx} must be a mapping.`, ctx);
  }
  const out: ProjectPaths = {};
  if (raw.experiments !== undefined) {
    out.experiments = parseStringList(
      raw.experiments,
      `${ctx}.experiments`,
      'project.paths.experiments',
    );
  }
  if (raw.agents !== undefined) {
    out.agents = parseStringList(raw.agents, `${ctx}.agents`, 'project.paths.agents');
  }
  if (raw.precedence !== undefined) {
    if (typeof raw.precedence !== 'string' || !VALID_PRECEDENCE.has(raw.precedence)) {
      fail(
        'project.paths.precedence.enum',
        `${ctx}.precedence must be 'local' or 'suites'.`,
        `${ctx}.precedence`,
      );
    }
    out.precedence = raw.precedence as ProjectPaths['precedence'];
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['experiments', 'agents', 'precedence']),
    ctx,
    'project.paths.unknown_field',
  );
  return out;
}

function parseStringList(raw: unknown, ctx: string, code: string): string[] {
  if (!Array.isArray(raw)) {
    fail(`${code}.type`, `${ctx} must be an array of strings.`, ctx);
  }
  return raw.map((item, i) => {
    if (typeof item !== 'string' || item.length === 0) {
      fail(
        `${code}.item.type`,
        `${ctx}[${i}] must be a non-empty string.`,
        `${ctx}[${i}]`,
      );
    }
    return item;
  });
}

function parseSuites(raw: unknown, ctx: string): ProjectSuiteEntry[] {
  if (!Array.isArray(raw)) {
    fail('project.suites.type', `${ctx} must be an array of suite entries.`, ctx);
  }
  const seenSources = new Set<string>();
  const seenAliases = new Set<string>();
  return raw.map((entry, i) => {
    const ictx = `${ctx}[${i}]`;
    if (!isRecord(entry)) {
      fail('project.suites.item.type', `${ictx} must be a mapping.`, ictx);
    }
    if ('id' in entry) {
      fail(
        'project.suites.id.removed',
        `${ictx}.id: suite ids are no longer declared in bunsen.config.yaml — they are derived from the source URL (host/org/repo). ` +
          `Use 'as: <local-alias>' if you need a short local name.`,
        `${ictx}.id`,
      );
    }
    if (entry.source === undefined) {
      fail(
        'project.suites.source.required',
        `${ictx}.source is required.`,
        `${ictx}.source`,
      );
    }
    const source = parseSuiteSource(entry.source, `${ictx}.source`);
    if (seenSources.has(source.url)) {
      fail(
        'project.suites.source.duplicate',
        `${ictx}.source.url: duplicate suite source ${JSON.stringify(source.url)}.`,
        `${ictx}.source.url`,
      );
    }
    seenSources.add(source.url);
    const out: ProjectSuiteEntry = { source };
    if (entry.as !== undefined) {
      const alias = requireString(entry.as, `${ictx}.as`, 'project.suites.as.type', {
        minLength: 1,
      });
      if (!/^[a-z0-9][a-z0-9-]*$/.test(alias)) {
        fail(
          'project.suites.as.pattern',
          `${ictx}.as must be kebab-case (ASCII, lowercase, digits, hyphens; starting with a letter or digit): got ${JSON.stringify(alias)}.`,
          `${ictx}.as`,
        );
      }
      if (seenAliases.has(alias)) {
        fail(
          'project.suites.as.duplicate',
          `${ictx}.as: duplicate suite alias ${JSON.stringify(alias)}.`,
          `${ictx}.as`,
        );
      }
      seenAliases.add(alias);
      out.as = alias;
    }
    if (entry.cacheDir !== undefined) {
      out.cacheDir = requireString(
        entry.cacheDir,
        `${ictx}.cacheDir`,
        'project.suites.cacheDir.type',
        { minLength: 1 },
      );
    }
    ensureNoUnknownKeys(
      entry,
      new Set(['source', 'as', 'cacheDir']),
      ictx,
      'project.suites.unknown_field',
    );
    return out;
  });
}

function parseSuiteSource(raw: unknown, ctx: string): ProjectSuiteSource {
  if (!isRecord(raw)) {
    fail('project.suites.source.type', `${ctx} must be a mapping.`, ctx);
  }
  if (raw.type !== 'git') {
    fail(
      'project.suites.source.type.enum',
      `${ctx}.type must be 'git' (only git sources are supported in v1).`,
      `${ctx}.type`,
    );
  }
  const url = requireString(raw.url, `${ctx}.url`, 'project.suites.source.url.required', {
    minLength: 1,
  });
  const out: ProjectSuiteSource = { type: 'git', url };
  if (raw.ref !== undefined) {
    out.ref = requireString(raw.ref, `${ctx}.ref`, 'project.suites.source.ref.type', {
      minLength: 1,
    });
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['type', 'url', 'ref']),
    ctx,
    'project.suites.source.unknown_field',
  );
  return out;
}

function parseStorage(raw: unknown, ctx: string): ProjectStorageConfig {
  if (!isRecord(raw)) {
    fail('project.storage.type', `${ctx} must be a mapping.`, ctx);
  }
  const out: ProjectStorageConfig = {};
  if (raw.root !== undefined) {
    out.root = requireString(raw.root, `${ctx}.root`, 'project.storage.root.type', {
      minLength: 1,
    });
  }
  ensureNoUnknownKeys(raw, new Set(['root']), ctx, 'project.storage.unknown_field');
  return out;
}

function parseDefaults(raw: unknown, ctx: string): ProjectDefaults {
  if (!isRecord(raw)) {
    fail('project.defaults.type', `${ctx} must be a mapping.`, ctx);
  }
  const out: ProjectDefaults = {};
  if (raw.run !== undefined) {
    out.run = parseRunDefaults(raw.run, `${ctx}.run`);
  }
  if (raw.env !== undefined) {
    out.env = parseStaticEnv(raw.env, `${ctx}.env`);
  }
  if (raw.passEnv !== undefined) {
    out.passEnv = parsePassEnv(raw.passEnv, `${ctx}.passEnv`);
  }
  if (raw.envFiles !== undefined) {
    out.envFiles = parseEnvFiles(raw.envFiles, `${ctx}.envFiles`);
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['run', 'env', 'passEnv', 'envFiles']),
    ctx,
    'project.defaults.unknown_field',
  );
  return out;
}

function parseStaticEnv(raw: unknown, ctx: string): Record<string, string> {
  if (!isRecord(raw)) {
    fail('project.defaults.env.type', `${ctx} must be a mapping of string → string.`, ctx);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isReservedEnvKey(key)) {
      fail(
        'project.defaults.env.reserved',
        `${ctx}.${key}: env names starting with 'BUNSEN_' are reserved by the platform and cannot be set in user config.`,
        `${ctx}.${key}`,
      );
    }
    if (typeof value !== 'string') {
      fail(
        'project.defaults.env.value',
        `${ctx}.${key} must be a string (got ${typeof value}).`,
        `${ctx}.${key}`,
      );
    }
    out[key] = value;
  }
  return out;
}

function parsePassEnv(raw: unknown, ctx: string): string[] {
  if (!Array.isArray(raw)) {
    fail('project.defaults.passEnv.type', `${ctx} must be an array of env var names.`, ctx);
  }
  const seen = new Set<string>();
  return raw.map((item, i) => {
    if (typeof item !== 'string' || item.length === 0) {
      fail(
        'project.defaults.passEnv.item.type',
        `${ctx}[${i}] must be a non-empty string.`,
        `${ctx}[${i}]`,
      );
    }
    if (isReservedEnvKey(item)) {
      fail(
        'project.defaults.passEnv.reserved',
        `${ctx}[${i}]: env names starting with 'BUNSEN_' are reserved and cannot be allowlisted.`,
        `${ctx}[${i}]`,
      );
    }
    if (seen.has(item)) {
      fail(
        'project.defaults.passEnv.duplicate',
        `${ctx}[${i}]: duplicate entry ${JSON.stringify(item)}.`,
        `${ctx}[${i}]`,
      );
    }
    seen.add(item);
    return item;
  });
}

function parseEnvFiles(raw: unknown, ctx: string): string[] {
  if (!Array.isArray(raw)) {
    fail('project.defaults.envFiles.type', `${ctx} must be an array of relative file paths.`, ctx);
  }
  return raw.map((item, i) => {
    if (typeof item !== 'string' || item.length === 0) {
      fail(
        'project.defaults.envFiles.item.type',
        `${ctx}[${i}] must be a non-empty string.`,
        `${ctx}[${i}]`,
      );
    }
    if (path.isAbsolute(item)) {
      fail(
        'project.defaults.envFiles.absolute',
        `${ctx}[${i}]: env files must be relative to the project root (got ${JSON.stringify(item)}).`,
        `${ctx}[${i}]`,
      );
    }
    const normalized = path.posix.normalize(item.replace(/\\/g, '/'));
    if (normalized === '..' || normalized.startsWith('../')) {
      fail(
        'project.defaults.envFiles.escape',
        `${ctx}[${i}]: env files must not escape the project root (got ${JSON.stringify(item)}).`,
        `${ctx}[${i}]`,
      );
    }
    return item;
  });
}

function parseRunDefaults(raw: unknown, ctx: string): ProjectRunDefaults {
  if (!isRecord(raw)) {
    fail('project.defaults.run.type', `${ctx} must be a mapping.`, ctx);
  }
  const out: ProjectRunDefaults = {};
  if (raw.timeout !== undefined) {
    out.timeout = requireDuration(
      raw.timeout,
      `${ctx}.timeout`,
      'project.defaults.run.timeout.type',
    );
  }
  if (raw.platform !== undefined) {
    if (typeof raw.platform !== 'string' || !VALID_RUN_PLATFORMS.has(raw.platform)) {
      fail(
        'project.defaults.run.platform.enum',
        `${ctx}.platform must be 'auto', 'linux/amd64', or 'linux/arm64'.`,
        `${ctx}.platform`,
      );
    }
    out.platform = raw.platform as 'auto' | RunPlatform;
  }
  if (raw.capture !== undefined) {
    out.capture = parseCapture(raw.capture, `${ctx}.capture`);
  }
  if (raw.supervisor !== undefined) {
    out.supervisor = parseSupervisor(raw.supervisor, `${ctx}.supervisor`);
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['timeout', 'platform', 'capture', 'supervisor']),
    ctx,
    'project.defaults.run.unknown_field',
  );
  return out;
}

function parseCapture(raw: unknown, ctx: string): ProjectCaptureConfig {
  if (!isRecord(raw)) {
    fail('project.defaults.run.capture.type', `${ctx} must be a mapping.`, ctx);
  }
  const out: ProjectCaptureConfig = {};
  if (raw.traces !== undefined) {
    if (typeof raw.traces !== 'boolean') {
      fail(
        'project.defaults.run.capture.traces.type',
        `${ctx}.traces must be a boolean.`,
        `${ctx}.traces`,
      );
    }
    out.traces = raw.traces;
  }
  if (raw.recording !== undefined) {
    if (typeof raw.recording !== 'boolean') {
      fail(
        'project.defaults.run.capture.recording.type',
        `${ctx}.recording must be a boolean.`,
        `${ctx}.recording`,
      );
    }
    out.recording = raw.recording;
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['traces', 'recording']),
    ctx,
    'project.defaults.run.capture.unknown_field',
  );
  return out;
}

function parseSupervisor(raw: unknown, ctx: string): ProjectSupervisorConfig {
  if (!isRecord(raw)) {
    fail('project.defaults.run.supervisor.type', `${ctx} must be a mapping.`, ctx);
  }
  const out: ProjectSupervisorConfig = {};
  if (raw.stallTimeout !== undefined) {
    out.stallTimeout = requireDuration(
      raw.stallTimeout,
      `${ctx}.stallTimeout`,
      'project.defaults.run.supervisor.stallTimeout.type',
    );
  }
  if (raw.maxCheckInterval !== undefined) {
    out.maxCheckInterval = requireDuration(
      raw.maxCheckInterval,
      `${ctx}.maxCheckInterval`,
      'project.defaults.run.supervisor.maxCheckInterval.type',
    );
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['stallTimeout', 'maxCheckInterval']),
    ctx,
    'project.defaults.run.supervisor.unknown_field',
  );
  return out;
}

function parseRegistries(raw: unknown, ctx: string): ProjectRegistries {
  if (!isRecord(raw)) {
    fail('project.registries.type', `${ctx} must be a mapping.`, ctx);
  }
  const out: ProjectRegistries = {};
  if (raw.images !== undefined) {
    out.images = parseImageRegistry(raw.images, `${ctx}.images`);
  }
  ensureNoUnknownKeys(raw, new Set(['images']), ctx, 'project.registries.unknown_field');
  return out;
}

function parseImageRegistry(raw: unknown, ctx: string): ProjectImageRegistry {
  if (!isRecord(raw)) {
    fail('project.registries.images.type', `${ctx} must be a mapping.`, ctx);
  }
  const out: ProjectImageRegistry = {};
  if (raw.headless !== undefined) {
    out.headless = requireString(
      raw.headless,
      `${ctx}.headless`,
      'project.registries.images.headless.type',
      { minLength: 1 },
    );
  }
  if (raw.browser !== undefined) {
    out.browser = requireString(
      raw.browser,
      `${ctx}.browser`,
      'project.registries.images.browser.type',
      { minLength: 1 },
    );
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['headless', 'browser']),
    ctx,
    'project.registries.images.unknown_field',
  );
  return out;
}

// ---------------------------------------------------------------------------
// Project root discovery
// ---------------------------------------------------------------------------

/**
 * Find the Bunsen project root from `startDir`.
 *
 * Discovery order:
 *   1. Nearest ancestor directory containing `bunsen.config.yaml`.
 *   2. Else the nearest ancestor containing `.git`.
 *   3. Else `startDir` itself.
 *
 * Note: previous markers (`package.json`, `pnpm-workspace.yaml`) are not
 * considered. They produced false positives in nested workspaces and could
 * surface a project root that didn't match where Bunsen runs were actually
 * stored.
 */
export function findProjectRoot(startDir: string = process.cwd()): string {
  const start = path.resolve(startDir);
  const fsRoot = path.parse(start).root;

  for (const marker of ['bunsen.config.yaml', '.git']) {
    let dir = start;
    while (true) {
      if (fs.existsSync(path.join(dir, marker))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir || dir === fsRoot) break;
      dir = parent;
    }
  }
  return start;
}

// ---------------------------------------------------------------------------
// Storage path derivation
// ---------------------------------------------------------------------------

/**
 * Resolve absolute storage paths for a project given its root and the
 * `storage.root` field (or its default).
 */
export function resolveStoragePaths(
  projectRoot: string,
  config: ProjectConfig,
): ResolvedStoragePaths {
  const rel = config.storage?.root ?? DEFAULT_STORAGE_ROOT;
  const root = path.isAbsolute(rel) ? rel : path.resolve(projectRoot, rel);
  return {
    root,
    runs: path.join(root, 'runs'),
    cache: path.join(root, 'cache'),
    suites: path.join(root, 'suites'),
    indexDb: path.join(root, 'index.sqlite'),
  };
}

// ---------------------------------------------------------------------------
// loadProject
// ---------------------------------------------------------------------------

const projectCache = new Map<string, ResolvedProject>();

/** For tests: drop the in-memory project cache so reloads pick up edits. */
export function clearProjectCache(): void {
  projectCache.clear();
}

/**
 * Discover and load the Bunsen project rooted at `startDir`.
 *
 * If a `bunsen.config.yaml` is found, its contents are parsed and validated.
 * If not, a default v1 config is returned and `configPath` is `undefined`.
 *
 * Returns `null` is never produced — every directory has a project context,
 * even an implicit one. Use {@link findProjectRoot} alone if you only need
 * the root path.
 */
export function loadProject(startDir: string = process.cwd()): ResolvedProject {
  const root = findProjectRoot(startDir);
  const cached = projectCache.get(root);
  if (cached) return cached;

  const configPath = path.join(root, CONFIG_FILE);
  let config: ProjectConfig;
  let resolvedConfigPath: string | undefined;
  const warnings: ProjectConfigWarning[] = [];

  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8');
    config = parseProjectConfig(raw, { source: configPath, warnings });
    resolvedConfigPath = configPath;
  } else {
    config = { version: 'v1' };
  }

  const storage = resolveStoragePaths(root, config);
  const resolved: ResolvedProject = { root, config, storage, warnings };
  if (resolvedConfigPath) resolved.configPath = resolvedConfigPath;
  projectCache.set(root, resolved);
  return resolved;
}

// ---------------------------------------------------------------------------
// Search-path helpers
// ---------------------------------------------------------------------------

const DEFAULT_EXPERIMENT_PATHS = ['experiments'];
const DEFAULT_AGENT_PATHS = ['agents'];

/** Absolute experiment search paths in priority order. */
export function getExperimentSearchPaths(project: ResolvedProject): string[] {
  const rel = project.config.paths?.experiments ?? DEFAULT_EXPERIMENT_PATHS;
  return rel.map((p) => path.resolve(project.root, p));
}

/** Absolute agent search paths in priority order. */
export function getAgentSearchPaths(project: ResolvedProject): string[] {
  const rel = project.config.paths?.agents ?? DEFAULT_AGENT_PATHS;
  return rel.map((p) => path.resolve(project.root, p));
}

// ---------------------------------------------------------------------------
// Reserved-env helpers
// ---------------------------------------------------------------------------

/**
 * Throw `ProjectConfigError` if any provided env keys collide with the
 * platform's reserved `BUNSEN_*` namespace. Used by the CLI's `--env` /
 * `--env-file` flag handling so user input is rejected with the same
 * message as a config file.
 */
export function assertNoReservedEnvKeys(
  keys: Iterable<string>,
  source: string,
): void {
  for (const key of keys) {
    if (isReservedEnvKey(key)) {
      throw new ProjectConfigError(
        'project.env.reserved',
        `${source}: env names starting with 'BUNSEN_' are reserved by the platform and cannot be overridden (got ${JSON.stringify(key)}).`,
        { path: key },
      );
    }
  }
}

export { isReservedEnvKey, RESERVED_ENV_PREFIX };
