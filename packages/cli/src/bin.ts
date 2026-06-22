#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0

/**
 * Bunsen CLI entry point
 */

import { program } from './index.js';
import { reportError } from './errors.js';

// Top-level handlers — funnel any uncaught BunsenCliError (or anything else
// thrown out of a command's async action) through `reportError` so we get a
// stable exit code and a structured payload under `--format json`.
const detectFormat = (): 'text' | 'json' | 'yaml' => {
  const idx = process.argv.findIndex((a) => a === '--format' || a === '-f');
  if (idx >= 0 && idx + 1 < process.argv.length) {
    const value = process.argv[idx + 1];
    if (value === 'json' || value === 'yaml' || value === 'text') return value;
  }
  return 'text';
};

process.on('unhandledRejection', (reason) => {
  reportError(reason, detectFormat());
});

process.on('uncaughtException', (err) => {
  reportError(err, detectFormat());
});

program.parse();
