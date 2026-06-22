// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for the run-events JSONL writer (task 13c).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendRunEvent,
  loadRunEvents,
  getRunEventsPath,
  RUN_EVENTS_FILENAME,
} from './run-events.js';
import { createRun, getRunDir } from './storage.js';

describe('run-events', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-events-test-'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  function newRunId(): string {
    return createRun({ experimentId: 'exp', experimentPath: '/exp', agentId: 'agent', agentPath: '/agent', args: [], baseDir: baseDir }).run_id;
  }

  it('writes events.jsonl into the v1 run-dir layout', () => {
    const runId = newRunId();
    const expectedPath = path.join(getRunDir(runId, baseDir), RUN_EVENTS_FILENAME);
    expect(getRunEventsPath(runId, baseDir)).toBe(expectedPath);

    appendRunEvent(runId, { event: 'run.started', data: { id: runId } }, baseDir);
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it('round-trips a sequence of events in append order', () => {
    const runId = newRunId();
    appendRunEvent(runId, { event: 'run.started', data: { id: runId } }, baseDir);
    appendRunEvent(runId, { event: 'install.build.started', data: { agent: 'echo' } }, baseDir);
    appendRunEvent(
      runId,
      { event: 'install.build.completed', data: { cacheHit: true, durationMs: 5 } },
      baseDir
    );
    appendRunEvent(
      runId,
      { event: 'run.completed', data: { id: runId, durationMs: 42 } },
      baseDir
    );

    const events = loadRunEvents(runId, baseDir);
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.event)).toEqual([
      'run.started',
      'install.build.started',
      'install.build.completed',
      'run.completed',
    ]);
    for (const e of events) {
      expect(typeof e.ts).toBe('string');
      expect(() => new Date(e.ts).toISOString()).not.toThrow();
    }
  });

  it('auto-stamps `ts` from the system clock', () => {
    const runId = newRunId();
    const before = Date.now();
    appendRunEvent(runId, { event: 'run.started', data: { id: runId } }, baseDir);
    const after = Date.now();

    const [event] = loadRunEvents(runId, baseDir);
    expect(event).toBeDefined();
    const stampedAt = new Date(event!.ts).getTime();
    expect(stampedAt).toBeGreaterThanOrEqual(before);
    expect(stampedAt).toBeLessThanOrEqual(after);
  });

  it('writes one JSON object per line, with a trailing newline', () => {
    const runId = newRunId();
    appendRunEvent(runId, { event: 'run.started', data: { id: runId } }, baseDir);
    appendRunEvent(
      runId,
      { event: 'agent.completed', data: { exitCode: 0, durationMs: 1000 } },
      baseDir
    );

    const raw = fs.readFileSync(getRunEventsPath(runId, baseDir), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);

    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('returns [] when the events file does not exist', () => {
    const runId = newRunId();
    expect(loadRunEvents(runId, baseDir)).toEqual([]);
  });

  it('skips malformed lines (e.g. partial trailing line from kill -9)', () => {
    const runId = newRunId();
    appendRunEvent(runId, { event: 'run.started', data: { id: runId } }, baseDir);

    // Append a partial line and a junk line directly, simulating a torn write.
    fs.appendFileSync(
      getRunEventsPath(runId, baseDir),
      '{"event":"agent.started","data":{"id":"e' /* truncated */ + '\nnot-json\n'
    );

    const events = loadRunEvents(runId, baseDir);
    // Only the valid run.started line survives.
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('run.started');
  });

  it('appends survive across processes (each call closes the fd)', () => {
    const runId = newRunId();
    appendRunEvent(runId, { event: 'run.started', data: { id: runId } }, baseDir);
    appendRunEvent(runId, { event: 'agent.started', data: { id: 'a' } }, baseDir);
    appendRunEvent(
      runId,
      { event: 'agent.completed', data: { exitCode: 0, durationMs: 1 } },
      baseDir
    );
    appendRunEvent(runId, { event: 'run.completed', data: { id: runId, durationMs: 10 } }, baseDir);

    expect(loadRunEvents(runId, baseDir).map((e) => e.event)).toEqual([
      'run.started',
      'agent.started',
      'agent.completed',
      'run.completed',
    ]);
  });
});
