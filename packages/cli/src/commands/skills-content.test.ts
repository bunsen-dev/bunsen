// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Guards the *content* of the bundled cross-agent skills (not the install
 * plumbing — that is skills.test.ts). These assertions are the reason the
 * skills can be trusted: every SKILL.md has a valid auto-invocation header, the
 * bodies never reference repo-relative paths a `bn`-installed user lacks, every
 * complete example YAML passes the SAME loader `bn … validate` uses, and the
 * generated reference tables are in sync with the JSON schemas.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  parseExperimentConfig,
  parseAgentConfig,
  validateCriteriaGraph,
} from '@bunsen-dev/runtime';
// The schema-reference generator (repo-root script) exports a drift checker.
import { checkAll } from '../../../../scripts/gen-skill-reference.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = path.resolve(here, '../../assets/skills');

const EXPECTED_SKILLS = [
  'bunsen-new-experiment',
  'bunsen-author-scorer',
  'bunsen-debug-run',
  'bunsen-new-agent',
];

interface ParsedSkill {
  name: string;
  dir: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseSkill(dir: string): ParsedSkill {
  const raw = fs.readFileSync(path.join(skillsDir, dir, 'SKILL.md'), 'utf8');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`${dir}/SKILL.md is missing YAML frontmatter`);
  const frontmatter = yaml.load(match[1]) as Record<string, unknown>;
  return { name: dir, dir, frontmatter, body: match[2] };
}

const skills = EXPECTED_SKILLS.map(parseSkill);

describe('bundled skills are present', () => {
  it('ships exactly the core-four skills', () => {
    const onDisk = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, 'SKILL.md')))
      .map((d) => d.name)
      .sort();
    expect(onDisk).toEqual([...EXPECTED_SKILLS].sort());
  });
});

describe('SKILL.md frontmatter', () => {
  for (const skill of skills) {
    it(`${skill.name}: name matches the directory and description is a real trigger`, () => {
      expect(skill.frontmatter.name).toBe(skill.dir);
      const description = skill.frontmatter.description;
      expect(typeof description).toBe('string');
      // A useful auto-invocation trigger is more than a label.
      expect((description as string).length).toBeGreaterThan(80);
    });
  }

  it('descriptions are distinct (non-overlapping triggers)', () => {
    const descriptions = skills.map((s) => s.frontmatter.description);
    expect(new Set(descriptions).size).toBe(skills.length);
  });
});

describe('SKILL.md bodies are portable', () => {
  // A bn-installed user has no repo on disk. Skills may only point at `bn`
  // commands, their own `reference/*.md`, and live URLs — never repo paths.
  const FORBIDDEN = ['docs/', 'packages/', 'examples/', 'working-docs/', 'tasks/', '/Users/'];
  for (const skill of skills) {
    it(`${skill.name}: references no repo-relative paths`, () => {
      for (const needle of FORBIDDEN) {
        expect(skill.body, `should not mention "${needle}"`).not.toContain(needle);
      }
    });
  }
});

describe('SKILL.md example YAML is valid against the real loader', () => {
  for (const skill of skills) {
    it(`${skill.name}: every complete v1 example parses + validates`, () => {
      const blocks = [...skill.body.matchAll(/```ya?ml\n([\s\S]*?)```/g)].map((m) => m[1]);
      let completeConfigs = 0;
      for (const block of blocks) {
        let doc: unknown;
        try {
          doc = yaml.load(block);
        } catch {
          continue; // illustrative partial snippet, not a full document
        }
        if (!doc || typeof doc !== 'object' || (doc as { version?: string }).version !== 'v1') {
          continue;
        }
        const obj = doc as Record<string, unknown>;
        if ('task' in obj) {
          const config = parseExperimentConfig(block, { source: `${skill.name}.yaml` });
          validateCriteriaGraph(config);
          completeConfigs += 1;
        } else if ('install' in obj || 'entrypoint' in obj) {
          parseAgentConfig(block);
          completeConfigs += 1;
        }
      }
      // The three authoring skills each ship at least one complete example.
      if (skill.name !== 'bunsen-debug-run') {
        expect(completeConfigs).toBeGreaterThan(0);
      }
    });
  }
});

describe('generated references are in sync with the schemas', () => {
  it('no schema change landed without regenerating reference/*.md', () => {
    expect(checkAll()).toEqual([]);
  });

  for (const skill of ['bunsen-new-experiment', 'bunsen-author-scorer', 'bunsen-new-agent']) {
    it(`${skill}: ships a generated reference and points at it`, () => {
      const refDir = path.join(skillsDir, skill, 'reference');
      const refs = fs.existsSync(refDir) ? fs.readdirSync(refDir) : [];
      expect(refs.some((f) => f.endsWith('.md'))).toBe(true);
      const body = fs.readFileSync(path.join(skillsDir, skill, 'SKILL.md'), 'utf8');
      expect(body).toContain('reference/');
    });
  }
});
