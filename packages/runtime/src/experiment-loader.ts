// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `experiment.yaml` v1 parser and loader.
 *
 * Reads the v1 schema (see `@bunsen-dev/types/schemas/experiment.v1.json` and the
 * experiment section of `docs/ENVIRONMENT.md`), validates required fields and
 * cross-field invariants, resolves variants, resolves workspace sources against
 * the experiment directory, and detects workspace-source path collisions.
 *
 * This is the single path for reading experiment YAML. There is no legacy
 * fallback — the old flat-schema format is rejected.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { isReservedEnvKey } from './project-loader.js';
import {
  parseSchemaMeta,
  parseDuration,
  InvalidDurationError,
  type ExperimentConfig,
  type TaskConfig,
  type WorkspaceConfig,
  type WorkspaceSourceEntry,
  type EnvironmentConfig,
  type RunConfig,
  type EvaluationConfig,
  type Criterion,
  type CriterionGate,
  type JudgeEvidence,
  type AggregateFunction,
  type AllowedScores,
  type ReportConfig,
  type ExperimentVariant,
  type StepConfig,
  type RunStep,
  type WriteFileStep,
  type RunPlatform,
  type RuntimeName,
  type PackageSpecs,
  type ExecutionUser,
} from '@bunsen-dev/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single resolved workspace-source entry, ready for runtime assembly. */
export interface ResolvedWorkspaceSource {
  /** Which kind of source this resolves from. */
  type: 'path' | 'image';
  /** Absolute filesystem path for `type: path`; image path for `type: image`. */
  sourcePath: string;
  /** Destination inside the workspace (relative). */
  target?: string;
  /** The original authored entry (for diagnostics). */
  original: WorkspaceSourceEntry;
  /** Source index within `workspace.sources`. */
  index: number;
}

/**
 * A fully loaded + variant-resolved experiment. This is the working shape the
 * runtime operates on: the authored v1 {@link ExperimentConfig} plus the
 * filesystem context needed to actually execute it.
 */
export interface ResolvedExperiment extends ExperimentConfig {
  /** Absolute path to the experiment directory. */
  dir: string;
  /** Absolute path to `experiment.yaml` within the directory. */
  configPath: string;
  /** Selected variant name, if any. */
  variant?: string;
  /** Ordered resolved workspace sources (may be empty). */
  workspaceSources: ResolvedWorkspaceSource[];
  /** Whether the experiment ships a custom Dockerfile. */
  hasDockerfile: boolean;
  /** Whether the experiment ships a `verifiers/` directory. */
  hasVerifiers: boolean;
  /** Absolute path to the verifiers directory, if present. */
  verifiersPath?: string;
}

/**
 * Structured error raised by the experiment loader.
 *
 * Callers can inspect `code` to build machine-readable diagnostics; `path`
 * is a dot-path into the experiment document for the offending field.
 */
export class ExperimentConfigError extends Error {
  readonly code: string;
  readonly path?: string;
  readonly resource?: string;

  constructor(code: string, message: string, options: { path?: string; resource?: string } = {}) {
    super(message);
    this.name = 'ExperimentConfigError';
    this.code = code;
    this.path = options.path;
    this.resource = options.resource;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_RUNTIME_NAMES: ReadonlySet<string> = new Set([
  'node',
  'python',
  'go',
  'rust',
  'ruby',
]);

const VALID_PACKAGE_KEYS: ReadonlySet<string> = new Set(['apt', 'npm', 'pip', 'cargo']);

const VALID_EXECUTION_USERS: ReadonlySet<string> = new Set(['user', 'root']);

const VALID_PLATFORMS: ReadonlySet<string> = new Set(['linux/amd64', 'linux/arm64']);

const VALID_RUN_PLATFORMS: ReadonlySet<string> = new Set([
  'auto',
  'linux/amd64',
  'linux/arm64',
]);

const VALID_CRITERION_TYPES: ReadonlySet<string> = new Set([
  'script',
  'judge',
  'agent',
  'browser-agent',
  'aggregate',
]);

const VALID_JUDGE_EVIDENCE: ReadonlySet<string> = new Set(['diff', 'logs', 'traces']);

const VALID_AGGREGATE_FUNCTIONS: ReadonlySet<string> = new Set([
  'weighted_average',
  'all',
  'any',
  'min',
  'max',
]);

const VALID_EVALUATION_CONTAINERS: ReadonlySet<string> = new Set(['dedicated', 'agent']);

/**
 * Legacy field names present at the top level of old experiment.yaml. If any
 * are present, the parser fails with a clear migration hint instead of a
 * generic "unknown field" error.
 */
const LEGACY_FIELD_HINTS: Record<string, string> = {
  base: 'moved to `environment.image.base`',
  rubric: 'renamed to `evaluation.criteria`',
  timeout: 'moved to `run.timeout` (use a duration string like "5m")',
  setup: 'moved to `environment.requires.packages.*`',
  requires_root: 'replaced by `environment.user: root`',
  score_in_agent_container: 'replaced by `evaluation.container: agent`',
  workspace_setup: 'moved to `workspace.setup`',
  workspace_setup_timeout: 'folded into `workspace.setup[].timeout`',
  artifact_capture_timeout: 'renamed to `run.artifactCaptureTimeout` (duration string)',
  platforms: 'moved to `environment.platforms`',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string, path?: string): never {
  throw new ExperimentConfigError(code, message, { path });
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

// ---------------------------------------------------------------------------
// Top-level parser
// ---------------------------------------------------------------------------

/**
 * Parse raw YAML data into an {@link ExperimentConfig}.
 *
 * Accepts either a parsed object or the raw YAML string. Validates the schema
 * version, required fields, criterion types, and durations. Does **not** apply
 * variants — use {@link applyVariant} or {@link loadExperiment}.
 */
export function parseExperimentConfig(
  input: unknown | string,
  options: { source?: string } = {},
): ExperimentConfig {
  const resource = options.source;
  const raw = typeof input === 'string' ? yaml.load(input) : input;

  if (!isRecord(raw)) {
    throw new ExperimentConfigError(
      'experiment.root.type',
      `${resource ? `${resource}: ` : ''}experiment.yaml must be a YAML mapping.`,
      { resource },
    );
  }

  // Migration hints for legacy top-level fields before anything else.
  for (const [field, hint] of Object.entries(LEGACY_FIELD_HINTS)) {
    if (field in raw) {
      throw new ExperimentConfigError(
        'experiment.legacy_field',
        `Legacy experiment.yaml field '${field}' is no longer supported — ${hint}. ` +
          `See @bunsen-dev/types/schemas/experiment.v1.json for the new schema.`,
        { resource, path: field },
      );
    }
  }

  // Schema meta (version, $schema).
  parseSchemaMeta(raw, { resource: resource ?? 'experiment.yaml' });

  // Top-level required fields.
  const name = requireString(raw.name, 'name', 'experiment.name.required', {
    minLength: 1,
  });
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    fail(
      'experiment.name.pattern',
      `name must be kebab-case (ASCII, lowercase, digits, hyphens; starting with a letter or digit): got ${JSON.stringify(name)}.`,
      'name',
    );
  }

  const description =
    raw.description === undefined
      ? undefined
      : requireString(raw.description, 'description', 'experiment.description.type');

  const labels = parseLabels(raw.labels, 'labels');

  if (raw.task === undefined) {
    fail('experiment.task.required', `'task' is required.`, 'task');
  }
  const task = parseTask(raw.task);

  const workspace =
    raw.workspace === undefined ? undefined : parseWorkspace(raw.workspace, 'workspace');

  if (raw.environment === undefined) {
    fail('experiment.environment.required', `'environment' is required.`, 'environment');
  }
  const environment = parseEnvironment(raw.environment, 'environment');

  const run = raw.run === undefined ? undefined : parseRunConfig(raw.run, 'run');

  if (raw.evaluation === undefined) {
    fail('experiment.evaluation.required', `'evaluation' is required.`, 'evaluation');
  }
  const evaluation = parseEvaluation(raw.evaluation, 'evaluation');

  const env = raw.env === undefined ? undefined : parseEnv(raw.env, 'env');
  const passEnv = raw.passEnv === undefined ? undefined : parsePassEnv(raw.passEnv, 'passEnv');

  const variants =
    raw.variants === undefined ? undefined : parseVariants(raw.variants, 'variants');

  const rootAllowed: ReadonlySet<string> = new Set([
    '$schema',
    'version',
    'name',
    'description',
    'labels',
    'task',
    'workspace',
    'environment',
    'run',
    'evaluation',
    'env',
    'passEnv',
    'variants',
  ]);
  ensureNoUnknownKeys(raw, rootAllowed, '(root)', 'experiment.unknown_field');

  const config: ExperimentConfig = {
    version: 'v1',
    name,
    task,
    environment,
    evaluation,
  };
  if (typeof raw.$schema === 'string') config.$schema = raw.$schema;
  if (description !== undefined) config.description = description;
  if (labels !== undefined) config.labels = labels;
  if (workspace !== undefined) config.workspace = workspace;
  if (run !== undefined) config.run = run;
  if (env !== undefined) config.env = env;
  if (passEnv !== undefined) config.passEnv = passEnv;
  if (variants !== undefined) config.variants = variants;

  // Validate the criteria graph on the *base* config. We also re-validate after
  // applying a variant, since variants can add or replace criteria.
  validateCriteriaGraph(config, 'evaluation.criteria');

  return config;
}

// ---------------------------------------------------------------------------
// Sub-parsers
// ---------------------------------------------------------------------------

function parseEnv(raw: unknown, ctx: string): Record<string, string> {
  if (!isRecord(raw)) {
    fail('experiment.env.type', `${ctx} must be a mapping of string → string.`, ctx);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isReservedEnvKey(key)) {
      fail(
        'experiment.env.reserved',
        `${ctx}.${key}: env names starting with 'BUNSEN_' are reserved by the platform.`,
        `${ctx}.${key}`,
      );
    }
    if (typeof value !== 'string') {
      fail(
        'experiment.env.value',
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
    fail('experiment.passEnv.type', `${ctx} must be an array of env var names.`, ctx);
  }
  const seen = new Set<string>();
  return raw.map((item, i) => {
    if (typeof item !== 'string' || item.length === 0) {
      fail(
        'experiment.passEnv.item.type',
        `${ctx}[${i}] must be a non-empty string.`,
        `${ctx}[${i}]`,
      );
    }
    if (isReservedEnvKey(item)) {
      fail(
        'experiment.passEnv.reserved',
        `${ctx}[${i}]: env names starting with 'BUNSEN_' are reserved and cannot be allowlisted.`,
        `${ctx}[${i}]`,
      );
    }
    if (seen.has(item)) {
      fail(
        'experiment.passEnv.duplicate',
        `${ctx}[${i}]: duplicate entry ${JSON.stringify(item)}.`,
        `${ctx}[${i}]`,
      );
    }
    seen.add(item);
    return item;
  });
}

function parseLabels(raw: unknown, ctx: string): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    fail('experiment.labels.type', `${ctx} must be a mapping of string → string.`, ctx);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string') {
      fail('experiment.labels.value', `${ctx}.${k} must be a string.`, `${ctx}.${k}`);
    }
    out[k] = v;
  }
  return out;
}

function parseTask(raw: unknown): TaskConfig {
  if (!isRecord(raw)) {
    fail('experiment.task.type', `'task' must be a mapping with a 'prompt' field.`, 'task');
  }
  const prompt = requireString(raw.prompt, 'task.prompt', 'experiment.task.prompt.required', {
    minLength: 1,
  });
  ensureNoUnknownKeys(raw, new Set(['prompt']), 'task', 'experiment.task.unknown_field');
  return { prompt };
}

function parseWorkspace(raw: unknown, ctx: string): WorkspaceConfig {
  if (!isRecord(raw)) {
    fail('experiment.workspace.type', `${ctx} must be a mapping.`, ctx);
  }
  const out: WorkspaceConfig = {};
  if (raw.sources !== undefined) {
    if (!Array.isArray(raw.sources)) {
      fail(
        'experiment.workspace.sources.type',
        `${ctx}.sources must be an array.`,
        `${ctx}.sources`,
      );
    }
    out.sources = raw.sources.map((entry, i) =>
      parseWorkspaceSource(entry, `${ctx}.sources[${i}]`),
    );
  }
  if (raw.setup !== undefined) {
    if (!Array.isArray(raw.setup)) {
      fail('experiment.workspace.setup.type', `${ctx}.setup must be an array.`, `${ctx}.setup`);
    }
    out.setup = raw.setup.map((entry, i) => parseStep(entry, `${ctx}.setup[${i}]`));
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['sources', 'setup']),
    ctx,
    'experiment.workspace.unknown_field',
  );
  return out;
}

function parseWorkspaceSource(raw: unknown, ctx: string): WorkspaceSourceEntry {
  if (!isRecord(raw)) {
    fail('experiment.workspace.source.type', `${ctx} must be a mapping.`, ctx);
  }
  const hasPath = raw.path !== undefined;
  const hasImagePath = raw.imagePath !== undefined;
  if (hasPath === hasImagePath) {
    fail(
      'experiment.workspace.source.one_of',
      `${ctx}: exactly one of 'path' or 'imagePath' must be set.`,
      ctx,
    );
  }
  if (raw.image_path !== undefined) {
    fail(
      'experiment.workspace.source.legacy_field',
      `${ctx}: legacy field 'image_path' renamed to 'imagePath'.`,
      `${ctx}.image_path`,
    );
  }

  const allowedKeys: ReadonlySet<string> = new Set(['path', 'imagePath', 'target']);
  ensureNoUnknownKeys(raw, allowedKeys, ctx, 'experiment.workspace.source.unknown_field');

  let target: string | undefined;
  if (raw.target !== undefined) {
    const t = requireString(raw.target, `${ctx}.target`, 'experiment.workspace.source.target.type', {
      minLength: 1,
    });
    const normalized = path.posix.normalize(t.trim());
    if (path.posix.isAbsolute(normalized)) {
      fail(
        'experiment.workspace.source.target.absolute',
        `${ctx}.target must be a relative path (got ${JSON.stringify(t)}).`,
        `${ctx}.target`,
      );
    }
    if (normalized === '..' || normalized.startsWith('../')) {
      fail(
        'experiment.workspace.source.target.escape',
        `${ctx}.target must not escape the workspace root.`,
        `${ctx}.target`,
      );
    }
    target = normalized === '.' ? undefined : normalized;
  }

  if (hasPath) {
    const p = requireString(raw.path, `${ctx}.path`, 'experiment.workspace.source.path.type', {
      minLength: 1,
    });
    return target === undefined ? { path: p } : { path: p, target };
  }
  const ip = requireString(
    raw.imagePath,
    `${ctx}.imagePath`,
    'experiment.workspace.source.imagePath.type',
    { minLength: 1 },
  );
  return target === undefined ? { imagePath: ip } : { imagePath: ip, target };
}

function parseStep(raw: unknown, ctx: string): StepConfig {
  if (!isRecord(raw)) {
    fail('experiment.step.type', `${ctx} must be a mapping.`, ctx);
  }
  const hasRun = raw.run !== undefined;
  const hasWriteFile = raw.writeFile !== undefined;
  if (hasRun && hasWriteFile) {
    fail(
      'experiment.step.exclusive',
      `${ctx}: a step may set 'run' or 'writeFile', not both.`,
      ctx,
    );
  }
  if (!hasRun && !hasWriteFile) {
    fail(
      'experiment.step.required',
      `${ctx}: a step must set either 'run' or 'writeFile'.`,
      ctx,
    );
  }
  return hasWriteFile ? parseExperimentWriteFileStep(raw, ctx) : parseExperimentRunStep(raw, ctx);
}

function parseExperimentRunStep(raw: Record<string, unknown>, ctx: string): RunStep {
  const run = requireString(raw.run, `${ctx}.run`, 'experiment.step.run.required', {
    minLength: 1,
  });
  const step: RunStep = { run };
  if (raw.as !== undefined) {
    if (typeof raw.as !== 'string' || !VALID_EXECUTION_USERS.has(raw.as)) {
      fail('experiment.step.as.enum', `${ctx}.as must be 'user' or 'root'.`, `${ctx}.as`);
    }
    step.as = raw.as as ExecutionUser;
  }
  if (raw.timeout !== undefined) {
    step.timeout = requireDuration(raw.timeout, `${ctx}.timeout`, 'experiment.step.timeout.type');
  }
  ensureNoUnknownKeys(raw, new Set(['run', 'as', 'timeout']), ctx, 'experiment.step.unknown_field');
  return step;
}

function parseExperimentWriteFileStep(raw: Record<string, unknown>, ctx: string): WriteFileStep {
  const target = requireString(
    raw.writeFile,
    `${ctx}.writeFile`,
    'experiment.step.writeFile.required',
    { minLength: 1 },
  );
  const hasFrom = raw.from !== undefined;
  const hasContent = raw.content !== undefined;
  if (hasFrom && hasContent) {
    fail(
      'experiment.step.writeFile.exclusive',
      `${ctx}: a writeFile step must set 'from' or 'content', not both.`,
      ctx,
    );
  }
  if (!hasFrom && !hasContent) {
    fail(
      'experiment.step.writeFile.source.required',
      `${ctx}: a writeFile step must set either 'from' (path relative to experiment.yaml) or 'content' (inline UTF-8).`,
      ctx,
    );
  }
  const step: WriteFileStep = { writeFile: target };
  if (hasFrom) {
    step.from = requireString(
      raw.from,
      `${ctx}.from`,
      'experiment.step.writeFile.from.type',
      { minLength: 1 },
    );
  }
  if (hasContent) {
    if (typeof raw.content !== 'string') {
      fail(
        'experiment.step.writeFile.content.type',
        `${ctx}.content must be a string.`,
        `${ctx}.content`,
      );
    }
    step.content = raw.content;
  }
  if (raw.as !== undefined) {
    if (typeof raw.as !== 'string' || !VALID_EXECUTION_USERS.has(raw.as)) {
      fail('experiment.step.as.enum', `${ctx}.as must be 'user' or 'root'.`, `${ctx}.as`);
    }
    step.as = raw.as as ExecutionUser;
  }
  if (raw.timeout !== undefined) {
    step.timeout = requireDuration(raw.timeout, `${ctx}.timeout`, 'experiment.step.timeout.type');
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['writeFile', 'from', 'content', 'as', 'timeout']),
    ctx,
    'experiment.step.unknown_field',
  );
  return step;
}

function parseEnvironment(raw: unknown, ctx: string): EnvironmentConfig {
  if (!isRecord(raw)) {
    fail('experiment.environment.type', `${ctx} must be a mapping.`, ctx);
  }

  if (raw.image === undefined) {
    fail(
      'experiment.environment.image.required',
      `${ctx}.image is required (provide 'base' or 'dockerfile').`,
      `${ctx}.image`,
    );
  }
  const rawImage = raw.image;
  if (!isRecord(rawImage)) {
    fail('experiment.environment.image.type', `${ctx}.image must be a mapping.`, `${ctx}.image`);
  }
  const hasBase = rawImage.base !== undefined;
  const hasDockerfile = rawImage.dockerfile !== undefined;
  if (hasBase === hasDockerfile) {
    fail(
      'experiment.environment.image.one_of',
      `${ctx}.image: exactly one of 'base' or 'dockerfile' must be set.`,
      `${ctx}.image`,
    );
  }
  ensureNoUnknownKeys(
    rawImage,
    new Set(['base', 'dockerfile']),
    `${ctx}.image`,
    'experiment.environment.image.unknown_field',
  );
  const image = hasBase
    ? {
        base: requireString(
          rawImage.base,
          `${ctx}.image.base`,
          'experiment.environment.image.base.type',
          { minLength: 1 },
        ),
      }
    : {
        dockerfile: requireString(
          rawImage.dockerfile,
          `${ctx}.image.dockerfile`,
          'experiment.environment.image.dockerfile.type',
          { minLength: 1 },
        ),
      };

  const out: EnvironmentConfig = { image };

  if (raw.requires !== undefined) {
    if (!isRecord(raw.requires)) {
      fail(
        'experiment.environment.requires.type',
        `${ctx}.requires must be a mapping.`,
        `${ctx}.requires`,
      );
    }
    const requires: EnvironmentConfig['requires'] = {};
    if (raw.requires.runtimes !== undefined) {
      requires.runtimes = parseRuntimes(raw.requires.runtimes, `${ctx}.requires.runtimes`);
    }
    if (raw.requires.packages !== undefined) {
      requires.packages = parsePackages(raw.requires.packages, `${ctx}.requires.packages`);
    }
    ensureNoUnknownKeys(
      raw.requires,
      new Set(['runtimes', 'packages']),
      `${ctx}.requires`,
      'experiment.environment.requires.unknown_field',
    );
    if (Object.keys(requires).length > 0) out.requires = requires;
  }

  if (raw.platforms !== undefined) {
    out.platforms = parsePlatformsList(raw.platforms, `${ctx}.platforms`);
  }

  if (raw.user !== undefined) {
    if (typeof raw.user !== 'string' || !VALID_EXECUTION_USERS.has(raw.user)) {
      fail(
        'experiment.environment.user.enum',
        `${ctx}.user must be 'user' or 'root'.`,
        `${ctx}.user`,
      );
    }
    out.user = raw.user as ExecutionUser;
  }

  ensureNoUnknownKeys(
    raw,
    new Set(['image', 'requires', 'platforms', 'user']),
    ctx,
    'experiment.environment.unknown_field',
  );
  return out;
}

function parseRuntimes(raw: unknown, ctx: string): Partial<Record<RuntimeName, string>> {
  if (!isRecord(raw)) {
    fail('experiment.requires.runtimes.type', `${ctx} must be a mapping.`, ctx);
  }
  const out: Partial<Record<RuntimeName, string>> = {};
  for (const [name, version] of Object.entries(raw)) {
    if (!VALID_RUNTIME_NAMES.has(name)) {
      fail(
        'experiment.requires.runtimes.unknown',
        `${ctx}: unknown runtime '${name}'. Valid: node, python, go, rust, ruby.`,
        `${ctx}.${name}`,
      );
    }
    if (typeof version !== 'string' && typeof version !== 'number') {
      fail(
        'experiment.requires.runtimes.version.type',
        `${ctx}.${name} must be a string or number.`,
        `${ctx}.${name}`,
      );
    }
    out[name as RuntimeName] = String(version);
  }
  return out;
}

function parsePackages(raw: unknown, ctx: string): PackageSpecs {
  if (!isRecord(raw)) {
    fail('experiment.requires.packages.type', `${ctx} must be a mapping.`, ctx);
  }
  const out: PackageSpecs = {};
  for (const [manager, packages] of Object.entries(raw)) {
    if (!VALID_PACKAGE_KEYS.has(manager)) {
      fail(
        'experiment.requires.packages.unknown',
        `${ctx}: unknown package manager '${manager}'. Valid: apt, npm, pip, cargo.`,
        `${ctx}.${manager}`,
      );
    }
    if (!Array.isArray(packages)) {
      fail(
        'experiment.requires.packages.list.type',
        `${ctx}.${manager} must be an array of strings.`,
        `${ctx}.${manager}`,
      );
    }
    out[manager as keyof PackageSpecs] = packages.map((pkg, i) => {
      if (typeof pkg !== 'string') {
        fail(
          'experiment.requires.packages.item.type',
          `${ctx}.${manager}[${i}] must be a string.`,
          `${ctx}.${manager}[${i}]`,
        );
      }
      return pkg;
    });
  }
  return out;
}

function parsePlatformsList(raw: unknown, ctx: string): RunPlatform[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail('experiment.environment.platforms.type', `${ctx} must be a non-empty array.`, ctx);
  }
  return raw.map((item, i) => {
    if (typeof item !== 'string' || !VALID_PLATFORMS.has(item)) {
      fail(
        'experiment.environment.platforms.enum',
        `${ctx}[${i}] must be 'linux/amd64' or 'linux/arm64'.`,
        `${ctx}[${i}]`,
      );
    }
    return item as RunPlatform;
  });
}

function parseRunConfig(raw: unknown, ctx: string): RunConfig {
  if (!isRecord(raw)) {
    fail('experiment.run.type', `${ctx} must be a mapping.`, ctx);
  }
  const out: RunConfig = {};
  if (raw.timeout !== undefined) {
    out.timeout = requireDuration(raw.timeout, `${ctx}.timeout`, 'experiment.run.timeout.type');
  }
  if (raw.platform !== undefined) {
    if (typeof raw.platform !== 'string' || !VALID_RUN_PLATFORMS.has(raw.platform)) {
      fail(
        'experiment.run.platform.enum',
        `${ctx}.platform must be 'auto', 'linux/amd64', or 'linux/arm64'.`,
        `${ctx}.platform`,
      );
    }
    out.platform = raw.platform as RunConfig['platform'];
  }
  if (raw.artifactCaptureTimeout !== undefined) {
    out.artifactCaptureTimeout = requireDuration(
      raw.artifactCaptureTimeout,
      `${ctx}.artifactCaptureTimeout`,
      'experiment.run.artifactCaptureTimeout.type',
    );
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['timeout', 'platform', 'artifactCaptureTimeout']),
    ctx,
    'experiment.run.unknown_field',
  );
  return out;
}

function parseEvaluation(raw: unknown, ctx: string): EvaluationConfig {
  if (!isRecord(raw)) {
    fail('experiment.evaluation.type', `${ctx} must be a mapping.`, ctx);
  }

  if (!Array.isArray(raw.criteria)) {
    fail(
      'experiment.evaluation.criteria.required',
      `${ctx}.criteria must be an array of criterion objects.`,
      `${ctx}.criteria`,
    );
  }

  const container = parseEvaluationContainer(raw.container, `${ctx}.container`);
  const criteria = raw.criteria.map((entry, i) => parseCriterion(entry, `${ctx}.criteria[${i}]`));
  const report =
    raw.report === undefined ? undefined : parseReport(raw.report, `${ctx}.report`);

  ensureNoUnknownKeys(
    raw,
    new Set(['container', 'criteria', 'report']),
    ctx,
    'experiment.evaluation.unknown_field',
  );

  const out: EvaluationConfig = {
    container,
    criteria,
  };
  if (report !== undefined) out.report = report;
  return out;
}

function parseEvaluationContainer(raw: unknown, ctx: string): 'dedicated' | 'agent' {
  if (raw === undefined) return 'dedicated';
  if (typeof raw !== 'string' || !VALID_EVALUATION_CONTAINERS.has(raw)) {
    fail(
      'experiment.evaluation.container.enum',
      `${ctx} must be 'dedicated' or 'agent'.`,
      ctx,
    );
  }
  return raw as 'dedicated' | 'agent';
}

function parseCriterion(raw: unknown, ctx: string): Criterion {
  if (!isRecord(raw)) {
    fail('experiment.criterion.type', `${ctx} must be a mapping.`, ctx);
  }

  // Detect legacy top-level fields on a criterion.
  if ('criterion' in raw) {
    fail(
      'experiment.criterion.legacy_field',
      `${ctx}: legacy field 'criterion' is replaced by 'id' + 'title'.`,
      `${ctx}.criterion`,
    );
  }
  if ('depends_on' in raw) {
    fail(
      'experiment.criterion.legacy_field',
      `${ctx}: legacy field 'depends_on' renamed to 'needs'.`,
      `${ctx}.depends_on`,
    );
  }
  if ('context' in raw) {
    fail(
      'experiment.criterion.legacy_field',
      `${ctx}: legacy field 'context' renamed to 'evidence' (judge criteria only).`,
      `${ctx}.context`,
    );
  }
  if ('code' in raw) {
    fail(
      'experiment.criterion.legacy_field',
      `${ctx}: legacy field 'code' is replaced by 'type: script' with 'run: <command>'.`,
      `${ctx}.code`,
    );
  }

  const id = requireString(raw.id, `${ctx}.id`, 'experiment.criterion.id.required', {
    minLength: 1,
  });
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    fail(
      'experiment.criterion.id.pattern',
      `${ctx}.id must be kebab-case (ASCII, lowercase, digits, hyphens; starting with a letter or digit): got ${JSON.stringify(id)}.`,
      `${ctx}.id`,
    );
  }
  const title = requireString(raw.title, `${ctx}.title`, 'experiment.criterion.title.required', {
    minLength: 1,
  });
  if (raw.type === undefined || typeof raw.type !== 'string') {
    fail(
      'experiment.criterion.type.required',
      `${ctx}.type is required (one of: script, judge, agent, browser-agent, aggregate).`,
      `${ctx}.type`,
    );
  }
  if (!VALID_CRITERION_TYPES.has(raw.type)) {
    fail(
      'experiment.criterion.type.enum',
      `${ctx}.type: unknown type ${JSON.stringify(raw.type)}. Valid: script, judge, agent, browser-agent, aggregate.`,
      `${ctx}.type`,
    );
  }

  const common = parseCommonCriterionFields(raw, id, title, ctx);

  switch (raw.type) {
    case 'script':
      return parseScriptCriterion(raw, common, ctx);
    case 'judge':
      return parseJudgeCriterion(raw, common, ctx);
    case 'agent':
      return parseAgentCriterion(raw, common, ctx);
    case 'browser-agent':
      return parseBrowserAgentCriterion(raw, common, ctx);
    case 'aggregate':
      return parseAggregateCriterion(raw, common, ctx);
    default:
      fail('experiment.criterion.type.enum', `${ctx}.type: unreachable`, `${ctx}.type`);
  }
}

interface CriterionBaseCommon {
  id: string;
  title: string;
  timeout?: string;
  weight?: number;
  scores?: AllowedScores;
  needs?: string[] | 'all';
  gate?: CriterionGate;
}

function parseCommonCriterionFields(
  raw: Raw,
  id: string,
  title: string,
  ctx: string,
): CriterionBaseCommon {
  const out: CriterionBaseCommon = { id, title };
  if (raw.timeout !== undefined) {
    out.timeout = requireDuration(
      raw.timeout,
      `${ctx}.timeout`,
      'experiment.criterion.timeout.type',
    );
  }
  if (raw.weight !== undefined) {
    if (typeof raw.weight !== 'number' || !Number.isFinite(raw.weight) || raw.weight < 0) {
      fail(
        'experiment.criterion.weight.type',
        `${ctx}.weight must be a non-negative number.`,
        `${ctx}.weight`,
      );
    }
    out.weight = raw.weight;
  }
  if (raw.scores !== undefined) {
    out.scores = parseAllowedScores(raw.scores, `${ctx}.scores`);
  }
  if (raw.needs !== undefined) {
    out.needs = parseNeeds(raw.needs, `${ctx}.needs`);
  }
  if (raw.gate !== undefined) {
    out.gate = parseGate(raw.gate, `${ctx}.gate`);
  }
  return out;
}

function parseAllowedScores(raw: unknown, ctx: string): AllowedScores {
  if (Array.isArray(raw)) {
    return raw.map((value, i) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail(
          'experiment.criterion.scores.item.type',
          `${ctx}[${i}] must be a finite number.`,
          `${ctx}[${i}]`,
        );
      }
      if (value < 0 || value > 1) {
        fail(
          'experiment.criterion.scores.item.range',
          `${ctx}[${i}] must be between 0 and 1 (got ${value}).`,
          `${ctx}[${i}]`,
        );
      }
      return value;
    });
  }
  if (isRecord(raw)) {
    const out: Record<number, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      const numKey = Number(key);
      if (!Number.isFinite(numKey)) {
        fail(
          'experiment.criterion.scores.key.type',
          `${ctx}: key ${JSON.stringify(key)} must be numeric.`,
          ctx,
        );
      }
      if (numKey < 0 || numKey > 1) {
        fail(
          'experiment.criterion.scores.key.range',
          `${ctx}: key ${key} must be between 0 and 1.`,
          ctx,
        );
      }
      if (typeof value !== 'string') {
        fail(
          'experiment.criterion.scores.value.type',
          `${ctx}.${key} must be a string label.`,
          `${ctx}.${key}`,
        );
      }
      out[numKey] = value;
    }
    return out;
  }
  fail(
    'experiment.criterion.scores.type',
    `${ctx} must be an array of numbers or a label map.`,
    ctx,
  );
}

function parseNeeds(raw: unknown, ctx: string): string[] | 'all' {
  if (raw === 'all') return 'all';
  if (!Array.isArray(raw)) {
    fail(
      'experiment.criterion.needs.type',
      `${ctx} must be 'all' or an array of criterion ids.`,
      ctx,
    );
  }
  return raw.map((item, i) => {
    if (typeof item !== 'string' || item.length === 0) {
      fail(
        'experiment.criterion.needs.item.type',
        `${ctx}[${i}] must be a non-empty string.`,
        `${ctx}[${i}]`,
      );
    }
    return item;
  });
}

function parseGate(raw: unknown, ctx: string): CriterionGate {
  if (typeof raw === 'number') {
    fail(
      'experiment.criterion.gate.legacy',
      `${ctx} must be an object '{ ifBelow: <n> }'. The bare-number/boolean form was retired.`,
      ctx,
    );
  }
  if (typeof raw === 'boolean') {
    fail(
      'experiment.criterion.gate.legacy',
      `${ctx} must be an object '{ ifBelow: <n> }'. Booleans are no longer accepted.`,
      ctx,
    );
  }
  if (!isRecord(raw)) {
    fail('experiment.criterion.gate.type', `${ctx} must be a mapping.`, ctx);
  }
  if (typeof raw.ifBelow !== 'number' || !Number.isFinite(raw.ifBelow)) {
    fail(
      'experiment.criterion.gate.ifBelow.type',
      `${ctx}.ifBelow must be a finite number.`,
      `${ctx}.ifBelow`,
    );
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['ifBelow']),
    ctx,
    'experiment.criterion.gate.unknown_field',
  );
  return { ifBelow: raw.ifBelow };
}

function parseScriptCriterion(raw: Raw, common: CriterionBaseCommon, ctx: string): Criterion {
  const run = requireString(raw.run, `${ctx}.run`, 'experiment.criterion.script.run.required', {
    minLength: 1,
  });
  const allowed: ReadonlySet<string> = new Set([
    'id',
    'title',
    'type',
    'timeout',
    'weight',
    'scores',
    'needs',
    'gate',
    'run',
  ]);
  ensureNoUnknownKeys(raw, allowed, ctx, 'experiment.criterion.script.unknown_field');
  return { ...common, type: 'script', run };
}

function parseJudgeCriterion(raw: Raw, common: CriterionBaseCommon, ctx: string): Criterion {
  const instructions = requireString(
    raw.instructions,
    `${ctx}.instructions`,
    'experiment.criterion.judge.instructions.required',
    { minLength: 1 },
  );
  const evidence =
    raw.evidence === undefined ? undefined : parseJudgeEvidence(raw.evidence, `${ctx}.evidence`);
  const scorer =
    raw.scorer === undefined
      ? undefined
      : parseJudgeScorer(raw.scorer, `${ctx}.scorer`);
  const allowed: ReadonlySet<string> = new Set([
    'id',
    'title',
    'type',
    'timeout',
    'weight',
    'scores',
    'needs',
    'gate',
    'instructions',
    'evidence',
    'scorer',
  ]);
  ensureNoUnknownKeys(raw, allowed, ctx, 'experiment.criterion.judge.unknown_field');
  return {
    ...common,
    type: 'judge',
    instructions,
    ...(evidence !== undefined ? { evidence } : {}),
    ...(scorer !== undefined ? { scorer } : {}),
  };
}

function parseJudgeEvidence(raw: unknown, ctx: string): JudgeEvidence[] {
  if (!Array.isArray(raw)) {
    fail('experiment.criterion.judge.evidence.type', `${ctx} must be an array.`, ctx);
  }
  return raw.map((item, i) => {
    if (typeof item !== 'string' || !VALID_JUDGE_EVIDENCE.has(item)) {
      fail(
        'experiment.criterion.judge.evidence.enum',
        `${ctx}[${i}] must be 'diff', 'logs', or 'traces'.`,
        `${ctx}[${i}]`,
      );
    }
    return item as JudgeEvidence;
  });
}

function parseJudgeScorer(raw: unknown, ctx: string): { model?: string } {
  if (!isRecord(raw)) {
    fail('experiment.criterion.judge.scorer.type', `${ctx} must be a mapping.`, ctx);
  }
  const out: { model?: string } = {};
  if (raw.model !== undefined) {
    out.model = requireString(
      raw.model,
      `${ctx}.model`,
      'experiment.criterion.judge.scorer.model.type',
    );
  }
  ensureNoUnknownKeys(raw, new Set(['model']), ctx, 'experiment.criterion.judge.scorer.unknown_field');
  return out;
}

function parseAgentCriterion(raw: Raw, common: CriterionBaseCommon, ctx: string): Criterion {
  const instructions = requireString(
    raw.instructions,
    `${ctx}.instructions`,
    'experiment.criterion.agent.instructions.required',
    { minLength: 1 },
  );
  const scorer =
    raw.scorer === undefined ? undefined : parseAgentScorer(raw.scorer, `${ctx}.scorer`);
  const allowed: ReadonlySet<string> = new Set([
    'id',
    'title',
    'type',
    'timeout',
    'weight',
    'scores',
    'needs',
    'gate',
    'instructions',
    'scorer',
  ]);
  ensureNoUnknownKeys(raw, allowed, ctx, 'experiment.criterion.agent.unknown_field');
  return {
    ...common,
    type: 'agent',
    instructions,
    ...(scorer !== undefined ? { scorer } : {}),
  };
}

function parseBrowserAgentCriterion(
  raw: Raw,
  common: CriterionBaseCommon,
  ctx: string,
): Criterion {
  const instructions = requireString(
    raw.instructions,
    `${ctx}.instructions`,
    'experiment.criterion.browser-agent.instructions.required',
    { minLength: 1 },
  );
  const scorer =
    raw.scorer === undefined ? undefined : parseAgentScorer(raw.scorer, `${ctx}.scorer`);
  const allowed: ReadonlySet<string> = new Set([
    'id',
    'title',
    'type',
    'timeout',
    'weight',
    'scores',
    'needs',
    'gate',
    'instructions',
    'scorer',
  ]);
  ensureNoUnknownKeys(raw, allowed, ctx, 'experiment.criterion.browser-agent.unknown_field');
  return {
    ...common,
    type: 'browser-agent',
    instructions,
    ...(scorer !== undefined ? { scorer } : {}),
  };
}

function parseAgentScorer(raw: unknown, ctx: string): { model?: string; tools?: string[] } {
  if (!isRecord(raw)) {
    fail('experiment.criterion.agent.scorer.type', `${ctx} must be a mapping.`, ctx);
  }
  const out: { model?: string; tools?: string[] } = {};
  if (raw.model !== undefined) {
    out.model = requireString(
      raw.model,
      `${ctx}.model`,
      'experiment.criterion.agent.scorer.model.type',
    );
  }
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools)) {
      fail(
        'experiment.criterion.agent.scorer.tools.type',
        `${ctx}.tools must be an array.`,
        `${ctx}.tools`,
      );
    }
    out.tools = raw.tools.map((tool, i) => {
      if (typeof tool !== 'string') {
        fail(
          'experiment.criterion.agent.scorer.tools.item.type',
          `${ctx}.tools[${i}] must be a string.`,
          `${ctx}.tools[${i}]`,
        );
      }
      return tool;
    });
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['model', 'tools']),
    ctx,
    'experiment.criterion.agent.scorer.unknown_field',
  );
  return out;
}

function parseAggregateCriterion(
  raw: Raw,
  common: CriterionBaseCommon,
  ctx: string,
): Criterion {
  if (raw.aggregate === undefined) {
    fail(
      'experiment.criterion.aggregate.required',
      `${ctx}.aggregate is required for aggregate criteria ({ function: <fn> }).`,
      `${ctx}.aggregate`,
    );
  }
  if (common.needs === undefined) {
    fail(
      'experiment.criterion.aggregate.needs.required',
      `${ctx}.needs is required for aggregate criteria.`,
      `${ctx}.needs`,
    );
  }
  if (!isRecord(raw.aggregate)) {
    fail(
      'experiment.criterion.aggregate.type',
      `${ctx}.aggregate must be a mapping '{ function: <fn> }'.`,
      `${ctx}.aggregate`,
    );
  }
  if (typeof raw.aggregate.function !== 'string' || !VALID_AGGREGATE_FUNCTIONS.has(raw.aggregate.function)) {
    fail(
      'experiment.criterion.aggregate.function.enum',
      `${ctx}.aggregate.function must be one of: ${Array.from(VALID_AGGREGATE_FUNCTIONS).join(', ')}.`,
      `${ctx}.aggregate.function`,
    );
  }
  ensureNoUnknownKeys(
    raw.aggregate,
    new Set(['function']),
    `${ctx}.aggregate`,
    'experiment.criterion.aggregate.unknown_field',
  );
  const allowed: ReadonlySet<string> = new Set([
    'id',
    'title',
    'type',
    'timeout',
    'weight',
    'scores',
    'needs',
    'gate',
    'aggregate',
  ]);
  ensureNoUnknownKeys(raw, allowed, ctx, 'experiment.criterion.aggregate.unknown_field');
  return {
    ...common,
    type: 'aggregate',
    needs: common.needs!,
    aggregate: { function: raw.aggregate.function as AggregateFunction },
  };
}

function parseReport(raw: unknown, ctx: string): ReportConfig {
  if (!isRecord(raw)) {
    fail('experiment.evaluation.report.type', `${ctx} must be a mapping.`, ctx);
  }
  const instructions = requireString(
    raw.instructions,
    `${ctx}.instructions`,
    'experiment.evaluation.report.instructions.required',
    { minLength: 1 },
  );
  const out: ReportConfig = { instructions };
  if (raw.model !== undefined) {
    out.model = requireString(raw.model, `${ctx}.model`, 'experiment.evaluation.report.model.type');
  }
  if (raw.evidence !== undefined) {
    out.evidence = parseJudgeEvidence(raw.evidence, `${ctx}.evidence`);
  }
  if (raw.needs !== undefined) {
    out.needs = parseNeeds(raw.needs, `${ctx}.needs`);
  }
  if (raw.timeout !== undefined) {
    out.timeout = requireDuration(
      raw.timeout,
      `${ctx}.timeout`,
      'experiment.evaluation.report.timeout.type',
    );
  }
  ensureNoUnknownKeys(
    raw,
    new Set(['instructions', 'model', 'evidence', 'needs', 'timeout']),
    ctx,
    'experiment.evaluation.report.unknown_field',
  );
  return out;
}

function parseVariants(raw: unknown, ctx: string): Record<string, ExperimentVariant> {
  if (!isRecord(raw)) {
    fail('experiment.variants.type', `${ctx} must be a mapping of variant-name → overlay.`, ctx);
  }
  const out: Record<string, ExperimentVariant> = {};
  for (const [name, rawVariant] of Object.entries(raw)) {
    if (!isRecord(rawVariant)) {
      fail(
        'experiment.variants.item.type',
        `${ctx}.${name} must be a mapping.`,
        `${ctx}.${name}`,
      );
    }
    out[name] = parseVariant(rawVariant, `${ctx}.${name}`);
  }
  return out;
}

function parseVariant(raw: Raw, ctx: string): ExperimentVariant {
  const out: ExperimentVariant = {};
  if (raw.description !== undefined) {
    out.description = requireString(
      raw.description,
      `${ctx}.description`,
      'experiment.variant.description.type',
    );
  }
  if (raw.labels !== undefined) {
    out.labels = parseLabels(raw.labels, `${ctx}.labels`);
  }
  if (raw.task !== undefined) {
    if (!isRecord(raw.task)) {
      fail('experiment.variant.task.type', `${ctx}.task must be a mapping.`, `${ctx}.task`);
    }
    if (raw.task.prompt !== undefined) {
      out.task = {
        prompt: requireString(
          raw.task.prompt,
          `${ctx}.task.prompt`,
          'experiment.variant.task.prompt.type',
        ),
      };
    } else {
      out.task = {};
    }
  }
  if (raw.workspace !== undefined) {
    out.workspace = parseWorkspace(raw.workspace, `${ctx}.workspace`);
  }
  if (raw.environment !== undefined) {
    // Variant environment is partial — parseEnvironment requires image; allow
    // missing here.
    if (!isRecord(raw.environment)) {
      fail(
        'experiment.variant.environment.type',
        `${ctx}.environment must be a mapping.`,
        `${ctx}.environment`,
      );
    }
    const envPartial: Partial<EnvironmentConfig> = {};
    if (raw.environment.image !== undefined) {
      // Re-use the image parser via a synthetic environment object.
      const parsed = parseEnvironment(
        { image: raw.environment.image },
        `${ctx}.environment`,
      );
      envPartial.image = parsed.image;
    }
    if (raw.environment.requires !== undefined) {
      const parsed = parseEnvironment(
        { image: { base: 'x' }, requires: raw.environment.requires },
        `${ctx}.environment`,
      );
      envPartial.requires = parsed.requires;
    }
    if (raw.environment.platforms !== undefined) {
      envPartial.platforms = parsePlatformsList(
        raw.environment.platforms,
        `${ctx}.environment.platforms`,
      );
    }
    if (raw.environment.user !== undefined) {
      if (
        typeof raw.environment.user !== 'string' ||
        !VALID_EXECUTION_USERS.has(raw.environment.user)
      ) {
        fail(
          'experiment.variant.environment.user.enum',
          `${ctx}.environment.user must be 'user' or 'root'.`,
          `${ctx}.environment.user`,
        );
      }
      envPartial.user = raw.environment.user as ExecutionUser;
    }
    ensureNoUnknownKeys(
      raw.environment,
      new Set(['image', 'requires', 'platforms', 'user']),
      `${ctx}.environment`,
      'experiment.variant.environment.unknown_field',
    );
    out.environment = envPartial;
  }
  if (raw.run !== undefined) {
    out.run = parseRunConfig(raw.run, `${ctx}.run`);
  }
  if (raw.evaluation !== undefined) {
    if (!isRecord(raw.evaluation)) {
      fail(
        'experiment.variant.evaluation.type',
        `${ctx}.evaluation must be a mapping.`,
        `${ctx}.evaluation`,
      );
    }
    const evalPartial: Partial<EvaluationConfig> = {};
    if (raw.evaluation.container !== undefined) {
      evalPartial.container = parseEvaluationContainer(
        raw.evaluation.container,
        `${ctx}.evaluation.container`,
      );
    }
    if (raw.evaluation.criteria !== undefined) {
      if (!Array.isArray(raw.evaluation.criteria)) {
        fail(
          'experiment.variant.evaluation.criteria.type',
          `${ctx}.evaluation.criteria must be an array.`,
          `${ctx}.evaluation.criteria`,
        );
      }
      evalPartial.criteria = raw.evaluation.criteria.map((entry, i) =>
        parseCriterion(entry, `${ctx}.evaluation.criteria[${i}]`),
      );
    }
    if (raw.evaluation.report !== undefined) {
      evalPartial.report = parseReport(raw.evaluation.report, `${ctx}.evaluation.report`);
    }
    ensureNoUnknownKeys(
      raw.evaluation,
      new Set(['container', 'criteria', 'report']),
      `${ctx}.evaluation`,
      'experiment.variant.evaluation.unknown_field',
    );
    out.evaluation = evalPartial;
  }
  if (raw.env !== undefined) {
    out.env = parseEnv(raw.env, `${ctx}.env`);
  }
  if (raw.passEnv !== undefined) {
    out.passEnv = parsePassEnv(raw.passEnv, `${ctx}.passEnv`);
  }
  ensureNoUnknownKeys(
    raw,
    new Set([
      'description',
      'labels',
      'task',
      'workspace',
      'environment',
      'run',
      'evaluation',
      'env',
      'passEnv',
    ]),
    ctx,
    'experiment.variant.unknown_field',
  );
  return out;
}

// ---------------------------------------------------------------------------
// Variant application
// ---------------------------------------------------------------------------

/**
 * Apply a variant overlay to a base config and return a new {@link ExperimentConfig}.
 *
 * Merge semantics:
 * - Scalar / object fields shallow-merge.
 * - Arrays replace wholesale, except `evaluation.criteria`.
 * - In `evaluation.criteria`, entries with the same `id` replace the base
 *   entry; new ids append. Variants cannot delete base criteria.
 */
export function applyVariant(base: ExperimentConfig, variantName: string): ExperimentConfig {
  if (!base.variants || !(variantName in base.variants)) {
    const available = base.variants ? Object.keys(base.variants).join(', ') || '(none)' : '(none)';
    throw new ExperimentConfigError(
      'experiment.variant.unknown',
      `Unknown variant ${JSON.stringify(variantName)}. Available: ${available}.`,
      { path: `variants.${variantName}` },
    );
  }
  const variant = base.variants[variantName];

  const merged: ExperimentConfig = {
    ...base,
    task: variant.task?.prompt ? { prompt: variant.task.prompt } : base.task,
    workspace: mergeWorkspace(base.workspace, variant.workspace),
    environment: mergeEnvironment(base.environment, variant.environment),
    run: variant.run ? { ...(base.run ?? {}), ...variant.run } : base.run,
    evaluation: mergeEvaluation(base.evaluation, variant.evaluation),
  };

  if (variant.description !== undefined) merged.description = variant.description;
  if (variant.labels !== undefined) merged.labels = { ...(base.labels ?? {}), ...variant.labels };
  if (variant.env !== undefined) {
    merged.env = { ...(base.env ?? {}), ...variant.env };
  }
  if (variant.passEnv !== undefined) {
    const combined = [...(base.passEnv ?? []), ...variant.passEnv];
    merged.passEnv = Array.from(new Set(combined));
  }

  // Variants on the merged config aren't meaningful — drop them so consumers
  // don't accidentally chain variants.
  delete merged.variants;

  validateCriteriaGraph(merged, `variants.${variantName}.evaluation.criteria`);
  return merged;
}

function mergeWorkspace(
  base: WorkspaceConfig | undefined,
  overlay: Partial<WorkspaceConfig> | undefined,
): WorkspaceConfig | undefined {
  if (!overlay) return base;
  const merged: WorkspaceConfig = { ...(base ?? {}) };
  if (overlay.sources !== undefined) merged.sources = overlay.sources;
  if (overlay.setup !== undefined) merged.setup = overlay.setup;
  if (Object.keys(merged).length === 0) return undefined;
  return merged;
}

function mergeEnvironment(
  base: EnvironmentConfig,
  overlay: Partial<EnvironmentConfig> | undefined,
): EnvironmentConfig {
  if (!overlay) return base;
  const merged: EnvironmentConfig = { ...base };
  if (overlay.image !== undefined) merged.image = overlay.image;
  if (overlay.requires !== undefined) {
    merged.requires = { ...(base.requires ?? {}), ...overlay.requires };
  }
  if (overlay.platforms !== undefined) merged.platforms = overlay.platforms;
  if (overlay.user !== undefined) merged.user = overlay.user;
  return merged;
}

function mergeEvaluation(
  base: EvaluationConfig,
  overlay: Partial<EvaluationConfig> | undefined,
): EvaluationConfig {
  if (!overlay) return base;
  const merged: EvaluationConfig = { ...base };
  if (overlay.container !== undefined) merged.container = overlay.container;
  if (overlay.criteria !== undefined) {
    merged.criteria = mergeCriteria(base.criteria, overlay.criteria);
  }
  if (overlay.report !== undefined) merged.report = overlay.report;
  return merged;
}

function mergeCriteria(base: Criterion[], overlay: Criterion[]): Criterion[] {
  const byId = new Map<string, number>();
  const result: Criterion[] = base.map((c, i) => {
    byId.set(c.id, i);
    return c;
  });
  for (const entry of overlay) {
    const idx = byId.get(entry.id);
    if (idx === undefined) {
      byId.set(entry.id, result.length);
      result.push(entry);
    } else {
      result[idx] = entry;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Criterion dependency graph validation
// ---------------------------------------------------------------------------

/** Validate criterion id uniqueness, `needs` targets, and acyclicity. */
export function validateCriteriaGraph(
  config: ExperimentConfig,
  ctx = 'evaluation.criteria',
): void {
  const criteria = config.evaluation.criteria;

  // Uniqueness.
  const seen = new Set<string>();
  for (let i = 0; i < criteria.length; i++) {
    if (seen.has(criteria[i].id)) {
      throw new ExperimentConfigError(
        'experiment.criterion.id.duplicate',
        `${ctx}[${i}]: duplicate criterion id ${JSON.stringify(criteria[i].id)}.`,
        { path: `${ctx}[${i}].id` },
      );
    }
    seen.add(criteria[i].id);
  }

  // `needs` targets must exist and must refer to *earlier* criteria (execution
  // is strict sequential; `all` means "all previous").
  const indexById = new Map<string, number>();
  criteria.forEach((c, i) => indexById.set(c.id, i));

  for (let i = 0; i < criteria.length; i++) {
    const c = criteria[i];
    if (!c.needs) continue;
    if (c.needs === 'all') continue;
    for (const need of c.needs) {
      const targetIdx = indexById.get(need);
      if (targetIdx === undefined) {
        throw new ExperimentConfigError(
          'experiment.criterion.needs.unknown',
          `${ctx}[${i}] (${c.id}): 'needs' references unknown criterion id ${JSON.stringify(need)}.`,
          { path: `${ctx}[${i}].needs` },
        );
      }
      if (targetIdx >= i) {
        throw new ExperimentConfigError(
          'experiment.criterion.needs.order',
          `${ctx}[${i}] (${c.id}): 'needs' references ${JSON.stringify(need)} which appears later in the list; criterion dependencies must reference earlier entries.`,
          { path: `${ctx}[${i}].needs` },
        );
      }
    }
  }

  // Report dependencies.
  const report = config.evaluation.report;
  if (report && report.needs && report.needs !== 'all') {
    for (const need of report.needs) {
      if (!indexById.has(need)) {
        throw new ExperimentConfigError(
          'experiment.evaluation.report.needs.unknown',
          `evaluation.report.needs references unknown criterion id ${JSON.stringify(need)}.`,
          { path: 'evaluation.report.needs' },
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Workspace source resolution
// ---------------------------------------------------------------------------

/**
 * Resolve workspace sources against the experiment directory and detect
 * target-path collisions.
 *
 * @throws ExperimentConfigError with code `workspace.source.collision` if two
 *   sources write to the same target path. Error message names both entries
 *   and the conflicting path.
 */
export function resolveWorkspaceSources(
  sources: readonly WorkspaceSourceEntry[] | undefined,
  experimentDir: string,
): ResolvedWorkspaceSource[] {
  if (!sources || sources.length === 0) return [];

  const resolved: ResolvedWorkspaceSource[] = [];
  for (let i = 0; i < sources.length; i++) {
    const entry = sources[i];
    if ('path' in entry) {
      const absPath = path.resolve(experimentDir, entry.path);
      if (!fs.existsSync(absPath)) {
        throw new ExperimentConfigError(
          'workspace.source.path.missing',
          `workspace.sources[${i}]: path does not exist: ${entry.path} (resolved to ${absPath}).`,
          { path: `workspace.sources[${i}].path` },
        );
      }
      const stat = fs.statSync(absPath);
      if (!stat.isFile() && !stat.isDirectory()) {
        throw new ExperimentConfigError(
          'workspace.source.path.type',
          `workspace.sources[${i}]: path must be a file or directory: ${entry.path}.`,
          { path: `workspace.sources[${i}].path` },
        );
      }
      resolved.push({
        type: 'path',
        sourcePath: absPath,
        target:
          entry.target !== undefined
            ? entry.target
            : stat.isFile()
              ? path.basename(absPath)
              : undefined,
        original: entry,
        index: i,
      });
    } else {
      resolved.push({
        type: 'image',
        sourcePath: entry.imagePath,
        target: entry.target,
        original: entry,
        index: i,
      });
    }
  }

  detectWorkspaceCollisions(resolved);
  return resolved;
}

interface TargetClaim {
  index: number;
  /** Normalized posix-style target (empty string = workspace root). */
  target: string;
  /** Describes whether this source claims a file or a directory. */
  kind: 'file' | 'directory' | 'root-merge';
}

function describeSource(r: ResolvedWorkspaceSource): string {
  const key = r.type === 'path' ? 'path' : 'imagePath';
  const value = r.type === 'path' ? (r.original as { path: string }).path : r.sourcePath;
  return `workspace.sources[${r.index}] (${key}: ${JSON.stringify(value)})`;
}

function normalizeTarget(target: string | undefined): string {
  if (target === undefined || target === '' || target === '.') return '';
  return path.posix.normalize(target.replace(/\\/g, '/')).replace(/\/+$/, '');
}

/**
 * Detect path collisions between workspace sources.
 *
 * Collision rules (conservative, fail-fast):
 * - Two file-target sources writing to the same relative target collide.
 * - A file-target and a directory-target at the same path collide.
 * - Two directory-target sources whose targets overlap (one is ancestor of
 *   the other, or both merge into the workspace root) collide.
 * - Two "root merge" directory sources collide because their directory
 *   contents cannot be guaranteed not to overlap; `target:` must be set on
 *   each. Image-path sources are treated conservatively as 'file' when a
 *   `target` is set, and as 'root-merge' otherwise.
 */
function detectWorkspaceCollisions(sources: ResolvedWorkspaceSource[]): void {
  const claims: TargetClaim[] = [];
  for (const r of sources) {
    const target = normalizeTarget(r.target);
    let kind: TargetClaim['kind'];
    if (r.type === 'path') {
      const stat = fs.statSync(r.sourcePath);
      if (stat.isFile()) {
        kind = 'file';
      } else if (target === '') {
        kind = 'root-merge';
      } else {
        kind = 'directory';
      }
    } else {
      // imagePath — we don't know at validation time if it's a file or directory.
      // If the target is provided, treat as a file (common case: copy a single
      // file into the workspace). If missing, treat as a root-merge (the
      // imagePath refers to a directory whose contents land at root).
      kind = target === '' ? 'root-merge' : 'file';
    }
    claims.push({ index: r.index, target, kind });
  }

  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i];
      const b = claims[j];
      if (collides(a, b)) {
        const aName = describeSource(sources[i]);
        const bName = describeSource(sources[j]);
        const targetLabel = a.target === '' && b.target === '' ? '<workspace root>' : a.target || b.target;
        throw new ExperimentConfigError(
          'workspace.source.collision',
          `workspace.sources path collision between ${aName} and ${bName} at ${JSON.stringify(targetLabel)}.`,
          { path: `workspace.sources[${b.index}]` },
        );
      }
    }
  }
}

function collides(a: TargetClaim, b: TargetClaim): boolean {
  // Any two claims on the same target collide, regardless of kind
  // (file/file, dir/dir, file/dir, or root-merge).
  if (a.target === b.target) return true;
  // Root-merge claims conflict with anything else rooted at the same workspace
  // root only if the other claim's target is a top-level entry that the merge
  // could overwrite. We don't have directory contents at validation time, so
  // we don't flag this case; runtime assembly will detect overlapping files.
  return false;
}

// ---------------------------------------------------------------------------
// loadExperiment
// ---------------------------------------------------------------------------

/**
 * Load, validate, and optionally variant-resolve an experiment from a directory.
 *
 * @param experimentPath Path to the experiment directory containing `experiment.yaml`.
 * @param variantName Optional variant to merge over the base config.
 */
export function loadExperiment(
  experimentPath: string,
  variantName?: string,
): ResolvedExperiment {
  const dir = path.resolve(experimentPath);
  const configPath = path.join(dir, 'experiment.yaml');
  if (!fs.existsSync(configPath)) {
    throw new ExperimentConfigError(
      'experiment.config.missing',
      `experiment.yaml not found: ${configPath}`,
      { resource: configPath },
    );
  }
  const source = fs.readFileSync(configPath, 'utf8');
  const base = parseExperimentConfig(source, { source: configPath });
  const config = variantName !== undefined ? applyVariant(base, variantName) : base;

  const workspaceSources = resolveWorkspaceSources(config.workspace?.sources, dir);

  const dockerfilePath = path.join(dir, 'Dockerfile');
  const hasDockerfile = fs.existsSync(dockerfilePath);
  const verifiersDir = path.join(dir, 'verifiers');
  const hasVerifiers = fs.existsSync(verifiersDir) && fs.statSync(verifiersDir).isDirectory();

  const resolved: ResolvedExperiment = {
    ...config,
    dir,
    configPath,
    workspaceSources,
    hasDockerfile,
    hasVerifiers,
  };
  if (variantName !== undefined) resolved.variant = variantName;
  if (hasVerifiers) resolved.verifiersPath = verifiersDir;
  return resolved;
}
