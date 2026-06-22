// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `bn publish` — reserved namespace for the sharing roadmap.
 *
 * Both subcommands fail cleanly with a structured `not_implemented` error and
 * make clear that the surface is reserved for a future release. The names exist
 * now so docs and external tooling can reference the eventual surface without a
 * future rename.
 */

import { BunsenCliError } from '../errors.js';
import { EXIT_CODES } from '../exit-codes.js';

const ROADMAP_HINT = 'Publishing is reserved for a future release.';

export interface PublishRunOptions {
  visibility?: 'public' | 'unlisted';
}

export function publishRunCommand(runId: string, options: PublishRunOptions): never {
  throw new BunsenCliError(
    'not_implemented',
    `\`bn publish run\` is reserved but not yet implemented. ${ROADMAP_HINT}`,
    {
      exitCode: EXIT_CODES.GENERIC,
      details: {
        runId,
        ...(options.visibility ? { visibility: options.visibility } : {}),
        feature: 'publishing',
      },
    },
  );
}

export function publishReportCommand(reportPath: string): never {
  throw new BunsenCliError(
    'not_implemented',
    `\`bn publish report\` is reserved but not yet implemented. ${ROADMAP_HINT}`,
    {
      exitCode: EXIT_CODES.GENERIC,
      details: {
        reportPath,
        feature: 'publishing',
      },
    },
  );
}
