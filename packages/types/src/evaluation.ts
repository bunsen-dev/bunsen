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
  /**
   * Why `evaluation.report` produced no narrative although it was configured:
   * the report scorer crashed, timed out, or returned no verdict. Absent when
   * the report succeeded or was not configured.
   */
  reportError?: string;
}

/** Per-criterion outcome. */
export interface CriterionResult {
  /** Criterion id (matches `Criterion.id` from the experiment). */
  id: string;
  /** Human-readable title carried through from the experiment config. */
  title?: string;
  /** Resolved weight after variant overrides (default 1). */
  weight: number;
  /** Score in `[0, 1]`; `null` for skipped or errored criteria. */
  score: number | null;
  /** Brief explanation, 1–3 sentences. */
  summary: string;
  status: CriterionStatus;
  scorerType: RunManifestScorerType;
  /**
   * The `<provider>/<model>` that scored this criterion. Present on LLM-backed
   * criteria (`judge`, `agent`, `browser-agent`); absent on `script` and
   * `aggregate`.
   */
  model?: string;
  /**
   * Short description of why the scorer could not produce a verdict (crash,
   * API failure, timeout, no verdict after the forced submit). Present only
   * when `status` is `'error'`; `score` is `null` and excluded from the
   * weighted score.
   */
  error?: string;
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
 * - `skipped`: scorer did not run because a `gate.ifBelow` threshold failed
 *   (or its evidence was lost to a failed capture step).
 * - `error`: the scorer ran but could not produce a verdict — it crashed,
 *   the model API failed after retries, it timed out, or it never submitted.
 *   `score` is `null` and excluded from the weighted score; `error` says why.
 *   A gate on an errored criterion does not pass. Evaluation continues.
 * - `not_run`: the run failed or was canceled before this criterion executed.
 */
export type CriterionStatus = 'completed' | 'skipped' | 'error' | 'not_run';
