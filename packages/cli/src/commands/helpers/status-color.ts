// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import chalk from 'chalk';

/**
 * Map a run status to its terminal color — the single source of truth for the
 * run-status palette shared by `bn runs list`, `bn runs compare`, and any other
 * run-table renderer.
 */
export function statusColor(status: string): (s: string) => string {
  switch (status) {
    case 'succeeded':
      return chalk.green;
    case 'failed':
      return chalk.red;
    case 'canceled':
      return chalk.magenta;
    case 'running':
      return chalk.yellow;
    default:
      return chalk.dim;
  }
}
