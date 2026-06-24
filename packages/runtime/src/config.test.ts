// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for the directory-discovery helpers exported from `./config.ts`.
 * Agent- and experiment-parser tests live in `agent-loader.test.ts` and
 * `experiment-loader.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { findExperiments, findAgents } from './config.js';

describe('findExperiments', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds experiments in a directory', () => {
    const exp1 = path.join(tempDir, 'exp1');
    const exp2 = path.join(tempDir, 'exp2');
    const notExp = path.join(tempDir, 'not-an-experiment');

    fs.mkdirSync(exp1);
    fs.mkdirSync(exp2);
    fs.mkdirSync(notExp);

    fs.writeFileSync(path.join(exp1, 'experiment.yaml'), 'name: exp1');
    fs.writeFileSync(path.join(exp2, 'experiment.yaml'), 'name: exp2');
    fs.writeFileSync(path.join(notExp, 'readme.md'), 'Not an experiment');

    const experiments = findExperiments(tempDir);

    expect(experiments).toHaveLength(2);
    expect(experiments).toContain(exp1);
    expect(experiments).toContain(exp2);
  });

  it('returns empty array for nonexistent directory', () => {
    const experiments = findExperiments('/nonexistent/path');
    expect(experiments).toEqual([]);
  });
});

describe('findAgents', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds agents in a directory', () => {
    const agent1 = path.join(tempDir, 'agent1');
    const agent2 = path.join(tempDir, 'agent2');

    fs.mkdirSync(agent1);
    fs.mkdirSync(agent2);

    fs.writeFileSync(path.join(agent1, 'agent.yaml'), 'name: agent1');
    fs.writeFileSync(path.join(agent2, 'agent.yaml'), 'name: agent2');

    const agents = findAgents(tempDir);

    expect(agents).toHaveLength(2);
    expect(agents).toContain(agent1);
    expect(agents).toContain(agent2);
  });
});
