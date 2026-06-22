// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Stable exit-code contract for the `bn` CLI.
 *
 * See the "Exit Codes" section in `README.md`. CI scripts and agents
 * condition on these values, so they must not drift.
 */

export const EXIT_CODES = {
  /** Command completed successfully. */
  SUCCESS: 0,
  /** Generic failure (catch-all for uncategorized errors). */
  GENERIC: 1,
  /** Usage error: bad flags, missing args, unknown command. */
  USAGE: 2,
  /** Validation failure: invalid YAML, schema violations, cross-resource errors. */
  VALIDATION: 3,
  /** Runtime failure during a run (agent crashed, container died, infra error). */
  RUNTIME: 4,
  /** Evaluation failure (scorer crashed; distinct from a low score). */
  EVALUATION: 5,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
