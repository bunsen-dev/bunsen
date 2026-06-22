// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Render the fallback-pricing caveat — `⚠ N call(s) priced with a coarse
 * default — not in the price table: <models>` — for runs that hit models
 * missing from the price snapshot, or `null` when there were none (so callers
 * omit the line). The single source of the caveat wording + model-list rollup
 * (empty list → "unknown"), shared by `bn runs cost` and `bn runs show`.
 * Callers add the color and any surrounding lines.
 */
export function formatPricingFallbackWarning(
  calls: number | undefined,
  models: string[] | undefined,
  indent = '',
): string | null {
  if (!calls) return null;
  const list = models?.length ? models.join(', ') : 'unknown';
  return `${indent}⚠ ${calls} call(s) priced with a coarse default — not in the price table: ${list}`;
}
