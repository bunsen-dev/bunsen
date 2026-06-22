// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for `cancelRun()` — covers the manifest-side behavior that doesn't
 * require a real Docker daemon (status transitions, no-op short-circuits,
 * event emission, error result shape). Container-stop integration is
 * verified manually via `bn runs cancel <run-id>` against a live run.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { cancelRun } from './run-cancel.js';
import { createRun, updateRunStatus, loadRunManifest } from './storage.js';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-cancel-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeRun(): string {
  const m = createRun({
    experimentId: 'exp',
    experimentPath: tempDir,
    agentId: 'agent',
    agentPath: tempDir,
    args: [],
    baseDir: tempDir,
  });
  return m.run_id;
}

describe('cancelRun', () => {
  it('throws when the run does not exist', async () => {
    await expect(cancelRun('nonexistent', tempDir)).rejects.toThrow(/Run not found/);
  });

  it('flips a running manifest to canceled and emits run.canceled event', async () => {
    const runId = makeRun();
    updateRunStatus(runId, 'running', undefined, tempDir);

    const result = await cancelRun(runId, tempDir);

    expect(result.previousStatus).toBe('running');
    expect(result.manifestUpdated).toBe(true);
    const m = loadRunManifest(runId, tempDir);
    expect(m?.status).toBe('canceled');
    expect(m?.exit_code).toBe(130);

    const eventsPath = path.join(tempDir, '.bunsen', 'runs', runId, 'events.jsonl');
    const events = fs
      .readFileSync(eventsPath, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const canceled = events.find((e) => e.event === 'run.canceled');
    expect(canceled).toBeDefined();
    expect(canceled.data.reason).toBe('external');
  });

  it('flips a pending manifest to canceled', async () => {
    const runId = makeRun();
    // createRun starts in `pending`; no status update needed.

    const result = await cancelRun(runId, tempDir);

    expect(result.previousStatus).toBe('pending');
    expect(result.manifestUpdated).toBe(true);
    expect(loadRunManifest(runId, tempDir)?.status).toBe('canceled');
  });

  it('is a no-op when the run is already terminal', async () => {
    const runId = makeRun();
    updateRunStatus(runId, 'succeeded', 0, tempDir);

    const result = await cancelRun(runId, tempDir);

    expect(result.previousStatus).toBe('succeeded');
    expect(result.manifestUpdated).toBe(false);
    expect(result.containersStopped).toBe(0);
    expect(loadRunManifest(runId, tempDir)?.status).toBe('succeeded');
  });

  it('is a no-op when the run is already canceled (idempotent)', async () => {
    const runId = makeRun();
    updateRunStatus(runId, 'canceled', 130, tempDir);

    const result = await cancelRun(runId, tempDir);

    expect(result.previousStatus).toBe('canceled');
    expect(result.manifestUpdated).toBe(false);
  });
});
