// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `agent.yaml` v1 parser and loader.
 *
 * Reads the v1 schema (see `@bunsen-dev/types/schemas/agent.v1.json` and the
 * agent section of `docs/ENVIRONMENT.md`), validates required fields and
 * cross-field invariants (including the `install.source` discriminated
 * union), resolves variants with `install.source` override support, and warns
 * when a `binary` source is missing its integrity hash.
 *
 * This is the single path for reading agent YAML. There is no legacy fallback;
 * the old flat-schema format (`command:`, `runtime.configure:`, `supervisor:`,
 * etc.) is rejected with clear migration hints.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { isReservedEnvKey } from './project-loader.js';
import {
  parseSchemaMeta,
  parseDuration,
  InvalidDurationError,
  type AgentConfig,
  type InstallConfig,
  type InstallSource,
  type BuildConfig,
  type AgentDepSpec,
  type AgentDepInstall,
  type AgentDepProvides,
  type AgentDepAbi,
  type AgentDepLinkage,
  type AgentDepRequires,
  type AgentDepLibraryRequirement,
  type ConfigureStep,
  type Entrypoint,
  type InteractionConfig,
  type InteractionMode,
  type ModelConfig,
  type AgentDefaults,
  type AgentExample,
  type AgentVariant,
  type VariantInstallConfig,
  type VariantInstallSource,
  type VariantConfigureSteps,
  type MergeableArray,
  type StepConfig,
  type RunStep,
  type WriteFileStep,
  type ExecutionUser,
} from '@bunsen-dev/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A fully loaded + variant-resolved agent. This is the working shape the
 * runtime operates on: the authored v1 {@link AgentConfig} plus the filesystem
 * context needed to actually execute it.
 */
export interface ResolvedAgent extends AgentConfig {
  /** Absolute path to the agent directory. */
  path: string;
  /** Absolute path to `agent.yaml` within the directory. */
  configPath: string;
  /** Selected variant name, if any. */
  variant?: string;
}

/** A hygiene warning surfaced by the agent loader (e.g. missing sha256). */
export interface AgentWarning {
  code: string;
  message: string;
  path?: string;
}

/**
 * Structured error raised by the agent loader.
 *
 * Callers can inspect `code` to build machine-readable diagnostics; `path`
 * is a dot-path into the agent document for the offending field.
 */
export class AgentConfigError extends Error {
  readonly code: string;
  readonly path?: string;
  readonly resource?: string;

  constructor(code: string, message: string, options: { path?: string; resource?: string } = {}) {
    super(message);
    this.name = 'AgentConfigError';
    this.code = code;
    this.path = options.path;
    this.resource = options.resource;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_EXECUTION_USERS: ReadonlySet<string> = new Set(['user', 'root']);

const VALID_DEP_LINKAGES: ReadonlySet<string> = new Set(['static', 'closure', 'dynamic']);

const VALID_DEP_LIBC: ReadonlySet<string> = new Set(['glibc', 'musl']);

const VALID_INTERACTION_MODES: ReadonlySet<string> = new Set(['direct', 'supervised']);

const VALID_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'local',
  'git',
  'npm',
  'binary',
]);

const VALID_BUILD_NETWORKS: ReadonlySet<string> = new Set(['default', 'none']);

const VALID_DEP_TARGETS: ReadonlySet<string> = new Set(['linux/amd64', 'linux/arm64']);

const DEP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const SHA256_PATTERN = /^[A-Fa-f0-9]{64}$/;

/**
 * Legacy top-level fields from the pre-v1 agent.yaml schema. The parser rejects
 * them with a clear migration hint instead of an opaque "unknown field" error.
 */
const LEGACY_TOP_LEVEL_HINTS: Record<string, string> = {
  command: "moved to 'entrypoint.command'",
  args: "moved to 'entrypoint.args'",
  help_command: "renamed to 'entrypoint.help'",
  supervisor:
    "replaced by 'interaction.mode: supervised' (or 'direct'). Booleans are no longer accepted.",
  source: "moved to 'install.source'",
  runtime:
    "removed: agents are sealed closures. Ship any required language runtimes via 'install.deps' " +
    "with appropriate 'linkage'/'abi' (see docs/ENVIRONMENT.md#asymmetric-composition)",
};

/** Legacy per-variant fields replaced by grouped overrides. */
const LEGACY_VARIANT_HINTS: Record<string, string> = {
  args: "moved to 'entrypoint.args'",
  env: "moved to 'defaults.env'",
  ref: "moved to 'install.source.ref' (or replace the whole 'install.source' block)",
  supervisor: "replaced by 'interaction.mode: supervised | direct'",
  runtime:
    "removed: agents are sealed closures. Ship any required language runtimes via 'install.deps' " +
    "with appropriate 'linkage'/'abi' (see docs/ENVIRONMENT.md#asymmetric-composition)",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string, path?: string): never {
  throw new AgentConfigError(code, message, { path });
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

function parseStringArray(raw: unknown, ctx: string, code: string): string[] {
  if (!Array.isArray(raw)) {
    fail(code, `${ctx} must be an array of strings.`, ctx);
  }
  return raw.map((item, i) => {
    if (typeof item !== 'string') {
      fail(`${code}.item`, `${ctx}[${i}] must be a string.`, `${ctx}[${i}]`);
    }
    return item;
  });
}

// ---------------------------------------------------------------------------
// Top-level parser
// ---------------------------------------------------------------------------

export interface ParseAgentOptions {
  source?: string;
  onWarning?: (warning: AgentWarning) => void;
}

/**
 * Parse raw YAML data into an {@link AgentConfig}.
 *
 * Accepts either a parsed object or the raw YAML string. Validates the schema
 * version, required fields, `install.source` discriminator, and durations.
 * Does **not** apply variants — use {@link applyAgentVariant} or
 * {@link loadAgent}.
 */
export function parseAgentConfig(
  input: unknown | string,
  options: ParseAgentOptions = {},
): AgentConfig {
  const resource = options.source;
  const raw = typeof input === 'string' ? yaml.load(input) : input;

  if (!isRecord(raw)) {
    throw new AgentConfigError(
      'agent.root.type',
      `${resource ? `${resource}: ` : ''}agent.yaml must be a YAML mapping.`,
      { resource },
    );
  }

  // Migration hints for legacy top-level fields first — "command" and friends
  // are the most common stumbling block.
  for (const [field, hint] of Object.entries(LEGACY_TOP_LEVEL_HINTS)) {
    if (field in raw) {
      throw new AgentConfigError(
        'agent.legacy_field',
        `Legacy agent.yaml field '${field}' is no longer supported — ${hint}. ` +
          `See @bunsen-dev/types/schemas/agent.v1.json for the new schema.`,
        { resource, path: field },
      );
    }
  }

  // Schema meta (version, $schema).
  parseSchemaMeta(raw, { resource: resource ?? 'agent.yaml' });

  const name = requireString(raw.name, 'name', 'agent.name.required', { minLength: 1 });
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    fail(
      'agent.name.pattern',
      `name must be kebab-case (ASCII, lowercase, digits, hyphens; starting with a letter or digit): got ${JSON.stringify(name)}.`,
      'name',
    );
  }

  const description =
    raw.description === undefined
      ? undefined
      : requireString(raw.description, 'description', 'agent.description.type');

  if (raw.install === undefined) {
    fail('agent.install.required', `'install' is required.`, 'install');
  }
  const install = parseInstall(raw.install, 'install', options.onWarning, resource);

  if (raw.entrypoint === undefined) {
    fail('agent.entrypoint.required', `'entrypoint' is required.`, 'entrypoint');
  }
  const entrypoint = parseEntrypoint(raw.entrypoint, 'entrypoint');

  if (raw.interaction === undefined) {
    fail('agent.interaction.required', `'interaction' is required.`, 'interaction');
  }
  const interaction = parseInteraction(raw.interaction, 'interaction');

  const model = raw.model === undefined ? undefined : parseModel(raw.model, 'model');

  const defaults =
    raw.defaults === undefined ? undefined : parseDefaults(raw.defaults, 'defaults');

  const examples =
    raw.examples === undefined ? undefined : parseExamples(raw.examples, 'examples');

  const variants =
    raw.variants === undefined
      ? undefined
      : parseVariants(raw.variants, 'variants', options.onWarning, resource);

  const allowed: ReadonlySet<string> = new Set([
    '$schema',
    'version',
    'name',
    'description',
    'install',
    'entrypoint',
    'interaction',
    'model',
    'defaults',
    'examples',
    'variants',
  ]);
  ensureNoUnknownKeys(raw, allowed, '(root)', 'agent.unknown_field');

  const config: AgentConfig = {
    version: 'v1',
    name,
    install,
    entrypoint,
    interaction,
  };
  if (typeof raw.$schema === 'string') config.$schema = raw.$schema;
  if (description !== undefined) config.description = description;
  if (model !== undefined) config.model = model;
  if (defaults !== undefined) config.defaults = defaults;
  if (examples !== undefined) config.examples = examples;
  if (variants !== undefined) config.variants = variants;

  return config;
}

// ---------------------------------------------------------------------------
// Sub-parsers
// ---------------------------------------------------------------------------

function parseInstall(
  raw: unknown,
  ctx: string,
  onWarning?: (w: AgentWarning) => void,
  resource?: string,
): InstallConfig {
  if (!isRecord(raw)) {
    fail('agent.install.type', `${ctx} must be a mapping.`, ctx);
  }

  if (raw.source === undefined) {
    fail('agent.install.source.required', `${ctx}.source is required.`, `${ctx}.source`);
  }
  const source = parseInstallSource(raw.source, `${ctx}.source`, onWarning);

  const deps =
    raw.deps === undefined ? undefined : parseDeps(raw.deps, `${ctx}.deps`, resource);
  const build =
    raw.build === undefined ? undefined : parseBuild(raw.build, `${ctx}.build`);
  const configure =
    raw.configure === undefined ? undefined : parseConfigure(raw.configure, `${ctx}.configure`);

  ensureNoUnknownKeys(
    raw,
    new Set(['source', 'deps', 'build', 'configure']),
    ctx,
    'agent.install.unknown_field',
  );

  const out: InstallConfig = { source };
  if (deps !== undefined) out.deps = deps;
  if (build !== undefined) out.build = build;
  if (configure !== undefined) out.configure = configure;
  return out;
}

// ---------------------------------------------------------------------------
// install.deps parsing
// ---------------------------------------------------------------------------

/**
 * Parse an `install.deps` list. File references (`{ file: ./path.yaml }`) are
 * resolved relative to the referring `agent.yaml` and the loaded spec is
 * spliced into the result inline.
 */
function parseDeps(raw: unknown, ctx: string, resource?: string): AgentDepSpec[] {
  if (!Array.isArray(raw)) {
    fail('agent.install.deps.type', `${ctx} must be an array of dep entries.`, ctx);
  }
  const seen = new Set<string>();
  const out: AgentDepSpec[] = [];
  raw.forEach((entry, i) => {
    const entryCtx = `${ctx}[${i}]`;
    if (!isRecord(entry)) {
      fail('agent.install.deps.item.type', `${entryCtx} must be a mapping.`, entryCtx);
    }
    let spec: AgentDepSpec;
    if ('file' in entry) {
      spec = resolveDepFile(entry, entryCtx, resource);
    } else {
      spec = parseDepSpec(entry, entryCtx);
    }
    if (seen.has(spec.name)) {
      fail(
        'agent.install.deps.duplicate_name',
        `${entryCtx}: duplicate dep name ${JSON.stringify(spec.name)} (deps must have unique names).`,
        entryCtx,
      );
    }
    seen.add(spec.name);
    out.push(spec);
  });
  return out;
}

function resolveDepFile(entry: Raw, ctx: string, resource?: string): AgentDepSpec {
  // Reject any keys other than `file` so misspelled inline-vs-ref deps fail loudly.
  const extra = Object.keys(entry).filter((k) => k !== 'file');
  if (extra.length > 0) {
    fail(
      'agent.install.deps.file.unknown_field',
      `${ctx}: dep file reference must only contain 'file' (got extra: ${extra.join(', ')}). Inline specs use 'name', 'install', etc.`,
      ctx,
    );
  }
  const filePath = requireString(entry.file, `${ctx}.file`, 'agent.install.deps.file.type', {
    minLength: 1,
  });
  if (!resource) {
    fail(
      'agent.install.deps.file.no_resource',
      `${ctx}.file: cannot resolve dep file reference ${JSON.stringify(filePath)} — the parser was called without a source path. Use loadAgent() or pass parseAgentConfig source.`,
      ctx,
    );
  }
  const baseDir = path.dirname(resource);
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
  if (!fs.existsSync(resolvedPath)) {
    fail(
      'agent.install.deps.file.missing',
      `${ctx}.file: dep file not found at ${resolvedPath}.`,
      ctx,
    );
  }
  let raw: unknown;
  try {
    raw = yaml.load(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (err) {
    fail(
      'agent.install.deps.file.parse',
      `${ctx}.file: failed to parse ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`,
      ctx,
    );
  }
  if (!isRecord(raw)) {
    fail(
      'agent.install.deps.file.type',
      `${ctx}.file: ${resolvedPath} must contain a single dep mapping (got ${typeof raw}).`,
      ctx,
    );
  }
  if ('file' in raw) {
    fail(
      'agent.install.deps.file.nested',
      `${ctx}.file: ${resolvedPath} cannot itself be a file reference — nested file references are not supported.`,
      ctx,
    );
  }
  return parseDepSpec(raw, `${ctx}<${path.relative(baseDir, resolvedPath)}>`);
}

function parseDepSpec(raw: Raw, ctx: string): AgentDepSpec {
  const name = requireString(raw.name, `${ctx}.name`, 'agent.install.deps.name.required', {
    minLength: 1,
  });
  if (!DEP_NAME_PATTERN.test(name)) {
    fail(
      'agent.install.deps.name.pattern',
      `${ctx}.name must be kebab-case (lowercase, digits, hyphens; starting with a letter or digit): got ${JSON.stringify(name)}.`,
      `${ctx}.name`,
    );
  }

  let version: string | undefined;
  if (raw.version !== undefined) {
    if (typeof raw.version !== 'string' && typeof raw.version !== 'number') {
      fail(
        'agent.install.deps.version.type',
        `${ctx}.version must be a string or number.`,
        `${ctx}.version`,
      );
    }
    version = String(raw.version);
    if (version.length === 0) {
      fail(
        'agent.install.deps.version.empty',
        `${ctx}.version must be a non-empty string.`,
        `${ctx}.version`,
      );
    }
  }

  const description =
    raw.description === undefined
      ? undefined
      : requireString(raw.description, `${ctx}.description`, 'agent.install.deps.description.type');

  let image: string | undefined;
  if (raw.image !== undefined) {
    image = requireString(raw.image, `${ctx}.image`, 'agent.install.deps.image.type', {
      minLength: 1,
    });
  }

  const linkage =
    raw.linkage === undefined ? undefined : parseDepLinkage(raw.linkage, `${ctx}.linkage`);

  const abi = raw.abi === undefined ? undefined : parseDepAbi(raw.abi, `${ctx}.abi`);

  const requires =
    raw.requires === undefined ? undefined : parseDepRequires(raw.requires, `${ctx}.requires`);

  // When the author explicitly opts into closure/dynamic, the abi must come
  // with it so cross-image expectations are honest. When linkage is omitted,
  // we treat the dep as implicit-closure for cache-key purposes but do not
  // demand an abi — that's the upgrade path for pre-asymmetric-ownership
  // deps. Static linkage forbids abi (static binaries embed everything).
  if (linkage !== undefined && linkage !== 'static' && abi === undefined) {
    fail(
      'agent.install.deps.abi.required',
      `${ctx}: linkage '${linkage}' requires an 'abi' block declaring the substrate libc ` +
        `(e.g. abi: { libc: glibc }). Use linkage: static if the artifact is fully self-contained.`,
      ctx,
    );
  }
  if (linkage === 'static' && abi !== undefined) {
    fail(
      'agent.install.deps.abi.unexpected',
      `${ctx}: linkage 'static' artifacts must not declare an 'abi' block — static binaries ` +
        `embed everything they need.`,
      ctx,
    );
  }
  if (linkage === 'static' && requires?.libraries && requires.libraries.length > 0) {
    fail(
      'agent.install.deps.requires.unexpected',
      `${ctx}: linkage 'static' artifacts must not declare 'requires.libraries' — static binaries ` +
        `do not depend on substrate libraries.`,
      ctx,
    );
  }

  const provides =
    raw.provides === undefined
      ? undefined
      : parseDepProvides(raw.provides, `${ctx}.provides`);

  if (raw.install === undefined) {
    fail(
      'agent.install.deps.install.required',
      `${ctx}.install is required (per-target build recipes).`,
      `${ctx}.install`,
    );
  }
  if (!Array.isArray(raw.install)) {
    fail(
      'agent.install.deps.install.type',
      `${ctx}.install must be an array of { target, run } entries.`,
      `${ctx}.install`,
    );
  }
  if (raw.install.length === 0) {
    fail(
      'agent.install.deps.install.empty',
      `${ctx}.install must contain at least one target.`,
      `${ctx}.install`,
    );
  }
  const seenTargets = new Set<string>();
  const install: AgentDepInstall[] = raw.install.map((entry, i) => {
    const entryCtx = `${ctx}.install[${i}]`;
    if (!isRecord(entry)) {
      fail('agent.install.deps.install.item.type', `${entryCtx} must be a mapping.`, entryCtx);
    }
    const target = requireString(
      entry.target,
      `${entryCtx}.target`,
      'agent.install.deps.install.target.required',
      { minLength: 1 },
    );
    if (!VALID_DEP_TARGETS.has(target)) {
      fail(
        'agent.install.deps.install.target.enum',
        `${entryCtx}.target must be one of: ${[...VALID_DEP_TARGETS].join(', ')} (got ${JSON.stringify(target)}).`,
        `${entryCtx}.target`,
      );
    }
    if (seenTargets.has(target)) {
      fail(
        'agent.install.deps.install.target.duplicate',
        `${entryCtx}.target: duplicate entry for ${target}.`,
        `${entryCtx}.target`,
      );
    }
    seenTargets.add(target);
    const runCmds = parseStringArray(
      entry.run,
      `${entryCtx}.run`,
      'agent.install.deps.install.run.type',
    );
    if (runCmds.length === 0) {
      fail(
        'agent.install.deps.install.run.empty',
        `${entryCtx}.run must contain at least one command.`,
        `${entryCtx}.run`,
      );
    }
    const entryImage =
      entry.image === undefined
        ? undefined
        : requireString(entry.image, `${entryCtx}.image`, 'agent.install.deps.install.image.type', {
            minLength: 1,
          });
    const effectiveImage = entryImage ?? image;
    if (!effectiveImage) {
      fail(
        'agent.install.deps.image.required',
        `${entryCtx}: no build image specified — set 'image' on the dep or on this target.`,
        `${entryCtx}.image`,
      );
    }
    const out: AgentDepInstall = { target, run: runCmds, image: effectiveImage };
    if (entry.network !== undefined) {
      if (typeof entry.network !== 'string' || !VALID_BUILD_NETWORKS.has(entry.network)) {
        fail(
          'agent.install.deps.install.network.enum',
          `${entryCtx}.network must be 'default' or 'none'.`,
          `${entryCtx}.network`,
        );
      }
      out.network = entry.network as AgentDepInstall['network'];
    }
    if (entry.timeout !== undefined) {
      out.timeout = requireDuration(
        entry.timeout,
        `${entryCtx}.timeout`,
        'agent.install.deps.install.timeout.type',
      );
    }
    ensureNoUnknownKeys(
      entry,
      new Set(['target', 'run', 'image', 'network', 'timeout']),
      entryCtx,
      'agent.install.deps.install.unknown_field',
    );
    return out;
  });

  ensureNoUnknownKeys(
    raw,
    new Set([
      'name',
      'version',
      'description',
      'image',
      'linkage',
      'abi',
      'requires',
      'provides',
      'install',
    ]),
    ctx,
    'agent.install.deps.unknown_field',
  );

  const out: AgentDepSpec = { name, install };
  if (version !== undefined) out.version = version;
  if (description !== undefined) out.description = description;
  if (image !== undefined) out.image = image;
  if (linkage !== undefined) out.linkage = linkage;
  if (abi !== undefined) out.abi = abi;
  if (requires !== undefined) out.requires = requires;
  if (provides !== undefined) out.provides = provides;
  return out;
}

function parseDepLinkage(raw: unknown, ctx: string): AgentDepLinkage {
  if (typeof raw !== 'string' || !VALID_DEP_LINKAGES.has(raw)) {
    fail(
      'agent.install.deps.linkage.enum',
      `${ctx}: linkage must be one of ${[...VALID_DEP_LINKAGES].join(', ')} (got ${JSON.stringify(raw)}).`,
      ctx,
    );
  }
  return raw as AgentDepLinkage;
}

function parseDepAbi(raw: unknown, ctx: string): AgentDepAbi {
  if (!isRecord(raw)) {
    fail('agent.install.deps.abi.type', `${ctx} must be a mapping with a 'libc' field.`, ctx);
  }
  if (typeof raw.libc !== 'string' || !VALID_DEP_LIBC.has(raw.libc)) {
    fail(
      'agent.install.deps.abi.libc.enum',
      `${ctx}.libc must be one of ${[...VALID_DEP_LIBC].join(', ')} (got ${JSON.stringify(raw.libc)}).`,
      `${ctx}.libc`,
    );
  }
  const out: AgentDepAbi = { libc: raw.libc as AgentDepAbi['libc'] };
  if (raw.libc_version !== undefined) {
    out.libc_version = requireString(
      raw.libc_version,
      `${ctx}.libc_version`,
      'agent.install.deps.abi.libc_version.type',
      { minLength: 1 },
    );
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['libc', 'libc_version']),
    ctx,
    'agent.install.deps.abi.unknown_field',
  );
  return out;
}

function parseDepRequires(raw: unknown, ctx: string): AgentDepRequires {
  if (!isRecord(raw)) {
    fail('agent.install.deps.requires.type', `${ctx} must be a mapping.`, ctx);
  }
  const out: AgentDepRequires = {};
  if (raw.libraries !== undefined) {
    if (!Array.isArray(raw.libraries)) {
      fail(
        'agent.install.deps.requires.libraries.type',
        `${ctx}.libraries must be an array of { name, version? } entries.`,
        `${ctx}.libraries`,
      );
    }
    const seen = new Set<string>();
    const libs: AgentDepLibraryRequirement[] = raw.libraries.map((entry, i) => {
      const entryCtx = `${ctx}.libraries[${i}]`;
      if (!isRecord(entry)) {
        fail(
          'agent.install.deps.requires.libraries.item.type',
          `${entryCtx} must be a mapping with a 'name' field.`,
          entryCtx,
        );
      }
      const libName = requireString(
        entry.name,
        `${entryCtx}.name`,
        'agent.install.deps.requires.libraries.name.required',
        { minLength: 1 },
      );
      if (seen.has(libName)) {
        fail(
          'agent.install.deps.requires.libraries.duplicate',
          `${entryCtx}: duplicate library name ${JSON.stringify(libName)}.`,
          entryCtx,
        );
      }
      seen.add(libName);
      const lib: AgentDepLibraryRequirement = { name: libName };
      if (entry.version !== undefined) {
        lib.version = requireString(
          entry.version,
          `${entryCtx}.version`,
          'agent.install.deps.requires.libraries.version.type',
          { minLength: 1 },
        );
      }
      ensureNoUnknownKeys(
        entry,
        new Set(['name', 'version']),
        entryCtx,
        'agent.install.deps.requires.libraries.unknown_field',
      );
      return lib;
    });
    if (libs.length > 0) out.libraries = libs;
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['libraries']),
    ctx,
    'agent.install.deps.requires.unknown_field',
  );
  return out;
}

function parseDepProvides(raw: unknown, ctx: string): AgentDepProvides {
  if (!isRecord(raw)) {
    fail('agent.install.deps.provides.type', `${ctx} must be a mapping.`, ctx);
  }
  const out: AgentDepProvides = {};
  if (raw.binaries !== undefined) {
    const list = parseStringArray(
      raw.binaries,
      `${ctx}.binaries`,
      'agent.install.deps.provides.binaries.type',
    );
    for (const [i, item] of list.entries()) {
      if (item.length === 0) {
        fail(
          'agent.install.deps.provides.binaries.empty',
          `${ctx}.binaries[${i}] must be a non-empty string.`,
          `${ctx}.binaries[${i}]`,
        );
      }
      if (item.includes('/')) {
        fail(
          'agent.install.deps.provides.binaries.invalid',
          `${ctx}.binaries[${i}] must be a bare binary name (no '/').`,
          `${ctx}.binaries[${i}]`,
        );
      }
    }
    out.binaries = list;
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['binaries']),
    ctx,
    'agent.install.deps.provides.unknown_field',
  );
  return out;
}

function parseInstallSource(
  raw: unknown,
  ctx: string,
  onWarning?: (w: AgentWarning) => void,
): InstallSource {
  if (!isRecord(raw)) {
    fail('agent.install.source.type', `${ctx} must be a mapping.`, ctx);
  }
  if (typeof raw.type !== 'string') {
    fail(
      'agent.install.source.type.required',
      `${ctx}.type is required (one of: local, git, npm, binary).`,
      `${ctx}.type`,
    );
  }
  if (!VALID_SOURCE_TYPES.has(raw.type)) {
    fail(
      'agent.install.source.type.enum',
      `${ctx}.type must be one of: local, git, npm, binary (got ${JSON.stringify(raw.type)}).`,
      `${ctx}.type`,
    );
  }

  switch (raw.type) {
    case 'local':
      ensureNoUnknownKeys(
        raw,
        new Set(['type']),
        ctx,
        'agent.install.source.local.unknown_field',
      );
      return { type: 'local' };
    case 'git': {
      const repo = requireString(raw.repo, `${ctx}.repo`, 'agent.install.source.git.repo.required', {
        minLength: 1,
      });
      let ref: string | undefined;
      if (raw.ref !== undefined) {
        ref = requireString(raw.ref, `${ctx}.ref`, 'agent.install.source.git.ref.type', {
          minLength: 1,
        });
      }
      ensureNoUnknownKeys(
        raw,
        new Set(['type', 'repo', 'ref']),
        ctx,
        'agent.install.source.git.unknown_field',
      );
      return ref === undefined ? { type: 'git', repo } : { type: 'git', repo, ref };
    }
    case 'npm': {
      const pkg = requireString(
        raw.package,
        `${ctx}.package`,
        'agent.install.source.npm.package.required',
        { minLength: 1 },
      );
      let version: string | undefined;
      if (raw.version !== undefined) {
        version = requireString(
          raw.version,
          `${ctx}.version`,
          'agent.install.source.npm.version.type',
          { minLength: 1 },
        );
      }
      ensureNoUnknownKeys(
        raw,
        new Set(['type', 'package', 'version']),
        ctx,
        'agent.install.source.npm.unknown_field',
      );
      return version === undefined
        ? { type: 'npm', package: pkg }
        : { type: 'npm', package: pkg, version };
    }
    case 'binary': {
      const url = requireString(raw.url, `${ctx}.url`, 'agent.install.source.binary.url.required', {
        minLength: 1,
      });
      let sha256: string | undefined;
      if (raw.sha256 !== undefined) {
        const value = requireString(
          raw.sha256,
          `${ctx}.sha256`,
          'agent.install.source.binary.sha256.type',
          { minLength: 1 },
        );
        if (!SHA256_PATTERN.test(value)) {
          fail(
            'agent.install.source.binary.sha256.format',
            `${ctx}.sha256 must be a 64-character hex string.`,
            `${ctx}.sha256`,
          );
        }
        sha256 = value;
      } else if (onWarning) {
        onWarning({
          code: 'agent.install.source.binary.sha256.missing',
          message:
            `${ctx}: binary source has no 'sha256' — integrity is not verified. ` +
            `Recommend adding a sha256 hash for reproducibility.`,
          path: ctx,
        });
      }
      ensureNoUnknownKeys(
        raw,
        new Set(['type', 'url', 'sha256']),
        ctx,
        'agent.install.source.binary.unknown_field',
      );
      return sha256 === undefined ? { type: 'binary', url } : { type: 'binary', url, sha256 };
    }
    default:
      fail(
        'agent.install.source.type.enum',
        `${ctx}.type: unreachable`,
        `${ctx}.type`,
      );
  }
}

function parseBuild(raw: unknown, ctx: string): BuildConfig {
  if (!isRecord(raw)) {
    fail('agent.install.build.type', `${ctx} must be a mapping.`, ctx);
  }

  // Reject legacy names that would silently misconfigure the build.
  if ('script' in raw) {
    fail(
      'agent.install.build.legacy_field',
      `${ctx}.script is replaced by ${ctx}.run (array of commands).`,
      `${ctx}.script`,
    );
  }
  if ('container' in raw) {
    fail(
      'agent.install.build.legacy_field',
      `${ctx}.container is renamed to ${ctx}.image.`,
      `${ctx}.container`,
    );
  }
  if ('cache_salt' in raw) {
    fail(
      'agent.install.build.legacy_field',
      `${ctx}.cache_salt is renamed to ${ctx}.cacheSalt.`,
      `${ctx}.cache_salt`,
    );
  }
  if ('arch' in raw) {
    fail(
      'agent.install.build.legacy_field',
      `${ctx}.arch is no longer supported — platform is resolved once per run via run.platform / defaults.run.platform.`,
      `${ctx}.arch`,
    );
  }

  const image = requireString(raw.image, `${ctx}.image`, 'agent.install.build.image.required', {
    minLength: 1,
  });

  if (raw.run === undefined) {
    fail('agent.install.build.run.required', `${ctx}.run is required (array of commands).`, `${ctx}.run`);
  }
  const runCmds = parseStringArray(raw.run, `${ctx}.run`, 'agent.install.build.run.type');
  if (runCmds.length === 0) {
    fail(
      'agent.install.build.run.empty',
      `${ctx}.run must contain at least one command.`,
      `${ctx}.run`,
    );
  }

  const out: BuildConfig = { image, run: runCmds };
  if (raw.network !== undefined) {
    if (typeof raw.network !== 'string' || !VALID_BUILD_NETWORKS.has(raw.network)) {
      fail(
        'agent.install.build.network.enum',
        `${ctx}.network must be 'default' or 'none'.`,
        `${ctx}.network`,
      );
    }
    out.network = raw.network as BuildConfig['network'];
  }
  if (raw.timeout !== undefined) {
    out.timeout = requireDuration(
      raw.timeout,
      `${ctx}.timeout`,
      'agent.install.build.timeout.type',
    );
  }
  if (raw.cacheSalt !== undefined) {
    out.cacheSalt = requireString(
      raw.cacheSalt,
      `${ctx}.cacheSalt`,
      'agent.install.build.cacheSalt.type',
    );
  }

  ensureNoUnknownKeys(
    raw,
    new Set(['image', 'run', 'network', 'timeout', 'cacheSalt']),
    ctx,
    'agent.install.build.unknown_field',
  );
  return out;
}

function parseConfigure(raw: unknown, ctx: string): ConfigureStep[] {
  if (!Array.isArray(raw)) {
    fail(
      'agent.install.configure.type',
      `${ctx} must be an array of step objects (use 'run:', 'as:', 'timeout:').`,
      ctx,
    );
  }
  return raw.map((entry, i) => parseStep(entry, `${ctx}[${i}]`));
}

function parseStep(raw: unknown, ctx: string): StepConfig {
  if (!isRecord(raw)) {
    fail('agent.step.type', `${ctx} must be a mapping.`, ctx);
  }
  const hasRun = raw.run !== undefined;
  const hasWriteFile = raw.writeFile !== undefined;
  if (hasRun && hasWriteFile) {
    fail(
      'agent.step.exclusive',
      `${ctx}: a step may set 'run' or 'writeFile', not both.`,
      ctx,
    );
  }
  if (!hasRun && !hasWriteFile) {
    fail(
      'agent.step.required',
      `${ctx}: a step must set either 'run' or 'writeFile'.`,
      ctx,
    );
  }
  return hasWriteFile ? parseWriteFileStep(raw, ctx) : parseRunStep(raw, ctx);
}

function parseRunStep(raw: Record<string, unknown>, ctx: string): RunStep {
  const run = requireString(raw.run, `${ctx}.run`, 'agent.step.run.required', {
    minLength: 1,
  });
  const step: RunStep = { run };
  if (raw.as !== undefined) {
    if (typeof raw.as !== 'string' || !VALID_EXECUTION_USERS.has(raw.as)) {
      fail('agent.step.as.enum', `${ctx}.as must be 'user' or 'root'.`, `${ctx}.as`);
    }
    step.as = raw.as as ExecutionUser;
  }
  if (raw.timeout !== undefined) {
    step.timeout = requireDuration(raw.timeout, `${ctx}.timeout`, 'agent.step.timeout.type');
  }
  ensureNoUnknownKeys(raw, new Set(['run', 'as', 'timeout']), ctx, 'agent.step.unknown_field');
  return step;
}

function parseWriteFileStep(raw: Record<string, unknown>, ctx: string): WriteFileStep {
  const target = requireString(
    raw.writeFile,
    `${ctx}.writeFile`,
    'agent.step.writeFile.required',
    { minLength: 1 },
  );
  const hasFrom = raw.from !== undefined;
  const hasContent = raw.content !== undefined;
  if (hasFrom && hasContent) {
    fail(
      'agent.step.writeFile.exclusive',
      `${ctx}: a writeFile step must set 'from' or 'content', not both.`,
      ctx,
    );
  }
  if (!hasFrom && !hasContent) {
    fail(
      'agent.step.writeFile.source.required',
      `${ctx}: a writeFile step must set either 'from' (path relative to agent.yaml) or 'content' (inline UTF-8).`,
      ctx,
    );
  }
  const step: WriteFileStep = { writeFile: target };
  if (hasFrom) {
    step.from = requireString(
      raw.from,
      `${ctx}.from`,
      'agent.step.writeFile.from.type',
      { minLength: 1 },
    );
  }
  if (hasContent) {
    if (typeof raw.content !== 'string') {
      fail(
        'agent.step.writeFile.content.type',
        `${ctx}.content must be a string.`,
        `${ctx}.content`,
      );
    }
    step.content = raw.content;
  }
  if (raw.as !== undefined) {
    if (typeof raw.as !== 'string' || !VALID_EXECUTION_USERS.has(raw.as)) {
      fail('agent.step.as.enum', `${ctx}.as must be 'user' or 'root'.`, `${ctx}.as`);
    }
    step.as = raw.as as ExecutionUser;
  }
  if (raw.timeout !== undefined) {
    step.timeout = requireDuration(raw.timeout, `${ctx}.timeout`, 'agent.step.timeout.type');
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['writeFile', 'from', 'content', 'as', 'timeout']),
    ctx,
    'agent.step.unknown_field',
  );
  return step;
}

function parseEntrypoint(raw: unknown, ctx: string): Entrypoint {
  if (!isRecord(raw)) {
    fail('agent.entrypoint.type', `${ctx} must be a mapping.`, ctx);
  }
  const command = requireString(
    raw.command,
    `${ctx}.command`,
    'agent.entrypoint.command.required',
    { minLength: 1 },
  );
  const out: Entrypoint = { command };
  if (raw.args !== undefined) {
    out.args = parseStringArray(raw.args, `${ctx}.args`, 'agent.entrypoint.args.type');
  }
  if (raw.help !== undefined) {
    out.help = requireString(raw.help, `${ctx}.help`, 'agent.entrypoint.help.type', {
      minLength: 1,
    });
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['command', 'args', 'help']),
    ctx,
    'agent.entrypoint.unknown_field',
  );
  return out;
}

function parseInteraction(raw: unknown, ctx: string): InteractionConfig {
  if (!isRecord(raw)) {
    fail('agent.interaction.type', `${ctx} must be a mapping.`, ctx);
  }
  if (typeof raw.mode !== 'string' || !VALID_INTERACTION_MODES.has(raw.mode)) {
    fail(
      'agent.interaction.mode.enum',
      `${ctx}.mode must be 'direct' or 'supervised'.`,
      `${ctx}.mode`,
    );
  }
  ensureNoUnknownKeys(raw, new Set(['mode']), ctx, 'agent.interaction.unknown_field');
  return { mode: raw.mode as InteractionMode };
}

function parseModel(raw: unknown, ctx: string): ModelConfig {
  if (!isRecord(raw)) {
    fail('agent.model.type', `${ctx} must be a mapping.`, ctx);
  }
  const env = requireString(raw.env, `${ctx}.env`, 'agent.model.env.required', { minLength: 1 });
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) {
    fail(
      'agent.model.env.pattern',
      `${ctx}.env must be a valid environment variable name (letters, digits, underscore; not starting with a digit): got ${JSON.stringify(env)}.`,
      `${ctx}.env`,
    );
  }
  if (isReservedEnvKey(env)) {
    fail(
      'agent.model.env.reserved',
      `${ctx}.env: env names starting with 'BUNSEN_' are reserved by the platform.`,
      `${ctx}.env`,
    );
  }
  const out: ModelConfig = { env };
  if (raw.default !== undefined) {
    out.default = requireString(raw.default, `${ctx}.default`, 'agent.model.default.type', {
      minLength: 1,
    });
  }
  ensureNoUnknownKeys(raw, new Set(['env', 'default']), ctx, 'agent.model.unknown_field');
  return out;
}

function parseDefaults(raw: unknown, ctx: string): AgentDefaults {
  if (!isRecord(raw)) {
    fail('agent.defaults.type', `${ctx} must be a mapping.`, ctx);
  }
  const out: AgentDefaults = {};
  if (raw.env !== undefined) {
    if (!isRecord(raw.env)) {
      fail('agent.defaults.env.type', `${ctx}.env must be a mapping.`, `${ctx}.env`);
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.env)) {
      if (isReservedEnvKey(key)) {
        fail(
          'agent.defaults.env.reserved',
          `${ctx}.env.${key}: env names starting with 'BUNSEN_' are reserved by the platform.`,
          `${ctx}.env.${key}`,
        );
      }
      if (typeof value !== 'string') {
        fail(
          'agent.defaults.env.value.type',
          `${ctx}.env.${key} must be a string.`,
          `${ctx}.env.${key}`,
        );
      }
      env[key] = value;
    }
    out.env = env;
  }
  if (raw.passEnv !== undefined) {
    if (!Array.isArray(raw.passEnv)) {
      fail('agent.defaults.passEnv.type', `${ctx}.passEnv must be an array.`, `${ctx}.passEnv`);
    }
    const seen = new Set<string>();
    out.passEnv = raw.passEnv.map((item, i) => {
      if (typeof item !== 'string' || item.length === 0) {
        fail(
          'agent.defaults.passEnv.item.type',
          `${ctx}.passEnv[${i}] must be a non-empty string.`,
          `${ctx}.passEnv[${i}]`,
        );
      }
      if (isReservedEnvKey(item)) {
        fail(
          'agent.defaults.passEnv.reserved',
          `${ctx}.passEnv[${i}]: env names starting with 'BUNSEN_' are reserved.`,
          `${ctx}.passEnv[${i}]`,
        );
      }
      if (seen.has(item)) {
        fail(
          'agent.defaults.passEnv.duplicate',
          `${ctx}.passEnv[${i}]: duplicate entry ${JSON.stringify(item)}.`,
          `${ctx}.passEnv[${i}]`,
        );
      }
      seen.add(item);
      return item;
    });
  }
  ensureNoUnknownKeys(raw, new Set(['env', 'passEnv']), ctx, 'agent.defaults.unknown_field');
  return out;
}

function parseExamples(raw: unknown, ctx: string): AgentExample[] {
  if (!Array.isArray(raw)) {
    fail('agent.examples.type', `${ctx} must be an array.`, ctx);
  }
  return raw.map((entry, i) => {
    if (!isRecord(entry)) {
      fail('agent.examples.item.type', `${ctx}[${i}] must be a mapping.`, `${ctx}[${i}]`);
    }
    // Legacy shape: { command, context }. Surface a clear migration hint.
    if ('command' in entry || 'context' in entry) {
      fail(
        'agent.examples.legacy_field',
        `${ctx}[${i}]: legacy 'command'/'context' fields are replaced by 'invocation'/'prompt'.`,
        `${ctx}[${i}]`,
      );
    }
    const prompt = requireString(
      entry.prompt,
      `${ctx}[${i}].prompt`,
      'agent.examples.prompt.required',
      { minLength: 1 },
    );
    const invocation = requireString(
      entry.invocation,
      `${ctx}[${i}].invocation`,
      'agent.examples.invocation.required',
      { minLength: 1 },
    );
    ensureNoUnknownKeys(
      entry,
      new Set(['prompt', 'invocation']),
      `${ctx}[${i}]`,
      'agent.examples.unknown_field',
    );
    return { prompt, invocation };
  });
}

function parseVariants(
  raw: unknown,
  ctx: string,
  onWarning?: (w: AgentWarning) => void,
  resource?: string,
): Record<string, AgentVariant> {
  if (!isRecord(raw)) {
    fail('agent.variants.type', `${ctx} must be a mapping of variant-name → overlay.`, ctx);
  }
  const out: Record<string, AgentVariant> = {};
  for (const [name, rawVariant] of Object.entries(raw)) {
    if (!isRecord(rawVariant)) {
      fail('agent.variants.item.type', `${ctx}.${name} must be a mapping.`, `${ctx}.${name}`);
    }
    out[name] = parseVariant(rawVariant, `${ctx}.${name}`, onWarning, resource);
  }
  return out;
}

function parseVariant(
  raw: Raw,
  ctx: string,
  onWarning?: (w: AgentWarning) => void,
  resource?: string,
): AgentVariant {
  for (const [legacy, hint] of Object.entries(LEGACY_VARIANT_HINTS)) {
    if (legacy in raw) {
      fail(
        'agent.variant.legacy_field',
        `${ctx}.${legacy} is no longer supported — ${hint}.`,
        `${ctx}.${legacy}`,
      );
    }
  }

  const out: AgentVariant = {};
  if (raw.description !== undefined) {
    out.description = requireString(
      raw.description,
      `${ctx}.description`,
      'agent.variant.description.type',
    );
  }
  if (raw.install !== undefined) {
    out.install = parseVariantInstall(raw.install, `${ctx}.install`, onWarning, resource);
  }
  if (raw.entrypoint !== undefined) {
    out.entrypoint = parseVariantEntrypoint(raw.entrypoint, `${ctx}.entrypoint`);
  }
  if (raw.interaction !== undefined) {
    out.interaction = parseInteraction(raw.interaction, `${ctx}.interaction`);
  }
  if (raw.defaults !== undefined) {
    out.defaults = parseDefaults(raw.defaults, `${ctx}.defaults`);
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['description', 'install', 'entrypoint', 'interaction', 'defaults']),
    ctx,
    'agent.variant.unknown_field',
  );
  return out;
}

function parseVariantInstall(
  raw: unknown,
  ctx: string,
  onWarning?: (w: AgentWarning) => void,
  resource?: string,
): VariantInstallConfig {
  if (!isRecord(raw)) {
    fail('agent.variant.install.type', `${ctx} must be a mapping.`, ctx);
  }
  const out: VariantInstallConfig = {};
  if (raw.source !== undefined) {
    out.source = parseVariantInstallSource(raw.source, `${ctx}.source`, onWarning);
  }
  if (raw.deps !== undefined) {
    out.deps = parseDeps(raw.deps, `${ctx}.deps`, resource);
  }
  if (raw.build !== undefined) {
    out.build = parseBuild(raw.build, `${ctx}.build`);
  }
  if (raw.configure !== undefined) {
    out.configure = parseVariantConfigure(raw.configure, `${ctx}.configure`);
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['source', 'deps', 'build', 'configure']),
    ctx,
    'agent.variant.install.unknown_field',
  );
  return out;
}

/**
 * Variant `install.configure` accepts either the raw step array (shorthand
 * for `{ mergeMode: 'replace', items: [...] }`) or the wrapped form with an
 * explicit `mergeMode`.
 */
function parseVariantConfigure(raw: unknown, ctx: string): VariantConfigureSteps {
  if (Array.isArray(raw)) {
    return parseConfigure(raw, ctx);
  }
  if (!isRecord(raw)) {
    fail(
      'agent.variant.install.configure.type',
      `${ctx} must be an array of steps or an object with 'mergeMode' and 'items'.`,
      ctx,
    );
  }
  if (!Array.isArray(raw.items)) {
    fail(
      'agent.variant.install.configure.items.required',
      `${ctx}.items must be an array of steps.`,
      `${ctx}.items`,
    );
  }
  let mergeMode: 'append' | 'replace' = 'replace';
  if (raw.mergeMode !== undefined) {
    if (raw.mergeMode !== 'append' && raw.mergeMode !== 'replace') {
      fail(
        'agent.variant.install.configure.mergeMode.enum',
        `${ctx}.mergeMode must be 'append' or 'replace'.`,
        `${ctx}.mergeMode`,
      );
    }
    mergeMode = raw.mergeMode;
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['mergeMode', 'items']),
    ctx,
    'agent.variant.install.configure.unknown_field',
  );
  const items = parseConfigure(raw.items, `${ctx}.items`);
  return { mergeMode, items };
}

/**
 * Variant overrides for `install.source` accept two shapes:
 * 1. A full source object (`{ type, ... }`), which replaces the base source.
 * 2. A partial (`{ ref }` or `{ version }`), which patches the base source's
 *    corresponding field. This is the common "main vs experimental-branch"
 *    case called out in the design doc.
 *
 * The parser accepts both shapes here as a {@link VariantInstallSource}.
 * {@link applyAgentVariant} merges it against the base.
 */
function parseVariantInstallSource(
  raw: unknown,
  ctx: string,
  onWarning?: (w: AgentWarning) => void,
): VariantInstallSource {
  if (!isRecord(raw)) {
    fail('agent.variant.install.source.type', `${ctx} must be a mapping.`, ctx);
  }
  if (typeof raw.type === 'string') {
    return parseInstallSource(raw, ctx, onWarning);
  }
  // Partial override: must be 'ref' and/or 'version' only.
  const keys = Object.keys(raw);
  const allowed = new Set(['ref', 'version']);
  for (const key of keys) {
    if (!allowed.has(key)) {
      fail(
        'agent.variant.install.source.partial.unknown_field',
        `${ctx}: partial install.source override must only contain 'ref' and/or 'version' (add 'type' to replace the whole block). Got '${key}'.`,
        `${ctx}.${key}`,
      );
    }
  }
  const out: { ref?: string; version?: string } = {};
  if (raw.ref !== undefined) {
    out.ref = requireString(raw.ref, `${ctx}.ref`, 'agent.variant.install.source.ref.type', {
      minLength: 1,
    });
  }
  if (raw.version !== undefined) {
    out.version = requireString(
      raw.version,
      `${ctx}.version`,
      'agent.variant.install.source.version.type',
      { minLength: 1 },
    );
  }
  if (out.ref === undefined && out.version === undefined) {
    fail(
      'agent.variant.install.source.partial.empty',
      `${ctx}: partial install.source override must set at least one of 'ref', 'version'.`,
      ctx,
    );
  }
  return out;
}

function parseVariantEntrypoint(raw: unknown, ctx: string): Partial<Entrypoint> {
  if (!isRecord(raw)) {
    fail('agent.variant.entrypoint.type', `${ctx} must be a mapping.`, ctx);
  }
  const out: Partial<Entrypoint> = {};
  if (raw.command !== undefined) {
    out.command = requireString(
      raw.command,
      `${ctx}.command`,
      'agent.variant.entrypoint.command.type',
      { minLength: 1 },
    );
  }
  if (raw.args !== undefined) {
    out.args = parseStringArray(raw.args, `${ctx}.args`, 'agent.variant.entrypoint.args.type');
  }
  if (raw.help !== undefined) {
    out.help = requireString(raw.help, `${ctx}.help`, 'agent.variant.entrypoint.help.type', {
      minLength: 1,
    });
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['command', 'args', 'help']),
    ctx,
    'agent.variant.entrypoint.unknown_field',
  );
  return out;
}

// ---------------------------------------------------------------------------
// Variant application
// ---------------------------------------------------------------------------

/**
 * Apply a variant overlay to a base config and return a new {@link AgentConfig}.
 *
 * Merge semantics:
 * - Scalar/object fields shallow-merge.
 * - Arrays replace wholesale by default (e.g. `entrypoint.args`).
 * - `install.configure` accepts the {@link MergeableArray} wrapper with
 *   `mergeMode: 'append'` to concatenate onto the base configure list.
 * - `install.source` may be overridden as a whole block (`{ type, ... }`) or
 *   patched via `{ ref }` / `{ version }`.
 * - `defaults.env` merges key-by-key with the base.
 */
export function applyAgentVariant(base: AgentConfig, variantName: string): AgentConfig {
  if (!base.variants || !(variantName in base.variants)) {
    const available = base.variants ? Object.keys(base.variants).join(', ') || '(none)' : '(none)';
    throw new AgentConfigError(
      'agent.variant.unknown',
      `Unknown variant ${JSON.stringify(variantName)}. Available: ${available}.`,
      { path: `variants.${variantName}` },
    );
  }
  const variant = base.variants[variantName];

  const merged: AgentConfig = {
    ...base,
    install: mergeInstall(base.install, variant.install, variantName),
    entrypoint: mergeEntrypoint(base.entrypoint, variant.entrypoint),
    interaction: variant.interaction?.mode
      ? { mode: variant.interaction.mode }
      : base.interaction,
    defaults: mergeDefaults(base.defaults, variant.defaults),
  };

  if (variant.description !== undefined) merged.description = variant.description;

  // Drop variants from the merged output so consumers don't accidentally chain.
  delete merged.variants;
  return merged;
}

function mergeInstall(
  base: InstallConfig,
  overlay: VariantInstallConfig | undefined,
  variantName: string,
): InstallConfig {
  if (!overlay) return base;
  const out: InstallConfig = { ...base };
  if (overlay.source !== undefined) {
    out.source = mergeInstallSource(base.source, overlay.source, variantName);
  }
  if (overlay.deps !== undefined) out.deps = overlay.deps;
  if (overlay.build !== undefined) out.build = overlay.build;
  if (overlay.configure !== undefined) {
    out.configure = mergeConfigure(base.configure, overlay.configure);
  }
  return out;
}

function mergeConfigure(
  base: ConfigureStep[] | undefined,
  overlay: VariantConfigureSteps,
): ConfigureStep[] {
  if (Array.isArray(overlay)) {
    // Raw-array shorthand = replace.
    return overlay;
  }
  if (overlay.mergeMode === 'append') {
    return [...(base ?? []), ...overlay.items];
  }
  return overlay.items;
}

function mergeInstallSource(
  base: InstallSource,
  overlay: VariantInstallSource,
  variantName: string,
): InstallSource {
  // A full override has a `type` that matches one of the source discriminators.
  if ('type' in overlay) {
    return overlay;
  }
  // Partial override — apply field-by-field against the base source.
  if (base.type === 'git') {
    if ('version' in overlay && overlay.version !== undefined) {
      throw new AgentConfigError(
        'agent.variant.install.source.partial.mismatch',
        `variants.${variantName}.install.source: 'version' override does not apply to git sources (use 'ref' instead).`,
        { path: `variants.${variantName}.install.source.version` },
      );
    }
    return overlay.ref !== undefined ? { ...base, ref: overlay.ref } : base;
  }
  if (base.type === 'npm') {
    if ('ref' in overlay && overlay.ref !== undefined) {
      throw new AgentConfigError(
        'agent.variant.install.source.partial.mismatch',
        `variants.${variantName}.install.source: 'ref' override does not apply to npm sources (use 'version' instead).`,
        { path: `variants.${variantName}.install.source.ref` },
      );
    }
    return overlay.version !== undefined ? { ...base, version: overlay.version } : base;
  }
  throw new AgentConfigError(
    'agent.variant.install.source.partial.mismatch',
    `variants.${variantName}.install.source: partial 'ref'/'version' override only applies to git/npm sources (base is ${base.type}). Provide the full { type, ... } block to replace the source entirely.`,
    { path: `variants.${variantName}.install.source` },
  );
}

function mergeEntrypoint(
  base: Entrypoint,
  overlay: Partial<Entrypoint> | undefined,
): Entrypoint {
  if (!overlay) return base;
  const out: Entrypoint = { ...base };
  if (overlay.command !== undefined) out.command = overlay.command;
  if (overlay.args !== undefined) out.args = overlay.args;
  if (overlay.help !== undefined) out.help = overlay.help;
  return out;
}

function mergeDefaults(
  base: AgentDefaults | undefined,
  overlay: Partial<AgentDefaults> | undefined,
): AgentDefaults | undefined {
  if (!base && !overlay) return undefined;
  const merged: AgentDefaults = {};
  if (base?.env || overlay?.env) {
    merged.env = { ...(base?.env ?? {}), ...(overlay?.env ?? {}) };
  }
  if (base?.passEnv || overlay?.passEnv) {
    const combined = [...(base?.passEnv ?? []), ...(overlay?.passEnv ?? [])];
    merged.passEnv = Array.from(new Set(combined));
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

// ---------------------------------------------------------------------------
// loadAgent
// ---------------------------------------------------------------------------

export interface LoadAgentOptions {
  variant?: string;
  onWarning?: (warning: AgentWarning) => void;
}

/**
 * Load, validate, and optionally variant-resolve an agent from a directory.
 *
 * @param agentPath Path to the agent directory containing `agent.yaml`.
 * @param options Optional variant and warning callback.
 */
export function loadAgent(agentPath: string, options: LoadAgentOptions = {}): ResolvedAgent {
  const dir = path.resolve(agentPath);
  const configPath = path.join(dir, 'agent.yaml');
  if (!fs.existsSync(configPath)) {
    throw new AgentConfigError(
      'agent.config.missing',
      `agent.yaml not found: ${configPath}`,
      { resource: configPath },
    );
  }
  const source = fs.readFileSync(configPath, 'utf8');
  const base = parseAgentConfig(source, {
    source: configPath,
    onWarning: options.onWarning,
  });
  const config = options.variant !== undefined ? applyAgentVariant(base, options.variant) : base;

  const resolved: ResolvedAgent = {
    ...config,
    path: dir,
    configPath,
  };
  if (options.variant !== undefined) resolved.variant = options.variant;
  return resolved;
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

/**
 * The resolved model wiring for a run: which env var carries the model, the
 * declared default, and the `--model` override (if any). `value` is what the
 * agent will actually use absent any experiment/CLI env override of the same
 * var (`overrideValue ?? defaultValue`).
 */
export interface ModelSelection {
  /** Env var the harness reads the model id from (`agent.model.env`). */
  envName: string;
  /** Declared default model id, if the agent declared one. */
  defaultValue?: string;
  /** `--model` override, if one was passed. */
  overrideValue?: string;
  /** `overrideValue ?? defaultValue`. */
  value?: string;
}

/**
 * Resolve a `--model` request against an agent's declared model wiring.
 *
 * Throws when `requestedModel` is given but the agent declares no `model.env`
 * (the harness exposes no model knob we can target). Returns `undefined` for
 * an agent with no model declaration and no request (nothing to do).
 */
export function resolveModelSelection(
  agent: AgentConfig,
  requestedModel: string | undefined,
): ModelSelection | undefined {
  if (requestedModel !== undefined && !agent.model) {
    throw new AgentConfigError(
      'agent.model.unsupported',
      `Agent ${JSON.stringify(agent.name)} does not support --model: it declares no 'model' block in agent.yaml. ` +
        `Add a top-level 'model: { env: <VAR> }' naming the env var the harness reads its model from, ` +
        `or set the model directly with --env.`,
    );
  }
  if (!agent.model) return undefined;
  const selection: ModelSelection = { envName: agent.model.env };
  if (agent.model.default !== undefined) selection.defaultValue = agent.model.default;
  if (requestedModel !== undefined) selection.overrideValue = requestedModel;
  const value = requestedModel ?? agent.model.default;
  if (value !== undefined) selection.value = value;
  return selection;
}

// ---------------------------------------------------------------------------
// Agent:variant syntax helper
// ---------------------------------------------------------------------------

/**
 * Split `agentName[:variant]` into `[name, variant?]`.
 * Preserves Windows drive letters (`C:\…`) and URL-like paths (`…:/…`) so
 * those don't get parsed as variants.
 */
export function parseAgentVariantSyntax(agentSpec: string): [string, string | undefined] {
  const colonIndex = agentSpec.lastIndexOf(':');
  if (colonIndex === -1) return [agentSpec, undefined];
  if (colonIndex < agentSpec.length - 1) {
    const afterColon = agentSpec[colonIndex + 1];
    if (afterColon === '/' || afterColon === '\\') return [agentSpec, undefined];
  }
  if (colonIndex === 1 && /^[a-zA-Z]$/.test(agentSpec[0])) return [agentSpec, undefined];
  const agentName = agentSpec.substring(0, colonIndex);
  const variantName = agentSpec.substring(colonIndex + 1);
  if (variantName === '') return [agentSpec, undefined];
  return [agentName, variantName];
}

/** List of variant names defined on an agent (empty if none). */
export function getAgentVariants(agent: AgentConfig): string[] {
  if (!agent.variants) return [];
  return Object.keys(agent.variants);
}
