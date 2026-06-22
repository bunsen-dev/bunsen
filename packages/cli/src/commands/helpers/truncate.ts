// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Truncate a string to `len` characters, replacing the overflowing tail with a
 * single-character ellipsis. Shared by the run-table renderers (`bn runs list`,
 * `bn runs compare`).
 */
export function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.slice(0, len - 1) + '…';
}

/**
 * Fit a string into a fixed-width table cell: truncate (with ellipsis) to leave
 * room, then pad to exactly `width`. The cell primitive shared by the run-table
 * renderers (`bn runs compare`'s 1D table and matrix).
 */
export function padCell(str: string, width: number): string {
  return truncate(str, width - 1).padEnd(width);
}
