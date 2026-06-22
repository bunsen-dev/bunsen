// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  listBundledSkills,
  clientSkillsDir,
  detectClients,
  installSkillsInto,
  uninstallSkillsFrom,
  installedSkillsAt,
} from './skills.js';

let tmp: string;
let source: string;

function writeSkill(root: string, name: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'reference'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\nbody\n`);
  fs.writeFileSync(path.join(dir, 'reference', 'r.md'), 'ref\n');
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-skills-'));
  source = path.join(tmp, 'bundled');
  fs.mkdirSync(source, { recursive: true });
  writeSkill(source, 'bunsen-alpha');
  writeSkill(source, 'bunsen-beta');
  // A directory without SKILL.md must be ignored as a skill.
  fs.mkdirSync(path.join(source, 'not-a-skill'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('listBundledSkills', () => {
  it('returns only dirs containing a SKILL.md, sorted', () => {
    expect(listBundledSkills(source)).toEqual(['bunsen-alpha', 'bunsen-beta']);
  });

  it('returns [] for a missing source dir', () => {
    expect(listBundledSkills(path.join(tmp, 'nope'))).toEqual([]);
  });
});

describe('clientSkillsDir', () => {
  it('resolves user scope under home and project scope under cwd', () => {
    const home = '/home/u';
    const cwd = '/repo';
    expect(clientSkillsDir('claude', 'user', cwd, home)).toBe('/home/u/.claude/skills');
    expect(clientSkillsDir('codex', 'user', cwd, home)).toBe('/home/u/.agents/skills');
    expect(clientSkillsDir('claude', 'project', cwd, home)).toBe('/repo/.claude/skills');
    expect(clientSkillsDir('codex', 'project', cwd, home)).toBe('/repo/.agents/skills');
  });
});

describe('detectClients', () => {
  it('detects claude from ~/.claude and codex from ~/.codex or ~/.agents', () => {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home, { recursive: true });
    expect(detectClients(home)).toEqual([]);
    fs.mkdirSync(path.join(home, '.claude'));
    expect(detectClients(home)).toEqual(['claude']);
    fs.mkdirSync(path.join(home, '.agents'));
    expect(detectClients(home).sort()).toEqual(['claude', 'codex']);
  });
});

describe('installSkillsInto', () => {
  it('copies every bundled skill, stamps the version, and is idempotent', () => {
    const target = path.join(tmp, 'home', '.claude', 'skills');
    const result = installSkillsInto(source, target, '1.2.3');
    expect(result.skills).toEqual(['bunsen-alpha', 'bunsen-beta']);
    expect(result.status).toBe('installed');
    expect(result.previousVersion).toBeNull();
    expect(fs.existsSync(path.join(target, 'bunsen-alpha', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'bunsen-alpha', 'reference', 'r.md'))).toBe(true);

    const stamp = installedSkillsAt(target);
    expect(stamp?.cliVersion).toBe('1.2.3');
    expect(stamp?.present).toEqual(['bunsen-alpha', 'bunsen-beta']);

    // A second install does not throw or duplicate.
    expect(() => installSkillsInto(source, target, '1.2.3')).not.toThrow();
  });

  it('reports install vs update vs reinstall from the prior stamp', () => {
    const target = path.join(tmp, 'home', '.claude', 'skills');

    const first = installSkillsInto(source, target, '1.0.0');
    expect(first.status).toBe('installed');
    expect(first.previousVersion).toBeNull();

    const same = installSkillsInto(source, target, '1.0.0');
    expect(same.status).toBe('reinstalled');
    expect(same.previousVersion).toBe('1.0.0');

    const upgraded = installSkillsInto(source, target, '2.0.0');
    expect(upgraded.status).toBe('updated');
    expect(upgraded.previousVersion).toBe('1.0.0');
    expect(installedSkillsAt(target)?.cliVersion).toBe('2.0.0');
  });

  it('replaces a stale copy of a skill on reinstall', () => {
    const target = path.join(tmp, 'home', '.claude', 'skills');
    installSkillsInto(source, target, '1.0.0');
    // Leave a stray file inside an installed skill; reinstall should remove it.
    fs.writeFileSync(path.join(target, 'bunsen-alpha', 'STALE.md'), 'old');
    installSkillsInto(source, target, '1.0.0');
    expect(fs.existsSync(path.join(target, 'bunsen-alpha', 'STALE.md'))).toBe(false);
  });

  it('throws when the source has no skills', () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    expect(() => installSkillsInto(empty, path.join(tmp, 'out'), '1.0.0')).toThrow(
      /No bundled skills/,
    );
  });
});

describe('uninstallSkillsFrom', () => {
  it('removes bundled skills and the stamp but leaves unrelated skills', () => {
    const target = path.join(tmp, 'home', '.claude', 'skills');
    installSkillsInto(source, target, '1.0.0');
    // A user's own skill that Bunsen must never touch.
    writeSkill(target, 'my-own-skill');

    const removed = uninstallSkillsFrom(target, ['bunsen-alpha', 'bunsen-beta']);
    expect(removed).toEqual(['bunsen-alpha', 'bunsen-beta']);
    expect(fs.existsSync(path.join(target, 'bunsen-alpha'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'my-own-skill', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.bunsen-skills.json'))).toBe(false);
    expect(installedSkillsAt(target)).toBeNull();
  });

  it('also removes skills recorded in the stamp even if no longer bundled', () => {
    const target = path.join(tmp, 'home', '.claude', 'skills');
    installSkillsInto(source, target, '1.0.0');
    // Simulate a renamed skill: stamp still references bunsen-beta; bundle no longer does.
    const removed = uninstallSkillsFrom(target, ['bunsen-alpha']);
    expect(removed.sort()).toEqual(['bunsen-alpha', 'bunsen-beta']);
  });
});
