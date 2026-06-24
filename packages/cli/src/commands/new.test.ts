// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect } from 'bun:test';
import { parseExperimentConfig, parseAgentConfig } from '@bunsen-dev/runtime';
import { getExperimentTemplate, getAgentTemplate } from './new.js';

// Guards the canonical `bn new` first-run flow: the YAML the scaffolder emits
// must pass the same loader `bn run` uses, or `bn new <name>` -> `bn run` breaks.
describe('bn new scaffold templates', () => {
  for (const template of ['default', 'coding-task']) {
    it(`experiment template "${template}" parses against the v1 loader`, () => {
      const yaml = getExperimentTemplate('scaffold-smoke', template);
      const config = parseExperimentConfig(yaml, { source: `${template}.yaml` });
      expect(config.version).toBe('v1');
      expect(config.name).toBe('scaffold-smoke');
      expect(config.evaluation.criteria.length).toBeGreaterThan(0);
    });
  }

  it('falls back to the default template for an unknown template name', () => {
    const yaml = getExperimentTemplate('scaffold-smoke', 'does-not-exist');
    expect(() => parseExperimentConfig(yaml)).not.toThrow();
  });

  it('agent template parses against the v1 loader', () => {
    const yaml = getAgentTemplate('scaffold-agent');
    const config = parseAgentConfig(yaml);
    expect(config.version).toBe('v1');
    expect(config.name).toBe('scaffold-agent');
  });
});
