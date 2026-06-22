// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Post-run capture of files the agent wrote to `/bunsen/output/`.
 *
 * Capture rules:
 * every file under the mount becomes a `kind: 'output'` artifact with
 * subdirectory structure preserved. Per-file `content_type`, `kind`, and
 * `title` can be overridden via an optional `output/manifest.json`.
 * Over-limit captures are *flagged* in the manifest but still included.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { ArtifactKind, RunManifestArtifact } from '@bunsen-dev/types';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Per-file cap. Over-limit files are flagged but still captured. */
export const OUTPUT_CAPTURE_PER_FILE_LIMIT_BYTES = 50 * 1024 * 1024;

/** Total cap across all captured outputs. Over-limit flags the manifest. */
export const OUTPUT_CAPTURE_TOTAL_LIMIT_BYTES = 500 * 1024 * 1024;

/** Name of the optional manifest file the agent can drop in `/bunsen/output/`. */
const MANIFEST_BASENAME = 'manifest.json';

/** Artifact kinds that `output/manifest.json` may select. */
const ALLOWED_OVERRIDE_KINDS: ReadonlySet<ArtifactKind> = new Set([
  'output',
  'screenshot',
  'report',
]);

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface OutputCaptureOptions {
  /** Host directory bind-mounted to `/bunsen/output/` during the run. */
  hostOutputDir: string;
  /** Destination directory on the host where captured files are written. */
  destDir: string;
}

export interface OutputCaptureArtifactFlag {
  key: string;
  code: 'per_file_limit_exceeded';
  bytes: number;
  limit: number;
}

export interface OutputCaptureResult {
  artifacts: RunManifestArtifact[];
  flags: OutputCaptureArtifactFlag[];
  /** True when total captured bytes exceeded the global cap. */
  totalLimitExceeded: boolean;
  totalBytes: number;
}

/**
 * Entry describing a per-file override in `/bunsen/output/manifest.json`.
 * The agent writes the manifest relative to the output directory; paths are
 * normalized before matching.
 */
export interface OutputManifestFileOverride {
  /** Relative path inside `/bunsen/output/`, normalized (no leading `./`). */
  path: string;
  kind?: ArtifactKind;
  mediaType?: string;
  title?: string;
}

export interface OutputManifest {
  files?: OutputManifestFileOverride[];
}

/**
 * Walk `hostOutputDir`, copy each file into `destDir` preserving subdirs,
 * and return artifact descriptors. Applies per-file and total size caps
 * without dropping files (over-limit cases are flagged instead).
 */
export function captureAgentOutput(
  options: OutputCaptureOptions,
): OutputCaptureResult {
  const { hostOutputDir, destDir } = options;
  const artifacts: RunManifestArtifact[] = [];
  const flags: OutputCaptureArtifactFlag[] = [];

  if (!fs.existsSync(hostOutputDir)) {
    return { artifacts, flags, totalLimitExceeded: false, totalBytes: 0 };
  }

  fs.mkdirSync(destDir, { recursive: true });

  const overrides = readManifest(hostOutputDir);

  const capturedAt = new Date().toISOString();
  let totalBytes = 0;

  for (const rel of walkFiles(hostOutputDir)) {
    // Skip the sidecar manifest itself — it is advisory, not an artifact.
    if (rel === MANIFEST_BASENAME) continue;

    const sourcePath = path.join(hostOutputDir, rel);
    const destPath = path.join(destDir, rel);

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(sourcePath, destPath);

    const stat = fs.statSync(destPath);
    const bytes = stat.size;
    totalBytes += bytes;

    if (bytes > OUTPUT_CAPTURE_PER_FILE_LIMIT_BYTES) {
      flags.push({
        key: rel,
        code: 'per_file_limit_exceeded',
        bytes,
        limit: OUTPUT_CAPTURE_PER_FILE_LIMIT_BYTES,
      });
    }

    const sha256 = sha256File(destPath);
    const override = overrides.get(normalizeRel(rel));

    const kind: ArtifactKind =
      override?.kind && ALLOWED_OVERRIDE_KINDS.has(override.kind)
        ? override.kind
        : 'output';

    const artifact: RunManifestArtifact = {
      key: rel,
      kind,
      rel_path: rel,
      bytes,
      sha256,
      created_at: capturedAt,
    };
    const contentType = override?.mediaType ?? guessMediaType(rel);
    if (contentType !== undefined) artifact.content_type = contentType;
    if (override?.title !== undefined) artifact.title = override.title;

    artifacts.push(artifact);
  }

  return {
    artifacts,
    flags,
    totalLimitExceeded: totalBytes > OUTPUT_CAPTURE_TOTAL_LIMIT_BYTES,
    totalBytes,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack: Array<{ abs: string; rel: string }> = [{ abs: root, rel: '' }];
  while (stack.length > 0) {
    const { abs, rel } = stack.pop()!;
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    for (const entry of entries) {
      const entryAbs = path.join(abs, entry.name);
      const entryRel = rel ? path.posix.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        stack.push({ abs: entryAbs, rel: entryRel });
      } else if (entry.isFile()) {
        out.push(entryRel);
      }
    }
  }
  return out.sort();
}

function sha256File(file: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function readManifest(root: string): Map<string, OutputManifestFileOverride> {
  const overrides = new Map<string, OutputManifestFileOverride>();
  const manifestPath = path.join(root, MANIFEST_BASENAME);
  if (!fs.existsSync(manifestPath)) return overrides;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return overrides;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as OutputManifest).files)
  ) {
    return overrides;
  }
  for (const entry of (parsed as OutputManifest).files ?? []) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof entry.path !== 'string' ||
      entry.path.length === 0
    ) {
      continue;
    }
    overrides.set(normalizeRel(entry.path), entry);
  }
  return overrides;
}

function normalizeRel(rel: string): string {
  let out = rel.replace(/\\/g, '/');
  if (out.startsWith('./')) out = out.slice(2);
  while (out.startsWith('/')) out = out.slice(1);
  return out;
}

const MEDIA_TYPE_BY_EXT: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
};

function guessMediaType(rel: string): string {
  const ext = path.extname(rel).toLowerCase();
  return MEDIA_TYPE_BY_EXT[ext] ?? 'application/octet-stream';
}
