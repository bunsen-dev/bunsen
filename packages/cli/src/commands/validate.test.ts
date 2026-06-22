// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { fixExperimentFile } from './validate.js';

let tmpdir: string;

beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-validate-fix-'));
});

afterEach(() => {
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

function writeFile(name: string, doc: unknown): string {
  const p = path.join(tmpdir, name);
  fs.writeFileSync(p, yaml.dump(doc));
  return p;
}

describe('fixExperimentFile', () => {
  it('auto-slugs criterion ids from titles', () => {
    const p = writeFile('experiment.yaml', {
      version: 'v1',
      name: 'demo',
      task: { prompt: 'hi' },
      environment: { image: { base: 'python:3.11-slim' } },
      evaluation: {
        container: 'dedicated',
        criteria: [
          { title: 'Code Quality', type: 'judge', instructions: 'judge it' },
          { title: 'Code Quality', type: 'judge', instructions: 'judge again' },
          { id: 'preexisting', title: 'X', type: 'judge', instructions: 'i' },
        ],
      },
    });
    const report = fixExperimentFile(p);
    expect(report.changed).toBe(true);
    const updated = yaml.load(fs.readFileSync(p, 'utf-8')) as {
      evaluation: { criteria: Array<{ id: string; title: string }> };
    };
    expect(updated.evaluation.criteria[0].id).toBe('code-quality');
    expect(updated.evaluation.criteria[1].id).toBe('code-quality-2');
    expect(updated.evaluation.criteria[2].id).toBe('preexisting');
  });

  it('leaves numeric duration values alone (parser will reject them)', () => {
    const p = writeFile('experiment.yaml', {
      version: 'v1',
      name: 'demo',
      task: { prompt: 'hi' },
      environment: { image: { base: 'python:3.11-slim' } },
      run: { timeout: 60000 },
      evaluation: {
        container: 'dedicated',
        criteria: [
          { id: 'check', title: 'Check', type: 'script', run: 'echo ok', timeout: 5000 },
        ],
      },
    });
    const report = fixExperimentFile(p);
    expect(report.changed).toBe(false);
    const updated = yaml.load(fs.readFileSync(p, 'utf-8')) as {
      run: { timeout: unknown };
      evaluation: { criteria: Array<{ timeout: unknown }> };
    };
    expect(updated.run.timeout).toBe(60000);
    expect(updated.evaluation.criteria[0].timeout).toBe(5000);
  });

  it('is idempotent', () => {
    const p = writeFile('experiment.yaml', {
      version: 'v1',
      name: 'demo',
      task: { prompt: 'hi' },
      environment: { image: { base: 'python:3.11-slim' } },
      evaluation: {
        container: 'dedicated',
        criteria: [{ title: 'Quality', type: 'judge', instructions: 'do it' }],
      },
    });
    const r1 = fixExperimentFile(p);
    const after1 = fs.readFileSync(p, 'utf-8');
    const r2 = fixExperimentFile(p);
    const after2 = fs.readFileSync(p, 'utf-8');
    expect(r1.changed).toBe(true);
    expect(r2.changed).toBe(false);
    expect(after1).toBe(after2);
  });
});
