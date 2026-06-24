// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Docker container execution via dockerode
 */

import Docker from 'dockerode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import type {
  ContainerOptions,
  ContainerMount,
  RunPlatform,
} from '@bunsen-dev/types';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Root directory for runtime assets that must live on the host filesystem so
 * they can be mounted into (or copied into) containers: the platform-agent
 * `.cjs` bundles, the proxy addon + pricing snapshot, the bunsen base-image
 * Dockerfiles, and (when shipped) the per-platform Node runtimes.
 *
 * Every asset resolver below resolves under this *single* directory, so the
 * layout is identical across every way Bunsen is distributed:
 *
 *   - Published npm `@bunsen-dev/cli`: the CLI build copies all assets to
 *     `dist/assets/`, which sits beside the executing `dist/bin.js`.
 *   - Monorepo dev (`pnpm bn`): same — `pnpm bn` runs the bundled
 *     `packages/cli/dist/bin.js`, so its assets are at `dist/assets/` too.
 *   - Bun single-binary (future): embeds the assets and points
 *     `BUNSEN_ASSET_DIR` at the embed root.
 *
 * The default is computed relative to this module via `import.meta.url`. When
 * the CLI is bundled with esbuild, `import.meta.url` rewrites to the *output*
 * bundle's URL, so the resolver follows the code wherever it lands rather than
 * pointing back at the monorepo source tree. `BUNSEN_ASSET_DIR` overrides it
 * for embedded/relocated installs.
 */
export function getAssetDir(): string {
  const override = process.env.BUNSEN_ASSET_DIR;
  if (override && override.trim()) return override;
  return path.join(__dirname, 'assets');
}

const docker = new Docker();

// ============================================================================
// Bunsen Container Labels
// ============================================================================

export const BUNSEN_LABEL = 'bunsen';
export const BUNSEN_RUN_ID_LABEL = 'bunsen.run-id';
export const BUNSEN_COMPONENT_LABEL = 'bunsen.component';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
/**
 * Pinned mitmproxy sidecar image. Pinned (not `:latest`) so an upstream breaking
 * release can't silently land on a user's next pull and break trace capture.
 * `12.2.3` is the current stable line — the version `:latest` already resolved
 * to, so the addon (`src/proxy/ai_capture.py`, which uses mitmproxy's stable
 * request/response hooks) has been running on it in practice; pinning just
 * freezes it. Surfaced by `bn doctor`; bump deliberately and re-test
 * `ai_capture_test.py` against the new line.
 */
export const MITMPROXY_IMAGE = 'mitmproxy/mitmproxy:12.2.3';
const PROXY_PORT = 8080;

const SUPPORTED_RUN_PLATFORMS = new Set<RunPlatform>(['linux/amd64', 'linux/arm64']);

export function normalizeDockerArch(arch: string): 'amd64' | 'arm64' {
  const normalized = arch.toLowerCase();
  if (normalized === 'arm64' || normalized === 'aarch64') {
    return 'arm64';
  }
  if (normalized === 'amd64' || normalized === 'x86_64' || normalized === 'x64') {
    return 'amd64';
  }
  throw new Error(
    `Unsupported Docker architecture "${arch}". Expected one of: amd64, arm64.`
  );
}

export function archToRunPlatform(arch: string): RunPlatform {
  return `linux/${normalizeDockerArch(arch)}`;
}

export function runPlatformToArch(platform: RunPlatform): 'amd64' | 'arm64' {
  return platform.split('/')[1] as 'amd64' | 'arm64';
}

export function normalizeRunPlatform(platform: string): RunPlatform {
  const normalized = platform.trim().toLowerCase();
  const candidate = normalized.includes('/') ? normalized : `linux/${normalized}`;
  if (SUPPORTED_RUN_PLATFORMS.has(candidate as RunPlatform)) {
    return candidate as RunPlatform;
  }
  throw new Error(
    `Unsupported run platform "${platform}". Expected linux/amd64 or linux/arm64.`
  );
}

export async function inspectImagePlatform(imageName: string): Promise<RunPlatform | undefined> {
  try {
    const inspect = await docker.getImage(imageName).inspect();
    const osName = typeof inspect.Os === 'string' ? inspect.Os : 'linux';
    const arch = inspect.Architecture;
    if (typeof arch !== 'string') {
      return undefined;
    }
    return normalizeRunPlatform(`${osName}/${normalizeDockerArch(arch)}`);
  } catch {
    return undefined;
  }
}

function formatDockerProgressEvent(event: {
  stream?: string;
  status?: string;
  progress?: string;
  id?: string;
}): string | undefined {
  if (event.stream) {
    return event.stream;
  }

  if (!event.status) {
    return undefined;
  }

  const prefix = event.id ? `${event.id}: ` : '';
  return event.progress
    ? `${prefix}${event.status} ${event.progress}`
    : `${prefix}${event.status}`;
}

/**
 * Build a Docker image from a Dockerfile
 */
export async function buildImage(
  dockerfilePath: string,
  imageName: string,
  onProgress?: (message: string) => void,
  platform?: RunPlatform
): Promise<void> {
  const contextPath = path.dirname(dockerfilePath);

  const stream = await docker.buildImage(
    {
      context: contextPath,
      src: ['.'],
    },
    {
      t: imageName,
      dockerfile: path.basename(dockerfilePath),
      ...(platform ? { platform } : {}),
    }
  );

  return new Promise((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      },
      (event: { stream?: string; status?: string; progress?: string; id?: string; error?: string }) => {
        if (event.error) {
          reject(new Error(event.error));
        } else if (onProgress) {
          const message = formatDockerProgressEvent(event);
          if (message) {
            onProgress(message);
          }
        }
      }
    );
  });
}

/**
 * Check if a Docker image exists locally
 */
export async function imageExists(imageName: string): Promise<boolean> {
  try {
    await docker.getImage(imageName).inspect();
    return true;
  } catch {
    return false;
  }
}

/**
 * Pull a Docker image if not present locally
 */
export async function ensureImage(
  imageName: string,
  onProgress?: (message: string) => void,
  platform?: RunPlatform
): Promise<void> {
  const existingPlatform = await inspectImagePlatform(imageName);
  if (existingPlatform && (!platform || existingPlatform === platform)) {
    return;
  }

  try {
    const stream = await docker.pull(imageName, platform ? { platform } : undefined);

    return new Promise((resolve, reject) => {
      docker.modem.followProgress(
        stream,
        (err: Error | null) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        },
        (event: { stream?: string; status?: string; progress?: string; id?: string }) => {
          if (onProgress) {
            const message = formatDockerProgressEvent(event);
            if (message) {
              onProgress(message);
            }
          }
        }
      );
    });
  } catch (err) {
    if (existingPlatform && platform && existingPlatform !== platform) {
      throw new Error(
        `Image "${imageName}" is available locally as ${existingPlatform}, but the resolved run platform is ${platform}. ` +
        `Pull or build a compatible image, or rerun with a matching --platform.`
      );
    }
    throw err;
  }
}

/**
 * Run setup commands on a base image to create a prepared image
 */
export async function prepareImage(
  baseImage: string,
  setupCommands: string[],
  targetImageName: string,
  onProgress?: (message: string) => void,
  platform?: RunPlatform
): Promise<void> {
  if (setupCommands.length === 0) {
    // No setup needed, just tag the base image
    const baseImageObj = docker.getImage(baseImage);
    await baseImageObj.tag({ repo: targetImageName.split(':')[0], tag: targetImageName.split(':')[1] || 'latest' });
    return;
  }

  // Run setup commands and commit the result
  const container = await docker.createContainer({
    Image: baseImage,
    Cmd: ['/bin/bash', '-c', setupCommands.join(' && ')],
    Tty: false,
    ...(platform ? { Platform: platform } : {}),
  });

  try {
    const stream = await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    });

    if (onProgress) {
      stream.on('data', (chunk: Buffer) => {
        onProgress(chunk.toString());
      });
    }

    await container.start();
    const result = await container.wait();

    if (result.StatusCode !== 0) {
      throw new Error(`Setup commands failed with exit code ${result.StatusCode}`);
    }

    // Commit the container as the target image
    const [repo, tag] = targetImageName.includes(':')
      ? targetImageName.split(':')
      : [targetImageName, 'latest'];

    await container.commit({
      repo,
      tag,
    });
  } finally {
    try {
      await container.remove({ force: true });
    } catch {
      // Ignore removal errors
    }
  }
}

/**
 * Get Docker version and architecture info
 */
export async function getDockerInfo(): Promise<{ version: string; apiVersion: string; arch: string }> {
  const version = await docker.version();
  return {
    version: version.Version,
    apiVersion: version.ApiVersion,
    arch: version.Arch,
  };
}

/**
 * Check if Docker is available
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Network Management
// ============================================================================

/**
 * Create a Docker network for a run
 */
export async function createNetwork(name: string, labels?: Record<string, string>): Promise<Docker.Network> {
  return docker.createNetwork({
    Name: name,
    Driver: 'bridge',
    Labels: labels,
  });
}

/**
 * Remove a Docker network
 */
export async function removeNetwork(name: string): Promise<void> {
  try {
    const network = docker.getNetwork(name);
    await network.remove();
  } catch {
    // Ignore errors (network may not exist)
  }
}

// ============================================================================
// Proxy Container Management
// ============================================================================

export interface ProxyContainerInfo {
  container: Docker.Container;
  networkName: string;
  proxyHost: string;
  proxyPort: number;
  certsDir: string;
  hostPort: number;
}

/**
 * Start the mitmproxy container for AI trace capture
 */
export async function startProxyContainer(
  runId: string,
  addonScriptPath: string,
  tracesOutputDir: string,
  onProgress?: (message: string) => void
): Promise<ProxyContainerInfo> {
  const networkName = `bunsen-net-${runId}`;
  const containerName = `bunsen-proxy-${runId}`;

  // Ensure mitmproxy image exists
  onProgress?.('Ensuring mitmproxy image exists...');
  await ensureImage(MITMPROXY_IMAGE, onProgress);

  // Create network for this run
  onProgress?.(`Creating network ${networkName}...`);
  const networkLabels = {
    [BUNSEN_LABEL]: 'true',
    [BUNSEN_RUN_ID_LABEL]: runId,
    [BUNSEN_COMPONENT_LABEL]: 'network',
  };
  await createNetwork(networkName, networkLabels);

  // Ensure traces directory exists
  fs.mkdirSync(tracesOutputDir, { recursive: true });

  // Create a temp directory for mitmproxy certs (shared with agent container during run)
  // These are ephemeral and don't need to be persisted with run artifacts
  const certsDir = fs.mkdtempSync(path.join(os.tmpdir(), `bunsen-certs-${runId}-`));

  // Find an available host port for the proxy
  const hostPort = 18080 + Math.floor(Math.random() * 1000);

  // Start mitmproxy container
  onProgress?.('Starting proxy container...');
  const container = await docker.createContainer({
    name: containerName,
    Image: MITMPROXY_IMAGE,
    Cmd: [
      'mitmdump',
      '-s',
      '/addon/ai_capture.py',
      '--set',
      `output_file=/traces/agent.jsonl`,
      '--set',
      'confdir=/certs',
      '--listen-host',
      '0.0.0.0',
      '--listen-port',
      String(PROXY_PORT),
      // Allow self-signed certs for upstream (not needed for AI providers but good for flexibility)
      '--ssl-insecure',
      // Docker Desktop 4.69 / Engine 29 SNATs some container→host-port connections
      // with the upstream destination IP (observed: api.anthropic.com / 160.79.104.10),
      // which mitmproxy's default block_global rejects. The proxy only listens on
      // a Docker-published port reachable from bunsen containers on this host, so
      // disabling the public-source guard is safe here.
      '--set',
      'block_global=false',
    ],
    ExposedPorts: {
      [`${PROXY_PORT}/tcp`]: {},
    },
    Labels: {
      [BUNSEN_LABEL]: 'true',
      [BUNSEN_RUN_ID_LABEL]: runId,
      [BUNSEN_COMPONENT_LABEL]: 'proxy',
    },
    HostConfig: {
      Binds: [
        `${path.resolve(addonScriptPath)}:/addon/ai_capture.py:ro`,
        // The vendored pricing snapshot ships beside the addon. Mount it so the
        // proxy prices captured calls fully offline (no runtime network); the
        // loader in ai_capture.py reads it from the addon's own directory.
        `${path.resolve(getPricingDataPath(addonScriptPath))}:/addon/model_prices.json:ro`,
        `${path.resolve(tracesOutputDir)}:/traces:rw`,
        `${path.resolve(certsDir)}:/certs:rw`,
      ],
      // Use bridge network so both proxy and agent can access the internet
      NetworkMode: 'bridge',
      // Expose proxy port on host so agent can reach it
      PortBindings: {
        [`${PROXY_PORT}/tcp`]: [{ HostPort: String(hostPort) }],
      },
    },
    Env: ['PYTHONUNBUFFERED=1'],
  });

  await container.start();

  // For agent containers to reach the proxy, use host.docker.internal (Mac/Windows)
  // or the Docker host gateway
  const proxyHost = 'host.docker.internal';

  // Wait for mitmproxy to generate its CA certificate
  onProgress?.('Waiting for proxy CA certificate...');
  const caCertPath = path.join(certsDir, 'mitmproxy-ca-cert.pem');
  let attempts = 0;
  while (!fs.existsSync(caCertPath) && attempts < 20) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    attempts++;
  }
  if (!fs.existsSync(caCertPath)) {
    throw new Error('Timed out waiting for mitmproxy CA certificate');
  }

  onProgress?.(`Proxy running at ${proxyHost}:${hostPort}`);

  return {
    container,
    networkName,
    proxyHost,
    proxyPort: hostPort, // Use the host port, not the container port
    certsDir,
    hostPort,
  };
}

/**
 * Stop and remove the proxy container and network
 */
export async function stopProxyContainer(proxyInfo: ProxyContainerInfo): Promise<void> {
  const { container, networkName, certsDir } = proxyInfo;

  try {
    // Stop and remove container
    await container.stop({ t: 5 });
  } catch {
    // Ignore stop errors (may already be stopped)
  }

  try {
    await container.remove({ force: true });
  } catch {
    // Ignore removal errors
  }

  // Remove network
  await removeNetwork(networkName);

  // Clean up temp certs directory
  try {
    fs.rmSync(certsDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Get proxy environment variables for a container.
 *
 * `existingEnv` is consulted only to preserve a user-set `NODE_OPTIONS`:
 * the proxy bootstrap's `--require` flag is *prepended* so the bootstrap
 * always runs, but any caller-supplied flags follow it untouched.
 */
export function getProxyEnv(
  proxyInfo: ProxyContainerInfo,
  existingEnv: Record<string, string> = {},
): Record<string, string> {
  const proxyUrl = `http://${proxyInfo.proxyHost}:${proxyInfo.proxyPort}`;
  // Bypass proxy for package registries and common infrastructure
  // We only want to intercept AI provider traffic
  const noProxyHosts = [
    'localhost',
    '127.0.0.1',
    // Python package registries
    'pypi.org',
    'files.pythonhosted.org',
    'pypi.python.org',
    // Node package registries
    'registry.npmjs.org',
    'registry.yarnpkg.com',
    // Other common registries
    'rubygems.org',
    'crates.io',
    // Claude Code installer + binary host
    'claude.ai',
    'storage.googleapis.com',
    // GitHub (for package downloads)
    'github.com',
    'raw.githubusercontent.com',
    'objects.githubusercontent.com',
  ].join(',');

  // Force native fetch / undici through the proxy. Node's built-in fetch
  // doesn't honor HTTPS_PROXY on its own, so without this require flag
  // SDKs like @anthropic-ai/sdk would open direct TLS connections and the
  // mitmproxy would never see the traffic.
  const requireFlag = `--require=${PROXY_BOOTSTRAP_CONTAINER_PATH}`;
  const existingNodeOpts = existingEnv.NODE_OPTIONS?.trim();
  const nodeOptions = existingNodeOpts
    ? `${requireFlag} ${existingNodeOpts}`
    : requireFlag;

  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: noProxyHosts,
    no_proxy: noProxyHosts,
    NODE_EXTRA_CA_CERTS: '/mitmproxy-certs/mitmproxy-ca-cert.pem',
    NODE_OPTIONS: nodeOptions,
  };
}

/**
 * Generate shell commands to inject the mitmproxy CA into the system trust store.
 * Supports Debian/Ubuntu, Alpine, and RHEL/CentOS/Fedora.
 */
export function getCAInjectionCommands(): string {
  // This script creates a combined CA bundle and injects the CA appropriately
  // Python's httpx/requests use certifi which ignores system CA stores, so we need
  // to create a combined bundle and set environment variables to use it.
  return `
# Install mitmproxy CA for transparent HTTPS interception
_install_ca() {
  local ca_cert="/mitmproxy-certs/mitmproxy-ca-cert.pem"
  local combined_bundle="/mitmproxy-certs/combined-ca-bundle.pem"

  if [ ! -f "$ca_cert" ]; then
    echo "[bunsen] Warning: CA certificate not found at $ca_cert" >&2
    return 0
  fi

  # Find existing CA bundle to combine with
  local existing_bundle=""
  # Check common locations for CA bundles
  for bundle in \\
    /etc/ssl/certs/ca-certificates.crt \\
    /etc/pki/tls/certs/ca-bundle.crt \\
    /etc/ssl/ca-bundle.pem \\
    /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem; do
    if [ -f "$bundle" ]; then
      existing_bundle="$bundle"
      break
    fi
  done

  # Also check Python's certifi bundle
  local certifi_bundle=""
  if command -v python3 >/dev/null 2>&1; then
    certifi_bundle=$(python3 -c "import certifi; print(certifi.where())" 2>/dev/null) || true
  elif command -v python >/dev/null 2>&1; then
    certifi_bundle=$(python -c "import certifi; print(certifi.where())" 2>/dev/null) || true
  fi

  # Prefer certifi bundle if available (most Python HTTP libs use it)
  if [ -n "$certifi_bundle" ] && [ -f "$certifi_bundle" ]; then
    existing_bundle="$certifi_bundle"
  fi

  # Create combined bundle
  if [ -n "$existing_bundle" ]; then
    cat "$existing_bundle" "$ca_cert" > "$combined_bundle" 2>/dev/null
  else
    # No existing bundle found, just use mitmproxy CA
    cp "$ca_cert" "$combined_bundle" 2>/dev/null
    echo "[bunsen] Warning: No existing CA bundle found, using mitmproxy CA only" >&2
  fi

  # Also update system CA store for non-Python tools (curl, wget, etc.)
  if command -v update-ca-certificates >/dev/null 2>&1; then
    cp "$ca_cert" /usr/local/share/ca-certificates/mitmproxy.crt 2>/dev/null && \
    update-ca-certificates >/dev/null 2>&1
  elif command -v update-ca-trust >/dev/null 2>&1; then
    cp "$ca_cert" /etc/pki/ca-trust/source/anchors/mitmproxy.crt 2>/dev/null && \
    update-ca-trust extract >/dev/null 2>&1
  fi

  # Export environment variables for this shell session
  export SSL_CERT_FILE="$combined_bundle"
  export REQUESTS_CA_BUNDLE="$combined_bundle"
  export CURL_CA_BUNDLE="$combined_bundle"
  export PIP_CERT="$combined_bundle"

  return 0
}
_install_ca
`.trim();
}

/**
 * Get path to the bundled ai_capture.py addon script
 */
export function getAddonScriptPath(): string {
  // The addon script ships under the asset dir's proxy subdirectory.
  return path.join(getAssetDir(), 'proxy', 'ai_capture.py');
}

/**
 * Get path to the vendored model-pricing snapshot the proxy prices calls from.
 * It lives beside the addon script (defaults to ai_capture.py's sibling), so the
 * proxy container can mount it and price models without any runtime network.
 */
export function getPricingDataPath(addonScriptPath: string = getAddonScriptPath()): string {
  return path.join(path.dirname(addonScriptPath), 'model_prices.json');
}

// ============================================================================
// Persistent Container Management (for in-container platform agents)
// ============================================================================

export interface PersistentContainer {
  container: Docker.Container;
  id: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export class ExecTimeoutError extends Error {
  stdout: string;
  stderr: string;
  durationMs: number;
  timeoutMs: number;

  constructor(timeoutMs: number, result: Omit<ExecResult, 'exitCode'>) {
    super(`Exec timed out after ${timeoutMs}ms`);
    this.name = 'ExecTimeoutError';
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.durationMs = result.durationMs;
    this.timeoutMs = timeoutMs;
  }
}

export interface ContainerLabelOptions {
  runId?: string;
  name?: string;
}

/**
 * Create a persistent container that stays running.
 * Use execInContainer() to run commands, then stopContainer() when done.
 */
export async function createPersistentContainer(
  options: ContainerOptions,
  labelOptions?: ContainerLabelOptions
): Promise<PersistentContainer> {
  const {
    image,
    mounts,
    env = {},
    workdir = '/workspace',
    networkMode = 'bridge',
    platform,
  } = options;

  // Convert mounts to Docker bind format
  const binds = mounts.map((mount: ContainerMount) => {
    const mode = mount.readonly ? 'ro' : 'rw';
    return `${path.resolve(mount.source)}:${mount.target}:${mode}`;
  });

  // Convert env to array format
  const envArray = Object.entries(env).map(([key, value]) => `${key}=${value}`);

  // Build labels
  const labels: Record<string, string> = {
    [BUNSEN_LABEL]: 'true',
    [BUNSEN_COMPONENT_LABEL]: 'agent',
  };
  if (labelOptions?.runId) {
    labels[BUNSEN_RUN_ID_LABEL] = labelOptions.runId;
  }

  // Create container with a long-running command (sleep infinity).
  // Init: true uses tini as PID 1, which properly reaps zombies and adopts
  // orphaned processes. This ensures background processes started by the agent
  // (e.g., servers, daemons) survive after the agent's docker exec session ends.
  const container = await docker.createContainer({
    Image: image,
    Cmd: ['/bin/bash', '-c', 'sleep infinity'],
    WorkingDir: workdir,
    Env: envArray,
    Labels: labels,
    ...(platform ? { Platform: platform } : {}),
    ...(labelOptions?.name && { name: labelOptions.name }),
    HostConfig: {
      Init: true,
      Binds: binds,
      AutoRemove: false,
      NetworkMode: networkMode,
      // Defense-in-depth: block setuid/setgid privilege escalation. A non-root
      // agent can't `sudo`/setuid its way to root *inside* the container, which
      // denies the first rung of a root-in-container → chained-exploit → host-escape
      // ladder. No-op for `environment.user: root` runs (root doesn't escalate via
      // setuid). Covers agent, scorer, and build containers (all created here).
      SecurityOpt: ['no-new-privileges'],
      ...(networkMode !== 'none' && { ExtraHosts: ['host.docker.internal:host-gateway'] }),
    },
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
  });

  await container.start();

  return {
    container,
    id: container.id,
  };
}

/**
 * Execute a command in a running container using docker exec.
 */
export async function execInContainer(
  persistentContainer: PersistentContainer,
  command: string[],
  options: {
    env?: Record<string, string>;
    user?: string;
    workdir?: string;
    timeout?: number;
    onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  } = {}
): Promise<ExecResult> {
  const { container } = persistentContainer;
  const {
    env = {},
    user,
    workdir,
    timeout = DEFAULT_TIMEOUT_MS,
    onOutput,
  } = options;

  const startTime = Date.now();

  // Create exec instance
  const exec = await container.exec({
    Cmd: command,
    AttachStdout: true,
    AttachStderr: true,
    Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
    ...(user ? { User: user } : {}),
    WorkingDir: workdir,
  });

  // Start exec and get the multiplexed stdout/stderr stream.
  //
  // NOT `{ hijack: true }`: dockerode's raw-socket hijack of Docker's
  // `101 Switching Protocols` upgrade is broken under the Bun runtime — it
  // throws `(HTTP code 101) unexpected …` (Bun's `node:http` doesn't surface the
  // hijacked upgrade socket the way docker-modem expects). `hijack` only matters
  // for bidirectional streaming (attaching stdin); this exec is output-only
  // (`stdin: false`), so the plain HTTP response stream carries the exact same
  // multiplexed frames and `demuxStream` below works identically — verified
  // byte-for-byte against Node. Re-test against real Docker before reintroducing
  // `hijack` (e.g. for an interactive stdin exec) — it will need a Bun fix first.
  const stream = await exec.start({ stdin: false });

  let stdout = '';
  let stderr = '';
  let timedOut = false;

  // Demux stdout/stderr
  const demuxPromise = new Promise<void>((resolve) => {
    container.modem.demuxStream(
      stream,
      {
        write: (chunk: Buffer) => {
          const text = chunk.toString();
          stdout += text;
          onOutput?.(text, 'stdout');
        },
      },
      {
        write: (chunk: Buffer) => {
          const text = chunk.toString();
          stderr += text;
          onOutput?.(text, 'stderr');
        },
      }
    );
    stream.on('end', resolve);
    // Also stop waiting if the stream errors mid-exec (connection drop, daemon
    // restart) — otherwise demuxPromise never settles and the exec only returns
    // via the full timeout. The exit-code inspection after the race is the source
    // of truth for success/failure. (The non-hijack http.IncomingMessage stream
    // used under Bun emits 'error' differently than the old socket, so this guard
    // matters.)
    stream.on('error', resolve);
  });

  // Wait for completion with timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      timedOut = true;
      reject(new ExecTimeoutError(timeout, {
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
      }));
    }, timeout);
  });

  try {
    await Promise.race([demuxPromise, timeoutPromise]);
  } catch (err) {
    if (timedOut) {
      // Note: We can't kill a running exec, but the timeout will at least
      // return control. The container remains for cleanup later.
      throw err;
    }
    throw err;
  }

  // Get exit code
  const inspectResult = await exec.inspect();
  const exitCode = inspectResult.ExitCode ?? 0;

  return {
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Execute a shell script in a running container.
 */
export async function execShellInContainer(
  persistentContainer: PersistentContainer,
  script: string,
  options: {
    env?: Record<string, string>;
    user?: string;
    workdir?: string;
    timeout?: number;
    onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  } = {}
): Promise<ExecResult> {
  return execInContainer(
    persistentContainer,
    ['/bin/bash', '-c', script],
    options
  );
}

/**
 * Write a file into a running container using base64 encoding.
 *
 * This avoids shell interpretation issues that occur with heredocs when content
 * contains backticks, $, quotes, or other shell special characters. Base64 output
 * only contains [A-Za-z0-9+/=\n], eliminating all shell escaping concerns.
 */
export async function writeFileInContainer(
  persistentContainer: PersistentContainer,
  filePath: string,
  content: string,
  options?: { mode?: string; timeout?: number }
): Promise<ExecResult> {
  const encoded = Buffer.from(content, 'utf-8').toString('base64');
  const mode = options?.mode ?? '644';
  const timeout = options?.timeout ?? 10000;
  const dir = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
  return execShellInContainer(
    persistentContainer,
    `mkdir -p '${dir}' && echo '${encoded}' | base64 -d > '${filePath}' && chmod ${mode} '${filePath}'`,
    { timeout }
  );
}

/**
 * Stop and remove a persistent container.
 */
export async function stopContainer(
  persistentContainer: PersistentContainer
): Promise<void> {
  const { container } = persistentContainer;

  try {
    await container.stop({ t: 5 });
  } catch {
    // Ignore stop errors (may already be stopped)
  }

  try {
    await container.remove({ force: true });
  } catch {
    // Ignore removal errors
  }
}

// ============================================================================
// tmux and asciinema helpers for recording
// ============================================================================

const DEFAULT_TMUX_SESSION = 'agent';
const DEFAULT_TERMINAL_SIZE = '120x40';

/**
 * Initialize a tmux session in the container for recording.
 */
export async function initTmuxSession(
  container: PersistentContainer,
  options: {
    sessionName?: string;
    terminalSize?: string;
  } = {}
): Promise<void> {
  const sessionName = options.sessionName || DEFAULT_TMUX_SESSION;
  const terminalSize = options.terminalSize || DEFAULT_TERMINAL_SIZE;
  const [cols, rows] = terminalSize.split('x').map(Number);

  const cmd = ['tmux', 'new-session', '-d', '-s', sessionName, '-x', String(cols), '-y', String(rows)];

  // Create tmux session with specified size
  const result = await execInContainer(
    container,
    cmd,
    { timeout: 10000 }
  );

  if (result.exitCode !== 0) {
    throw new Error(`Failed to create tmux session (exit ${result.exitCode}): stdout="${result.stdout}" stderr="${result.stderr}" cmd=${JSON.stringify(cmd)}`);
  }
}

/**
 * Start asciinema recording of the tmux session.
 * Recording is started in a separate process and writes to
 * /bunsen/run/artifacts/recording.cast (the v1 layout location).
 */
export async function startAsciinemaRecording(
  container: PersistentContainer,
  options: {
    sessionName?: string;
    terminalSize?: string;
    outputPath?: string;
  } = {}
): Promise<void> {
  const sessionName = options.sessionName || DEFAULT_TMUX_SESSION;
  const terminalSize = options.terminalSize || DEFAULT_TERMINAL_SIZE;
  const [cols, rows] = terminalSize.split('x').map(Number);
  const outputPath = options.outputPath || '/bunsen/run/artifacts/recording.cast';

  // Start asciinema in the background, attached to the tmux session
  // We use nohup and redirect to ensure it runs in background
  const result = await execShellInContainer(
    container,
    `nohup asciinema rec --overwrite --cols ${cols} --rows ${rows} -c "tmux attach -t ${sessionName}" ${outputPath} > /dev/null 2>&1 &`,
    { timeout: 10000 }
  );

  if (result.exitCode !== 0) {
    throw new Error(`Failed to start asciinema recording: ${result.stderr}`);
  }

  // Give asciinema a moment to start
  await new Promise((resolve) => setTimeout(resolve, 500));
}

/**
 * Send keys/commands to the tmux session.
 */
export async function sendKeysToTmux(
  container: PersistentContainer,
  keys: string,
  options: {
    sessionName?: string;
  } = {}
): Promise<void> {
  const sessionName = options.sessionName || DEFAULT_TMUX_SESSION;

  const result = await execInContainer(
    container,
    ['tmux', 'send-keys', '-t', sessionName, keys],
    { timeout: 5000 }
  );

  if (result.exitCode !== 0) {
    throw new Error(`Failed to send keys to tmux: ${result.stderr}`);
  }
}

/**
 * Send Enter key to tmux (separate from other keys for clarity).
 */
export async function sendEnterToTmux(
  container: PersistentContainer,
  options: {
    sessionName?: string;
  } = {}
): Promise<void> {
  const sessionName = options.sessionName || DEFAULT_TMUX_SESSION;

  const result = await execInContainer(
    container,
    ['tmux', 'send-keys', '-t', sessionName, 'Enter'],
    { timeout: 5000 }
  );

  if (result.exitCode !== 0) {
    throw new Error(`Failed to send Enter to tmux: ${result.stderr}`);
  }
}

/**
 * Capture the current terminal state from tmux.
 */
export async function captureTmuxPane(
  container: PersistentContainer,
  options: {
    sessionName?: string;
  } = {}
): Promise<string> {
  const sessionName = options.sessionName || DEFAULT_TMUX_SESSION;

  const result = await execInContainer(
    container,
    ['tmux', 'capture-pane', '-t', sessionName, '-p'],
    { timeout: 5000 }
  );

  if (result.exitCode !== 0) {
    throw new Error(`Failed to capture tmux pane: ${result.stderr}`);
  }

  return result.stdout;
}

/**
 * Start tmux pipe-pane to capture all output to a log file.
 */
export async function startTmuxLogCapture(
  container: PersistentContainer,
  logPath: string,
  options: {
    sessionName?: string;
  } = {}
): Promise<void> {
  const sessionName = options.sessionName || DEFAULT_TMUX_SESSION;

  const result = await execInContainer(
    container,
    ['tmux', 'pipe-pane', '-t', sessionName, '-o', `cat >> ${logPath}`],
    { timeout: 5000 }
  );

  if (result.exitCode !== 0) {
    throw new Error(`Failed to start tmux log capture: ${result.stderr}`);
  }
}

/**
 * Stop tmux pipe-pane log capture.
 */
export async function stopTmuxLogCapture(
  container: PersistentContainer,
  options: {
    sessionName?: string;
  } = {}
): Promise<void> {
  const sessionName = options.sessionName || DEFAULT_TMUX_SESSION;

  // Empty argument to pipe-pane stops it
  await execInContainer(
    container,
    ['tmux', 'pipe-pane', '-t', sessionName],
    { timeout: 5000 }
  );
}

/**
 * Check if tmux session is still active.
 */
export async function isTmuxSessionActive(
  container: PersistentContainer,
  options: {
    sessionName?: string;
  } = {}
): Promise<boolean> {
  const sessionName = options.sessionName || DEFAULT_TMUX_SESSION;

  const result = await execInContainer(
    container,
    ['tmux', 'has-session', '-t', sessionName],
    { timeout: 5000 }
  );

  return result.exitCode === 0;
}

/**
 * Stop asciinema recording by detaching from tmux.
 * This gracefully ends the recording.
 */
export async function stopAsciinemaRecording(
  container: PersistentContainer,
  _options: {
    sessionName?: string;
  } = {}
): Promise<void> {
  // Note: sessionName is available in _options if we need more targeted stopping in the future.
  // For now, we just kill all asciinema processes which works reliably.

  // Kill any asciinema processes
  await execShellInContainer(
    container,
    'pkill -f asciinema || true',
    { timeout: 5000 }
  );

  // Give it a moment to finish writing
  await new Promise((resolve) => setTimeout(resolve, 500));
}

/**
 * Get recording file info (size).
 */
export async function getRecordingInfo(
  container: PersistentContainer,
  recordingPath: string = '/bunsen/run/artifacts/recording.cast'
): Promise<{ size: number; exists: boolean }> {
  const result = await execInContainer(
    container,
    ['stat', '-c', '%s', recordingPath],
    { timeout: 5000 }
  );

  if (result.exitCode !== 0) {
    return { size: 0, exists: false };
  }

  return {
    size: parseInt(result.stdout.trim(), 10) || 0,
    exists: true,
  };
}

// ============================================================================
// Platform Tool Paths
// ============================================================================

/**
 * Get the path to a platform tool JS bundle.
 * @param bundleName - The name of the bundle (orchestrator, scorer, supervisor, or gitignore-filter)
 */
export function getPlatformBundlePath(
  bundleName: 'orchestrator' | 'scorer' | 'supervisor' | 'gitignore-filter' | 'proxy-bootstrap'
): string {
  // Bundles ship flat at the root of the asset dir.
  return path.join(getAssetDir(), `${bundleName}.cjs`);
}

/**
 * Container path where the proxy-bootstrap bundle is mounted. The bundle
 * configures undici's global dispatcher to honor `HTTPS_PROXY` and trust
 * `NODE_EXTRA_CA_CERTS`, fixing the gap where Node native fetch silently
 * bypasses the mitmproxy. Loaded into Node processes via
 * `NODE_OPTIONS=--require=<this path>`.
 */
export const PROXY_BOOTSTRAP_CONTAINER_PATH = '/bunsen/runtime/proxy-bootstrap.cjs';

// The per-platform Node runtime resolver (asset path + layered on-demand
// download/cache for custom-image experiments) lives in `./node-runtime.ts`
// (`getNodeRuntimePath`, `resolveContainerNodeRuntime`). It imports getAssetDir
// and the platform/arch helpers from this module.


// ============================================================================
// Bunsen Image Management
// ============================================================================

const BUNSEN_IMAGE_PREFIX = 'bunsen/';
const BUNSEN_REGISTRY = 'ghcr.io/bunsen-dev';

/**
 * Check if an image name is a bunsen image (e.g., "bunsen/headless")
 */
export function isBunsenImage(imageName: string): boolean {
  return imageName.startsWith(BUNSEN_IMAGE_PREFIX);
}

/**
 * Get the image name without the bunsen/ prefix (e.g., "headless" from "bunsen/headless")
 */
function getBunsenImageName(imageName: string): string {
  return imageName.slice(BUNSEN_IMAGE_PREFIX.length).split(':')[0];
}

/**
 * Get the path to the local Dockerfile for a bunsen image.
 * Returns null if the Dockerfile doesn't exist locally.
 */
export function getBunsenImageDockerfilePath(imageName: string): string | null {
  if (!isBunsenImage(imageName)) {
    return null;
  }

  const name = getBunsenImageName(imageName);
  // Base-image Dockerfiles ship under the asset dir's `images/` subdirectory.
  // When absent (e.g. a relocated install that didn't ship them), the caller
  // falls back to pulling the prebuilt image from the registry.
  const dockerfilePath = path.join(getAssetDir(), 'images', name, 'Dockerfile');

  if (fs.existsSync(dockerfilePath)) {
    return dockerfilePath;
  }

  return null;
}

/**
 * Get the remote registry URL for a bunsen image.
 * e.g., "bunsen/headless" -> "ghcr.io/bunsen-dev/bunsen-headless"
 */
export function getBunsenRegistryImage(imageName: string): string {
  if (!isBunsenImage(imageName)) {
    return imageName;
  }

  const name = getBunsenImageName(imageName);
  const tag = imageName.includes(':') ? imageName.split(':')[1] : 'latest';
  return `${BUNSEN_REGISTRY}/bunsen-${name}:${tag}`;
}

/**
 * Ensure a bunsen image exists locally.
 * First checks if it exists, then tries to build from local Dockerfile,
 * finally falls back to pulling from the remote registry.
 */
export async function ensureBunsenImage(
  imageName: string,
  onProgress?: (message: string) => void,
  platform?: RunPlatform
): Promise<void> {
  // Check if already exists locally
  const existingPlatform = await inspectImagePlatform(imageName);
  if (existingPlatform && (!platform || existingPlatform === platform)) {
    onProgress?.(`Using existing ${imageName}`);
    return;
  }

  // Try to build from local Dockerfile
  const dockerfilePath = getBunsenImageDockerfilePath(imageName);
  if (dockerfilePath) {
    onProgress?.(`Building ${imageName} from local Dockerfile...`);
    await buildImage(dockerfilePath, imageName, onProgress, platform);
    return;
  }

  // Fall back to pulling from remote registry
  const registryImage = getBunsenRegistryImage(imageName);
  onProgress?.(`Pulling ${registryImage}...`);

  try {
    await ensureImage(registryImage, onProgress, platform);

    // Tag it with the local bunsen/ name for future use
    const image = docker.getImage(registryImage);
    const [repo, tag] = imageName.includes(':')
      ? imageName.split(':')
      : [imageName, 'latest'];
    await image.tag({ repo, tag });
    onProgress?.(`Tagged as ${imageName}`);
  } catch (err) {
    if (existingPlatform && platform && existingPlatform !== platform) {
      throw new Error(
        `Failed to obtain bunsen image "${imageName}" for ${platform}. ` +
        `A local image exists for ${existingPlatform}, which is incompatible with this run.`
      );
    }
    throw new Error(
      `Failed to obtain bunsen image "${imageName}". ` +
      `No local Dockerfile found and remote pull failed: ${err instanceof Error ? err.message : err}`
    );
  }
}

// ============================================================================
// Bunsen Container Cleanup
// ============================================================================

export interface BunsenContainerInfo {
  id: string;
  name: string;
  state: string;
  status: string;
  image: string;
  created: number;
  runId?: string;
  component?: string;
}

export interface CleanupResult {
  containersRemoved: number;
  networksRemoved: number;
  errors: string[];
}

/**
 * List all bunsen containers using two strategies:
 * 1. Docker label filter (bunsen=true) for labeled containers
 * 2. Name pattern matching (bunsen-run-*, bunsen-proxy-*) and image pattern (bunsen-experiment-*) for legacy unlabeled containers
 */
export async function listBunsenContainers(): Promise<BunsenContainerInfo[]> {
  const seen = new Set<string>();
  const results: BunsenContainerInfo[] = [];

  const addContainer = (c: Docker.ContainerInfo) => {
    if (seen.has(c.Id)) return;
    seen.add(c.Id);

    const name = (c.Names?.[0] || '').replace(/^\//, '');
    results.push({
      id: c.Id,
      name,
      state: c.State,
      status: c.Status,
      image: c.Image,
      created: c.Created,
      runId: c.Labels?.[BUNSEN_RUN_ID_LABEL],
      component: c.Labels?.[BUNSEN_COMPONENT_LABEL],
    });
  };

  // Strategy 1: labeled containers
  try {
    const labeled = await docker.listContainers({
      all: true,
      filters: { label: [`${BUNSEN_LABEL}=true`] },
    });
    for (const c of labeled) addContainer(c);
  } catch {
    // Ignore filter errors
  }

  // Strategy 2: name/image pattern matching, as a fallback for any container
  // missing the bunsen label (mirrors listBunsenNetworks below).
  try {
    const all = await docker.listContainers({ all: true });
    for (const c of all) {
      const name = (c.Names?.[0] || '').replace(/^\//, '');
      if (
        name.startsWith('bunsen-proxy-') ||
        name.startsWith('bunsen-run-') ||
        c.Image.startsWith('bunsen-experiment-')
      ) {
        addContainer(c);
      }
    }
  } catch {
    // Ignore list errors
  }

  return results;
}

/**
 * List all bunsen networks using two strategies:
 * 1. Docker label filter (bunsen=true)
 * 2. Name pattern matching (bunsen-net-*)
 */
export async function listBunsenNetworks(): Promise<{ id: string; name: string }[]> {
  const seen = new Set<string>();
  const results: { id: string; name: string }[] = [];

  const addNetwork = (n: { Id: string; Name: string }) => {
    if (seen.has(n.Id)) return;
    seen.add(n.Id);
    results.push({ id: n.Id, name: n.Name });
  };

  // Strategy 1: labeled networks
  try {
    const labeled = await docker.listNetworks({
      filters: { label: [`${BUNSEN_LABEL}=true`] },
    });
    for (const n of labeled) addNetwork(n);
  } catch {
    // Ignore filter errors
  }

  // Strategy 2: name pattern matching
  try {
    const all = await docker.listNetworks();
    for (const n of all) {
      if (n.Name.startsWith('bunsen-net-')) {
        addNetwork(n);
      }
    }
  } catch {
    // Ignore list errors
  }

  return results;
}

/**
 * Stop and remove all bunsen containers and networks.
 */
export async function cleanupBunsenContainers(dryRun = false): Promise<CleanupResult> {
  const result: CleanupResult = { containersRemoved: 0, networksRemoved: 0, errors: [] };

  // Remove containers
  const containers = await listBunsenContainers();
  for (const c of containers) {
    if (dryRun) {
      result.containersRemoved++;
      continue;
    }
    try {
      const container = docker.getContainer(c.id);
      if (c.state === 'running') {
        await container.stop({ t: 5 });
      }
      await container.remove({ force: true });
      result.containersRemoved++;
    } catch (err) {
      result.errors.push(`Failed to remove container ${c.name || c.id.slice(0, 12)}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Remove networks
  const networks = await listBunsenNetworks();
  for (const n of networks) {
    if (dryRun) {
      result.networksRemoved++;
      continue;
    }
    try {
      const network = docker.getNetwork(n.id);
      await network.remove();
      result.networksRemoved++;
    } catch (err) {
      result.errors.push(`Failed to remove network ${n.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return result;
}
