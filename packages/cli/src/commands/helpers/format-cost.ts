// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Format a USD cost as `$0.0000` — the CLI's standard 4-decimal money format. */
export function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}
