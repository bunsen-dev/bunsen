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
import type { JudgeEvidence, ScorerToolName } from './experiment.js';
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
 * The four shapes the bundled scorer runs. `judge`, `agent`, and
 * `browser-agent` are the LLM-backed criterion types (the public
 * {@link RunManifestScorerType} vocabulary); `report` is the dedicated
 * `evaluation.report` narrative step, which has no manifest scorer type.
 * `script` and `aggregate` criteria never reach the bundle — the runtime
 * dispatches them itself.
 *
 * @internal
 */
export type ScorerRunType = 'judge' | 'agent' | 'browser-agent' | 'report';

/** @internal */
export interface DependencyScore {
  score: number | null;
  summary: string;
}

/**
 * What the runtime hands the bundled scorer (`scorer.cjs --config`). Every
 * field is resolved on the host: `model` is always the full
 * `<provider>/<model>` string (the default is applied before the config is
 * written), and paths are container paths.
 *
 * @internal
 */
export interface ScorerConfig {
  type: ScorerRunType;
  /** Criterion id (`summary-report` for the report step). */
  id: string;
  /** Human-readable criterion title, shown in the user turn. */
  title: string;
  /** The criterion's `instructions` (or `report.instructions`). */
  instructions: string;
  /** Resolved `<provider>/<model>`; never absent. */
  model: string;
  /** User-supplied replacement for the default system prompt. */
  systemPrompt?: string;
  /** Exploration-tool allowlist (agent / browser-agent). Verdict tools are implicit. */
  tools?: ScorerToolName[];
  /** Allowed discrete scores; enforced by the `submit_score` schema. */
  scores?: AllowedScores;
  /** Evidence inlined into the user turn (judge and report). */
  evidence?: JudgeEvidence[];
  /** Run context dir inside the container (`/bunsen/run`). */
  contextDir: string;
  /** The agent's final workspace inside the container (`/workspace`). */
  workspacePath: string;
  /** The pre-run workspace snapshot, when mounted (`/workspace-source`, dedicated mode only). */
  workspaceSourcePath?: string;
  /** Results of the criteria this one `needs` (always set for the report). */
  dependencyScores?: Record<string, DependencyScore>;
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
