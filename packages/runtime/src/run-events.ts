// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Append-only `events.jsonl` writer.
 *
 * `events.jsonl` is the canonical, ordered, append-only execution record for
 * a run — the timeline complement to `manifest.json` (the end-state summary).
 * The event vocabulary and payload shapes are public contract; see
 * `@bunsen-dev/types/src/events.ts` and `docs/RUN_MANIFEST.md`.
 *
 * Durability semantics:
 *   - Each emit opens the file with O_APPEND, writes one JSON object plus a
 *     trailing newline, fsyncs the descriptor, and closes. Lines arrive whole
 *     to disk on normal termination, even across `process.exit` from a signal
 *     handler.
 *   - kill -9 is allowed to lose the trailing partial line; no preceding
 *     event can be lost once `appendRunEvent` returns.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunEvent } from '@bunsen-dev/types';
import { getRunDir } from './storage.js';

export const RUN_EVENTS_FILENAME = 'events.jsonl';

/**
 * `Omit<RunEvent, 'ts'>` does NOT distribute over the discriminated union —
 * it collapses to `{ event: AllLiterals; data: AllShapes }`, which lets a
 * caller pair `event: 'run.started'` with `agent.completed`'s data and pass
 * the type checker. Distributing the omit per-variant preserves the
 * discriminator → data-shape link.
 */
export type RunEventInput<T = RunEvent> = T extends RunEvent
  ? Omit<T, 'ts'>
  : never;

export function getRunEventsPath(runId: string, baseDir: string = process.cwd()): string {
  return path.join(getRunDir(runId, baseDir), RUN_EVENTS_FILENAME);
}

/**
 * Append a single `RunEvent` to the run's `events.jsonl`. Callers omit `ts`;
 * we stamp it here from `new Date().toISOString()`.
 */
export function appendRunEvent(
  runId: string,
  event: RunEventInput,
  baseDir: string = process.cwd()
): void {
  const stamped = { ...event, ts: new Date().toISOString() } as RunEvent;
  const eventsPath = getRunEventsPath(runId, baseDir);
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });

  const line = JSON.stringify(stamped) + '\n';
  const fd = fs.openSync(eventsPath, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Load every event emitted for a run, in order. Returns `[]` if no events
 * file exists. Skips malformed lines (e.g., a partial trailing line from a
 * `kill -9`) so a corrupt tail never poisons the rest of the timeline.
 */
export function loadRunEvents(
  runId: string,
  baseDir: string = process.cwd()
): RunEvent[] {
  const eventsPath = getRunEventsPath(runId, baseDir);
  if (!fs.existsSync(eventsPath)) return [];

  const events: RunEvent[] = [];
  for (const line of fs.readFileSync(eventsPath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as RunEvent);
    } catch {
      // Skip malformed lines.
    }
  }
  return events;
}
