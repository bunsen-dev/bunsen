// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for the runtime contract surface — stable paths and reserved
 * `BUNSEN_*` env vars the agent may rely on.
 */

import { describe, it, expect } from 'vitest';
import {
  STABLE_PATHS,
  buildStablePathsMkdirScript,
  buildReservedEnv,
} from './runtime-contract.js';

describe('STABLE_PATHS', () => {
  it('uses the canonical /bunsen/* layout the design doc prescribes', () => {
    expect(STABLE_PATHS).toEqual({
      workspace: '/workspace',
      workspaceSource: '/workspace-source',
      taskDir: '/bunsen/task',
      taskFile: '/bunsen/task/prompt.md',
      outputDir: '/bunsen/output',
      runDir: '/bunsen/run',
      verifiersDir: '/bunsen/verifiers',
      binDir: '/bunsen/bin',
      artifactsDir: '/bunsen/artifacts',
    });
  });
});

describe('buildStablePathsMkdirScript', () => {
  it('creates every platform-owned dir that is not bind-mounted', () => {
    const script = buildStablePathsMkdirScript();
    expect(script).toContain('/bunsen/task');
    expect(script).toContain('/bunsen/output');
    expect(script).toContain('/bunsen/run');
    expect(script).toContain('/bunsen/bin');
    expect(script.startsWith('mkdir -p ')).toBe(true);
  });

  it('does not mkdir workspace paths (they are workspace-assembly territory)', () => {
    const script = buildStablePathsMkdirScript();
    expect(script).not.toMatch(/\/workspace(\s|$)/);
    expect(script).not.toContain('/workspace-source');
  });

  it('does not mkdir bind-mount targets (artifacts, verifiers)', () => {
    const script = buildStablePathsMkdirScript();
    expect(script).not.toContain('/bunsen/artifacts');
    expect(script).not.toContain('/bunsen/verifiers');
  });
});

describe('buildReservedEnv', () => {
  it('populates every required user-contract BUNSEN_* var', () => {
    const env = buildReservedEnv({
      runId: 'run-abc',
      experimentName: 'fix-bug',
      agentName: 'claude-code',
      platform: 'linux/amd64',
    });
    expect(env).toMatchObject({
      BUNSEN_RUN_ID: 'run-abc',
      BUNSEN_EXPERIMENT: 'fix-bug',
      BUNSEN_AGENT: 'claude-code',
      BUNSEN_WORKSPACE_DIR: '/workspace',
      BUNSEN_WORKSPACE_SOURCE_DIR: '/workspace-source',
      BUNSEN_OUTPUT_DIR: '/bunsen/output',
      BUNSEN_TASK_FILE: '/bunsen/task/prompt.md',
      BUNSEN_TASK_DIR: '/bunsen/task',
      BUNSEN_RUN_DIR: '/bunsen/run',
      BUNSEN_AGENT_HOME: '/home/bunsen',
      BUNSEN_PLATFORM: 'linux/amd64',
    });
  });

  it('sets BUNSEN_AGENT_HOME to /root when requiresRoot is true', () => {
    const env = buildReservedEnv({
      runId: 'r',
      experimentName: 'e',
      agentName: 'a',
      platform: 'linux/amd64',
      requiresRoot: true,
    });
    expect(env.BUNSEN_AGENT_HOME).toBe('/root');
  });

  it('sets BUNSEN_AGENT_HOME to /home/bunsen when requiresRoot is false or omitted', () => {
    const omitted = buildReservedEnv({
      runId: 'r',
      experimentName: 'e',
      agentName: 'a',
      platform: 'linux/amd64',
    });
    const explicit = buildReservedEnv({
      runId: 'r',
      experimentName: 'e',
      agentName: 'a',
      platform: 'linux/amd64',
      requiresRoot: false,
    });
    expect(omitted.BUNSEN_AGENT_HOME).toBe('/home/bunsen');
    expect(explicit.BUNSEN_AGENT_HOME).toBe('/home/bunsen');
  });

  it('every reserved key uses the BUNSEN_ prefix', () => {
    const env = buildReservedEnv({
      runId: 'r',
      experimentName: 'e',
      agentName: 'a',
      platform: 'linux/arm64',
      agentVariant: 'haiku',
      experimentVariant: 'hinted',
      suiteId: 'terminal-bench',
      suiteVersion: '1.0.0',
    });
    for (const key of Object.keys(env)) {
      expect(key.startsWith('BUNSEN_')).toBe(true);
    }
  });

  it('omits variant vars when not provided', () => {
    const env = buildReservedEnv({
      runId: 'r',
      experimentName: 'e',
      agentName: 'a',
      platform: 'linux/amd64',
    });
    expect(env.BUNSEN_EXPERIMENT_VARIANT).toBeUndefined();
    expect(env.BUNSEN_AGENT_VARIANT).toBeUndefined();
  });

  it('sets BUNSEN_EXPERIMENT_VARIANT and BUNSEN_AGENT_VARIANT independently', () => {
    const onlyAgent = buildReservedEnv({
      runId: 'r',
      experimentName: 'e',
      agentName: 'a',
      platform: 'linux/amd64',
      agentVariant: 'fast',
    });
    expect(onlyAgent.BUNSEN_AGENT_VARIANT).toBe('fast');
    expect(onlyAgent.BUNSEN_EXPERIMENT_VARIANT).toBeUndefined();

    const onlyExperiment = buildReservedEnv({
      runId: 'r',
      experimentName: 'e',
      agentName: 'a',
      platform: 'linux/amd64',
      experimentVariant: 'hard',
    });
    expect(onlyExperiment.BUNSEN_EXPERIMENT_VARIANT).toBe('hard');
    expect(onlyExperiment.BUNSEN_AGENT_VARIANT).toBeUndefined();
  });

  it('omits suite vars when not provided', () => {
    const env = buildReservedEnv({
      runId: 'r',
      experimentName: 'e',
      agentName: 'a',
      platform: 'linux/amd64',
    });
    expect(env.BUNSEN_SUITE_ID).toBeUndefined();
    expect(env.BUNSEN_SUITE_VERSION).toBeUndefined();
  });

  it('sets suite vars when provided', () => {
    const env = buildReservedEnv({
      runId: 'r',
      experimentName: 'e',
      agentName: 'a',
      platform: 'linux/amd64',
      suiteId: 'terminal-bench',
      suiteVersion: 'abc123',
    });
    expect(env.BUNSEN_SUITE_ID).toBe('terminal-bench');
    expect(env.BUNSEN_SUITE_VERSION).toBe('abc123');
  });
});
