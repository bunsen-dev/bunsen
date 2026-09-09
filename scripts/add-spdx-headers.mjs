#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: Apache-2.0
/**
 * Add SPDX license headers to Bunsen-OWNED source files.
 *
 * Bunsen uses the standard Apache-2.0 SPDX identifier (see LICENSING.md).
 *
 * Third-party code (examples/experiments/**), build output (dist/**),
 * node_modules, and *.d.ts are excluded — they keep their own terms.
 *
 * Usage (run from the repo root):
 *   node scripts/add-spdx-headers.mjs           # dry-run: report what would change
 *   node scripts/add-spdx-headers.mjs --apply   # write headers (idempotent)
 *   node scripts/add-spdx-headers.mjs --check    # exit 1 if any owned file has a missing or incorrect header (CI)
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const COPYRIGHT = 'Matthew Job Granmoe';
const YEAR = '2026';
const SPDX_ID = 'Apache-2.0';

const GLOBS = [
  'packages/**/*.ts', 'packages/**/*.js', 'packages/**/*.mjs', 'packages/**/*.cjs', 'packages/**/*.py',
  'scripts/**/*.ts', 'scripts/**/*.mjs', 'scripts/**/*.js', 'scripts/**/*.py',
];
const EXCLUDE = /(^|\/)(node_modules|dist)\/|\.d\.ts$/;

const listFiles = () =>
  execSync(`git ls-files ${GLOBS.map((g) => `':(glob)${g}'`).join(' ')}`, { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean)
    // Skip excluded paths and files still in the index but deleted from disk
    // (e.g. an unstaged removal), which would otherwise throw on read.
    .filter((f) => !EXCLUDE.test(f) && existsSync(f));

const headerIds = (text) =>
  [...text.slice(0, 500).matchAll(/^(?:\/\/|#) SPDX-License-Identifier:[ \t]*([^\r\n]*)/gm)]
    .map((match) => match[1].trim());

function withHeader(file, text) {
  const c = file.endsWith('.py') ? '#' : '//';
  const header = `${c} SPDX-FileCopyrightText: ${YEAR} ${COPYRIGHT}\n${c} SPDX-License-Identifier: ${SPDX_ID}\n`;
  const lines = text.split('\n');
  // Keep a shebang on line 1; keep a Python coding declaration in the first two lines.
  let at = 0;
  if (lines[0]?.startsWith('#!')) at = 1;
  if (lines[at] && /coding[:=]\s*[-\w.]+/.test(lines[at]) && file.endsWith('.py')) at += 1;
  const head = lines.slice(0, at);
  const tail = lines.slice(at);
  return [...head, ...header.replace(/\n$/, '').split('\n'), ...tail].join('\n');
}

const mode = process.argv.includes('--apply') ? 'apply'
  : process.argv.includes('--check') ? 'check' : 'dry';

const files = listFiles();
const missing = [];
const incorrect = [];
let added = 0, skipped = 0;
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const ids = headerIds(text);
  if (ids.length) {
    if (ids.length === 1 && ids[0] === SPDX_ID) skipped++;
    else incorrect.push(f);
    continue;
  }
  missing.push(f);
  if (mode === 'apply') { writeFileSync(f, withHeader(f, text)); added++; }
}

if (mode === 'check') {
  if (missing.length || incorrect.length) {
    console.error(`Missing SPDX header in ${missing.length} file(s):`);
    missing.slice(0, 50).forEach((f) => console.error('  ' + f));
    console.error(`Incorrect SPDX header (expected ${SPDX_ID}) in ${incorrect.length} file(s):`);
    incorrect.slice(0, 50).forEach((f) => console.error('  ' + f));
    process.exit(1);
  }
  console.log(`OK: all ${files.length} owned source files carry the ${SPDX_ID} header.`);
  process.exit(0);
}

console.log(
  `Owned source files: ${files.length} | already tagged: ${skipped} | ` +
  `${mode === 'apply' ? `headers added: ${added}` : `would tag: ${missing.length}`}`
);
if (mode === 'dry' && missing.length) {
  console.log('Sample of untagged files:');
  missing.slice(0, 8).forEach((f) => console.log('  ' + f));
  console.log('Re-run with --apply to write headers.');
}

if (incorrect.length) {
  console.error(`Incorrect SPDX header (expected ${SPDX_ID}); review these files manually:`);
  incorrect.forEach((f) => console.error('  ' + f));
  process.exitCode = 1;
}
