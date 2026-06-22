// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Display helpers for ULID run IDs.
 *
 * ULIDs are 26 chars: a 10-char Crockford-base32 timestamp prefix, then 16
 * random chars. The first 8 chars only encode milliseconds-bucketed time, so
 * adjacent runs collide visually when displayed as `runId.slice(0, 8)`. The
 * last 8 chars are random and discriminating.
 */

const ULID_LENGTH = 26;

/**
 * Short, human-friendly run-id for log lines and tables.
 *
 * For ULIDs we return the last 8 random chars so visually-close runs don't
 * look identical. For non-ULID ids (legacy short ids) we fall back to the
 * leading 8 chars.
 */
export function shortRunId(runId: string): string {
  if (runId.length >= ULID_LENGTH) return runId.slice(-8);
  return runId.slice(0, 8);
}
