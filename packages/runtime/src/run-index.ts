// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Local SQLite index over `RunManifestV1` projections.
 *
 * SQLite is a derived index: it can always be dropped and rebuilt from
 * `manifest.json` files via `bn index rebuild`. The manifest is the source of
 * truth; this module is read-optimized projection.
 *
 * See `docs/RUN_MANIFEST.md` for the manifest fields projected into this index.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import type {
  AgentModelUsage,
  AllowedScores,
  RunFilter,
  RunManifestV1,
  RunStatus,
  RunSummary,
} from '@bunsen-dev/types';
import { getBunsenDir, getRunsDir, loadRunManifest } from './storage.js';

export const RUN_INDEX_FILENAME = 'index.sqlite';

// `RunSummary` and `RunFilter` are part of the public v1 type surface in
// `@bunsen-dev/types/src/run.ts`. Re-exported from this module for convenience
// because the SQLite query helpers below produce/consume them; treat the
// `@bunsen-dev/types` definitions as the canonical contract.
export type { RunFilter, RunSummary };

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Bumped whenever the schema or projection logic changes, and stored in
 * `meta.schema_version`. The index is never migrated in place — `CREATE TABLE
 * IF NOT EXISTS` can't add columns to an existing table, so a fresh file is the
 * only way a change takes effect. A version mismatch therefore triggers a
 * delete-and-rebuild from `manifest.json` (always the source of truth), both
 * automatically at open time ({@link ensureRunIndexFresh}) and on demand via
 * `bn index rebuild` ({@link rebuildIndex}).
 */
export const RUN_INDEX_SCHEMA_VERSION = 4;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  manifest_revision INTEGER NOT NULL,
  run_source TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER NOT NULL,

  experiment_id TEXT NOT NULL,
  experiment_path TEXT,
  experiment_variant TEXT,
  suite_id TEXT,
  suite_version TEXT,
  experiment_config_hash TEXT,

  agent_id TEXT NOT NULL,
  agent_path TEXT,
  agent_variant TEXT,
  -- Derived headline: rank-0 (highest-cost) model from agent.models. NULL when
  -- no agent traces were captured. Full breakdown lives in run_agent_models.
  agent_model TEXT,
  -- Number of distinct models the agent drove. NULL when unknown (no traces).
  agent_model_count INTEGER,
  agent_config_hash TEXT,
  args_json TEXT NOT NULL,

  orchestration_json TEXT,

  total_ai_calls INTEGER NOT NULL,
  total_input_tokens INTEGER NOT NULL,
  total_output_tokens INTEGER NOT NULL,
  total_cache_read_input_tokens INTEGER,
  total_cache_creation_input_tokens INTEGER,
  estimated_cost_usd REAL NOT NULL,
  agent_cost_usd REAL,
  platform_cost_usd REAL,
  -- Calls priced with a coarse default because their model was absent from the
  -- pricing snapshot. NULL/0 = every model was priced. Drives the fallback
  -- marker in bn runs compare / list; per-model details live in the manifest.
  pricing_fallback_calls INTEGER,
  weighted_score REAL,

  verification_tier TEXT NOT NULL,
  replayable INTEGER NOT NULL,
  image_digest TEXT,
  suite_version_locked INTEGER,
  attestation_id TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_criteria (
  run_id TEXT NOT NULL,
  criterion TEXT NOT NULL,
  weight REAL NOT NULL,
  score REAL,
  summary TEXT NOT NULL,
  status TEXT,
  scorer_type TEXT,
  allowed_scores_json TEXT,
  screenshots_json TEXT,
  log_path TEXT,
  PRIMARY KEY (run_id, criterion),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS run_human_scores (
  run_id TEXT NOT NULL,
  criterion TEXT NOT NULL,
  human_score REAL NOT NULL,
  llm_score REAL,
  notes TEXT,
  allowed_scores_json TEXT,
  scored_by TEXT NOT NULL,
  scored_at TEXT NOT NULL,
  PRIMARY KEY (run_id, criterion),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS run_cost_breakdown (
  run_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  calls INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_input_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
  cost_usd REAL NOT NULL,
  PRIMARY KEY (run_id, source_key),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS run_agent_models (
  run_id TEXT NOT NULL,
  model TEXT NOT NULL,
  rank INTEGER NOT NULL,
  calls INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  PRIMARY KEY (run_id, model),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS run_artifacts (
  run_id TEXT NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  rel_path TEXT,
  object_url TEXT,
  content_type TEXT,
  bytes INTEGER,
  sha256 TEXT,
  redaction_state TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, key),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_experiment_started ON runs(experiment_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_agent_started ON runs(agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_experiment_agent_started ON runs(experiment_id, agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status_started ON runs(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_weighted_score ON runs(weighted_score);
CREATE INDEX IF NOT EXISTS idx_runs_cost ON runs(estimated_cost_usd);
CREATE INDEX IF NOT EXISTS idx_criteria_criterion_score ON run_criteria(criterion, score);
CREATE INDEX IF NOT EXISTS idx_human_scores_criterion ON run_human_scores(criterion);
CREATE INDEX IF NOT EXISTS idx_cost_source ON run_cost_breakdown(source_key);
CREATE INDEX IF NOT EXISTS idx_agent_models_model ON run_agent_models(model);
CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON run_artifacts(kind);
`;

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

export function getRunIndexPath(baseDir: string = process.cwd()): string {
  return path.join(getBunsenDir(baseDir), RUN_INDEX_FILENAME);
}

export interface OpenIndexOptions {
  /** When true, the database file must already exist (no schema creation). */
  readonly?: boolean;
}

/**
 * Open the run-index database. Creates the schema + .bunsen dir if missing.
 * Caller is responsible for closing the returned handle when done.
 *
 * The schema is never migrated in place: the index is a derived cache, so a
 * schema change just bumps {@link RUN_INDEX_SCHEMA_VERSION} and the recovery
 * is `bn index rebuild` (delete + regenerate from manifests). `SCHEMA_SQL`
 * therefore only ever needs to build a fresh schema.
 */
export function openRunIndex(
  baseDir: string = process.cwd(),
  options: OpenIndexOptions = {}
): DatabaseType {
  ensureRunIndexFresh(baseDir);
  return openIndexRaw(getRunIndexPath(baseDir), !!options.readonly);
}

/**
 * Open the index file directly, skipping the staleness check. Internal — used
 * by {@link openRunIndex} (after the check) and {@link rebuildIndex} (which IS
 * the recovery, so it must not re-trigger the check).
 */
function openIndexRaw(dbPath: string, readonly: boolean): DatabaseType {
  if (readonly) {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // WAL mode: better concurrency; the SQLite file becomes a write-ahead log
  // that's append-only for the duration of a transaction. Important here
  // because manifest writes happen on every run completion.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  upsertSchemaVersion(db);
  return db;
}

/**
 * Auto-recover from a schema-version change at the open boundary. When the
 * on-disk version doesn't match {@link RUN_INDEX_SCHEMA_VERSION} (or the file is
 * unreadable), {@link rebuildIndex} discards it and regenerates from
 * `manifest.json` files. No-op when the index is absent (readers handle that) or
 * already current — the common path is one cheap version read.
 */
export function ensureRunIndexFresh(baseDir: string = process.cwd()): void {
  const dbPath = getRunIndexPath(baseDir);
  if (!fs.existsSync(dbPath)) return;
  if (!indexSchemaIsStale(dbPath)) return;
  rebuildIndex(baseDir);
}

function indexSchemaIsStale(dbPath: string): boolean {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      return !row || Number(row.value) !== RUN_INDEX_SCHEMA_VERSION;
    } finally {
      db.close();
    }
  } catch {
    return true; // unreadable / corrupt → rebuild
  }
}

function upsertSchemaVersion(db: DatabaseType): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run('schema_version', String(RUN_INDEX_SCHEMA_VERSION));
}

// ---------------------------------------------------------------------------
// Upsert from manifest
// ---------------------------------------------------------------------------

/**
 * Upsert a manifest into the SQLite index.
 *
 * Wraps all the per-table writes in a single transaction so partial state
 * never lands. If the manifest is for a run that already has rows, the
 * existing rows are replaced (criteria, human scores, cost breakdown,
 * artifacts are full-replaced, not merged — the manifest is authoritative).
 */
export function upsertManifest(db: DatabaseType, manifest: RunManifestV1): void {
  const tx = db.transaction((m: RunManifestV1) => {
    db.prepare(
      `INSERT INTO runs (
         run_id, schema_version, manifest_revision, run_source, status,
         exit_code, started_at, completed_at, duration_ms,
         experiment_id, experiment_path, experiment_variant, suite_id,
         suite_version, experiment_config_hash,
         agent_id, agent_path, agent_variant, agent_model, agent_model_count,
         agent_config_hash, args_json,
         orchestration_json,
         total_ai_calls, total_input_tokens, total_output_tokens,
         total_cache_read_input_tokens, total_cache_creation_input_tokens,
         estimated_cost_usd, agent_cost_usd, platform_cost_usd,
         pricing_fallback_calls, weighted_score,
         verification_tier, replayable, image_digest, suite_version_locked,
         attestation_id, created_at, updated_at
       ) VALUES (
         @run_id, @schema_version, @manifest_revision, @run_source, @status,
         @exit_code, @started_at, @completed_at, @duration_ms,
         @experiment_id, @experiment_path, @experiment_variant, @suite_id,
         @suite_version, @experiment_config_hash,
         @agent_id, @agent_path, @agent_variant, @agent_model, @agent_model_count,
         @agent_config_hash, @args_json,
         @orchestration_json,
         @total_ai_calls, @total_input_tokens, @total_output_tokens,
         @total_cache_read_input_tokens, @total_cache_creation_input_tokens,
         @estimated_cost_usd, @agent_cost_usd, @platform_cost_usd,
         @pricing_fallback_calls, @weighted_score,
         @verification_tier, @replayable, @image_digest, @suite_version_locked,
         @attestation_id, @created_at, @updated_at
       )
       ON CONFLICT(run_id) DO UPDATE SET
         schema_version = excluded.schema_version,
         manifest_revision = excluded.manifest_revision,
         run_source = excluded.run_source,
         status = excluded.status,
         exit_code = excluded.exit_code,
         started_at = excluded.started_at,
         completed_at = excluded.completed_at,
         duration_ms = excluded.duration_ms,
         experiment_id = excluded.experiment_id,
         experiment_path = excluded.experiment_path,
         experiment_variant = excluded.experiment_variant,
         suite_id = excluded.suite_id,
         suite_version = excluded.suite_version,
         experiment_config_hash = excluded.experiment_config_hash,
         agent_id = excluded.agent_id,
         agent_path = excluded.agent_path,
         agent_variant = excluded.agent_variant,
         agent_model = excluded.agent_model,
         agent_model_count = excluded.agent_model_count,
         agent_config_hash = excluded.agent_config_hash,
         args_json = excluded.args_json,
         orchestration_json = excluded.orchestration_json,
         total_ai_calls = excluded.total_ai_calls,
         total_input_tokens = excluded.total_input_tokens,
         total_output_tokens = excluded.total_output_tokens,
         total_cache_read_input_tokens = excluded.total_cache_read_input_tokens,
         total_cache_creation_input_tokens = excluded.total_cache_creation_input_tokens,
         estimated_cost_usd = excluded.estimated_cost_usd,
         agent_cost_usd = excluded.agent_cost_usd,
         platform_cost_usd = excluded.platform_cost_usd,
         pricing_fallback_calls = excluded.pricing_fallback_calls,
         weighted_score = excluded.weighted_score,
         verification_tier = excluded.verification_tier,
         replayable = excluded.replayable,
         image_digest = excluded.image_digest,
         suite_version_locked = excluded.suite_version_locked,
         attestation_id = excluded.attestation_id,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`
    ).run({
      run_id: m.run_id,
      schema_version: m.schema_version,
      manifest_revision: m.manifest_revision,
      run_source: m.run_source,
      status: m.status,
      exit_code: m.exit_code ?? null,
      started_at: m.started_at,
      completed_at: m.completed_at ?? null,
      duration_ms: m.duration_ms,
      experiment_id: m.experiment.id,
      experiment_path: m.experiment.path ?? null,
      experiment_variant: m.experiment.variant ?? null,
      suite_id: m.experiment.suite_id ?? null,
      suite_version: m.experiment.suite_version ?? null,
      experiment_config_hash: m.experiment.config_hash ?? null,
      agent_id: m.agent.id,
      agent_path: m.agent.path ?? null,
      agent_variant: m.agent.variant ?? null,
      // Headline projection of the agent.models breakdown.
      agent_model: m.agent.models?.[0]?.model ?? null,
      agent_model_count: m.agent.models?.length ?? null,
      agent_config_hash: m.agent.config_hash ?? null,
      args_json: JSON.stringify(m.agent.args ?? []),
      orchestration_json: m.orchestration ? JSON.stringify(m.orchestration) : null,
      total_ai_calls: m.usage.total_ai_calls,
      total_input_tokens: m.usage.total_input_tokens,
      total_output_tokens: m.usage.total_output_tokens,
      total_cache_read_input_tokens: m.usage.total_cache_read_input_tokens ?? null,
      total_cache_creation_input_tokens: m.usage.total_cache_creation_input_tokens ?? null,
      estimated_cost_usd: m.usage.estimated_cost_usd,
      agent_cost_usd: m.usage.agent_cost_usd ?? null,
      platform_cost_usd: m.usage.platform_cost_usd ?? null,
      pricing_fallback_calls: m.usage.pricing_fallback_calls ?? null,
      weighted_score: m.evaluation?.weighted_score ?? null,
      verification_tier: m.provenance.verification_tier,
      replayable: m.provenance.replayable ? 1 : 0,
      image_digest: m.provenance.image_digest ?? null,
      suite_version_locked: m.provenance.suite_version_locked === undefined ? null : (m.provenance.suite_version_locked ? 1 : 0),
      attestation_id: m.provenance.attestation_id ?? null,
      created_at: m.created_at,
      updated_at: m.updated_at,
    });

    // Replace child rows. SQLite's ON DELETE CASCADE handles the cleanup if
    // we delete the parent, but we keep the parent row intact and clear+
    // refill the child tables.
    db.prepare('DELETE FROM run_criteria WHERE run_id = ?').run(m.run_id);
    db.prepare('DELETE FROM run_human_scores WHERE run_id = ?').run(m.run_id);
    db.prepare('DELETE FROM run_cost_breakdown WHERE run_id = ?').run(m.run_id);
    db.prepare('DELETE FROM run_agent_models WHERE run_id = ?').run(m.run_id);
    db.prepare('DELETE FROM run_artifacts WHERE run_id = ?').run(m.run_id);

    if (m.evaluation) {
      const insertCriterion = db.prepare(
        `INSERT INTO run_criteria (
           run_id, criterion, weight, score, summary, status,
           scorer_type, allowed_scores_json, screenshots_json, log_path
         ) VALUES (
           @run_id, @criterion, @weight, @score, @summary, @status,
           @scorer_type, @allowed_scores_json, @screenshots_json, @log_path
         )`
      );
      for (const c of m.evaluation.criteria) {
        insertCriterion.run({
          run_id: m.run_id,
          criterion: c.id,
          weight: c.weight,
          score: c.score,
          summary: c.summary,
          status: c.status ?? null,
          scorer_type: c.scorer_type ?? null,
          allowed_scores_json: c.allowed_scores ? JSON.stringify(c.allowed_scores) : null,
          screenshots_json: c.screenshots ? JSON.stringify(c.screenshots) : null,
          log_path: c.log_path ?? null,
        });
      }
    }

    if (m.human_scoring) {
      const insertHuman = db.prepare(
        `INSERT INTO run_human_scores (
           run_id, criterion, human_score, llm_score, notes,
           allowed_scores_json, scored_by, scored_at
         ) VALUES (
           @run_id, @criterion, @human_score, @llm_score, @notes,
           @allowed_scores_json, @scored_by, @scored_at
         )`
      );
      for (const c of m.human_scoring.criteria) {
        insertHuman.run({
          run_id: m.run_id,
          criterion: c.id,
          human_score: c.human_score,
          llm_score: c.llm_score,
          notes: c.notes ?? null,
          allowed_scores_json: c.allowed_scores ? JSON.stringify(c.allowed_scores) : null,
          scored_by: m.human_scoring!.scored_by,
          scored_at: m.human_scoring!.scored_at,
        });
      }
    }

    if (m.usage.by_source) {
      const insertCost = db.prepare(
        `INSERT INTO run_cost_breakdown (
           run_id, source_key, calls, input_tokens, output_tokens,
           cache_read_input_tokens, cache_creation_input_tokens, cost_usd
         ) VALUES (
           @run_id, @source_key, @calls, @input_tokens, @output_tokens,
           @cache_read_input_tokens, @cache_creation_input_tokens, @cost_usd
         )`
      );
      for (const [source, src] of Object.entries(m.usage.by_source)) {
        insertCost.run({
          run_id: m.run_id,
          source_key: source,
          calls: src.calls,
          input_tokens: src.input_tokens,
          output_tokens: src.output_tokens,
          cache_read_input_tokens: src.cache_read_input_tokens ?? null,
          cache_creation_input_tokens: src.cache_creation_input_tokens ?? null,
          cost_usd: src.cost_usd,
        });
      }
    }

    if (m.agent.models && m.agent.models.length > 0) {
      const insertModel = db.prepare(
        `INSERT INTO run_agent_models (
           run_id, model, rank, calls, input_tokens, output_tokens, cost_usd
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      // models[] is already sorted highest-cost first; persist that order as rank.
      m.agent.models.forEach((am, rank) => {
        insertModel.run(
          m.run_id,
          am.model,
          rank,
          am.calls,
          am.input_tokens,
          am.output_tokens,
          am.cost_usd,
        );
      });
    }

    if (m.artifacts.length > 0) {
      const insertArtifact = db.prepare(
        `INSERT INTO run_artifacts (
           run_id, key, kind, rel_path, object_url, content_type,
           bytes, sha256, redaction_state, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const a of m.artifacts) {
        insertArtifact.run(
          m.run_id,
          a.key,
          a.kind,
          a.rel_path ?? null,
          a.object_url ?? null,
          a.content_type ?? null,
          a.bytes ?? null,
          a.sha256 ?? null,
          a.redaction_state ?? null,
          a.created_at,
        );
      }
    }
  });
  tx(manifest);
}

export function deleteRun(db: DatabaseType, runId: string): void {
  // CASCADE handles child tables.
  db.prepare('DELETE FROM runs WHERE run_id = ?').run(runId);
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

interface RunRow {
  run_id: string;
  experiment_id: string;
  experiment_variant: string | null;
  agent_id: string;
  agent_variant: string | null;
  agent_model: string | null;
  agent_model_count: number | null;
  status: string;
  exit_code: number | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number;
  weighted_score: number | null;
  estimated_cost_usd: number;
  agent_cost_usd: number | null;
  platform_cost_usd: number | null;
  pricing_fallback_calls: number | null;
  total_ai_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_input_tokens: number | null;
  total_cache_creation_input_tokens: number | null;
}

const SUMMARY_COLUMNS =
  `run_id, experiment_id, experiment_variant, agent_id, agent_variant,
   agent_model, agent_model_count, status, exit_code, started_at, completed_at,
   duration_ms, weighted_score, estimated_cost_usd, agent_cost_usd,
   platform_cost_usd, pricing_fallback_calls, total_ai_calls, total_input_tokens,
   total_output_tokens, total_cache_read_input_tokens, total_cache_creation_input_tokens`;

function rowToSummary(row: RunRow): RunSummary {
  const out: RunSummary = {
    runId: row.run_id,
    experimentId: row.experiment_id,
    agentId: row.agent_id,
    status: row.status as RunStatus,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    weightedScore: row.weighted_score,
    estimatedCostUsd: row.estimated_cost_usd,
    totalAiCalls: row.total_ai_calls,
    totalInputTokens: row.total_input_tokens,
    totalOutputTokens: row.total_output_tokens,
  };
  if (row.experiment_variant) out.experimentVariant = row.experiment_variant;
  if (row.agent_variant) out.agentVariant = row.agent_variant;
  if (row.agent_model) out.agentModel = row.agent_model;
  if (row.agent_model_count !== null) out.agentModelCount = row.agent_model_count;
  if (row.exit_code !== null) out.exitCode = row.exit_code;
  if (row.completed_at) out.completedAt = row.completed_at;
  if (row.agent_cost_usd !== null) out.agentCostUsd = row.agent_cost_usd;
  if (row.platform_cost_usd !== null) out.platformCostUsd = row.platform_cost_usd;
  // Truthy (not `!== null`) on purpose: NULL and 0 both mean "fully priced" —
  // the column is only ever written when the count is > 0.
  if (row.pricing_fallback_calls) out.pricingFallbackCalls = row.pricing_fallback_calls;
  if (row.total_cache_read_input_tokens !== null) out.totalCacheReadInputTokens = row.total_cache_read_input_tokens;
  if (row.total_cache_creation_input_tokens !== null) out.totalCacheCreationInputTokens = row.total_cache_creation_input_tokens;
  return out;
}

export function getRunSummary(db: DatabaseType, runId: string): RunSummary | null {
  const row = db.prepare<[string], RunRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM runs WHERE run_id = ?`
  ).get(runId);
  return row ? rowToSummary(row) : null;
}

export function listRunSummaries(db: DatabaseType, filter: RunFilter = {}): RunSummary[] {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filter.experimentId) { where.push('experiment_id = ?'); params.push(filter.experimentId); }
  if (filter.agentId) { where.push('agent_id = ?'); params.push(filter.agentId); }
  if (filter.status) {
    if (Array.isArray(filter.status)) {
      where.push(`status IN (${filter.status.map(() => '?').join(', ')})`);
      params.push(...filter.status);
    } else {
      where.push('status = ?'); params.push(filter.status);
    }
  }
  if (filter.minScore !== undefined) { where.push('weighted_score >= ?'); params.push(filter.minScore); }
  if (filter.maxScore !== undefined) { where.push('weighted_score <= ?'); params.push(filter.maxScore); }
  if (filter.startedAfter) { where.push('started_at >= ?'); params.push(filter.startedAfter); }
  if (filter.startedBefore) { where.push('started_at <= ?'); params.push(filter.startedBefore); }

  const orderBy = filter.orderBy ?? 'started_at';
  const orderDir = filter.orderDir ?? 'DESC';
  const limit = filter.limit ?? -1;
  const offset = filter.offset ?? 0;

  const sql =
    `SELECT ${SUMMARY_COLUMNS}
       FROM runs
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ${orderBy} ${orderDir}
       LIMIT ? OFFSET ?`;

  const rows = db.prepare<unknown[], RunRow>(sql).all(...params, limit, offset);
  return rows.map(rowToSummary);
}

export interface CriterionRow {
  runId: string;
  criterion: string;
  weight: number;
  score: number | null;
  summary: string;
  status: string | null;
  scorerType: string | null;
  allowedScores: AllowedScores | null;
  logPath: string | null;
}

export function listRunCriteria(db: DatabaseType, runId: string): CriterionRow[] {
  const rows = db.prepare<[string], {
    run_id: string; criterion: string; weight: number; score: number | null;
    summary: string; status: string | null; scorer_type: string | null;
    allowed_scores_json: string | null; log_path: string | null;
  }>(
    `SELECT run_id, criterion, weight, score, summary, status, scorer_type,
            allowed_scores_json, log_path
       FROM run_criteria WHERE run_id = ?
       ORDER BY criterion`
  ).all(runId);
  return rows.map((r) => ({
    runId: r.run_id,
    criterion: r.criterion,
    weight: r.weight,
    score: r.score,
    summary: r.summary,
    status: r.status,
    scorerType: r.scorer_type,
    allowedScores: r.allowed_scores_json ? JSON.parse(r.allowed_scores_json) as AllowedScores : null,
    logPath: r.log_path,
  }));
}

export function countRuns(db: DatabaseType): number {
  const row = db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM runs').get();
  return row?.c ?? 0;
}

/**
 * The per-model usage breakdown for one run, highest-cost first (ascending
 * `rank`). Mirrors the manifest's `agent.models`; sourced from the index so
 * cross-run callers don't have to open each manifest.
 */
export function listRunAgentModels(db: DatabaseType, runId: string): AgentModelUsage[] {
  const rows = db.prepare<[string], {
    model: string; calls: number; input_tokens: number;
    output_tokens: number; cost_usd: number;
  }>(
    `SELECT model, calls, input_tokens, output_tokens, cost_usd
       FROM run_agent_models WHERE run_id = ?
       ORDER BY rank`
  ).all(runId);
  return rows.map((r) => ({
    model: r.model,
    calls: r.calls,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cost_usd: r.cost_usd,
  }));
}

/**
 * Run ids that drove a given model at any rank — the cross-run query the
 * single `agent_model` headline column can't answer (it would miss runs where
 * the model was secondary). Backed by `idx_agent_models_model`.
 */
export function findRunIdsByModel(db: DatabaseType, model: string): string[] {
  const rows = db.prepare<[string], { run_id: string }>(
    `SELECT DISTINCT run_id FROM run_agent_models WHERE model = ?`
  ).all(model);
  return rows.map((r) => r.run_id);
}

// ---------------------------------------------------------------------------
// Rebuild from manifests on disk
// ---------------------------------------------------------------------------

export interface RebuildOptions {
  /** Drop existing index rows before populating. Default: true. */
  dropExisting?: boolean;
}

export interface RebuildReport {
  indexedRuns: number;
  skippedRuns: string[];
}

/**
 * Rebuild the SQLite index from `manifest.json` files on disk.
 *
 * Scans every run directory under `.bunsen/runs/*` and upserts each
 * manifest. Run dirs without a `manifest.json` are skipped and reported —
 * every run dir is born with a manifest, so a missing manifest indicates a
 * partial or hand-edited run dir.
 */
export function rebuildIndex(
  baseDir: string = process.cwd(),
  options: RebuildOptions = {}
): RebuildReport {
  const dropExisting = options.dropExisting ?? true;

  const runsDir = getRunsDir(baseDir);
  if (!fs.existsSync(runsDir)) {
    return { indexedRuns: 0, skippedRuns: [] };
  }

  const dbPath = getRunIndexPath(baseDir);
  // A full rebuild deletes the FILE, not just the rows: CREATE TABLE IF NOT
  // EXISTS can't add columns to a stale table, so a schema change only takes
  // effect on a fresh file. This is what lets `bn index rebuild` — and the
  // open-time auto-recovery that routes here — pick up a schema bump.
  if (dropExisting) {
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  }

  // openIndexRaw, not openRunIndex: rebuild IS the staleness recovery, so it
  // must not recurse back into ensureRunIndexFresh.
  const db = openIndexRaw(dbPath, false);
  try {
    let indexed = 0;
    const skipped: string[] = [];

    for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const runId = entry.name;

      const manifest = loadRunManifest(runId, baseDir);
      if (!manifest) {
        skipped.push(runId);
        continue;
      }

      try {
        upsertManifest(db, manifest);
        indexed += 1;
      } catch {
        skipped.push(runId);
      }
    }

    return { indexedRuns: indexed, skippedRuns: skipped };
  } finally {
    db.close();
  }
}

/**
 * Best-effort SQLite upsert from a manifest. Used by the executor and
 * `bn eval human` immediately after a manifest write, so the index
 * stays warm without a manual rebuild.
 *
 * Swallows all errors — index failures must never fail the underlying run.
 */
export function upsertManifestSafely(manifest: RunManifestV1, baseDir: string): void {
  try {
    const db = openRunIndex(baseDir);
    try {
      upsertManifest(db, manifest);
    } finally {
      db.close();
    }
  } catch {
    // best-effort; bn rebuild-index recovers
  }
}
