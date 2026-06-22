// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for container utilities
 */

import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getAssetDir,
  getAddonScriptPath,
  getPricingDataPath,
  getProxyEnv,
  PROXY_BOOTSTRAP_CONTAINER_PATH,
  BUNSEN_LABEL,
  BUNSEN_RUN_ID_LABEL,
  BUNSEN_COMPONENT_LABEL,
  ExecTimeoutError,
  execInContainer,
  createPersistentContainer,
  normalizeDockerArch,
  archToRunPlatform,
  normalizeRunPlatform,
  runPlatformToArch,
  getNodeRuntimePath,
  type ProxyContainerInfo,
} from './container.js';

// Capture the args passed to docker.createContainer so we can assert on the
// HostConfig that createPersistentContainer builds, without a real daemon.
const { createContainerMock } = vi.hoisted(() => ({ createContainerMock: vi.fn() }));
vi.mock('dockerode', () => ({
  default: vi.fn(() => ({ createContainer: createContainerMock })),
}));

describe('getAssetDir', () => {
  const original = process.env.BUNSEN_ASSET_DIR;
  afterEach(() => {
    if (original === undefined) delete process.env.BUNSEN_ASSET_DIR;
    else process.env.BUNSEN_ASSET_DIR = original;
  });

  it('defaults to an absolute `assets` dir beside the executing module', () => {
    delete process.env.BUNSEN_ASSET_DIR;
    const dir = getAssetDir();
    expect(path.isAbsolute(dir)).toBe(true);
    expect(path.basename(dir)).toBe('assets');
  });

  it('honors the BUNSEN_ASSET_DIR override verbatim (Bun-binary embed root)', () => {
    process.env.BUNSEN_ASSET_DIR = '/some/embed/root';
    expect(getAssetDir()).toBe('/some/embed/root');
  });

  it('falls back to the default when the override is empty or whitespace', () => {
    process.env.BUNSEN_ASSET_DIR = '   ';
    expect(path.basename(getAssetDir())).toBe('assets');
  });

  it('is the parent of the proxy asset directory the resolvers use', () => {
    delete process.env.BUNSEN_ASSET_DIR;
    // getAddonScriptPath resolves <assetDir>/proxy/ai_capture.py
    expect(getAddonScriptPath()).toBe(path.join(getAssetDir(), 'proxy', 'ai_capture.py'));
  });
});

describe('getAddonScriptPath', () => {
  it('returns path to ai_capture.py', () => {
    const addonPath = getAddonScriptPath();
    expect(addonPath).toContain('proxy');
    expect(addonPath).toContain('ai_capture.py');
  });

  it('returns absolute path', () => {
    const addonPath = getAddonScriptPath();
    expect(path.isAbsolute(addonPath)).toBe(true);
  });
});

describe('getPricingDataPath', () => {
  it('returns the model_prices.json snapshot beside the addon script', () => {
    const pricingPath = getPricingDataPath();
    expect(pricingPath).toContain('proxy');
    expect(pricingPath).toContain('model_prices.json');
    expect(path.isAbsolute(pricingPath)).toBe(true);
    // It must be a sibling of the addon so the container mount logic holds.
    expect(path.dirname(pricingPath)).toBe(path.dirname(getAddonScriptPath()));
  });

  it('derives the snapshot from a supplied addon path', () => {
    const pricingPath = getPricingDataPath('/some/dir/ai_capture.py');
    expect(pricingPath).toBe(path.join('/some/dir', 'model_prices.json'));
  });
});

describe('bunsen container labels', () => {
  it('BUNSEN_LABEL is "bunsen"', () => {
    expect(BUNSEN_LABEL).toBe('bunsen');
  });

  it('BUNSEN_RUN_ID_LABEL is "bunsen.run-id"', () => {
    expect(BUNSEN_RUN_ID_LABEL).toBe('bunsen.run-id');
  });

  it('BUNSEN_COMPONENT_LABEL is "bunsen.component"', () => {
    expect(BUNSEN_COMPONENT_LABEL).toBe('bunsen.component');
  });
});

describe('platform helpers', () => {
  it('normalizes Docker arch aliases', () => {
    expect(normalizeDockerArch('amd64')).toBe('amd64');
    expect(normalizeDockerArch('x86_64')).toBe('amd64');
    expect(normalizeDockerArch('arm64')).toBe('arm64');
    expect(normalizeDockerArch('aarch64')).toBe('arm64');
  });

  it('maps between arch and run platform', () => {
    expect(archToRunPlatform('amd64')).toBe('linux/amd64');
    expect(archToRunPlatform('arm64')).toBe('linux/arm64');
    expect(runPlatformToArch('linux/amd64')).toBe('amd64');
    expect(runPlatformToArch('linux/arm64')).toBe('arm64');
  });

  it('normalizes bare and full platform strings', () => {
    expect(normalizeRunPlatform('amd64')).toBe('linux/amd64');
    expect(normalizeRunPlatform('linux/arm64')).toBe('linux/arm64');
  });

  it('rejects unsupported run platforms', () => {
    expect(() => normalizeRunPlatform('linux/s390x')).toThrow('Unsupported run platform');
  });
});

describe('getNodeRuntimePath', () => {
  it('returns the amd64 runtime path for amd64 inputs', () => {
    expect(getNodeRuntimePath('amd64')).toContain('node-linux-x64');
    expect(getNodeRuntimePath('linux/amd64')).toContain('node-linux-x64');
  });

  it('returns the arm64 runtime path for arm64 inputs', () => {
    expect(getNodeRuntimePath('arm64')).toContain('node-linux-arm64');
    expect(getNodeRuntimePath('linux/arm64')).toContain('node-linux-arm64');
  });
});

describe('ExecTimeoutError', () => {
  it('preserves partial exec output for callers', async () => {
    const stream = new EventEmitter();
    const exec = {
      start: vi.fn().mockResolvedValue(stream),
      inspect: vi.fn().mockResolvedValue({ ExitCode: null }),
    };
    const container = {
      exec: vi.fn().mockResolvedValue(exec),
      modem: {
        demuxStream: vi.fn((_stream, stdoutTarget, stderrTarget) => {
          stdoutTarget.write(Buffer.from('partial stdout'));
          stderrTarget.write(Buffer.from('partial stderr'));
        }),
      },
    };

    const error = await execInContainer(
      { container, id: 'test-container' } as never,
      ['sleep', 'infinity'],
      { timeout: 10 }
    ).then(
      () => { throw new Error('expected timeout'); },
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ExecTimeoutError);
    expect(error).toMatchObject({
      message: 'Exec timed out after 10ms',
      stdout: 'partial stdout',
      stderr: 'partial stderr',
      timeoutMs: 10,
    });

    expect(container.exec).toHaveBeenCalledOnce();
    expect(exec.inspect).not.toHaveBeenCalled();
  });
});

describe('writeFileInContainer', () => {
  // writeFileInContainer uses base64 encoding to safely write content into containers.
  // We test the encoding logic directly since calling the function requires a real Docker container.

  it('generates base64 output with only safe characters', () => {
    const content = 'echo `whoami` && echo $HOME && echo "hello \'world\'"';
    const encoded = Buffer.from(content, 'utf-8').toString('base64');

    // Verify the base64 output contains no shell-sensitive characters
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(encoded).not.toContain('`');
    expect(encoded).not.toContain('$');
    expect(encoded).not.toContain("'");
    expect(encoded).not.toContain('"');
  });

  it('base64 roundtrip preserves content with backticks', () => {
    const content = 'Run `npm install` and then `npm test`';
    const encoded = Buffer.from(content, 'utf-8').toString('base64');
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    expect(decoded).toBe(content);
  });

  it('base64 roundtrip preserves content with dollar signs', () => {
    const content = 'echo $HOME && echo ${PATH} && cost is $5.00';
    const encoded = Buffer.from(content, 'utf-8').toString('base64');
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    expect(decoded).toBe(content);
  });

  it('base64 roundtrip preserves content with quotes', () => {
    const content = `She said "hello" and 'goodbye' and \\"escaped\\"`;
    const encoded = Buffer.from(content, 'utf-8').toString('base64');
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    expect(decoded).toBe(content);
  });

  it('base64 roundtrip preserves heredoc delimiters', () => {
    const content = `cat > /tmp/file << 'EOF'\nhello world\nEOF`;
    const encoded = Buffer.from(content, 'utf-8').toString('base64');
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    expect(decoded).toBe(content);
  });

  it('base64 roundtrip preserves unicode characters', () => {
    const content = 'Hello \u{1F525}\u{1F9EA} Bunsen! \u00C9t\u00E9 caf\u00E9 \u00FC\u00F6\u00E4';
    const encoded = Buffer.from(content, 'utf-8').toString('base64');
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    expect(decoded).toBe(content);
  });

  it('base64 roundtrip preserves newlines and empty lines', () => {
    const content = 'line1\n\nline3\n\n\nline6\n';
    const encoded = Buffer.from(content, 'utf-8').toString('base64');
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    expect(decoded).toBe(content);
  });

  it('base64 roundtrip preserves complex shell script content', () => {
    const content = `#!/bin/bash
export HOME=/home/bunsen
export PATH=$HOME/.local/bin:$PATH

# Run the agent with backtick-containing task
/agent/run.sh "Fix the bug where \`parse_args()\` fails with $undefined variables"
EXIT_CODE=$?
echo $EXIT_CODE > /bunsen/run/marker
`;
    const encoded = Buffer.from(content, 'utf-8').toString('base64');
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    expect(decoded).toBe(content);
    // Verify no shell-sensitive chars in encoded form
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('generates correct shell command structure', () => {
    // Verify the command that writeFileInContainer would generate
    const content = 'test content';
    const encoded = Buffer.from(content, 'utf-8').toString('base64');
    const filePath = '/bunsen/bin/test-script';
    const dir = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
    const mode = '755';

    const expectedCmd = `mkdir -p '${dir}' && echo '${encoded}' | base64 -d > '${filePath}' && chmod ${mode} '${filePath}'`;

    expect(expectedCmd).toContain("mkdir -p '/bunsen/bin'");
    expect(expectedCmd).toContain(`echo '${encoded}'`);
    expect(expectedCmd).toContain('base64 -d');
    expect(expectedCmd).toContain("chmod 755 '/bunsen/bin/test-script'");
  });

  it('uses default mode 644 and handles directory extraction', () => {
    const filePath = '/tmp/workspace-setup.sh';
    const dir = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
    expect(dir).toBe('/tmp');

    const rootFilePath = '/test';
    const rootDir = rootFilePath.substring(0, rootFilePath.lastIndexOf('/')) || '/';
    expect(rootDir).toBe('/');
  });
});

describe('createPersistentContainer HostConfig', () => {
  it('sets no-new-privileges to block setuid escalation inside the container', async () => {
    createContainerMock.mockReset();
    createContainerMock.mockResolvedValue({
      id: 'mock-container-id',
      start: vi.fn().mockResolvedValue(undefined),
    });

    await createPersistentContainer({ image: 'bunsen/headless', mounts: [] });

    expect(createContainerMock).toHaveBeenCalledOnce();
    const config = createContainerMock.mock.calls[0][0];
    expect(config.HostConfig.SecurityOpt).toEqual(['no-new-privileges']);
  });
});

describe('getProxyEnv', () => {
  const proxyInfo: ProxyContainerInfo = {
    container: {} as never,
    networkName: 'bunsen-net',
    proxyHost: 'bunsen-proxy',
    proxyPort: 8080,
    certsDir: '/tmp/bunsen-certs',
    hostPort: 8080,
  };

  it('sets the standard HTTP proxy + CA env vars', () => {
    const env = getProxyEnv(proxyInfo);
    expect(env.HTTP_PROXY).toBe('http://bunsen-proxy:8080');
    expect(env.HTTPS_PROXY).toBe('http://bunsen-proxy:8080');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/mitmproxy-certs/mitmproxy-ca-cert.pem');
  });

  it('injects --require=<bootstrap> into NODE_OPTIONS', () => {
    const env = getProxyEnv(proxyInfo);
    expect(env.NODE_OPTIONS).toBe(`--require=${PROXY_BOOTSTRAP_CONTAINER_PATH}`);
  });

  it('preserves a user-set NODE_OPTIONS by prepending the require flag', () => {
    const env = getProxyEnv(proxyInfo, { NODE_OPTIONS: '--max-old-space-size=4096' });
    expect(env.NODE_OPTIONS).toBe(
      `--require=${PROXY_BOOTSTRAP_CONTAINER_PATH} --max-old-space-size=4096`,
    );
  });

  it('ignores empty existing NODE_OPTIONS', () => {
    const env = getProxyEnv(proxyInfo, { NODE_OPTIONS: '   ' });
    expect(env.NODE_OPTIONS).toBe(`--require=${PROXY_BOOTSTRAP_CONTAINER_PATH}`);
  });
});
