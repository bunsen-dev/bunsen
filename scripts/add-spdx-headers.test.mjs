// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./add-spdx-headers.mjs', import.meta.url));

function fixture(t, source, extension = 'ts', directory = 'packages/test') {
  const cwd = mkdtempSync(join(tmpdir(), 'bunsen-spdx-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, directory), { recursive: true });
  const file = join(cwd, `${directory}/source.${extension}`);
  writeFileSync(file, source);
  for (const args of [['init', '-q'], ['add', '.']]) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  return { file, run: (mode) => spawnSync(process.execPath, [script, mode], { cwd, encoding: 'utf8' }) };
}

test('check rejects missing, incorrect, and conflicting identifiers', (t) => {
  for (const source of [
    'export {};\n',
    '// SPDX-License-Identifier: MIT\nexport {};\n',
    '// SPDX-License-Identifier: Apache-2.0 OR MIT\nexport {};\n',
    '// SPDX-License-Identifier: Apache-2.0\n// SPDX-License-Identifier: MIT\n',
  ]) {
    const { run, file } = fixture(t, source);
    const result = run('--check');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /source.ts/);
    assert.equal(readFileSync(file, 'utf8'), source);
  }
});

test('apply preserves Python preamble, adds the expected header, and is idempotent', (t) => {
  const { run, file } = fixture(t, '#!/usr/bin/env python3\n# coding: utf-8\nprint("ok")\n', 'py');
  assert.equal(run('--apply').status, 0);
  const applied = readFileSync(file, 'utf8');
  assert.match(applied, /^#!\/usr\/bin\/env python3\n# coding: utf-8\n# SPDX-FileCopyrightText:/);
  assert.equal(run('--check').status, 0);
  assert.equal(run('--apply').status, 0);
  assert.equal(readFileSync(file, 'utf8'), applied);
});

test('apply requires review of an existing incorrect license instead of overwriting it', (t) => {
  const source = '// SPDX-License-Identifier: MIT\nexport {};\n';
  const { run, file } = fixture(t, source);
  assert.equal(run('--apply').status, 1);
  assert.equal(readFileSync(file, 'utf8'), source);
});

test('check includes scripts directly in the scripts directory', (t) => {
  const { run } = fixture(t, '// SPDX-License-Identifier: MIT\n', 'mjs', 'scripts');
  const result = run('--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /scripts\/source.mjs/);
});
