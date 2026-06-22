// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Public `EvaluationResult` shape, aligned with v1 criterion types.
 */

import type { AllowedScores } from './common.js';
import type { RunManifestScorerType } from './manifest.js';

export interface EvaluationResult {
  /** All criterion results, preserving YAML order. */
  criteria: CriterionResult[];
  /** Weighted score in `[0, 1]`, computed from criteria with `weight > 0`. */
  weightedScore: number;
  /** Narrative produced by `evaluation.report`, if configured. */
  report?: string;
}

/** Per-criterion outcome. */
export interface CriterionResult {
  /** Criterion id (matches `Criterion.id` from the experiment). */
  id: string;
  /** Human-readable title carried through from the experiment config. */
  title?: string;
  /** Resolved weight after variant overrides (default 1). */
  weight: number;
  /** Score in `[0, 1]`; `null` for skipped criteria or narrative-only scorers. */
  score: number | null;
  /** Brief explanation, 1–3 sentences. */
  summary: string;
  status: CriterionStatus;
  scorerType: RunManifestScorerType;
  /** Allowed discrete scores, if the criterion declared them. */
  allowedScores?: AllowedScores;
  /** Artifact keys for screenshots captured by the scorer. */
  screenshots?: string[];
  /** Artifact key for the scorer's log output. */
  logPath?: string;
  /** Extra artifacts attached via `result.json` (script criteria). */
  artifacts?: ScriptResultArtifact[];
}

/**
 * Optional structured result for `type: script` criteria.
 *
 * The scorer writes this JSON document to `BUNSEN_EVAL_RESULT`
 * (defaulting to `/bunsen/scorer-output/result.json`). When present,
 * it takes precedence over `BUNSEN_SCORE_FILE` and the exit-code
 * fallback during score resolution. See `docs/SCORERS.md`.
 */
export interface ScriptResult {
  /** Score in `[0, 1]`. */
  score: number;
  /** Optional human-readable summary. Falls back to default messages. */
  summary?: string;
  /** Optional artifact metadata, propagated into the run manifest. */
  artifacts?: ScriptResultArtifact[];
}

/**
 * Metadata for an artifact file emitted by a script scorer.
 *
 * `path` is interpreted relative to `BUNSEN_SCORER_OUTPUT`
 * (`/bunsen/scorer-output`) and must point at a file the scorer wrote
 * during the criterion run.
 */
export interface ScriptResultArtifact {
  /** Path relative to the scorer-output directory. */
  path: string;
  /** Optional MIME type for downstream tooling. */
  mediaType?: string;
}

/**
 * Criterion execution status.
 *
 * - `completed`: scorer ran and produced a score.
 * - `skipped`: scorer did not run because a `gate.ifBelow` threshold failed.
 * - `not_run`: the run failed or was canceled before this criterion executed.
 */
export type CriterionStatus = 'completed' | 'skipped' | 'not_run';
