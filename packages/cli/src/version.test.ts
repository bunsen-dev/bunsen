// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Guard against version drift: CLI_VERSION is a hand-maintained constant
 * (bundled into the standalone binary, where package.json is not readable),
 * and the v0.3.0 release shipped binaries self-reporting 0.2.0 because the
 * release checklist bumped package.json but not this constant. This test
 * makes the drift impossible to miss — `pnpm -r test` runs on every PR.
 */

import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_VERSION } from './version.js';

describe('CLI_VERSION', () => {
  it('matches packages/cli/package.json version (release-checklist drift guard)', () => {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string };
    expect(CLI_VERSION).toBe(pkg.version);
  });
});
