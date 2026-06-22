// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Local JSON Schema loader. Bunsen's schemas are bundled inside `@bunsen-dev/types`
 * and read from disk; `$schema` URLs are stable identifiers for tooling (IDE
 * integration, `bn validate`) but are never fetched over the network at runtime.
 * Offline validation is a hard requirement.
 *
 * Schema JSON files live under `packages/types/schemas/` in the repo and are
 * copied into `dist/schemas/` during build (see `packages/types/package.json`).
 */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Stable schema identifiers. Keep in sync with the filenames under `schemas/`. */
export type SchemaId =
  | 'project.v1'
  | 'suite.v1'
  | 'experiment.v1'
  | 'agent.v1';

/** Canonical `$schema` URL for each schema id. */
const SCHEMA_URLS: Record<SchemaId, string> = {
  'project.v1': 'https://schemas.bunsen.dev/project.v1.json',
  'suite.v1': 'https://schemas.bunsen.dev/suite.v1.json',
  'experiment.v1': 'https://schemas.bunsen.dev/experiment.v1.json',
  'agent.v1': 'https://schemas.bunsen.dev/agent.v1.json',
};

/** Loose representation of a parsed JSON Schema document. */
export type JsonSchema = Record<string, unknown>;

const ALL_IDS: readonly SchemaId[] = [
  'project.v1',
  'suite.v1',
  'experiment.v1',
  'agent.v1',
];

const CACHE = new Map<SchemaId, JsonSchema>();

function schemasDir(): string {
  // `import.meta.url` resolves to either the compiled file (`dist/schemas.js`,
  // where the build copies JSON into `dist/schemas/`) or the source file
  // (`src/schemas.ts`, used under vitest). Check the sibling `schemas/` first,
  // then fall back to the repo-root `packages/types/schemas/` for source runs.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sibling = path.join(here, 'schemas');
  if (existsSync(sibling)) return sibling;
  return path.join(here, '..', 'schemas');
}

/**
 * Load a bundled schema by id, reading from disk. Results are cached.
 *
 * Throws a plain `Error` if the schema file is missing or unparseable —
 * that's a packaging bug, not a user-facing validation error.
 */
export function loadSchema(id: SchemaId): JsonSchema {
  const cached = CACHE.get(id);
  if (cached) return cached;

  const filePath = path.join(schemasDir(), `${id}.json`);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(
      `Failed to read bundled schema ${id} at ${filePath}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Bundled schema ${id} is not valid JSON: ${(err as Error).message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Bundled schema ${id} is not a JSON object.`);
  }

  const schema = parsed as JsonSchema;
  CACHE.set(id, schema);
  return schema;
}

/** List every schema id bundled with `@bunsen-dev/types`. */
export function listSchemaIds(): SchemaId[] {
  return [...ALL_IDS];
}

/** Canonical `$schema` URL for a given id. */
export function schemaUrl(id: SchemaId): string {
  return SCHEMA_URLS[id];
}

/** For tests: drop the in-memory cache so reloads pick up schema edits. */
export function __clearSchemaCache(): void {
  CACHE.clear();
}
