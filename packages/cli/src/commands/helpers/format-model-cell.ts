// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Render a run's model for a one-line listing (`bn runs list`, `bn runs
 * compare`): the primary (highest-cost) model, with a `+N` suffix when the run
 * drove additional models. The full per-model breakdown is shown by
 * `bn runs show`. Returns `-` when no model is known (e.g. no traces captured).
 */
export function formatModelCell(primary: string | undefined, count?: number): string {
  if (!primary) return '-';
  return count && count > 1 ? `${primary} +${count - 1}` : primary;
}
