// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Duration-string parsing for the redesigned Bunsen schemas.
 *
 * All user-facing durations are strings with a unit suffix: `ms`, `s`, `m`, `h`.
 * Examples: "500ms", "300s", "5m", "1h", "1.5s".
 *
 * Bare integers are rejected — they were ambiguous under the old schema
 * (some fields meant seconds, some meant milliseconds). Callers that need
 * a numeric passthrough should explicitly append a unit.
 */

/** A duration string with a unit suffix, e.g. "5m", "300s", "1h", "500ms". */
export type DurationString = string;

/** Units accepted by {@link parseDuration}. */
export type DurationUnit = 'ms' | 's' | 'm' | 'h';

const UNIT_TO_MS: Record<DurationUnit, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

// Longest suffixes first so `ms` wins over `s` during matching.
const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;

/**
 * Error thrown when a duration string cannot be parsed. Distinguishing this
 * from a generic `Error` lets validation layers collect and report it as a
 * structured error rather than a free-form message.
 */
export class InvalidDurationError extends Error {
  readonly input: unknown;
  constructor(input: unknown, message: string) {
    super(message);
    this.name = 'InvalidDurationError';
    this.input = input;
  }
}

/**
 * Parse a duration string and return the value in milliseconds.
 *
 * Throws {@link InvalidDurationError} if the input is not a string matching
 * `<number><unit>` with `unit` in `ms | s | m | h`. Bare integers / numeric
 * inputs are rejected so fields do not silently fall back to legacy
 * seconds-vs-milliseconds behavior.
 */
export function parseDuration(value: string): number {
  if (typeof value !== 'string') {
    throw new InvalidDurationError(
      value,
      `Expected a duration string (e.g. "5m"), got ${typeof value}.`,
    );
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidDurationError(value, 'Duration string is empty.');
  }

  const match = DURATION_PATTERN.exec(trimmed);
  if (!match) {
    throw new InvalidDurationError(
      value,
      `Invalid duration ${JSON.stringify(value)}. Expected <number><unit> with unit in ms, s, m, h (e.g. "500ms", "5m", "1.5s").`,
    );
  }

  const [, numberPart, unit] = match;
  const magnitude = Number(numberPart);
  if (!Number.isFinite(magnitude) || magnitude < 0) {
    throw new InvalidDurationError(
      value,
      `Duration ${JSON.stringify(value)} is not a finite, non-negative number.`,
    );
  }

  const multiplier = UNIT_TO_MS[unit as DurationUnit];
  const ms = magnitude * multiplier;
  // Round to the nearest millisecond — 1.5s should be exactly 1500, not 1499.9999...
  return Math.round(ms);
}

/**
 * Parse a duration if present; return `undefined` for `undefined`/`null` so
 * optional fields don't need a separate null check at every call site.
 */
export function parseOptionalDuration(value: string | undefined | null): number | undefined {
  if (value === undefined || value === null) return undefined;
  return parseDuration(value);
}

/**
 * Format a millisecond duration as the most natural single-unit duration
 * string — the inverse of {@link parseDuration} for clean values. Picks the
 * largest unit (h, m, s, ms) that divides the duration exactly, so 1_800_000
 * formats as "30m", 600_000 as "10m", 3_600_000 as "1h", 90_000 as "90s", and
 * 500 as "500ms". The result always carries a unit suffix, so it round-trips
 * back through {@link parseDuration}.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new InvalidDurationError(ms, `Cannot format a non-finite or negative duration: ${ms}.`);
  }
  const rounded = Math.round(ms);
  if (rounded === 0) return '0s';
  if (rounded % UNIT_TO_MS.h === 0) return `${rounded / UNIT_TO_MS.h}h`;
  if (rounded % UNIT_TO_MS.m === 0) return `${rounded / UNIT_TO_MS.m}m`;
  if (rounded % UNIT_TO_MS.s === 0) return `${rounded / UNIT_TO_MS.s}s`;
  return `${rounded}ms`;
}
