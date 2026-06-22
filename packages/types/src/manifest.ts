// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Canonical `RunManifestV1` shape.
 *
 * The authoritative public reference lives at `docs/RUN_MANIFEST.md`. This
 * module is the TypeScript projection.
 */

import type { AllowedScores, ArtifactKind, RedactionState, RunPlatform, RunSource, VerificationTier } from './common.js';
import type { CriterionStatus } from './evaluation.js';
import type { RunStatus } from './run.js';

export interface RunManifestV1 {
  schema_version: 1;
  run_id: string;
  /** Starts at 1; incremented on manifest-changing updates. */
  manifest_revision: number;
  run_source: RunSource;

  created_at: string;
  updated_at: string;

  status: RunStatus;
  exit_code?: number;
  started_at: string;
  completed_at?: string;
  duration_ms: number;

  /** Resolved platform for the run. */
  platform?: RunPlatform;

  experiment: RunManifestExperiment;
  agent: RunManifestAgent;

  orchestration?: RunManifestOrchestration;

  usage: RunManifestUsage;
  evaluation?: RunManifestEvaluation;
  human_scoring?: RunManifestHumanScoring;

  provenance: RunManifestProvenance;
  artifacts: RunManifestArtifact[];

  /**
   * Structured diagnostics recorded for this run — non-blocking signals the
   * runtime wants to surface in `bn runs show`. Currently only the
   * cross-boundary binary-shadow detector emits entries (see
   * `docs/ENVIRONMENT.md#asymmetric-composition`). Absent on runs that
   * recorded no diagnostics.
   */
  diagnostics?: RunManifestDiagnostic[];

  /** Reserved extensibility zone. */
  extensions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Sub-shapes
// ---------------------------------------------------------------------------

export interface RunManifestExperiment {
  id: string;
  path?: string;
  variant?: string;
  /**
   * Canonical suite id (`<host>/<org>/<repo>` for git-cloned suites, or
   * `local/<dirname>` for on-disk suites). Only present when the run came
   * from a suite. Not the local alias from `bunsen.config.yaml#suites[].as`.
   */
  suite_id?: string;
  /** Commit sha of the cloned suite ref. Only present for suite runs. */
  suite_version?: string;
  /** Git URL the suite was cloned from. Only present for git-cloned suite runs. */
  suite_source_url?: string;
  /** SHA-256 over the normalized experiment config. */
  config_hash?: string;
}

export interface RunManifestAgent {
  id: string;
  path?: string;
  variant?: string;
  args: string[];
  /**
   * The model the agent was *configured* with for this run — the value of the
   * agent's declared `model.env` variable after the full env merge (`--model`
   * override, variant pin, or declared default). This is the intent, recorded
   * at launch; contrast with `models` below, which is what actually ran,
   * observed from captured traces. Absent when the agent declares no model
   * selection (no `model.env`).
   */
  model?: string;
  /**
   * Models the agent-under-test drove, observed from captured traces and
   * sorted highest-cost first. Each entry carries that model's share of the
   * agent's API calls, tokens, and cost. Absent when no agent traces were
   * captured — there is no declared/placeholder fallback, so this is always
   * a record of what actually ran. Counts only successful (2xx) inference:
   * errored calls (e.g. a 404 for an unavailable model) are excluded, so a
   * model that never returned a response can't appear here. Platform models
   * (orchestrator, supervisor, scorer) are excluded too; they live in
   * `usage.by_source`. NB: because errored + platform calls are filtered out,
   * the per-model call counts here do not sum to `usage.total_ai_calls`.
   */
  models?: AgentModelUsage[];
  /** SHA-256 over the normalized agent config. */
  config_hash?: string;
  /** Resolved install.deps for the run (version + cache key, in declared order). */
  deps?: RunManifestAgentDep[];
}

/**
 * One model's slice of an agent run's API usage. The full set (sorted
 * highest-cost first) lives on `RunManifestAgent.models`; `models[0]` is the
 * run's headline/primary model — the one that carried the run's compute, not
 * necessarily the one with the most calls.
 */
export interface AgentModelUsage {
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface RunManifestAgentDep {
  name: string;
  version?: string;
  /** install.deps build-cache key. */
  cache_key: string;
  /** Binary names declared in `provides.binaries`. */
  binaries: string[];
}

export interface RunManifestOrchestration {
  setup_commands: string[];
  /** Structured invocation — see `OrchestrationResult` for the public SDK shape. */
  invocation: { command: string; args: string[] };
}

export interface RunManifestUsage {
  total_ai_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  /**
   * Run-wide cache-read / cache-creation input tokens, summed across every
   * source. Disjoint from `total_input_tokens` (which is fresh-only). Cache
   * reads routinely dwarf fresh input on agent loops, so this is what explains
   * why a run cost what it did. Absent on runs finalized before cache
   * accounting existed and on runs with no captured traces.
   */
  total_cache_read_input_tokens?: number;
  total_cache_creation_input_tokens?: number;
  estimated_cost_usd: number;
  agent_cost_usd?: number;
  platform_cost_usd?: number;
  /**
   * Calls whose model was absent from the vendored pricing snapshot and priced
   * with a coarse per-provider default — so this much of the cost is a rough
   * estimate, not a data-driven rate. Present only when > 0. `bn runs show` and
   * `bn runs cost` surface it so a guessed cost isn't read as accurate; the
   * camelCase trace-summary equivalent is `TracesSummary.pricingFallbackCalls`.
   */
  pricing_fallback_calls?: number;
  /** Distinct unrecognized model ids behind `pricing_fallback_calls`, sorted. */
  unpriced_models?: string[];
  by_source?: Record<string, RunManifestUsageSource>;
  /**
   * Whether the count/token/cost numbers reflect actual captured API traffic.
   * Distinguishes "trustworthy zero" from "no proxy data — we don't know".
   *
   * - `captured`: proxy intercepted at least one inference call. Numbers are
   *   accurate within the limits of the in-proxy parser.
   * - `missing`: proxy was active but recorded no traces. Could mean a
   *   deterministic agent that made no LLM calls, OR an agent whose HTTP
   *   client bypassed the proxy (e.g., Node native fetch / undici, which
   *   doesn't honor `HTTPS_PROXY`). Treat the totals as a lower bound.
   * - `skipped`: tracing was deliberately disabled (`--skip-traces`).
   *
   * Absent (`undefined`) on legacy runs and on runs that errored before the
   * trace-finalization step.
   */
  accounting_status?: 'captured' | 'missing' | 'skipped';
}

export interface RunManifestUsageSource {
  calls: number;
  /** Fresh (non-cached) input tokens. */
  input_tokens: number;
  output_tokens: number;
  /**
   * Cache-read / cache-creation input tokens for this source. Disjoint from
   * `input_tokens`. Always written by the current projection; absent only on
   * sources projected before cache accounting existed.
   */
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost_usd: number;
}

export interface RunManifestEvaluation {
  weighted_score: number;
  criteria: RunManifestCriterion[];
  report?: string;
}

export interface RunManifestCriterion {
  /** Criterion id (matches `Criterion.id` from the experiment). */
  id: string;
  title?: string;
  weight: number;
  score: number | null;
  summary: string;
  status?: CriterionStatus;
  scorer_type?: RunManifestScorerType;
  allowed_scores?: AllowedScores;
  /** Artifact keys for any screenshots produced by the scorer. */
  screenshots?: string[];
  /** Artifact key for the scorer's log output. */
  log_path?: string;
}

export type RunManifestScorerType =
  | 'script'
  | 'judge'
  | 'agent'
  | 'browser-agent'
  | 'aggregate';

export interface RunManifestHumanScoring {
  scored_by: string;
  scored_at: string;
  criteria: RunManifestHumanCriterion[];
}

export interface RunManifestHumanCriterion {
  id: string;
  human_score: number;
  llm_score: number | null;
  notes?: string;
  allowed_scores?: AllowedScores;
}

export interface RunManifestProvenance {
  verification_tier: VerificationTier;
  replayable: boolean;
  image_digest?: string;
  suite_version_locked?: boolean;
  attestation_id?: string;
}

/**
 * Discriminated union of structured run-level diagnostics. Currently only
 * the cross-boundary binary-shadow detector (introduced with the
 * asymmetric-ownership change) writes entries; extend by adding new
 * `diagnostic` discriminator values rather than relaxing the existing shapes.
 */
export type RunManifestDiagnostic = RunManifestCrossBoundaryShadow;

export interface RunManifestCrossBoundaryShadow {
  diagnostic: 'cross-boundary-binary-shadow';
  /** Binary name (e.g. `rg`). Matches `provides.binaries[]` on the agent dep. */
  binary: string;
  /** Resolved winner on the run's PATH. */
  winner: {
    source: 'agent-dep';
    /** Dep name. */
    name: string;
    /** Version when known. */
    version?: string;
  };
  /** Loser of the precedence contest (the substrate-side package that also declared this binary). */
  shadowed: {
    source: 'substrate-apt' | 'substrate-npm' | 'substrate-pip';
    name: string;
    version?: string;
  };
  /** Human-readable reason explaining how the conflict resolved. */
  resolution: string;
}

export interface RunManifestArtifact {
  key: string;
  kind: ArtifactKind;
  rel_path?: string;
  object_url?: string;
  content_type?: string;
  bytes?: number;
  sha256?: string;
  redaction_state?: RedactionState;
  created_at: string;
  /** Human-readable title surfaced in UIs. */
  title?: string;
}
