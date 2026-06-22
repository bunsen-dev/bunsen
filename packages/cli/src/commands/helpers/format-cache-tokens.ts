// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Render cache-token counts as `<read> read · <created> created`, or `null`
 * when there's no cache activity (so callers omit the line). The single source
 * of the read/created phrasing + zero-suppression, shared by `bn runs cost`
 * (per-source and run-wide) and `bn runs show`.
 */
export function formatCacheTokens(read: number, created: number): string | null {
  if (read + created === 0) return null;
  return `${read.toLocaleString()} read · ${created.toLocaleString()} created`;
}
