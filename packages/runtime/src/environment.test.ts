// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect } from 'vitest';
import {
  resolveEnvironment,
  generatePackageInstallCommands,
  hasPackageRequirements,
} from './environment.js';
import type { ExperimentConfig, AgentConfig, RuntimeName } from '@bunsen-dev/types';
import { DEFAULT_BASE_IMAGE } from './config.js';

/**
 * Substrate-only environment resolution: the experiment provides the task
 * substrate (runtimes, packages, services). The agent is a sealed closure
 * and does NOT contribute to substrate. See
 * `docs/ENVIRONMENT.md#asymmetric-composition`.
 */

interface EnvironmentOverrides {
  base?: string;
  runtimes?: Partial<Record<RuntimeName, string>>;
  packages?: { apt?: string[]; npm?: string[]; pip?: string[]; cargo?: string[] };
  workspace_setup?: string | string[];
}

function createExperiment(overrides: EnvironmentOverrides = {}): ExperimentConfig {
  const base: ExperimentConfig = {
    version: 'v1',
    name: 'test-experiment',
    description: 'A test experiment',
    task: { prompt: 'Do the thing' },
    environment: {
      image: { base: overrides.base ?? DEFAULT_BASE_IMAGE },
    },
    evaluation: {
      container: 'dedicated',
      criteria: [
        { id: 'correctness', title: 'Correctness', type: 'judge', instructions: 'Is it correct?' },
      ],
    },
  };
  if (overrides.runtimes || overrides.packages) {
    base.environment.requires = {};
    if (overrides.runtimes) base.environment.requires.runtimes = overrides.runtimes;
    if (overrides.packages) base.environment.requires.packages = overrides.packages;
  }
  if (overrides.workspace_setup) {
    const cmds = Array.isArray(overrides.workspace_setup)
      ? overrides.workspace_setup
      : [overrides.workspace_setup];
    base.workspace = { setup: cmds.map((run) => ({ run })) };
  }
  return base;
}

function createAgent(configure?: string | string[]): AgentConfig {
  const agent: AgentConfig = {
    version: 'v1',
    name: 'test-agent',
    description: 'A test agent',
    install: { source: { type: 'local' } },
    entrypoint: { command: 'run-agent' },
    interaction: { mode: 'direct' },
  };
  if (configure) {
    const cmds = Array.isArray(configure) ? configure : [configure];
    agent.install.configure = cmds.map((run) => ({ run }));
  }
  return agent;
}

describe('resolveEnvironment (substrate-only)', () => {
  describe('base image resolution', () => {
    it('uses DEFAULT_BASE_IMAGE when no base specified', () => {
      const result = resolveEnvironment(createExperiment(), createAgent());
      expect(result.baseImage).toBe(DEFAULT_BASE_IMAGE);
    });

    it('uses experiment base when specified', () => {
      const result = resolveEnvironment(
        createExperiment({ base: 'custom/image:latest' }),
        createAgent(),
      );
      expect(result.baseImage).toBe('custom/image:latest');
    });
  });

  describe('substrate runtimes', () => {
    it('uses default substrate runtimes when none specified', () => {
      const result = resolveEnvironment(createExperiment(), createAgent());
      expect(result.runtimes.node).toBe('20');
      expect(result.runtimes.python).toBe('3.11');
    });

    it('experiment can override default substrate runtimes', () => {
      const result = resolveEnvironment(
        createExperiment({ runtimes: { node: '18' } }),
        createAgent(),
      );
      expect(result.runtimes.node).toBe('18');
      expect(result.runtimes.python).toBe('3.11');
    });

    it('experiment can add a substrate runtime not in defaults', () => {
      const result = resolveEnvironment(
        createExperiment({ runtimes: { go: '1.21' } }),
        createAgent(),
      );
      expect(result.runtimes.go).toBe('1.21');
    });

    it('agent never contributes substrate runtimes (sealed closure)', () => {
      // The agent type no longer has a runtime field; ensure that adding a
      // configure step does not leak anything into resolved runtimes.
      const result = resolveEnvironment(
        createExperiment(),
        createAgent('echo configured'),
      );
      expect(Object.keys(result.runtimes)).toEqual(['node', 'python']);
    });
  });

  describe('substrate packages', () => {
    it('takes packages from the experiment alone', () => {
      const result = resolveEnvironment(
        createExperiment({
          packages: { apt: ['git', 'curl'], npm: ['typescript'], pip: ['pytest'] },
        }),
        createAgent(),
      );
      expect(result.packages.apt).toEqual(['git', 'curl']);
      expect(result.packages.npm).toEqual(['typescript']);
      expect(result.packages.pip).toEqual(['pytest']);
    });

    it('returns empty arrays when no packages declared', () => {
      const result = resolveEnvironment(createExperiment(), createAgent());
      expect(result.packages.apt).toEqual([]);
      expect(result.packages.npm).toEqual([]);
      expect(result.packages.pip).toEqual([]);
    });
  });

  describe('setup resolution', () => {
    it('collects workspace.setup[].run commands', () => {
      const result = resolveEnvironment(
        createExperiment({ workspace_setup: 'npm install' }),
        createAgent(),
      );
      expect(result.experimentSetup).toEqual([{ run: 'npm install' }]);
    });

    it('collects multiple workspace.setup commands in order', () => {
      const result = resolveEnvironment(
        createExperiment({ workspace_setup: ['npm install', 'npm run build'] }),
        createAgent(),
      );
      expect(result.experimentSetup).toEqual([
        { run: 'npm install' },
        { run: 'npm run build' },
      ]);
    });

    it('collects agent install.configure commands', () => {
      const result = resolveEnvironment(
        createExperiment(),
        createAgent('echo "Agent ready"'),
      );
      expect(result.agentConfigure).toEqual([{ run: 'echo "Agent ready"' }]);
    });

    it('works without the agent argument', () => {
      const result = resolveEnvironment(createExperiment());
      expect(result.agentConfigure).toBeUndefined();
    });
  });
});

describe('generatePackageInstallCommands', () => {
  it('generates apt install command', () => {
    const commands = generatePackageInstallCommands({
      apt: ['git', 'curl'],
      npm: [],
      pip: [],
    });
    expect(commands).toContain('apt-get update && apt-get install -y git curl');
  });

  it('generates npm install command', () => {
    const commands = generatePackageInstallCommands({
      apt: [],
      npm: ['typescript', 'eslint'],
      pip: [],
    });
    expect(commands).toContain('npm install -g typescript eslint');
  });

  it('generates pip install command', () => {
    const commands = generatePackageInstallCommands({
      apt: [],
      npm: [],
      pip: ['anthropic', 'openai'],
    });
    expect(commands).toContain('pip install anthropic openai');
  });

  it('returns empty array when no packages', () => {
    expect(generatePackageInstallCommands({ apt: [], npm: [], pip: [] })).toEqual([]);
  });
});

describe('hasPackageRequirements', () => {
  it('returns false when no packages', () => {
    expect(
      hasPackageRequirements({
        baseImage: 'test',
        runtimes: {},
        packages: { apt: [], npm: [], pip: [] },
      }),
    ).toBe(false);
  });

  it('returns true when apt packages present', () => {
    expect(
      hasPackageRequirements({
        baseImage: 'test',
        runtimes: {},
        packages: { apt: ['git'], npm: [], pip: [] },
      }),
    ).toBe(true);
  });

  it('returns true when npm packages present', () => {
    expect(
      hasPackageRequirements({
        baseImage: 'test',
        runtimes: {},
        packages: { apt: [], npm: ['typescript'], pip: [] },
      }),
    ).toBe(true);
  });

  it('returns true when pip packages present', () => {
    expect(
      hasPackageRequirements({
        baseImage: 'test',
        runtimes: {},
        packages: { apt: [], npm: [], pip: ['anthropic'] },
      }),
    ).toBe(true);
  });
});
