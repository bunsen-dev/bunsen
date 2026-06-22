// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Shared `$schema` / `version` handling for every Bunsen resource
 * (`bunsen.config.yaml`, `bunsen-suite.yaml`, `experiment.yaml`, `agent.yaml`).
 *
 * The matching JSON Schemas live at `@bunsen-dev/types/schemas/*.v1.json`.
 */

/** Accepted resource-schema versions. Only `v1` today; extend as new schemas ship. */
export type SchemaVersion = 'v1';

/** Header fields common to every resource YAML. */
export interface SchemaMeta {
  /** Stable identifier used by tooling for IDE hints; never fetched at runtime. */
  $schema?: string;
  /** Schema version — not a content version. Always `v1`, `v2`, … (never semver). */
  version: SchemaVersion;
}

export interface ParseSchemaMetaOptions {
  /**
   * Allowed versions. Defaults to the current set of supported versions.
   * Individual parsers can narrow this further (e.g. a schema that only
   * understands `v1` can pass `['v1']` explicitly).
   */
  allowedVersions?: readonly SchemaVersion[];
  /**
   * Resource kind, used only to produce a better error message.
   * Example: `"experiment.yaml"`.
   */
  resource?: string;
}

const DEFAULT_VERSIONS: readonly SchemaVersion[] = ['v1'];

/** Error thrown when a resource's `$schema` / `version` header is malformed. */
export class SchemaMetaError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'SchemaMetaError';
    this.field = field;
  }
}

/**
 * Validate that `value` is a plain object carrying a required `version` of one
 * of `allowedVersions`, and an optional string `$schema`. Returns the narrowed
 * `SchemaMeta` slice so callers can reuse it without re-validating.
 *
 * Does not validate the rest of the resource — that is the parser's job. This
 * helper exists so every parser applies the same version check identically.
 */
export function parseSchemaMeta(
  value: unknown,
  options: ParseSchemaMetaOptions = {},
): SchemaMeta {
  const allowed = options.allowedVersions ?? DEFAULT_VERSIONS;
  const prefix = options.resource ? `${options.resource}: ` : '';

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SchemaMetaError(
      '',
      `${prefix}Expected a YAML mapping with a "version" field.`,
    );
  }

  const record = value as Record<string, unknown>;

  if (!('version' in record)) {
    throw new SchemaMetaError(
      'version',
      `${prefix}Missing required "version" field. Expected one of: ${allowed.join(', ')}.`,
    );
  }

  const version = record.version;
  if (typeof version !== 'string') {
    throw new SchemaMetaError(
      'version',
      `${prefix}"version" must be a string, got ${typeof version}.`,
    );
  }
  if (!allowed.includes(version as SchemaVersion)) {
    throw new SchemaMetaError(
      'version',
      `${prefix}Unsupported schema version ${JSON.stringify(version)}. Expected one of: ${allowed.join(', ')}.`,
    );
  }

  const schemaUrl = record.$schema;
  if (schemaUrl !== undefined && typeof schemaUrl !== 'string') {
    throw new SchemaMetaError(
      '$schema',
      `${prefix}"$schema" must be a string URL if present, got ${typeof schemaUrl}.`,
    );
  }

  return schemaUrl === undefined
    ? { version: version as SchemaVersion }
    : { $schema: schemaUrl, version: version as SchemaVersion };
}

/** Non-throwing variant: returns either the parsed meta or the error. */
export function tryParseSchemaMeta(
  value: unknown,
  options: ParseSchemaMetaOptions = {},
): { ok: true; meta: SchemaMeta } | { ok: false; error: SchemaMetaError } {
  try {
    return { ok: true, meta: parseSchemaMeta(value, options) };
  } catch (err) {
    if (err instanceof SchemaMetaError) return { ok: false, error: err };
    throw err;
  }
}
