// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * RunManifestV1 helpers — artifact classification + artifacts[] refresh.
 *
 * The manifest is now the single on-disk source of truth (see `storage.ts`).
 * Every per-run state writer (createRun, updateRunStatus, saveTraces,
 * saveEvaluationResult, saveHumanScores) mutates the manifest in place.
 *
 * The legacy "synthesize a manifest from `run.json` + `scores.json` + the
 * other flat-layout projections" path is gone — every run dir is born with
 * a v1 manifest, so synthesis has no remaining caller. What lives here:
 *
 *   - `classifyArtifact(relPath)` — maps a run-dir-relative path to an
 *     `ArtifactKind`, recognizing the v1 nested layout.
 *   - `refreshRunManifest(runId, baseDir)` — re-walks the run dir and
 *     refreshes the manifest's `artifacts[]` list (the only field that
 *     can drift between in-process state and on-disk state).
 *   - `discoverArtifacts(runId, baseDir, fallbackTimestamp)` — the
 *     directory walk used by `refreshRunManifest`; exported for tests.
 *
 * See `docs/RUN_MANIFEST.md` for the public spec and on-disk layout, and
 * `RunManifestV1` in `@bunsen-dev/types/src/manifest.ts`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ArtifactKind,
  RunManifestArtifact,
  RunManifestV1,
} from '@bunsen-dev/types';
import {
  getRunDir,
  loadRunManifest,
  saveRunManifest,
  RUN_MANIFEST_FILENAME,
} from './storage.js';

export {
  RUN_MANIFEST_FILENAME,
  RUN_MANIFEST_SCHEMA_VERSION,
  loadRunManifest,
  saveRunManifest,
  getRunManifestPath,
} from './storage.js';

// ---------------------------------------------------------------------------
// Artifact classification
// ---------------------------------------------------------------------------

/**
 * Map a relative path inside the run directory to an `ArtifactKind`.
 *
 * Returns `undefined` for paths the manifest does not enumerate (the
 * manifest itself, internal scratch files). Unknown files default to
 * `output`.
 *
 * Recognizes the v1 nested layout (see `RunManifestV1` in
 * `@bunsen-dev/types/src/manifest.ts`).
 */
export function classifyArtifact(relPath: string): ArtifactKind | undefined {
  const norm = relPath.split(path.sep).join('/');
  if (norm === RUN_MANIFEST_FILENAME) return undefined;
  if (norm === 'events.jsonl') return undefined;
  if (norm === 'logs.txt') return 'logs';
  if (norm === 'task/prompt.md') return 'task_prompt';
  if (norm === 'orchestration/result.json') return 'orchestration_result';
  if (norm === 'workspace/diff.patch') return 'workspace_diff';
  if (norm === 'workspace/export.tar.gz' || norm === 'workspace/export.tar.zst') return 'workspace_tar';
  if (norm === 'evaluation/result.json') return 'scores';
  if (norm === 'evaluation/report.md') return 'report';
  if (norm === 'evaluation/human.json') return 'human_scores';
  if (/^evaluation\/criteria\/[^/]+\.json$/.test(norm)) return 'criterion_result';
  if (/^evaluation\/criteria\/[^/]+\.log$/.test(norm)) return 'scorer_log';
  if (norm.startsWith('evaluation/criteria/')) return 'output';
  if (norm === 'artifacts/recording.cast') return 'recording_cast';
  if (norm.startsWith('artifacts/screenshots/')) return 'screenshot';
  if (norm.startsWith('artifacts/output/')) return 'output';
  if (norm === 'supervisor.log') return 'supervisor';
  if (norm === 'traces/agent.jsonl') return 'trace_raw';
  if (norm === 'traces/platform.jsonl') return 'trace_platform';
  if (norm.startsWith('traces/threads/')) return 'trace_structured';
  if (norm === 'traces/summary.json') return 'trace_summary';
  // Internal / scratch files we deliberately skip.
  if (
    norm === 'agent-script.sh' ||
    norm === 'agent-complete.marker' ||
    norm === 'launcher.sh' ||
    norm === 'supervisor.json'
  ) {
    return undefined;
  }
  return 'output';
}

// ---------------------------------------------------------------------------
// Artifact discovery (directory walk)
// ---------------------------------------------------------------------------

function listFilesRecursive(dir: string, prefix = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(abs, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

export function discoverArtifacts(
  runId: string,
  baseDir: string,
  fallbackTimestamp: string,
): RunManifestArtifact[] {
  const runDir = getRunDir(runId, baseDir);
  if (!fs.existsSync(runDir)) return [];
  const files = listFilesRecursive(runDir);
  const artifacts: RunManifestArtifact[] = [];
  for (const rel of files) {
    const kind = classifyArtifact(rel);
    if (!kind) continue;
    const abs = path.join(runDir, rel);
    let bytes: number | undefined;
    let createdAt: string | undefined;
    try {
      const stat = fs.statSync(abs);
      bytes = stat.size;
      createdAt = stat.birthtime.toISOString();
    } catch {
      // ignore stat failures
    }
    const entry: RunManifestArtifact = {
      key: `runs/${runId}/${rel}`,
      kind,
      rel_path: rel,
      created_at: createdAt ?? fallbackTimestamp,
    };
    if (bytes !== undefined) entry.bytes = bytes;
    artifacts.push(entry);
  }
  artifacts.sort((a, b) => (a.kind === b.kind ? a.key.localeCompare(b.key) : a.kind.localeCompare(b.kind)));
  return artifacts;
}

// ---------------------------------------------------------------------------
// Refresh artifacts[]
// ---------------------------------------------------------------------------

/**
 * Refresh the manifest's `artifacts[]` list from the on-disk run dir.
 *
 * Loads the existing manifest (the source of truth for everything else),
 * re-walks the run directory, and writes the refreshed manifest back —
 * bumping `manifest_revision` + `updated_at` only when the artifacts list
 * actually changed. Returns the persisted (or unchanged) manifest, or
 * `null` when no manifest exists for this run.
 *
 * Use this at end-of-run (and after any out-of-band file additions like
 * `bn eval human`) to make sure `artifacts[]` reflects every file on
 * disk. The skip-on-no-change keeps the revision counter honest: it ticks
 * for real external observers (publishes, manual writes), not for the
 * end-of-run housekeeping that often discovers nothing new.
 */
export function refreshRunManifest(
  runId: string,
  baseDir: string = process.cwd()
): RunManifestV1 | null {
  const manifest = loadRunManifest(runId, baseDir);
  if (!manifest) return null;
  const next = discoverArtifacts(runId, baseDir, manifest.created_at);
  if (artifactsEqual(manifest.artifacts, next)) {
    return manifest;
  }
  manifest.artifacts = next;
  manifest.manifest_revision += 1;
  manifest.updated_at = new Date().toISOString();
  saveRunManifest(runId, manifest, baseDir);
  return manifest;
}

/**
 * Shallow structural equality for two `artifacts[]` lists. Both lists are
 * already sorted by (kind, key) by `discoverArtifacts`, so a positional
 * compare on the identity-bearing fields is sufficient.
 */
function artifactsEqual(a: RunManifestArtifact[], b: RunManifestArtifact[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.key !== y.key || x.kind !== y.kind || x.bytes !== y.bytes) return false;
  }
  return true;
}
