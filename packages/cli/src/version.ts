// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Single source of truth for the CLI version string.
 *
 * Kept in sync with `packages/cli/package.json` `version`. Used both for the
 * `bn --version` flag and to stamp `bn skills install` so `bn skills list` can
 * warn when bundled skills were installed by an older CLI.
 */
export const CLI_VERSION = '0.1.0';
