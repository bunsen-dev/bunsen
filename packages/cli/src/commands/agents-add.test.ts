// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  listBundledAgents,
  bundledAgentSummary,
  installAgentsInto,
} from './agents-add.js';

let tmp: string;
let source: string;

function writeAgent(root: string, name: string, description = `${name} starter`): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'agent.yaml'),
    `version: v1\nname: ${name}\ndescription: |\n  ${description}\n  second line\n`,
  );
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-agents-add-'));
  source = path.join(tmp, 'bundled');
  fs.mkdirSync(source, { recursive: true });
  writeAgent(source, 'claude-code');
  writeAgent(source, 'codex-cli');
  writeAgent(source, 'gemini-cli');
  // A directory without agent.yaml must be ignored as a starter.
  fs.mkdirSync(path.join(source, 'not-an-agent'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('listBundledAgents', () => {
  it('returns only dirs containing an agent.yaml, sorted', () => {
    expect(listBundledAgents(source)).toEqual(['claude-code', 'codex-cli', 'gemini-cli']);
  });

  it('returns [] for a missing source dir', () => {
    expect(listBundledAgents(path.join(tmp, 'nope'))).toEqual([]);
  });
});

describe('bundledAgentSummary', () => {
  it('returns the first non-empty line of the description', () => {
    expect(bundledAgentSummary(source, 'claude-code')).toBe('claude-code starter');
  });

  it('returns empty string when the agent.yaml is unreadable', () => {
    expect(bundledAgentSummary(source, 'does-not-exist')).toBe('');
  });
});

describe('installAgentsInto', () => {
  it('copies the named starters into a fresh agents dir', () => {
    const target = path.join(tmp, 'project', 'agents');
    const results = installAgentsInto(source, target, ['claude-code', 'codex-cli']);
    expect(results).toEqual([
      { name: 'claude-code', status: 'added' },
      { name: 'codex-cli', status: 'added' },
    ]);
    expect(fs.existsSync(path.join(target, 'claude-code', 'agent.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'codex-cli', 'agent.yaml'))).toBe(true);
    // Unrequested agent is not copied.
    expect(fs.existsSync(path.join(target, 'gemini-cli'))).toBe(false);
  });

  it('skips an agent that already exists (no overwrite without --force)', () => {
    const target = path.join(tmp, 'project', 'agents');
    fs.mkdirSync(path.join(target, 'claude-code'), { recursive: true });
    fs.writeFileSync(path.join(target, 'claude-code', 'agent.yaml'), 'name: mine\n');

    const results = installAgentsInto(source, target, ['claude-code', 'codex-cli']);
    expect(results).toEqual([
      { name: 'claude-code', status: 'skipped' },
      { name: 'codex-cli', status: 'added' },
    ]);
    // The user's customized file is untouched.
    expect(fs.readFileSync(path.join(target, 'claude-code', 'agent.yaml'), 'utf8')).toBe('name: mine\n');
  });

  it('overwrites an existing agent with force and removes stale files', () => {
    const target = path.join(tmp, 'project', 'agents');
    fs.mkdirSync(path.join(target, 'claude-code'), { recursive: true });
    fs.writeFileSync(path.join(target, 'claude-code', 'stale.txt'), 'old');

    const results = installAgentsInto(source, target, ['claude-code'], { force: true });
    expect(results).toEqual([{ name: 'claude-code', status: 'overwritten' }]);
    // Bundled agent.yaml is present; the stale file is gone.
    expect(fs.existsSync(path.join(target, 'claude-code', 'agent.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'claude-code', 'stale.txt'))).toBe(false);
  });

  it('throws on an unknown starter name', () => {
    const target = path.join(tmp, 'project', 'agents');
    expect(() => installAgentsInto(source, target, ['nope'])).toThrow(/Unknown starter agent/);
  });

  it('throws when the bundled source has no agents (packaging error)', () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    expect(() => installAgentsInto(empty, path.join(tmp, 'p', 'agents'), [])).toThrow(
      /No bundled starter agents/,
    );
  });
});
