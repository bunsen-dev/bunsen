// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Configuration entry point for `experiment.yaml` and `agent.yaml`.
 *
 * The parsing/validation lives in the dedicated v1 loaders
 * (`./experiment-loader.ts`, `./agent-loader.ts`); this module is the
 * config-domain aggregator that surfaces them alongside the directory
 * discovery helpers and the default base image.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Default base image when none specified */
export const DEFAULT_BASE_IMAGE = 'bunsen/headless';

// ---------------------------------------------------------------------------
// experiment.yaml (v1) — re-exported from the loader module
// ---------------------------------------------------------------------------

export {
  parseExperimentConfig,
  loadExperiment,
  applyVariant,
  validateCriteriaGraph,
  resolveWorkspaceSources,
  ExperimentConfigError,
} from './experiment-loader.js';
export type {
  ResolvedExperiment,
  ResolvedWorkspaceSource,
} from './experiment-loader.js';

// ---------------------------------------------------------------------------
// agent.yaml (v1) — re-exported from the loader module
// ---------------------------------------------------------------------------

export {
  parseAgentConfig,
  loadAgent,
  applyAgentVariant,
  parseAgentVariantSyntax,
  getAgentVariants,
  resolveModelSelection,
  AgentConfigError,
} from './agent-loader.js';
export type {
  ResolvedAgent,
  AgentWarning,
  LoadAgentOptions,
  ParseAgentOptions,
  ModelSelection,
} from './agent-loader.js';

// ---------------------------------------------------------------------------
// Directory discovery helpers
// ---------------------------------------------------------------------------

/** List experiment directories under `baseDir` that contain an `experiment.yaml`. */
export function findExperiments(baseDir: string): string[] {
  const resolvedDir = path.resolve(baseDir);
  if (!fs.existsSync(resolvedDir)) return [];
  const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
  return entries
    .filter((entry) => {
      if (!entry.isDirectory()) return false;
      const configPath = path.join(resolvedDir, entry.name, 'experiment.yaml');
      return fs.existsSync(configPath);
    })
    .map((entry) => path.join(resolvedDir, entry.name));
}

/** List agent directories under `baseDir` that contain an `agent.yaml`. */
export function findAgents(baseDir: string): string[] {
  const resolvedDir = path.resolve(baseDir);
  if (!fs.existsSync(resolvedDir)) return [];
  const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
  return entries
    .filter((entry) => {
      if (!entry.isDirectory()) return false;
      const configPath = path.join(resolvedDir, entry.name, 'agent.yaml');
      return fs.existsSync(configPath);
    })
    .map((entry) => path.join(resolvedDir, entry.name));
}
