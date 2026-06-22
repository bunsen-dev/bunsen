// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for targeted, comment-preserving edits to bunsen.config.yaml#suites.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'js-yaml';
import {
  replaceSuitesBlock,
  updateProjectSuites,
  ProjectConfigEditError,
  getProjectConfigPath,
} from './project-config-edit.js';
import type { ProjectSuiteEntry } from '@bunsen-dev/types';

function mkTemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-config-edit-test-'));
}

const ENTRY_A: ProjectSuiteEntry = {
  source: { type: 'git', url: 'https://github.com/bunsen-dev/terminal-bench.git' },
  as: 'terminal-bench',
};

const ENTRY_B: ProjectSuiteEntry = {
  source: { type: 'git', url: 'https://gitlab.com/team/eval-suite.git', ref: 'v0.2.1' },
};

describe('replaceSuitesBlock', () => {
  it('inserts a suites block when none exists', () => {
    const initial = `version: v1\nname: test\n`;
    const out = replaceSuitesBlock(initial, [ENTRY_A]);
    expect(out).toContain('suites:');
    const parsed = yaml.load(out) as { suites: unknown[] };
    expect(parsed.suites).toHaveLength(1);
  });

  it('replaces an existing suites block while preserving surrounding content', () => {
    const initial = [
      'version: v1',
      'name: test',
      '',
      '# Comment about paths',
      'paths:',
      '  experiments:',
      '    - examples',
      '',
      'suites:',
      '  - source:',
      '      type: git',
      '      url: https://github.com/old/repo.git',
      '',
      'defaults:',
      '  envFiles:',
      '    - .env',
      '',
    ].join('\n');
    const out = replaceSuitesBlock(initial, [ENTRY_A, ENTRY_B]);
    // Comments and other top-level keys preserved.
    expect(out).toContain('# Comment about paths');
    expect(out).toContain('paths:');
    expect(out).toContain('defaults:');
    expect(out).toContain('envFiles:');
    // Old suite URL gone.
    expect(out).not.toContain('old/repo.git');

    const parsed = yaml.load(out) as { suites: { source: { url: string } }[] };
    expect(parsed.suites.map((s) => s.source.url)).toEqual([
      ENTRY_A.source.url,
      ENTRY_B.source.url,
    ]);
  });

  it('removes the suites block when called with an empty array', () => {
    const initial = [
      'version: v1',
      'suites:',
      '  - source:',
      '      type: git',
      '      url: https://x/y.git',
      'paths:',
      '  experiments:',
      '    - examples',
      '',
    ].join('\n');
    const out = replaceSuitesBlock(initial, []);
    expect(out).not.toContain('suites:');
    expect(out).toContain('paths:');
  });

  it('emits ref and as fields for entries that declare them', () => {
    const out = replaceSuitesBlock('version: v1\n', [
      { source: { type: 'git', url: 'https://x/y.git', ref: 'v1.2' }, as: 'y' },
    ]);
    const parsed = yaml.load(out) as {
      suites: { source: { ref?: string }; as?: string }[];
    };
    expect(parsed.suites[0].source.ref).toBe('v1.2');
    expect(parsed.suites[0].as).toBe('y');
  });
});

describe('updateProjectSuites', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkTemp();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates a new config file when missing', () => {
    const configPath = getProjectConfigPath(tempDir);
    const result = updateProjectSuites(configPath, (current) => [...current, ENTRY_A]);
    expect(result).toHaveLength(1);
    const raw = fs.readFileSync(configPath, 'utf8');
    expect(raw).toContain('version: v1');
    expect(raw).toContain('suites:');
  });

  it('appends to an existing suites array', () => {
    const configPath = getProjectConfigPath(tempDir);
    fs.writeFileSync(
      configPath,
      `version: v1\nname: test\nsuites:\n  - source:\n      type: git\n      url: https://x/y.git\n`,
    );
    const result = updateProjectSuites(configPath, (current) => [...current, ENTRY_A]);
    expect(result).toHaveLength(2);
    const raw = fs.readFileSync(configPath, 'utf8');
    expect(raw).toContain('https://x/y.git');
    expect(raw).toContain('terminal-bench');
  });

  it('rejects duplicate URLs at write time', () => {
    const configPath = getProjectConfigPath(tempDir);
    expect(() =>
      updateProjectSuites(configPath, () => [ENTRY_A, ENTRY_A]),
    ).toThrow(ProjectConfigEditError);
  });

  it('rejects duplicate aliases at write time', () => {
    const configPath = getProjectConfigPath(tempDir);
    const dupAlias: ProjectSuiteEntry = {
      source: { type: 'git', url: 'https://example.com/a/b.git' },
      as: 'terminal-bench',
    };
    expect(() =>
      updateProjectSuites(configPath, () => [ENTRY_A, dupAlias]),
    ).toThrow(ProjectConfigEditError);
  });

  it('preserves comments outside the suites block', () => {
    const configPath = getProjectConfigPath(tempDir);
    fs.writeFileSync(
      configPath,
      [
        '# Project config',
        'version: v1',
        '',
        '# Search paths',
        'paths:',
        '  experiments: [examples]',
        '',
      ].join('\n'),
    );
    updateProjectSuites(configPath, (current) => [...current, ENTRY_A]);
    const raw = fs.readFileSync(configPath, 'utf8');
    expect(raw).toContain('# Project config');
    expect(raw).toContain('# Search paths');
  });

  it('round-trips through js-yaml after edits', () => {
    const configPath = getProjectConfigPath(tempDir);
    updateProjectSuites(configPath, () => [ENTRY_A, ENTRY_B]);
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    expect((parsed.suites as unknown[]).length).toBe(2);
  });
});
