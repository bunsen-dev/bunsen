// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { BunsenCliError } from '../../errors.js';
import { EXIT_CODES } from '../../exit-codes.js';

/**
 * Parse a CLI count flag (e.g. `--last`) as a positive integer.
 *
 * `Number` (unlike `parseInt`) rejects trailing garbage and non-integers
 * outright: `parseInt('2.9')` is 2 and `parseInt('3x')` is 3, which would
 * silently honor a malformed flag.
 */
export function parsePositiveInt(value: string, flag: string, code = 'bad_count'): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new BunsenCliError(code, `${flag} must be a positive integer, got: ${value}`, {
      exitCode: EXIT_CODES.USAGE,
      details: { value },
    });
  }
  return n;
}
