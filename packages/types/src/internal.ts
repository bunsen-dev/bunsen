// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Internal runtime/CLI/platform-agent type layer.
 *
 * These shapes back the in-process runtime, the `bn` CLI, and the bundled
 * platform agents (orchestrator, scorer, supervisor). They are **not** part of
 * the public v1 API — `@bunsen-dev/sdk` and the `RunManifestV1` family are the
 * stable, externally-facing surface. The types here are the in-memory and
 * on-disk-artifact shapes the engine works with before/while projecting onto
 * the canonical `manifest.json`.
 *
 * They live in `@bunsen-dev/types` (rather than `@bunsen-dev/runtime`) because the
 * bundled agents can only import from dependency-free packages — see
 * `packages/agents/CLAUDE.md`.
 *
 * @internal
 */

import type { RunPlatform, AllowedScores } from './common.js';
import type { AggregateFunction, JudgeEvidence } from './experiment.js';
import type { ScriptResultArtifact } from './evaluation.js';
import type { RunManifestScorerType } from './manifest.js';

// ============================================================================
// AI trace capture
// ============================================================================

/** @internal */
export interface AITrace {
  provider: 'anthropic' | 'openai' | 'google' | 'other';
  model: string;
  endpoint: string;
  source?: string;
  timestamp: string;
  latencyMs: number;
  /** HTTP status of the captured response. Stamped by the proxy on every call. */
  statusCode?: number;
  request: {
    messages?: unknown[];
    system?: string;
    [key: string]: unknown;
  };
  response: {
    content?: unknown;
    /**
     * Normalized token usage. The three input buckets are DISJOINT for every
     * provider (Anthropic, OpenAI, Gemini): `inputTokens` is fresh, non-cached
     * input only; cached input is in `cacheReadInputTokens` /
     * `cacheCreationInputTokens`. Total prompt size =
     * inputTokens + cacheReadInputTokens + cacheCreationInputTokens. This
     * normalization happens in the proxy (`ai_capture.py:_extract_usage`); the
     * displayed "in" count is therefore fresh-only and comparable across
     * vendors, and it equals the input billed at the full (non-cached) rate.
     */
    usage?: {
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
    };
    [key: string]: unknown;
  };
  estimatedCostUsd: number;
  /**
   * Set by the proxy when the captured model wasn't found in the vendored
   * pricing snapshot, so `estimatedCostUsd` is a coarse per-provider default
   * rather than a data-driven rate. Absent means the model was priced from the
   * snapshot. Only stamped when the fallback produced a non-zero cost, so $0
   * calls (e.g. `count_tokens`) don't raise false alarms.
   */
  pricingFallback?: boolean;
}

/** @internal */
export interface SourceCostBreakdown {
  calls: number;
  /** Fresh (non-cached) input tokens — billed at the full rate. */
  inputTokens: number;
  outputTokens: number;
  /**
   * Cached input read back at the discounted rate. Disjoint from
   * `inputTokens`; often dominates the prompt size on agent loops (a single
   * Claude Code run observed 3,447 fresh input vs 1,143,571 cache-read).
   */
  cacheReadInputTokens: number;
  /** Input written into the cache at the cache-write premium. */
  cacheCreationInputTokens: number;
  costUsd: number;
}

/** @internal */
export interface TracesSummary {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Run-wide cache-read input tokens (sum across all sources). */
  totalCacheReadInputTokens: number;
  /** Run-wide cache-creation input tokens (sum across all sources). */
  totalCacheCreationInputTokens: number;
  estimatedTotalCostUsd: number;
  /**
   * Calls whose model was absent from the pricing snapshot and priced with a
   * coarse per-provider default (see `AITrace.pricingFallback`). Present
   * only when > 0. `bn runs cost` surfaces this so a guessed cost isn't
   * mistaken for an accurate one.
   */
  pricingFallbackCalls?: number;
  /** Distinct unrecognized model ids behind `pricingFallbackCalls`, sorted. */
  unpricedModels?: string[];
  bySource?: {
    agent: SourceCostBreakdown;
    platform: SourceCostBreakdown;
    orchestrator?: SourceCostBreakdown;
    supervisor?: SourceCostBreakdown;
    scorer?: SourceCostBreakdown;
    scorers?: Record<string, SourceCostBreakdown>;
  };
}

// ============================================================================
// Human scoring + calibration
// ============================================================================

/** @internal */
export interface HumanCriterionScore {
  criterion: string;
  humanScore: number;
  llmScore: number | null;
  notes?: string;
  allowedScores?: AllowedScores;
}

/** @internal */
export interface HumanScores {
  criteria: HumanCriterionScore[];
  scoredBy: string;
  scoredAt: string;
}

/** @internal */
export interface CalibrationCriterionStats {
  criterion: string;
  count: number;
  meanAbsoluteError: number;
  meanSignedError: number;
  scorerType?: RunManifestScorerType;
}

/** @internal */
export interface CalibrationResult {
  criteria: CalibrationCriterionStats[];
  overallMAE: number;
  overallMeanSignedError: number;
  runCount: number;
  byScorerType: Record<string, { mae: number; meanSignedError: number; count: number }>;
}

// ============================================================================
// Container plumbing
// ============================================================================

/** @internal */
export interface ContainerOptions {
  image: string;
  mounts: ContainerMount[];
  env?: Record<string, string>;
  workdir?: string;
  networkMode?: 'bridge' | 'none';
  platform?: RunPlatform;
  command?: string[];
  timeout?: number;
}

/** @internal */
export interface ContainerMount {
  source: string;
  target: string;
  readonly?: boolean;
}

// ============================================================================
// Scorer runtime contract (runtime → bundled scorer agent)
// ============================================================================

/**
 * Internal scorer-dispatch vocabulary. This is the contract the runtime sends
 * to the bundled scorer agent (`ScorerConfig.type`), which switches on these
 * values to pick a scoring strategy. Distinct from the public
 * {@link RunManifestScorerType} (`judge`/`script`/`browser-agent`/…): this set
 * is the engine's own vocabulary and additionally carries `report`, the
 * dedicated `evaluation.report` narrative step, which has no manifest scorer
 * type.
 *
 * @internal
 */
export type ScorerType = 'llm' | 'agent' | 'visual' | 'report' | 'aggregate' | 'code';

/** @internal */
export interface DependencyScore {
  score: number | null;
  summary: string;
}

/** @internal */
export interface ScorerConfig {
  criterion: string;
  instructions?: string;
  type: ScorerType;
  model?: string;
  tools?: string[];
  scores?: AllowedScores;
  prompt?: string;
  contextDir: string;
  workspacePath: string;
  dependencyScores?: Record<string, DependencyScore>;
  aggregate?: AggregateFunction;
  context?: JudgeEvidence[];
}

/** @internal */
export interface ScorerOutput {
  score: number | null;
  summary: string;
  report?: string;
  screenshots?: string[];
  /** Artifacts captured from a `type: script` criterion's `result.json`. */
  artifacts?: ScriptResultArtifact[];
}

// ============================================================================
// Supervisor
// ============================================================================

/** @internal */
export interface SupervisorInteraction {
  timestamp: string;
  terminalState: string;
  detected: boolean;
  response?: string;
  keysSent?: string;
  error?: string;
}

/** @internal */
export interface SupervisorLog {
  interactions: SupervisorInteraction[];
  totalDetections: number;
  totalInteractions: number;
  startTime: string;
  endTime?: string;
}
