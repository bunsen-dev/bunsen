// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Public v1 shape for `bunsen-suite.yaml`.
 *
 * The matching JSON Schema lives at `@bunsen-dev/types/schemas/suite.v1.json`.
 *
 * The manifest deliberately does **not** include an `id` field — a suite's
 * canonical id is derived from where it was cloned (`<host>/<org>/<repo>`)
 * or `local/<dirname>` for on-disk suites, never declared by the author.
 * That keeps suite ids globally unique by construction.
 */

// ---------------------------------------------------------------------------
// Top-level suite manifest
// ---------------------------------------------------------------------------

export interface SuiteManifestV1 {
  $schema?: string;
  version: 'v1';
  /** Human display name; not used for identity. */
  name: string;
  description?: string;
  /** Suite content version (semver recommended). Separate from schema `version`. */
  version_tag?: string;
  license?: string;

  compatibility?: SuiteCompatibility;

  /** Directories in the repo that contain `experiment.yaml` files. */
  experiments: string[];

  tags?: Record<string, string[]>;
  tracks?: Record<string, SuiteTrack>;

  aggregation?: SuiteAggregation;
}

export interface SuiteCompatibility {
  /**
   * Minimum `bn` version that understands this manifest's schema features.
   * Per-experiment image / runtime / package needs live in each
   * `experiment.yaml` and are not duplicated here.
   */
  min_bunsen_version?: string;
}

export interface SuiteTrack {
  description?: string;
  include?: string[];
  exclude?: string[];
}

export interface SuiteAggregation {
  default?: 'weighted_average' | 'all' | 'any' | 'min' | 'max' | 'mean';
  weights?: SuiteWeightConfig;
}

export interface SuiteWeightConfig {
  by_tag?: Record<string, number>;
  by_experiment?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Resolved suite — manifest + identity + on-disk location
// ---------------------------------------------------------------------------

/**
 * A suite that has been located on disk (either via a project's
 * `bunsen.config.yaml#suites` entry or as the local project itself).
 *
 * `id` is the canonical, derived identifier: `<host>/<org>/<repo>` for
 * git-cloned suites, `local/<dirname>` for on-disk suites with no clone URL.
 * Suite-level provenance fields (`source_url`, `version` = commit sha) are
 * also carried here so they can flow into run manifests without re-deriving.
 */
export interface ResolvedSuite {
  /** Canonical suite id. */
  id: string;
  /** Absolute path to the suite repo root. */
  root: string;
  /** Parsed `bunsen-suite.yaml`, or `undefined` if the repo lacks a manifest. */
  manifest?: SuiteManifestV1;
  /** Optional local alias from `bunsen.config.yaml#suites[].as`. */
  alias?: string;
  /** Source URL the suite was cloned from (absent for `local/...` suites). */
  source_url?: string;
  /** Commit sha of the resolved ref (absent for `local/...` suites). */
  version?: string;
}
