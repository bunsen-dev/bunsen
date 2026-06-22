// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Run-level public types: status enum, artifact descriptors.
 *
 * `RunPlatform` lives in `common.ts` so it can be shared with `experiment.ts`
 * and `project.ts` without pulling in this module.
 */

import type { ArtifactKind, RedactionState } from './common.js';

/**
 * Run status — v1 values.
 *
 * Supersedes the earlier `completed` / `aborted` pair. `succeeded` makes the
 * success-vs-failure split explicit; `canceled` distinguishes user/system
 * cancellation from crashes.
 */
export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled';

/**
 * Compact projection of a `RunManifestV1` for cross-run listings (`bn runs
 * list`, `bn runs compare`, etc.). Public — task 17's `--format json` will
 * surface this shape directly. Field names follow the rest of the public
 * type surface (camelCase), unlike the snake_case manifest itself.
 */
export interface RunSummary {
  runId: string;
  experimentId: string;
  experimentVariant?: string;
  agentId: string;
  agentVariant?: string;
  /** Most-used agent model (rank 0 of `agent.models`); `undefined` when no traces were captured. */
  agentModel?: string;
  /** Number of distinct models the agent drove. Powers the multi-model "+N" hint in listings. */
  agentModelCount?: number;
  status: RunStatus;
  exitCode?: number;
  startedAt: string;
  completedAt?: string;
  durationMs: number;
  weightedScore: number | null;
  /** Headline (agent-under-test) cost. */
  estimatedCostUsd: number;
  agentCostUsd?: number;
  platformCostUsd?: number;
  /**
   * Calls priced with a coarse default because their model was absent from the
   * pricing snapshot — so some of `estimatedCostUsd` is a rough estimate, not a
   * data-driven rate. Present only when > 0; `bn runs compare` / `bn runs list`
   * mark these runs. Per-model details live in the manifest / `bn runs cost`.
   */
  pricingFallbackCalls?: number;
  /** Total AI calls across agent + platform sources. */
  totalAiCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /**
   * Run-wide cache-read / cache-creation input tokens (disjoint from
   * `totalInputTokens`). Absent on runs indexed before cache accounting existed
   * — the index is a derived cache, so `bn index rebuild` repopulates them.
   */
  totalCacheReadInputTokens?: number;
  totalCacheCreationInputTokens?: number;
}

/**
 * Filter passed to cross-run query helpers. Shared by the local SQLite
 * index and (eventually) the cloud query path so SDK callers can pass
 * the same shape to either backend.
 */
export interface RunFilter {
  experimentId?: string;
  agentId?: string;
  status?: RunStatus | RunStatus[];
  minScore?: number;
  maxScore?: number;
  startedAfter?: string;
  startedBefore?: string;
  limit?: number;
  offset?: number;
  /** Sort column. Default: `startedAt` (descending). */
  orderBy?: 'started_at' | 'completed_at' | 'weighted_score' | 'estimated_cost_usd';
  orderDir?: 'ASC' | 'DESC';
}

/**
 * Public artifact descriptor returned by the SDK. Aligned with the
 * `artifacts[]` entries stored in `RunManifestV1`.
 */
export interface ArtifactDescriptor {
  /** Logical key — `runs/<run_id>/<rel_path>`. */
  key: string;
  kind: ArtifactKind;
  /** Local filesystem relative path (when the run lives on disk). */
  rel_path?: string;
  /** Cloud URL (when the artifact lives in remote object storage). */
  object_url?: string;
  /** MIME type, when known. */
  mediaType?: string;
  bytes?: number;
  sha256?: string;
  redaction_state?: RedactionState;
  created_at: string;
  /** Human-readable title surfaced in UIs. */
  title?: string;
}
