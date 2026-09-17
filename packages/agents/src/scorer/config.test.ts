import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadScorerConfig } from './config.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorer-config-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeConfig(value: unknown): string {
  const file = path.join(dir, 'criterion.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

const valid = {
  type: 'agent',
  id: 'tests-pass',
  title: 'Tests pass',
  instructions: 'Do the tests pass?',
  model: 'anthropic/claude-sonnet-4-6',
  contextDir: '/bunsen/run',
  workspacePath: '/workspace',
};

describe('loadScorerConfig', () => {
  it('loads a resolved config', () => {
    expect(loadScorerConfig(writeConfig(valid))).toEqual(valid);
  });

  it('keeps the optional fields the host resolved', () => {
    const config = loadScorerConfig(
      writeConfig({
        ...valid,
        workspaceSourcePath: '/workspace-source',
        systemPrompt: 'Grade harshly.',
        tools: ['read_file'],
        scores: { 0: 'fail', 1: 'pass' },
        evidence: ['diff', 'logs'],
        dependencyScores: { lint: { score: null, summary: 'Skipped: gated' } },
      }),
    );

    expect(config.workspaceSourcePath).toBe('/workspace-source');
    expect(config.systemPrompt).toBe('Grade harshly.');
    expect(config.tools).toEqual(['read_file']);
    expect(config.scores).toEqual({ 0: 'fail', 1: 'pass' });
    expect(config.evidence).toEqual(['diff', 'logs']);
    expect(config.dependencyScores).toEqual({ lint: { score: null, summary: 'Skipped: gated' } });
  });

  it('says which file it could not read', () => {
    expect(() => loadScorerConfig(path.join(dir, 'missing.json'))).toThrow(
      /Could not read scorer config at .*missing\.json/,
    );
  });

  it('rejects a bare model id and shows the fix', () => {
    expect(() => loadScorerConfig(writeConfig({ ...valid, model: 'claude-sonnet-4-6' }))).toThrow(
      /"model" must be "<provider>\/<model>"/,
    );
  });

  it('rejects an unknown scorer type', () => {
    expect(() => loadScorerConfig(writeConfig({ ...valid, type: 'visual' }))).toThrow(
      /"type" must be one of judge, agent, browser-agent, report/,
    );
  });

  it('rejects a missing required field', () => {
    const { instructions: _dropped, ...without } = valid;
    expect(() => loadScorerConfig(writeConfig(without))).toThrow(
      /"instructions" must be a non-empty string/,
    );
  });

  it('rejects an empty tool allowlist with the fix', () => {
    expect(() => loadScorerConfig(writeConfig({ ...valid, tools: [] }))).toThrow(
      /"tools" must list at least one tool; use type: judge for a scorer with no tools/,
    );
  });

  it('rejects a browser tool on an agent scorer', () => {
    expect(() => loadScorerConfig(writeConfig({ ...valid, tools: ['screenshot'] }))).toThrow(
      /is not a agent scorer tool/,
    );
    expect(
      loadScorerConfig(writeConfig({ ...valid, type: 'browser-agent', tools: ['screenshot'] })).tools,
    ).toEqual(['screenshot']);
  });

  it('rejects an unknown evidence kind', () => {
    expect(() => loadScorerConfig(writeConfig({ ...valid, evidence: ['screenshots'] }))).toThrow(
      /"evidence" entry "screenshots" is not one of diff, logs, traces/,
    );
  });

  it('rejects malformed scores', () => {
    expect(() => loadScorerConfig(writeConfig({ ...valid, scores: [] }))).toThrow(
      /"scores" must list at least one value/,
    );
    expect(() => loadScorerConfig(writeConfig({ ...valid, scores: ['pass'] }))).toThrow(
      /"scores" must be a list of numbers/,
    );
  });
});
