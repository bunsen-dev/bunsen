// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Public v1 shape for `bunsen.config.yaml`.
 *
 * The matching JSON Schema lives at `@bunsen-dev/types/schemas/project.v1.json`.
 */

import type { RunPlatform } from './common.js';

// ---------------------------------------------------------------------------
// Top-level project config
// ---------------------------------------------------------------------------

export interface ProjectConfig {
  $schema?: string;
  version: 'v1';
  name?: string;

  paths?: ProjectPaths;
  suites?: ProjectSuiteEntry[];
  storage?: ProjectStorageConfig;
  defaults?: ProjectDefaults;
  registries?: ProjectRegistries;
  /**
   * Reserved namespace for the future remote-execution provider config. The
   * v1 parser preserves any value passed here and emits a warning rather than
   * a hard error so external tooling can target the eventual shape today.
   */
  remote?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface ProjectPaths {
  experiments?: string[];
  agents?: string[];
  /** Precedence rule when suite experiments share a name with local ones. */
  precedence?: 'local' | 'suites';
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

export interface ProjectSuiteEntry {
  source: ProjectSuiteSource;
  /**
   * Optional local alias used for unqualified `bn run <name>` resolution and
   * short experiment paths. The canonical suite id (recorded in run manifests)
   * is always derived from the source URL — this only affects how the user
   * refers to the suite locally.
   */
  as?: string;
  /** Optional cache override; defaults to `storage.root/suites/<derived-id>`. */
  cacheDir?: string;
}

/** Suite source — only git is supported in v1. */
export type ProjectSuiteSource = ProjectSuiteSourceGit;

export interface ProjectSuiteSourceGit {
  type: 'git';
  url: string;
  /** Branch, tag, or SHA. Defaults to the repo's default branch. */
  ref?: string;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface ProjectStorageConfig {
  /** Storage root for runs, caches, and suite clones. */
  root?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export interface ProjectDefaults {
  run?: ProjectRunDefaults;
  /** Env variables applied to every run at the project level. */
  env?: Record<string, string>;
  /** Host env vars allowed to pass through to runs. */
  passEnv?: string[];
  /** `.env` files auto-loaded by the CLI (project-root only). */
  envFiles?: string[];
}

export interface ProjectRunDefaults {
  /** Default per-run timeout. Duration string. */
  timeout?: string;
  /** Default platform; `auto` = use Docker daemon architecture. */
  platform?: 'auto' | RunPlatform;
  capture?: ProjectCaptureConfig;
  supervisor?: ProjectSupervisorConfig;
}

export interface ProjectCaptureConfig {
  traces?: boolean;
  recording?: boolean;
}

export interface ProjectSupervisorConfig {
  /** Stall detection timeout. Duration string. */
  stallTimeout?: string;
  /** Maximum check interval. Duration string. */
  maxCheckInterval?: string;
}

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

export interface ProjectRegistries {
  images?: ProjectImageRegistry;
}

export interface ProjectImageRegistry {
  headless?: string;
  browser?: string;
}
