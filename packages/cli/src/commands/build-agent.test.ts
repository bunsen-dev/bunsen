// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const coreMocks = vi.hoisted(() => ({
  parseAgentVariantSyntax: vi.fn(),
  resolveAgent: vi.fn(),
  describeSearchedLocations: vi.fn(),
  loadAgent: vi.fn(),
  resolveAgentSource: vi.fn(),
  buildAgentArtifacts: vi.fn(),
}));

vi.mock('@bunsen-dev/runtime', () => coreMocks);

vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    fail: vi.fn(),
    text: '',
  }),
}));

import { buildAgentCommand } from './build-agent.js';

describe('buildAgentCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    coreMocks.parseAgentVariantSyntax.mockReturnValue(['claude-code', undefined]);
    coreMocks.resolveAgent.mockReturnValue({ path: '/tmp/agent' });
    coreMocks.loadAgent.mockReturnValue({
      name: 'claude-code',
      install: { source: { type: 'local' } },
      entrypoint: { command: 'claude', args: [] },
      interaction: { mode: 'supervised' },
      path: '/tmp/agent',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints JSON metadata when build succeeds', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-cli-build-agent-test-'));
    const metadataPath = path.join(tempDir, 'metadata.json');
    fs.writeFileSync(metadataPath, JSON.stringify({ cacheKey: 'abc123' }, null, 2));

    coreMocks.buildAgentArtifacts.mockResolvedValue({
      artifactsPath: tempDir,
      deps: [],
      platform: 'linux/amd64',
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await buildAgentCommand('claude-code', { format: 'json', rebuild: true, platform: 'linux/amd64' });

    expect(coreMocks.buildAgentArtifacts).toHaveBeenCalledTimes(1);
    expect(coreMocks.buildAgentArtifacts.mock.calls[0][1]).toMatchObject({
      baseDir: process.cwd(),
      platform: 'linux/amd64',
      rebuild: true,
    });

    const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
    const payload = JSON.parse(output);
    expect(payload).toMatchObject({
      agent: 'claude-code',
      built: true,
      artifactsPath: tempDir,
      metadata: { cacheKey: 'abc123' },
      deps: [],
    });

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('prints JSON reason when agent has neither install.deps nor install.build', async () => {
    coreMocks.buildAgentArtifacts.mockResolvedValue(null);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await buildAgentCommand('claude-code', { format: 'json' });

    const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
    const payload = JSON.parse(output);
    expect(payload).toMatchObject({
      agent: 'claude-code',
      built: false,
      reason: 'Agent defines neither install.deps nor install.build',
    });
  });

  it('prints deps even when there is no install.build', async () => {
    coreMocks.buildAgentArtifacts.mockResolvedValue({
      deps: [
        {
          name: 'ripgrep',
          version: '14.1.1',
          cacheKey: 'abc123',
          artifactsPath: '/tmp/deps/ripgrep-abc123',
          cacheHit: false,
          binaries: ['rg'],
        },
      ],
      platform: 'linux/arm64',
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await buildAgentCommand('claude-code', { format: 'json' });

    const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
    const payload = JSON.parse(output);
    expect(payload).toMatchObject({
      agent: 'claude-code',
      built: true,
      deps: [
        {
          name: 'ripgrep',
          version: '14.1.1',
          cacheKey: 'abc123',
          binaries: ['rg'],
        },
      ],
    });
    expect(payload.artifactsPath).toBeUndefined();
  });
});
