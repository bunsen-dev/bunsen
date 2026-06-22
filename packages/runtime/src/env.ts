// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Environment variable utilities.
 *
 * - Parse `.env` files (standard format).
 * - Parse `--env` / `--env-file` CLI flags.
 * - Load project-level `.env` for the CLI based on `defaults.envFiles` from
 *   `bunsen.config.yaml`. Nothing is auto-loaded by scanning agent or
 *   experiment directories anymore — everything must be declared explicitly.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadProject } from './project-loader.js';
import { assertNoReservedEnvKeys, isReservedEnvKey } from './project-loader.js';

/**
 * Parse a .env file into a Record<string, string>
 * Supports:
 * - KEY=value
 * - KEY="quoted value"
 * - KEY='single quoted'
 * - # comments
 * - Empty lines
 * - Inline comments after values
 */
export function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Environment file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  return parseEnvContent(content);
}

/**
 * Parse .env file content string
 */
export function parseEnvContent(content: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Find the first = sign
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue; // Skip lines without =
    }

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Handle quoted values
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      // Remove inline comments for unquoted values
      const commentIndex = value.indexOf(' #');
      if (commentIndex !== -1) {
        value = value.slice(0, commentIndex).trim();
      }
    }

    // Only set if key is valid
    if (key && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      env[key] = value;
    }
  }

  return env;
}

/**
 * Parse a single --env flag value
 * Supports:
 * - VAR=value (set explicitly)
 * - VAR (pass through from host environment)
 */
export function parseEnvFlag(flag: string): { key: string; value: string } | null {
  const eqIndex = flag.indexOf('=');

  if (eqIndex === -1) {
    // Pass through from host environment
    const key = flag.trim();
    const value = process.env[key];
    if (value !== undefined) {
      return { key, value };
    }
    // Silently skip if not set in host (like Docker behavior)
    return null;
  }

  const key = flag.slice(0, eqIndex).trim();
  const value = flag.slice(eqIndex + 1);

  if (!key) {
    return null;
  }

  return { key, value };
}

/**
 * Parse multiple --env flags into a Record
 */
export function parseEnvFlags(flags: string[]): Record<string, string> {
  const env: Record<string, string> = {};

  for (const flag of flags) {
    const parsed = parseEnvFlag(flag);
    if (parsed) {
      env[parsed.key] = parsed.value;
    }
  }

  return env;
}

/**
 * Merge env from CLI `--env-file` and `--env` flags.
 *
 * Precedence (later wins): envFiles in order → envFlags in order.
 *
 * Rejects entries that would collide with the reserved `BUNSEN_*` namespace.
 */
export function loadEnvFromSources(options: {
  envFiles?: string[];
  envFlags?: string[];
}): Record<string, string> {
  const { envFiles = [], envFlags = [] } = options;
  let env: Record<string, string> = {};

  for (const file of envFiles) {
    env = { ...env, ...parseEnvFile(file) };
  }

  env = { ...env, ...parseEnvFlags(envFlags) };

  assertNoReservedEnvKeys(Object.keys(env), 'CLI env input');

  return env;
}

// ---------------------------------------------------------------------------
// 8-source run environment merge
// ---------------------------------------------------------------------------

/**
 * One contribution to the run environment, tagged with a human label used
 * in error messages when a reserved BUNSEN_ key collides.
 */
export interface RunEnvSource {
  label: string;
  env?: Record<string, string>;
  passEnv?: string[];
}

export interface MergeRunEnvironmentOptions {
  /**
   * User-controlled sources, applied in order (later wins). Per the design
   * doc, the intended sequence is:
   *   1. project defaults
   *   2. agent defaults
   *   3. experiment defaults
   *   4. agent variant defaults
   *   5. experiment variant defaults
   */
  sources?: RunEnvSource[];
  /** `--env-file` paths from the CLI. */
  cliEnvFiles?: string[];
  /** `--env KEY=VALUE` flags from the CLI. */
  cliEnvFlags?: string[];
  /** `--pass-env HOST_NAME` flags from the CLI (host passthrough allowlist). */
  cliPassEnv?: string[];
  /** Reserved `BUNSEN_*` vars. These win over everything and reject collisions. */
  reserved?: Record<string, string>;
  /**
   * Host env snapshot used to resolve `passEnv` entries. Defaults to
   * `process.env`; callers can inject a deterministic snapshot for tests.
   */
  hostEnv?: NodeJS.ProcessEnv;
}

/**
 * Merge run environment from the 8-source order (this function is the
 * authoritative spec; the practical summary lives in `docs/ENVIRONMENT.md`):
 *
 *   (0) host passthrough via `passEnv`       ← weakest
 *   (1) project defaults
 *   (2) agent defaults
 *   (3) experiment defaults
 *   (4) agent variant defaults
 *   (5) experiment variant defaults
 *   (6) CLI `--env-file`
 *   (7) CLI `--env`
 *   (8) reserved `BUNSEN_*`                   ← strongest (collision = hard error)
 *
 * Host passthrough is opt-in: only host env vars named in a `passEnv` list
 * (merged across every source) reach the container, and any explicit user
 * setting for the same name wins over the host value.
 *
 * Any user-controlled source that tries to set a reserved `BUNSEN_*` key
 * causes this function to throw with the source's label in the message.
 */
export function mergeRunEnvironment(
  options: MergeRunEnvironmentOptions,
): Record<string, string> {
  const {
    sources = [],
    cliEnvFiles = [],
    cliEnvFlags = [],
    cliPassEnv = [],
    reserved = {},
    hostEnv = process.env,
  } = options;

  const merged: Record<string, string> = {};

  // (0) Host passthrough via merged passEnv allowlist.
  const passEnvNames = new Set<string>();
  for (const src of sources) {
    for (const name of src.passEnv ?? []) passEnvNames.add(name);
  }
  for (const name of cliPassEnv) passEnvNames.add(name);
  for (const name of passEnvNames) {
    if (isReservedEnvKey(name)) {
      throw new Error(
        `passEnv entry ${JSON.stringify(name)} uses the reserved BUNSEN_ prefix.`,
      );
    }
    const value = hostEnv[name];
    if (value !== undefined) merged[name] = value;
  }

  // (1)–(5) Ordered user sources.
  for (const src of sources) {
    if (!src.env) continue;
    assertNoReservedEnvKeys(Object.keys(src.env), src.label);
    for (const [k, v] of Object.entries(src.env)) {
      merged[k] = v;
    }
  }

  // (6) CLI --env-file (files merge in order).
  for (const file of cliEnvFiles) {
    const parsed = parseEnvFile(file);
    assertNoReservedEnvKeys(Object.keys(parsed), `CLI --env-file ${file}`);
    for (const [k, v] of Object.entries(parsed)) {
      merged[k] = v;
    }
  }

  // (7) CLI --env flags.
  const cliFlagEnv = parseEnvFlags(cliEnvFlags);
  assertNoReservedEnvKeys(Object.keys(cliFlagEnv), 'CLI --env');
  for (const [k, v] of Object.entries(cliFlagEnv)) {
    merged[k] = v;
  }

  // (8) Reserved BUNSEN_* — must not collide with anything user-provided.
  for (const [k, v] of Object.entries(reserved)) {
    if (!isReservedEnvKey(k)) {
      throw new Error(
        `Reserved env key ${JSON.stringify(k)} does not use the BUNSEN_ prefix.`,
      );
    }
    if (merged[k] !== undefined && merged[k] !== v) {
      throw new Error(
        `Reserved env key ${JSON.stringify(k)} was already set by a user source; ` +
          `BUNSEN_ names are immutable and cannot be overridden.`,
      );
    }
    merged[k] = v;
  }

  return merged;
}

/**
 * Apply each env file declared in `defaults.envFiles` (relative to the
 * project root, as resolved by {@link loadProject}) to `process.env`.
 *
 * Only variables that aren't already defined in `process.env` are set —
 * explicit shell values always win.
 *
 * Does nothing if no `bunsen.config.yaml` is present, or if the config
 * declares no `envFiles`. This replaces the previous behavior where the
 * CLI would implicitly load any `.env` at the project root on startup.
 */
export function loadProjectEnv(): Record<string, string> {
  const project = loadProject();
  const envFiles = project.config.defaults?.envFiles ?? [];

  const merged: Record<string, string> = {};
  for (const rel of envFiles) {
    const envPath = path.resolve(project.root, rel);
    if (!fs.existsSync(envPath)) continue;
    const parsed = parseEnvFile(envPath);
    for (const [key, value] of Object.entries(parsed)) {
      merged[key] = value;
    }
  }

  for (const [key, value] of Object.entries(merged)) {
    if (isReservedEnvKey(key)) continue;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return merged;
}
