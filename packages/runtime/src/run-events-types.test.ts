// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Compile-time regression test for `RunEventInput`.
 *
 * `RunEventInput` is a distributive omit (`T extends RunEvent ? Omit<T, 'ts'>
 * : never`) so each variant of the `RunEvent` discriminated union keeps its
 * `event` literal tied to its specific `data` shape. A plain
 * `Omit<RunEvent, 'ts'>` would collapse the union to
 * `{ event: AllLiterals; data: AllShapes }`, silently accepting mismatched
 * pairings (e.g. `event: 'run.started'` with `agent.completed`'s data).
 *
 * Each `@ts-expect-error` below MUST flag a real type error. If any of these
 * starts compiling, TypeScript reports "unused @ts-expect-error directive"
 * and `tsc --noEmit` (which the build runs) fails — exactly the regression
 * signal we want.
 *
 * One-line declarations are deliberate: `@ts-expect-error` only suppresses
 * the immediately-following line, and TS reports object-literal errors on
 * the nested `data:` property rather than the outer line.
 *
 * Vitest discovers this file via the `*.test.ts` glob; there are no runtime
 * assertions because the checks are at the type level.
 */

import { describe, it } from 'vitest';
import type { RunEventInput } from './run-events.js';

describe('RunEventInput type safety', () => {
  it('rejects mismatched event/data pairings at compile time', () => {
    // Valid — keep at least one to pin the happy path.
    const ok: RunEventInput = { event: 'run.started', data: { id: 'abc' } };
    void ok;

    // Cross-variant mix: `run.started`'s literal with `agent.completed`'s data.
    // @ts-expect-error event/data must come from the same RunEvent variant
    const crossVariant: RunEventInput = { event: 'run.started', data: { exitCode: 0, durationMs: 5 } };
    void crossVariant;

    // Invalid event literal.
    // @ts-expect-error 'not.a.real.event' is not a member of RunEventName
    const badLiteral: RunEventInput = { event: 'not.a.real.event', data: {} };
    void badLiteral;

    // `agent.completed` requires `durationMs` alongside `exitCode`.
    // @ts-expect-error agent.completed.data is missing required durationMs
    const missingField: RunEventInput = { event: 'agent.completed', data: { exitCode: 0 } };
    void missingField;

    // `criterion.completed` requires `id`, `score`, `durationMs`.
    // @ts-expect-error criterion.completed.data shape is wrong
    const wrongShape: RunEventInput = { event: 'criterion.completed', data: { foo: 'bar' } };
    void wrongShape;

    // `install.build.completed` requires `cacheHit` and `durationMs`.
    // @ts-expect-error install.build.completed.data is missing cacheHit
    const partial: RunEventInput = { event: 'install.build.completed', data: { durationMs: 10 } };
    void partial;

    // `workspace.sources.started` data is `Record<string, never>` — extra keys must fail.
    // @ts-expect-error workspace.sources.started.data must be empty
    const extraKey: RunEventInput = { event: 'workspace.sources.started', data: { unexpected: 1 } };
    void extraKey;
  });
});
