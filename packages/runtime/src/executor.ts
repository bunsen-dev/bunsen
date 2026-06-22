// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Experiment executor - orchestrates running experiments with agents
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type {
  RunManifestV1,
  OrchestrationResult,
  ContainerMount,
  Criterion,
  ReportConfig,
  RunPlatform,
  AgentDepSpec,
} from '@bunsen-dev/types';
import { parseOptionalDuration } from '@bunsen-dev/types';
import {
  loadExperiment,
  loadAgent,
  resolveModelSelection,
  type ResolvedExperiment,
  type ResolvedAgent,
} from './config.js';
import { dispatchSteps } from './step-dispatch.js';
import { mergeRunEnvironment, type RunEnvSource } from './env.js';
import {
  STABLE_PATHS,
  buildStablePathsMkdirScript,
  buildReservedEnv,
} from './runtime-contract.js';
import { captureAgentOutput } from './output-capture.js';
import { loadProject } from './project-loader.js';
import { detectSuiteProvenance } from './suite-loader.js';
import {
  resolveEnvironment,
  generatePackageInstallCommands,
  hasPackageRequirements,
  type ResolvedEnvironment,
} from './environment.js';
import {
  buildDefaultArgvInvocation,
  formatInvocationForLog,
  parseOrchestrationResult,
  renderArgvInvocation,
} from './orchestration.js';
import { resolveAgentSource } from './sources.js';
import {
  createRun,
  updateRunStatus,
  saveLogs,
  appendLogs,
  mutateRunManifest,
  loadRunManifest,
  buildThreadsForScorer,
  finalizeRunTraces,
  saveWorkspaceDiff,
  saveEvaluationResult,
  saveTaskPrompt,
  saveOrchestrationResult,
  getRunDir,
  getScreenshotsDir,
  RUN_PATHS,
} from './storage.js';
import { refreshRunManifest } from './manifest.js';
import { appendRunEvent, type RunEventInput } from './run-events.js';
import {
  resolveCriteria,
  getExecutionOrder,
  buildScorerConfig,
  runAggregate,
  buildEvaluationResult,
  validateRubric,
  checkGate,
  getGateThreshold,
  determineScorerType,
} from './evaluation-coordinator.js';
import {
  createScorerContainer,
  runCodeScorer,
  runLLMScorer,
  stopScorerContainer,
  slugifyCriterion,
  BUNSEN_SCORE_SCRIPT,
  type ScorerContainerInfo,
} from './scorer-container.js';
import type {
  ScorerOutput,
  CriterionResult,
  DependencyScore,
  ScorerConfig,
} from '@bunsen-dev/types';
import {
  buildImage,
  ensureImage,
  prepareImage,
  imageExists,
  isDockerAvailable,
  getDockerInfo,
  startProxyContainer,
  stopProxyContainer,
  getAddonScriptPath,
  getProxyEnv,
  getCAInjectionCommands,
  createPersistentContainer,
  execInContainer,
  execShellInContainer,
  writeFileInContainer,
  stopContainer,
  getPlatformBundlePath,
  getNodeRuntimePath,
  isBunsenImage,
  ensureBunsenImage,
  archToRunPlatform,
  normalizeRunPlatform,
  runPlatformToArch,
  // Recording support
  getRecordingInfo,
  ExecTimeoutError,
  type ProxyContainerInfo,
  type PersistentContainer,
  type ExecResult,
} from './container.js';

/**
 * Thrown out of `executeRun` when the run was canceled mid-flight (either by
 * SIGINT to the foreground process or an out-of-band `cancelRun()` call).
 * The CLI uses the `instanceof` check to surface "Run canceled" instead of
 * the docker fallout error (typically a 409 from a stopped container exec).
 */
export class RunCanceledError extends Error {
  readonly runId: string;
  readonly reason: 'SIGINT' | 'external';
  constructor(runId: string, reason: 'SIGINT' | 'external', message?: string) {
    super(message ?? `Run ${runId} was canceled`);
    this.name = 'RunCanceledError';
    this.runId = runId;
    this.reason = reason;
  }
}

/**
 * In-flight run state visible to the signal handler. All mutable state the
 * signal handler reads/writes lives here so it stays in one place: the run
 * id + baseDir for emit/log/status calls, the current phase for `run.failed`
 * payloads, container handles for async cleanup, and the bookkeeping flags
 * (`cleaningUp` for re-entrancy, `terminalEventEmitted` to suppress duplicate
 * terminal events when the catch block runs after the handler).
 */
interface ActiveRun {
  runId: string;
  baseDir: string;
  /**
   * Absolute path to the run dir (host-side, bind-mounted RW into the
   * container). The signal handler needs it to scrub the live-key file
   * (`agent-script.sh`) before force-exiting — see `handleSignal`.
   */
  runDir: string;
  phase: string;
  container: PersistentContainer | null;
  proxyInfo: ProxyContainerInfo | null;
  scorerContainer: ScorerContainerInfo | null;
  cleaningUp: boolean;
  terminalEventEmitted: boolean;
}

let activeRun: ActiveRun | null = null;

// Signal handlers to mark runs as canceled/failed on interruption
export function handleSignal(signal: 'SIGINT' | 'SIGTERM') {
  const exitCode = signal === 'SIGINT' ? 130 : 143; // 128 + signal number
  // SIGINT (Ctrl+C) = user-initiated cancel, SIGTERM = external termination (failure)
  const status = signal === 'SIGINT' ? 'canceled' : 'failed';

  // Second signal during cleanup = force exit immediately
  if (activeRun?.cleaningUp) {
    process.exit(exitCode);
  }

  // Update run status synchronously (this part is safe in signal handlers)
  if (activeRun) {
    activeRun.cleaningUp = true;
    try {
      updateRunStatus(activeRun.runId, status, exitCode, activeRun.baseDir);
      appendLogs(activeRun.runId, `\n--- INTERRUPTED (${signal}) ---\n`, activeRun.baseDir);
      // The signal handler force-exits before the executor's catch block can
      // run, so the terminal event has to be emitted here. SIGINT = user
      // cancel; SIGTERM = external termination (recorded as a failed phase).
      if (signal === 'SIGINT') {
        appendRunEvent(
          activeRun.runId,
          { event: 'run.canceled', data: { reason: 'SIGINT' } },
          activeRun.baseDir
        );
      } else {
        appendRunEvent(
          activeRun.runId,
          { event: 'run.failed', data: { phase: activeRun.phase, reason: 'SIGTERM' } },
          activeRun.baseDir
        );
      }
      activeRun.terminalEventEmitted = true;
    } catch {
      // Ignore errors during cleanup - we're exiting anyway
    }

    // Scrub the live-key file from the host-shared run dir before any exit
    // path. `agent-script.sh` (and `launcher.sh`) hold the user's plaintext
    // API keys via `export KEY="value"` lines; the executor's finally-block
    // cleanup never runs once the handler force-exits, so do it here. This is
    // synchronous so it completes before the `process.exit()` calls below (and
    // the 10s hard-timeout fallback), and exception-safe so a failed unlink
    // can't block teardown.
    try {
      cleanupInternalRunFiles(activeRun.runDir);
    } catch {
      // Ignore - best effort; we're exiting anyway.
    }
  }

  // Hard timeout: force exit after 10 seconds regardless
  const hardTimeout = setTimeout(() => process.exit(exitCode), 10_000);
  hardTimeout.unref();

  // Async cleanup of containers
  const cleanupPromises: Promise<void>[] = [];

  if (activeRun?.container) {
    cleanupPromises.push(
      stopContainer(activeRun.container).catch(() => {
        // Ignore errors - best effort cleanup
      })
    );
  }

  if (activeRun?.scorerContainer) {
    cleanupPromises.push(
      stopScorerContainer(activeRun.scorerContainer).catch(() => {
        // Ignore errors - best effort cleanup
      })
    );
  }

  if (activeRun?.proxyInfo) {
    cleanupPromises.push(
      stopProxyContainer(activeRun.proxyInfo).catch(() => {
        // Ignore errors - best effort cleanup
      })
    );
  }

  if (cleanupPromises.length > 0) {
    Promise.all(cleanupPromises).finally(() => {
      process.exit(exitCode);
    });
  } else {
    process.exit(exitCode);
  }
}

process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));

/**
 * Test seam: install (or clear) the in-flight run state the signal handler
 * reads, so signal-handling behavior can be exercised without spinning up a
 * real executor/Docker run. Not used in production code paths.
 */
export function setActiveRunForTest(run: ActiveRun | null): void {
  activeRun = run;
}

// =============================================================================
// Constants
// =============================================================================

/** Default per-criterion evaluation timeout (ms) */
const DEFAULT_CRITERION_TIMEOUT_MS = 600_000; // 10 minutes

/** Default timeout for post-run artifact capture commands (seconds) */
const DEFAULT_ARTIFACT_CAPTURE_TIMEOUT_SECONDS = 120;

/** Default terminal size for recording */
const DEFAULT_TERMINAL_SIZE = '120x40';

/** Default timeout for agent build scripts (seconds) */
const DEFAULT_AGENT_BUILD_TIMEOUT_SECONDS = 600;

/** Max total artifact size for /output from agent builds (bytes) */
const MAX_AGENT_ARTIFACT_BYTES = 500 * 1024 * 1024; // 500MB

/**
 * PATH composition policy for the agent container:
 *
 *   /bunsen/artifacts/bin : /bunsen/artifacts : <deps in declared order> : $PATH
 *
 * The agent's own `install.build` artifacts win over its deps, and both win
 * over substrate (`/usr/bin`, etc.). This is the deterministic precedence
 * that makes asymmetric composition honest: tools the agent ships always
 * shadow substrate-installed binaries with the same name. The cross-boundary
 * shadow detector (below) surfaces those shadowings in the run manifest so
 * they are visible rather than silent.
 */
function buildDepsPathPrefix(deps: PreparedAgentDep[]): string {
  const segments = ['/bunsen/artifacts/bin', '/bunsen/artifacts'];
  for (const dep of deps) {
    segments.push(`/bunsen/deps/${dep.name}/bin`);
  }
  return segments.join(':');
}

function buildArtifactsPathExport(deps: PreparedAgentDep[]): string {
  return `export PATH=${buildDepsPathPrefix(deps)}:$PATH`;
}
/** Relative path to build cache directory */
const BUILD_CACHE_RELATIVE_DIR = '.bunsen/build-cache';
/** Relative path to install.deps cache directory */
const DEPS_CACHE_RELATIVE_DIR = '.bunsen/deps-cache';
/** Default build image used when a dep does not specify one and no per-target image overrides */
const DEFAULT_AGENT_DEP_BUILD_TIMEOUT_SECONDS = 600;
/** Cap per-dep artifact size (bytes). 500MB is plenty for a single CLI. */
const MAX_AGENT_DEP_ARTIFACT_BYTES = 500 * 1024 * 1024;

// =============================================================================
// Types
// =============================================================================

export interface ExecutorOptions {
  experimentPath: string;
  agentPath: string;
  args?: string[];
  /** Agent variant name, if one was selected. */
  agentVariant?: string;
  /** Experiment variant name, if one was selected. */
  experimentVariant?: string;
  /**
   * Model id override (`bn run --model <id>`). Sets the agent's declared
   * `model.env` var at CLI precedence, overriding any model baked into the
   * selected variant. Errors if the agent declares no `model` block.
   */
  model?: string;
  /** Post-orchestration args (variant args if specified, otherwise base agent args) */
  guaranteedArgs?: string[];
  /** Resolved supervisor setting (variant can override base agent) */
  resolvedSupervisor?: boolean;
  /** `--env-file` paths from the CLI. Merged in order. */
  cliEnvFiles?: string[];
  /** `--env KEY=VALUE` flags from the CLI. */
  cliEnvFlags?: string[];
  /** `--pass-env HOST_NAME` flags from the CLI (host-env allowlist additions). */
  cliPassEnv?: string[];
  skipOrchestration?: boolean;
  skipEvaluation?: boolean;
  /** Skip AI API trace capture (via mitmproxy sidecar) */
  skipTraces?: boolean;
  verbose?: boolean;
  baseDir?: string;
  timeout?: number;
  /** Keep container running after completion for debugging */
  debugKeepContainer?: boolean;
  /** Export workspace as tar.gz after run */
  exportWorkspace?: boolean;
  /** Enable terminal recording via tmux + asciinema */
  record?: boolean;
  /** Terminal size for recording (e.g., '120x40'). Default: '120x40' */
  terminalSize?: string;
  /** Force rebuilding runtime.build artifacts, bypassing build cache */
  rebuildAgent?: boolean;
  /** Explicit execution platform for the run */
  platform?: RunPlatform | string;
}

export interface ExecutorCallbacks {
  onProgress?: (message: string) => void;
  onLog?: (log: string) => void;
  /** Called for each chunk of output as it streams from the container */
  onOutputChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** Called for persistent info messages that should remain visible */
  onInfo?: (message: string) => void;
  /** Called for transient logs that will be cleared later (e.g., orchestrator logs) */
  onTransientLog?: (message: string) => void;
  /** Called to clear transient logs */
  onClearTransientLogs?: () => void;
}

export interface AgentArtifactBuildOptions {
  agentPath: string;
  baseDir?: string;
  platform?: RunPlatform | string;
  rebuild?: boolean;
  onProgress?: (message: string) => void;
}

export interface BuildCacheEntry {
  key: string;
  path: string;
  sizeBytes: number;
  createdAt?: string;
  platform?: RunPlatform;
  arch?: string;
  image?: string;
  timeoutMs?: number;
  totalArtifactBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Strip ANSI escape codes from terminal output for clean, readable logs.
 */
function stripAnsiCodes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?<>=]*[a-zA-Z]/g, '') // CSI sequences (DEC private modes, mouse reports, etc.)
             .replace(/\x1b\][^\x07]*\x07/g, '')        // OSC sequences (title bar, etc.)
             .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')  // DCS, SOS, PM, APC sequences
             .replace(/\x1b[()#][^\n]*/g, '')            // Charset/line attribute sequences
             .replace(/\x1b[a-zA-Z]/g, '')               // Two-byte escape sequences
             .replace(/[\x00-\x09\x0b-\x1f]/g, '');     // Other control chars except newline
}

export function buildExecLogs(result: Pick<ExecResult, 'stdout' | 'stderr'>): string {
  return result.stdout + (result.stderr ? `\n--- STDERR ---\n${result.stderr}` : '');
}

export function cleanupInternalRunFiles(runDir: string): void {
  for (const file of ['agent-script.sh', 'agent-complete.marker', 'launcher.sh']) {
    const filePath = path.join(runDir, file);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

/**
 * Execute an experiment with an agent
 */
export async function executeRun(
  options: ExecutorOptions,
  callbacks: ExecutorCallbacks = {}
): Promise<RunManifestV1> {
  const {
    experimentPath,
    agentPath,
    args = [],
    agentVariant,
    experimentVariant,
    model,
    guaranteedArgs = [],
    cliEnvFiles = [],
    cliEnvFlags = [],
    cliPassEnv = [],
    skipOrchestration = false,
    skipEvaluation = false,
    skipTraces = false,
    verbose = false,
    baseDir = process.cwd(),
    timeout = DEFAULT_TIMEOUT_MS,
    debugKeepContainer = false,
    record = false,
    terminalSize = DEFAULT_TERMINAL_SIZE,
    rebuildAgent = false,
    platform,
    resolvedSupervisor,
  } = options;

  const { onProgress, onLog, onOutputChunk, onInfo, onTransientLog, onClearTransientLogs } =
    callbacks;

  // Progress logging - always show if callback provided
  const progress = (message: string) => {
    onProgress?.(message);
  };

  // Info logging - persistent messages that should remain visible
  const info = (message: string) => {
    onInfo?.(message);
  };

  // Transient logging - messages that will be cleared later
  const transientLog = (message: string) => {
    onTransientLog?.(message);
  };

  // Clear transient logs
  const clearTransientLogs = () => {
    onClearTransientLogs?.();
  };

  const createTransientLineForwarder = (onLine?: (line: string) => void) => {
    let lastLine: string | undefined;
    const ansiPattern = /\x1B\[[0-?]*[ -/]*[@-~]/g;

    return (message: string) => {
      const normalized = message.replace(/\r/g, '\n').replace(ansiPattern, '');
      for (const rawLine of normalized.split('\n')) {
        const line = rawLine.trim();
        if (!line || line === lastLine) {
          continue;
        }
        lastLine = line;
        onLine?.(line);
        transientLog(line);
      }
    };
  };

  // Verbose logging - only show in verbose mode
  const log = (message: string) => {
    if (verbose) {
      onProgress?.(message);
    }
  };

  // Load experiment and agent configs. Load both the base (to extract the
  // pre-variant env) and the variant-merged view (for the rest of the run).
  progress('Loading configurations...');
  const experimentBase = loadExperiment(experimentPath);
  const experiment =
    experimentVariant !== undefined
      ? loadExperiment(experimentPath, experimentVariant)
      : experimentBase;
  const agentBase = loadAgent(agentPath);
  const agent =
    agentVariant !== undefined ? loadAgent(agentPath, { variant: agentVariant }) : agentBase;

  // Resolve `--model` against the agent's declared model wiring. Throws early
  // (before any Docker work) if --model was passed to an agent with no `model`
  // block. `undefined` when the agent has neither a model declaration nor a
  // request.
  const modelSelection = resolveModelSelection(agent, model);

  // Surface the override when it shadows a model the selected variant pins
  // (e.g. claude-code:auto, which requires a specific model). CLI wins, but the
  // user should know the variant's model was overridden.
  if (modelSelection?.overrideValue !== undefined && agentVariant !== undefined) {
    const variantModel = agentBase.variants?.[agentVariant]?.defaults?.env?.[modelSelection.envName];
    if (variantModel !== undefined && variantModel !== modelSelection.overrideValue) {
      info(
        `--model ${modelSelection.overrideValue} overrides ${modelSelection.envName}=${variantModel} ` +
          `set by variant '${agentVariant}'.`,
      );
    }
  }

  // Load project config early so platform resolution can read its defaults.
  const project = loadProject(baseDir);

  // Check Docker availability and get architecture
  progress('Checking Docker availability...');
  if (!(await isDockerAvailable())) {
    throw new Error('Docker is not available. Please ensure Docker is running.');
  }
  const dockerInfo = await getDockerInfo();
  const runPlatform = resolveRunPlatform({
    cliPlatform: platform,
    experimentRunPlatform: experiment.run?.platform,
    projectDefaultPlatform: project.config.defaults?.run?.platform,
    dockerArch: dockerInfo.arch,
    supportedPlatforms: experiment.environment.platforms,
  });
  progress(`Resolved run platform: ${runPlatform}`);
  info(`Run platform: ${runPlatform}`);

  // Calculate effective timeout: experiment.run.timeout takes precedence over CLI timeout.
  const experimentTimeoutMs = parseOptionalDuration(experiment.run?.timeout);
  const effectiveTimeout = experimentTimeoutMs ?? timeout;
  const artifactCaptureTimeoutMs =
    parseOptionalDuration(experiment.run?.artifactCaptureTimeout) ??
    DEFAULT_ARTIFACT_CAPTURE_TIMEOUT_SECONDS * 1000;

  // Resolve substrate environment. The agent is a sealed closure and does
  // not contribute to substrate (see docs/ENVIRONMENT.md#asymmetric-composition).
  // We still pass the agent in so its install.configure commands flow through
  // the same resolution shape; they run later against the agent's context.
  const resolvedEnv = resolveEnvironment(experiment, agent);
  log(`Resolved substrate: base=${resolvedEnv.baseImage}, runtimes=${JSON.stringify(resolvedEnv.runtimes)}`);

  // Resolve agent source if needed (git, npm, binary)
  let resolvedAgentPath = agent.path;
  if (agent.install.source.type !== 'local') {
    log(`Resolving ${agent.install.source.type} source...`);
    resolvedAgentPath = await resolveAgentSource(agent, baseDir, (msg) => log(msg));
  }

  // CLI args (variant args are now post-orchestration, not passed to orchestrator)
  const allArgs = [...args];

  // Detect whether this experiment was resolved through a project suite.
  // When it was, record the suite's canonical id, source URL, and resolved
  // commit sha into the run's manifest provenance fields.
  const suiteProvenance = detectSuiteProvenance(experiment.dir, project, {
    // Surface suite-resolution failures persistently — they signal a real
    // config problem the user should see even without --verbose.
    onWarn: (message) => info(message),
  });
  if (suiteProvenance) {
    log(`Suite provenance: ${suiteProvenance.id}${suiteProvenance.version ? ` @ ${suiteProvenance.version.slice(0, 12)}` : ''}`);
  }

  // Create run (includes variant in manifest). The manifest's `agent.variant`
  // field currently records the agent variant (the only one the CLI exposes
  // today); a future split into agent/experiment variant tracking lands with
  // the run manifest work in task 13.
  const initialManifest = createRun({
    experimentId: experiment.name,
    experimentPath: experiment.dir,
    agentId: agent.name,
    agentPath: resolvedAgentPath,
    args: allArgs,
    baseDir,
    variant: agentVariant,
    suite: suiteProvenance,
  });
  const runId = initialManifest.run_id;

  log(`Created run ${runId}`);

  // Track current run for signal handling
  activeRun = {
    runId,
    baseDir,
    runDir: getRunDir(runId, baseDir),
    phase: 'init',
    container: null,
    proxyInfo: null,
    scorerContainer: null,
    cleaningUp: false,
    terminalEventEmitted: false,
  };

  // Best-effort event emit. Never let JSONL append errors fail a run — the
  // manifest is still authoritative for run state.
  const emit = (event: RunEventInput) => {
    try {
      appendRunEvent(runId, event, baseDir);
    } catch (err) {
      log(`Failed to emit run event: ${err instanceof Error ? err.message : err}`);
    }
  };

  const runStartedAt = Date.now();
  emit({ event: 'run.started', data: { id: runId } });

  try {
    // Update status to running
    updateRunStatus(runId, 'running', undefined, baseDir);

    mutateRunManifest(runId, baseDir, (m) => {
      m.platform = runPlatform;
    });

    // Prepare the Docker image + agent artifacts (using resolved environment).
    // Both fall under the install.build phase: image prep is the
    // experiment-side build, agent artifact prep is the agent-side build.
    // `installBuildCacheHit` flips to false the first time either prep
    // function reports an actual build via its onCacheHit(false) callback.
    activeRun.phase = 'install.build';
    emit({
      event: 'install.build.started',
      data: { agent: agent.name, ...(agentVariant ? { variant: agentVariant } : {}) },
    });
    const installBuildStart = Date.now();
    let installBuildCacheHit = true;
    const noteCacheHit = (hit: boolean) => {
      if (!hit) installBuildCacheHit = false;
    };

    progress('Preparing Docker image...');
    const imagePrepLog = createTransientLineForwarder();
    const imageName = await prepareExperimentImage(
      experiment,
      resolvedEnv,
      runId,
      runPlatform,
      (msg) => imagePrepLog(msg),
      noteCacheHit
    );
    clearTransientLogs();

    // install.deps build/cache. Runs before install.build so the build can
    // shell out to any binary a dep provides (e.g., curl from a dep used
    // during the agent's own build script).
    const preparedDeps = await prepareAgentDeps(agent, runPlatform, baseDir, {
      forceRebuild: rebuildAgent,
      onProgress: (msg) => progress(msg),
    });
    for (const dep of preparedDeps) {
      if (!dep.cacheHit) noteCacheHit(false);
    }
    if (preparedDeps.length > 0) {
      mutateRunManifest(runId, baseDir, (m) => {
        m.agent.deps = preparedDeps.map((dep) => ({
          name: dep.name,
          ...(dep.version !== undefined ? { version: dep.version } : {}),
          cache_key: dep.cacheKey,
          binaries: dep.binaries,
        }));
      });
    }

    // Record any cross-boundary binary shadows so they're visible in the run
    // manifest instead of silently resolving on PATH. Non-blocking.
    const shadows = detectCrossBoundaryShadows(preparedDeps, resolvedEnv.packages);
    if (shadows.length > 0) {
      for (const shadow of shadows) {
        const sourceLabel = SHADOWED_SUBSTRATE_SOURCE_LABEL[shadow.shadowed.source];
        log(
          `cross-boundary-binary-shadow: ${shadow.binary} provided by both ` +
            `agent dep ${shadow.winner.name} and ${sourceLabel}; ${shadow.resolution}`,
        );
      }
      mutateRunManifest(runId, baseDir, (m) => {
        m.diagnostics = [...(m.diagnostics ?? []), ...shadows];
      });
    }

    // Build/cache agent artifacts after platform resolution so build caches/runtime match the run.
    const agentArtifactsPath = await prepareAgentArtifacts(
      agent,
      resolvedAgentPath,
      runPlatform,
      baseDir,
      (msg) => progress(msg),
      rebuildAgent,
      noteCacheHit,
      preparedDeps
    );

    emit({
      event: 'install.build.completed',
      data: {
        cacheHit: installBuildCacheHit,
        durationMs: Date.now() - installBuildStart,
      },
    });

    // Set up mounts
    const mounts = createMounts(experiment, resolvedAgentPath, agentArtifactsPath, preparedDeps);
    const depsPathPrefix = buildDepsPathPrefix(preparedDeps);
    const depsPathExport = buildArtifactsPathExport(preparedDeps);

    // Host-side tmpdir that mirrors the agent's /bunsen/output/ — post-run
    // auto-capture reads from this path.
    const agentOutputHostDir = path.join(os.tmpdir(), `bunsen-agent-output-${runId}`);
    fs.mkdirSync(agentOutputHostDir, { recursive: true });

    mounts.push({
      source: agentOutputHostDir,
      target: STABLE_PATHS.outputDir,
      readonly: false,
    });

    // Internal /output mount — bunsen writes workspace.diff / workspace.tar.gz
    // here during post-run artifact capture. Separate from /bunsen/output/
    // (agent-authored artifacts) to keep the contracts independent.
    const tempOutputDir = path.join(os.tmpdir(), `bunsen-output-${runId}`);
    fs.mkdirSync(tempOutputDir, { recursive: true });
    mounts.push({
      source: tempOutputDir,
      target: '/output',
      readonly: false,
    });

    // Verifiers mount: read-only, present for every run so script scorers and
    // any agent that wants to inspect the expected-output contract can find
    // their files at a stable path. Agent-container scoring used to add this
    // mount conditionally; it is now always added when the experiment declares
    // a verifiers/ directory.
    if (experiment.verifiersPath) {
      mounts.push({
        source: experiment.verifiersPath,
        target: STABLE_PATHS.verifiersDir,
        readonly: true,
      });
    }

    // --- 8-source environment merge (see `mergeRunEnvironment` in env.ts) ---
    //
    // Slots 2+4 (agent defaults + agent variant) and 3+5 (experiment defaults +
    // experiment variant) are already combined by the respective config loaders'
    // variant application, which preserves last-wins precedence within each pair.
    // We feed the merged view into mergeRunEnvironment as a single source per
    // pair; the ordering between slots 1 → 5 is still strictly respected.
    const defaultPassEnv = [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
    ];
    // The agent's declared model `default` seeds its model env var at the
    // agent-defaults tier — same precedence the model held when it lived in
    // `defaults.env`, so a variant that pins the model (folded into
    // `agent.defaults.env` by variant application) still wins over the default.
    const agentDefaultsEnv: Record<string, string> | undefined =
      modelSelection?.defaultValue !== undefined
        ? { [modelSelection.envName]: modelSelection.defaultValue, ...agent.defaults?.env }
        : agent.defaults?.env;

    // The `--model` override rides the CLI `--env` tier so it beats agent and
    // variant defaults; an explicit `--env <VAR>=...` still wins (it lands
    // later in the flag list).
    const modelOverrideFlags =
      modelSelection?.overrideValue !== undefined
        ? [`${modelSelection.envName}=${modelSelection.overrideValue}`]
        : [];

    const envSources: RunEnvSource[] = [
      {
        label: 'project defaults',
        env: project.config.defaults?.env,
        // Always allow the major LLM provider API keys through by default so
        // existing experiments keep working without an explicit passEnv block.
        passEnv: [
          ...(project.config.defaults?.passEnv ?? []),
          ...defaultPassEnv,
        ],
      },
      {
        label: 'agent defaults',
        env: agentDefaultsEnv,
        passEnv: agent.defaults?.passEnv,
      },
      {
        label: 'experiment',
        env: experiment.env,
        passEnv: experiment.passEnv,
      },
    ];

    const reserved = buildReservedEnv({
      runId: runId,
      experimentName: experiment.name,
      agentName: agent.name,
      platform: runPlatform,
      requiresRoot: experiment.environment.user === 'root',
      agentVariant,
      experimentVariant,
      ...(suiteProvenance ? { suiteId: suiteProvenance.id } : {}),
      ...(suiteProvenance?.version ? { suiteVersion: suiteProvenance.version } : {}),
    });

    const env: Record<string, string> = mergeRunEnvironment({
      sources: envSources,
      cliEnvFiles,
      cliEnvFlags: [...modelOverrideFlags, ...cliEnvFlags],
      cliPassEnv,
      reserved,
    });

    // Record the model the agent was *configured* with — the merged value of
    // its declared model env var, after override/variant/default all applied.
    // This is the launch-time intent; `agent.models` (observed from traces) is
    // recorded later from what actually ran.
    if (modelSelection !== undefined) {
      const configuredModel = env[modelSelection.envName];
      if (configuredModel !== undefined) {
        mutateRunManifest(runId, baseDir, (m) => {
          m.agent.model = configuredModel;
        });
      }
    }

    // Set up tracing if enabled
    let proxyInfo: ProxyContainerInfo | undefined;
    const runDir = getRunDir(runId, baseDir);
    const tracesDir = path.join(runDir, 'traces');

    if (!skipTraces) {
      progress('Starting trace capture...');
      try {
        proxyInfo = await startProxyContainer(runId, getAddonScriptPath(), tracesDir, (msg) =>
          log(msg)
        );
        activeRun.proxyInfo = proxyInfo;
        // Give the proxy a moment to start up
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (err) {
        log(`Warning: Failed to start trace proxy: ${err instanceof Error ? err.message : err}`);
        // Continue without tracing rather than failing the run
      }
    }

    // Get platform tool bundle paths (for in-container orchestration and evaluation)
    const orchestratorBundlePath = getPlatformBundlePath('orchestrator');
    const scorerBundlePath = getPlatformBundlePath('scorer');
    const supervisorBundlePath = getPlatformBundlePath('supervisor');
    const gitignoreFilterBundlePath = getPlatformBundlePath('gitignore-filter');
    const hasOrchestratorBundle = fs.existsSync(orchestratorBundlePath);
    const hasScorerBundle = fs.existsSync(scorerBundlePath);
    const hasSupervisorBundle = fs.existsSync(supervisorBundlePath);
    const hasGitignoreFilterBundle = fs.existsSync(gitignoreFilterBundlePath);

    // Check if we need the Node.js runtime (for custom images or custom Dockerfiles)
    const baseImage = resolvedEnv.baseImage;
    const needsNodeRuntime = experiment.hasDockerfile || !isBunsenImage(baseImage);
    const nodeRuntimePath = getNodeRuntimePath(runPlatform);
    const hasNodeRuntime = fs.existsSync(nodeRuntimePath);

    if (!skipOrchestration && !hasOrchestratorBundle) {
      throw new Error(
        `Orchestrator bundle not found at ${orchestratorBundlePath}. ` +
          `Run 'pnpm build:bundles' in packages/agents to build it.`
      );
    }

    // Scorer bundle only needed if there are LLM-based criteria (not
    // script/aggregate-only) or a dedicated `evaluation.report` step.
    const needsScorerBundle =
      !skipEvaluation &&
      (experiment.evaluation.criteria.some((c) => {
        const type = determineScorerType(c);
        return type !== 'code' && type !== 'aggregate';
      }) ||
        experiment.evaluation.report !== undefined);
    if (needsScorerBundle && !hasScorerBundle) {
      throw new Error(
        `Scorer bundle not found at ${scorerBundlePath}. ` +
          `Run 'pnpm build:bundles' in packages/agents to build it.`
      );
    }

    // Gitignore filter is optional - we'll fall back to shell-based filtering if not available
    if (hasInitialWorkspaceSource(experiment) && !hasGitignoreFilterBundle) {
      log(`Gitignore filter bundle not found at ${gitignoreFilterBundlePath}, will use shell-based fallback`);
    }

    // Determine if supervisor is needed. The agent's `interaction.mode` is the
    // canonical source (already variant-merged); `resolvedSupervisor` is kept as
    // an explicit executor-side override for CLI tooling that sets it directly.
    const useSupervisor =
      resolvedSupervisor !== undefined
        ? resolvedSupervisor
        : agent.interaction.mode === 'supervised';
    const needsTmux = record || useSupervisor;

    // Supervisor bundle is optional - will log a message if not available
    if (useSupervisor && !hasSupervisorBundle) {
      log(`Supervisor bundle not found at ${supervisorBundlePath}, interactive prompt handling disabled`);
    }

    // For custom images, we need the Node.js runtime. These per-platform Node
    // binaries are not shipped in the interim npm `@bunsen-dev/cli` (tens of MB
    // each), so custom-Dockerfile / non-bunsen-base-image experiments require a
    // from-source checkout for now. bunsen-base-image experiments (the common
    // case) need no Node runtime and work from the npm install.
    if (needsNodeRuntime && !hasNodeRuntime && (!skipOrchestration || !skipEvaluation)) {
      throw new Error(
        `Node.js runtime for ${runPlatform} not found at ${nodeRuntimePath}. ` +
          `This experiment uses a custom/non-bunsen base image, which the interim ` +
          `npm CLI does not bundle the Node runtime for. Use a from-source checkout ` +
          `and run 'pnpm build:bundles:runtime' in packages/agents to download it.`
      );
    }

    // Get API key for platform agents (orchestrator and/or scorer)
    const platformApiKey = process.env.BUNSEN_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!skipOrchestration && !platformApiKey) {
      throw new Error(
        'BUNSEN_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY environment variable is required for orchestration'
      );
    }
    // Check if evaluation needs an API key (script + aggregate only rubrics
    // without a report step don't need one).
    const needsEvalApiKey =
      !skipEvaluation &&
      (experiment.evaluation.criteria.some((c) => {
        const type = determineScorerType(c);
        return type !== 'code' && type !== 'aggregate';
      }) ||
        experiment.evaluation.report !== undefined);
    if (needsEvalApiKey && !platformApiKey) {
      throw new Error(
        'BUNSEN_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY environment variable is required for evaluation'
      );
    }

    // Add mounts for platform tool bundles and run data
    if (!skipOrchestration) {
      mounts.push({
        source: orchestratorBundlePath,
        target: '/bunsen/lib/orchestrator.cjs',
        readonly: true,
      });
    }
    // Mount run directory unconditionally — the agent execution path writes
    // agent-script.sh, logs, and completion markers under /bunsen/run regardless
    // of whether evaluation or tmux is enabled.
    mounts.push({ source: runDir, target: '/bunsen/run', readonly: false });
    // Mount gitignore-filter if available (for workspace diff/export)
    if (hasInitialWorkspaceSource(experiment) && hasGitignoreFilterBundle) {
      mounts.push({
        source: gitignoreFilterBundlePath,
        target: '/bunsen/lib/gitignore-filter.cjs',
        readonly: true,
      });
    }
    // Mount supervisor if needed and bundle available
    if (useSupervisor && hasSupervisorBundle) {
      mounts.push({
        source: supervisorBundlePath,
        target: '/bunsen/lib/supervisor.cjs',
        readonly: true,
      });
    }
    // For custom images, mount the Node.js runtime in agent container
    // Needed for orchestration, supervisor, or agent-container scoring (LLM scorers).
    const scoreInAgentContainer = experiment.evaluation.container === 'agent';
    const needsNodeInAgent = needsNodeRuntime && (
      !skipOrchestration ||
      (useSupervisor && hasSupervisorBundle) ||
      (scoreInAgentContainer && needsScorerBundle)
    );
    if (needsNodeInAgent) {
      mounts.push({
        source: nodeRuntimePath,
        target: '/bunsen/runtime/node',
        readonly: true,
      });
    }

    // When scoring in agent container, pre-mount scorer-related directories
    // (Docker can't add mounts to a running container)
    let agentScorerOutputDir: string | undefined;
    if (scoreInAgentContainer && !skipEvaluation) {
      agentScorerOutputDir = path.join(os.tmpdir(), `bunsen-scorer-output-${runId}`);
      fs.mkdirSync(agentScorerOutputDir, { recursive: true });

      mounts.push({
        source: agentScorerOutputDir,
        target: '/bunsen/scorer-output',
        readonly: false,
      });

      // Mount scorer bundle for LLM-based scoring
      if (hasScorerBundle && needsScorerBundle) {
        mounts.push({
          source: scorerBundlePath,
          target: '/bunsen/lib/scorer.cjs',
          readonly: true,
        });
      }
    }

    // If tracing, mount proxy certs and the undici proxy-bootstrap bundle.
    // The bundle is required via NODE_OPTIONS to force Node's native fetch
    // through the mitmproxy (it ignores HTTPS_PROXY by default).
    if (proxyInfo) {
      mounts.push({ source: proxyInfo.certsDir, target: '/mitmproxy-certs', readonly: false });
      const proxyBootstrapPath = getPlatformBundlePath('proxy-bootstrap');
      if (fs.existsSync(proxyBootstrapPath)) {
        mounts.push({
          source: proxyBootstrapPath,
          target: '/bunsen/runtime/proxy-bootstrap.cjs',
          readonly: true,
        });
      } else {
        log(
          `Warning: proxy-bootstrap bundle not found at ${proxyBootstrapPath}. ` +
            `Run 'pnpm build:bundles' in packages/agents to build it. ` +
            `Without it, Node-based agents (e.g., Claude Code) will bypass the trace proxy.`,
        );
      }
    }

    // When scoring in agent container, add platform API key for LLM scorers
    if (scoreInAgentContainer && platformApiKey && needsScorerBundle) {
      env.BUNSEN_ANTHROPIC_API_KEY = platformApiKey;
    }

    // Create persistent container (stays alive for agent + evaluator)
    progress('Starting container...');
    const container = await createPersistentContainer(
      {
        image: imageName,
        mounts,
        env,
        workdir: '/workspace',
        platform: runPlatform,
      },
      { runId: runId, name: `bunsen-run-${runId}` }
    );
    activeRun.container = container;

    let result: { exitCode: number; stdout: string; stderr: string; durationMs: number };
    // Track whether evaluation threw so we can compute final run status
    // after the agent + eval phases finish. Gate failures don't fail the
    // run — they're a scored outcome, not an error.
    let evaluationThrew = false;

    try {
      // ===== Setup phase ordering =====
      //
      // 1. install.build (cached, platform-keyed) — done at image prep time above.
      // 2. Mount build artifacts and image-backed inputs — done at container creation above.
      // 3. Assemble workspace.sources into /workspace-source (NO copy to /workspace yet).
      // 4. Execution user creation + ownership handoff (while /workspace is still empty).
      // 5. Materialize /workspace from /workspace-source as the execution user.
      //    Running cp -a as bunsen produces bunsen-owned files in /workspace without a
      //    recursive chown, which is critical for large immutable seeds.
      // 6. install.configure (per-run, fast).
      // 7. workspace.setup (per-run, fast).
      // 8. Agent execution.
      //
      // See docs/ENVIRONMENT.md for the setup-ordering rationale.
      // =======================================================================

      // Step 3: Assemble /workspace-source. /workspace stays empty for now.
      // The assembly script also runs a recursive chmod to make the source
      // world-readable so the non-root user can materialize from it in step 5.
      activeRun.phase = 'workspace.sources';
      emit({ event: 'workspace.sources.started', data: {} });
      const workspaceSourcesStart = Date.now();
      log('Assembling workspace sources...');
      await execShellInContainer(
        container,
        buildWorkspaceSourceAssemblyScript(experiment),
        {
          env,
          workdir: '/',
          timeout: 600000, // 10 minutes for assembly + recursive chmod on large seeds
        }
      );
      emit({
        event: 'workspace.sources.completed',
        data: {
          sourceCount: experiment.workspaceSources.length,
          durationMs: Date.now() - workspaceSourcesStart,
        },
      });

      // Ensure every stable /bunsen/* path the runtime contract promises
      // exists inside the container before the agent runs. Bind-mounts handle
      // the rest (/bunsen/artifacts, /bunsen/verifiers).
      await execShellInContainer(container, buildStablePathsMkdirScript(), {
        workdir: '/',
        timeout: 10000,
      });

      // Write the canonical task prompt to /bunsen/task/prompt.md inside the
      // container, AND mirror it to the run dir at task/prompt.md so the
      // exact prompt the agent received survives in the run record.
      await writeFileInContainer(container, STABLE_PATHS.taskFile, experiment.task.prompt);
      saveTaskPrompt(runId, experiment.task.prompt, baseDir);

      // For custom images, symlink the mounted Node.js runtime onto PATH
      // so orchestrator-generated commands (e.g. "node /agent/...") work
      if (needsNodeRuntime && hasNodeRuntime) {
        await execShellInContainer(
          container,
          'ln -sf /bunsen/runtime/node /usr/local/bin/node',
          { env, workdir: '/', timeout: 10000 }
        );
      }

      // Step 4: Non-root user creation + ownership handoff.
      // /workspace is still empty at this point, so chown -R is trivial.
      // /workspace-source stays root-owned; the bunsen user reads from it via
      // standard world-readable perms during materialization in step 5.
      let runAsNonRoot = false;
      const requiresRoot = experiment.environment.user === 'root';
      if (!requiresRoot) {
        log('Setting up non-root user for agent execution...');
        const userSetupResult = await execShellInContainer(
          container,
          `# Create bunsen user if it doesn't exist
# Don't hardcode UID — some images have a 'node' user at UID 1000
if ! id bunsen >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then
    useradd -m -s /bin/bash bunsen 2>/dev/null || true
  elif command -v adduser >/dev/null 2>&1; then
    adduser -D -s /bin/bash bunsen 2>/dev/null || true
  fi
fi
# Verify user exists
if id bunsen >/dev/null 2>&1; then
  # Transfer ownership of workspace and bunsen directories.
  # /workspace is still empty and /workspace-source is left root-owned
  # (readable) — see docs/ENVIRONMENT.md.
  chown -R bunsen:bunsen /workspace 2>/dev/null || true
  chown -R bunsen:bunsen /bunsen 2>/dev/null || true
  mkdir -p /home/bunsen && chown -R bunsen:bunsen /home/bunsen 2>/dev/null || true
  echo "SUCCESS"
else
  echo "FALLBACK"
fi`,
          { timeout: 30000 }
        );

        if (userSetupResult.stdout.trim().includes('SUCCESS')) {
          runAsNonRoot = true;
          log('Agent will run as non-root user (bunsen)');
        } else {
          log('Non-root user setup failed, falling back to root execution');
        }
      } else if (requiresRoot) {
        log('Experiment requires root - skipping non-root user setup');
      }

      // Step 5: Materialize /workspace from /workspace-source as the execution user.
      // Running cp -a as bunsen avoids a recursive chown -R over a potentially
      // large seed — bunsen simply owns the output files from the start.
      log('Materializing /workspace from /workspace-source...');
      const materializeScript = buildWorkspaceMaterializationScript();
      await writeFileInContainer(
        container,
        '/tmp/bunsen-materialize-workspace.sh',
        `#!/bin/bash\n${materializeScript}\n`,
        { mode: '755' }
      );
      const materializeCmd = runAsNonRoot
        ? 'su bunsen -c /tmp/bunsen-materialize-workspace.sh'
        : '/tmp/bunsen-materialize-workspace.sh';
      const materializeResult = await execShellInContainer(container, materializeCmd, {
        env,
        workdir: '/',
        timeout: 600000, // 10 minutes — allow for very large immutable seeds
      });
      if (materializeResult.exitCode !== 0) {
        throw new Error(
          `Workspace materialization failed with exit code ${materializeResult.exitCode}: ${materializeResult.stderr}`
        );
      }

      // Step 6: install.configure (as root).
      // Runs as root so the script can install system packages and write to
      // privileged paths if needed. Agent-facing config files should be
      // written to $BUNSEN_AGENT_HOME (set in the reserved env to /root or
      // /home/bunsen depending on the execution user). After the configure
      // step finishes, anything inside that home dir is chowned to the
      // execution user so it's readable/owned correctly when the agent runs.
      if (resolvedEnv.agentConfigure && resolvedEnv.agentConfigure.length > 0) {
        activeRun.phase = 'install.configure';
        emit({ event: 'install.configure.started', data: {} });
        const installConfigureStart = Date.now();
        progress('Running agent runtime configure...');
        // install.configure defaults to as: root (lets steps install system
        // packages and write to privileged paths). A step that explicitly
        // sets `as: user` runs through the bunsen su wrapper in non-root
        // mode so it lands user-owned.
        const installConfigureWrapAs = makeInstallConfigureWrapAs(
          container,
          runAsNonRoot,
          depsPathPrefix,
        );
        await dispatchSteps(container, resolvedEnv.agentConfigure, {
          sourceDir: resolvedAgentPath,
          preScript: depsPathExport,
          env,
          workdir: '/workspace',
          defaultRunTimeoutMs: 120_000, // 2 minutes for runtime configure
          defaultAs: 'root',
          wrapAs: installConfigureWrapAs,
          onOutput: verbose ? onOutputChunk : undefined,
          phaseLabel: 'Agent runtime configure',
        });

        // Configure ran (mostly) as root; anything it wrote into
        // $BUNSEN_AGENT_HOME (= /home/bunsen for non-root runs) is now
        // root-owned. Chown the whole home back to bunsen so the agent can
        // read its config and exec anything in $BUNSEN_AGENT_HOME/.local/bin.
        // (Steps that opted in via `as: user` already landed bunsen-owned;
        // this chown is harmless for them.)
        if (runAsNonRoot) {
          await execShellInContainer(
            container,
            'chown -R bunsen:bunsen /home/bunsen 2>/dev/null || true',
            { timeout: 10000 }
          );
        }
        emit({
          event: 'install.configure.completed',
          data: {
            stepCount: resolvedEnv.agentConfigure.length,
            durationMs: Date.now() - installConfigureStart,
          },
        });
      }

      // Step 7: Workspace setup (as bunsen by default).
      const workspaceSetupSteps = resolvedEnv.experimentSetup;
      if (workspaceSetupSteps && workspaceSetupSteps.length > 0) {
        activeRun.phase = 'workspace.setup';
        emit({ event: 'workspace.setup.started', data: {} });
        const workspaceSetupStart = Date.now();
        progress('Running workspace setup...');

        // workspace.setup defaults to as: user. In non-root mode that wraps
        // run-batches AND writeFile steps in `su bunsen -c <file>` so files
        // land bunsen-owned (the agent will need to modify them). A step
        // that explicitly sets `as: root` escalates and runs directly via
        // docker exec — keeping workdir authority on the dispatcher (not
        // the wrapper) means `as: root` steps still land in /workspace
        // rather than wherever the wrapper happened to cd to.
        const workspaceWrapAs = makeWorkspaceSetupWrapAs(
          container,
          runAsNonRoot,
          depsPathPrefix,
        );
        await dispatchSteps(container, workspaceSetupSteps, {
          sourceDir: experiment.dir,
          preScript: runAsNonRoot ? undefined : depsPathExport,
          env,
          workdir: '/workspace',
          defaultRunTimeoutMs: 300_000,
          defaultAs: 'user',
          wrapAs: workspaceWrapAs,
          onOutput: onOutputChunk,
          phaseLabel: 'Workspace setup',
        });
        emit({
          event: 'workspace.setup.completed',
          data: {
            stepCount: workspaceSetupSteps.length,
            durationMs: Date.now() - workspaceSetupStart,
          },
        });
      }

      // Determine how to run Node.js in the container
      // Bunsen images have Node.js pre-installed, custom images use our mounted runtime
      const nodeCmd = needsNodeRuntime ? '/bunsen/runtime/node' : 'node';

      // Get orchestration (run orchestrator in container or use default)
      let orchestration: OrchestrationResult;
      if (skipOrchestration) {
        // Default orchestration: just run the agent command
        orchestration = {
          setupCommands: ['cd /workspace'],
          invocation: buildDefaultArgvInvocation(agent, experiment, allArgs),
        };
      } else {
        activeRun.phase = 'orchestration';
        // Run orchestrator in container
        progress('Running orchestrator...');
        // Names of env vars that the selected variants contribute, so the
        // orchestrator can call them out in the task prompt it builds. Covers
        // both agent and experiment variants.
        const variantEnvVarNames = [
          ...Object.keys(
            (agentVariant && agentBase.variants?.[agentVariant]?.defaults?.env) ?? {},
          ),
          ...Object.keys(
            (experimentVariant && experimentBase.variants?.[experimentVariant]?.env) ?? {},
          ),
        ];
        const orchestratorResult = await execInContainer(container, [nodeCmd, '/bunsen/lib/orchestrator.cjs'], {
          env: {
            BUNSEN_ANTHROPIC_API_KEY: platformApiKey!,
            BUNSEN_EXPERIMENT_PATH: '/input/experiment/experiment.yaml',
            BUNSEN_AGENT_PATH: '/agent/agent.yaml',
            BUNSEN_CLI_ARGS: JSON.stringify(allArgs),
            BUNSEN_GUARANTEED_ARGS: JSON.stringify(guaranteedArgs),
            BUNSEN_VARIANT_ENV_VAR_NAMES: JSON.stringify(variantEnvVarNames),
            BUNSEN_TRACE_SOURCE: 'orchestrator',
            ...(proxyInfo ? getProxyEnv(proxyInfo) : {}),
          },
          timeout: 60000, // 1 minute timeout for orchestration
          onOutput: (chunk, stream) => {
            if (stream === 'stderr') {
              // Show orchestrator logs as transient (will be cleared when done)
              transientLog(chunk.trim());
            }
          },
        });

        // Clear transient orchestrator logs
        clearTransientLogs();

        if (orchestratorResult.exitCode !== 0) {
          throw new Error(
            `Orchestrator failed with exit code ${orchestratorResult.exitCode}: ${orchestratorResult.stderr}`
          );
        }

        // Parse orchestration result from stdout (JSON)
        try {
          orchestration = parseOrchestrationResult(orchestratorResult.stdout.trim());
        } catch (parseError) {
          throw new Error(
            `Failed to parse orchestration result: ${parseError instanceof Error ? parseError.message : parseError}`
          );
        }

        log(`Orchestration: ${formatInvocationForLog(orchestration.invocation)}`);
      }

      // Append guaranteed args (from agent.entrypoint.args + variant args).
      // These attach as additional argv tokens — no shell quoting needed.
      if (guaranteedArgs.length > 0) {
        if (!runAsNonRoot && guaranteedArgs.includes('--dangerously-skip-permissions')) {
          const rootReason = requiresRoot
            ? `This experiment sets environment.user: root, so the agent must run as root.`
            : `Bunsen could not run as the non-root "bunsen" user in this container and fell back to root.`;
          throw new Error(
            `Agent args include --dangerously-skip-permissions, but this run is executing as root. ` +
              `${rootReason} ` +
              `Use this agent on experiments that do not set requires_root: true, or choose/create an agent variant without that flag.`
          );
        }
        orchestration.invocation.args = [...orchestration.invocation.args, ...guaranteedArgs];
        log(`Appended args: ${guaranteedArgs.join(' ')}`);
      }

      info(`Agent invocation command:`);
      info(`  ${formatInvocationForLog(orchestration.invocation)}`);

      // Save orchestration to the manifest AND to its canonical artifact
      // file (orchestration/result.json). The manifest field is a
      // quick-access projection; the file is what the manifest catalogs.
      mutateRunManifest(runId, baseDir, (m) => {
        m.orchestration = {
          setup_commands: [...orchestration.setupCommands],
          invocation: { ...orchestration.invocation },
        };
      });
      saveOrchestrationResult(runId, orchestration, baseDir);

      // Build the agent command script (workspace copy already done).
      // setupCommands is shell (chained with &&). The invocation is rendered
      // with each arg POSIX-single-quoted so task-text metacharacters never
      // reach bash for reinterpretation.
      const renderedInvocation = renderArgvInvocation(orchestration.invocation);
      const commands: string[] = [...orchestration.setupCommands, renderedInvocation];
      let agentScript = commands.join(' && ');
      agentScript = `${depsPathExport}\n${agentScript}`;

      // If using proxy, prepend CA injection commands
      if (proxyInfo) {
        const caInjection = getCAInjectionCommands();
        agentScript = `${caInjection}\n\n# Agent commands\n${agentScript}`;
      }

      // Run agent commands
      activeRun.phase = 'agent';
      emit({ event: 'agent.started', data: { id: agent.name } });
      const agentStartTime = Date.now();
      progress('Running agent...');
      const agentEnv = proxyInfo ? { ...env, ...getProxyEnv(proxyInfo, env) } : env;

      // tmux mode: used for recording (asciinema) and/or supervisor (interactive prompt handling)
      // Architecture:
      // 1. Create tmux session and set up pipe-pane for output capture
      // 2. Start tail -f to stream output to user
      // 3. If recording, run asciinema which attaches to tmux; otherwise send script directly
      // 4. Agent script runs inside the tmux session
      if (needsTmux) {
        if (record) {
          log(`Recording enabled (terminal size: ${terminalSize})`);
        } else {
          log('tmux mode enabled for supervisor (if you also want to record, pass --record to write out a recording.cast file).');
        }

        // Pre-flight: verify tmux is available (and asciinema if recording)
        const checkTmux = await execShellInContainer(container, 'command -v tmux', { timeout: 5000 });
        if (checkTmux.exitCode !== 0) {
          const tmuxReason = record && useSupervisor
            ? 'for recording and the supervisor'
            : record
              ? 'for recording'
              : 'for the supervisor';
          throw new Error(
            `tmux is required ${tmuxReason} but is not installed in the container image. ` +
            `Options: use a Bunsen base image (bunsen/headless, bunsen/visual), add tmux to your Dockerfile, ` +
            `or include it in your custom image/build process.`
          );
        }
        if (record) {
          const checkAsciinema = await execShellInContainer(container, 'command -v asciinema', { timeout: 5000 });
          if (checkAsciinema.exitCode !== 0) {
            throw new Error(
              `Recording requires asciinema but it is not installed in the container image. ` +
              `Rebuild your base image (e.g. docker build -t bunsen/visual ./images/visual) or run without --record.`
            );
          }
        }

        const [cols, rows] = terminalSize.split('x').map(Number);
        const recordingPath = `/bunsen/run/${RUN_PATHS.artifactsRecording}`;
        const agentScriptFile = '/bunsen/run/agent-script.sh';
        const logFile = '/bunsen/run/logs.txt';
        const markerFile = '/bunsen/run/agent-complete.marker';

        // Write the agent script to a file
        const envExports = Object.entries(agentEnv)
          .map(([k, v]) => `export ${k}="${v.replace(/"/g, '\\"')}"`)
          .join('\n');

        // When running as non-root, set HOME and ensure ~/.local/bin is on PATH
        // (many tools like pip, npm, and Claude Code install binaries to ~/.local/bin)
        const homeExport = runAsNonRoot
          ? `export HOME=/home/bunsen\nexport PATH=${depsPathPrefix}:$HOME/.local/bin:$PATH`
          : depsPathExport;

        const agentScriptContent = `#!/bin/bash
${homeExport}
${envExports}

# Run agent
${agentScript}
EXIT_CODE=\$?

# Write marker file when done
echo \$EXIT_CODE > ${markerFile}
`;

        // Write script (base64-encoded to avoid shell escaping issues) and create empty log file
        // If running as non-root, ensure bunsen owns the script and log file
        await writeFileInContainer(container, agentScriptFile, agentScriptContent, { mode: '755' });
        const ownershipCmd = runAsNonRoot
          ? `&& chown bunsen:bunsen ${agentScriptFile} ${logFile} ${markerFile.replace('/agent-complete.marker', '')}`
          : '';
        await execShellInContainer(
          container,
          `touch ${logFile} ${ownershipCmd}`,
          { timeout: 10000 }
        );

        // If running as non-root, create a launcher script that switches to bunsen user
        // This avoids complex quoting issues with tmux send-keys
        const launcherScriptFile = '/bunsen/run/launcher.sh';
        if (runAsNonRoot) {
          const launcherContent = `#!/bin/bash
exec su bunsen -c "${agentScriptFile}"
`;
          await writeFileInContainer(container, launcherScriptFile, launcherContent, { mode: '755' });
        }

        const startTime = Date.now();

        // 1. Create tmux session
        await execShellInContainer(
          container,
          `tmux new-session -d -s agent -x ${cols} -y ${rows}`,
          { timeout: 10000 }
        );

        // 2. Configure tmux for clean recording (no status bar, no alternate screen buffer)
        await execShellInContainer(
          container,
          `tmux set -t agent status off && tmux set -t agent alternate-screen off`,
          { timeout: 5000 }
        );

        // 3. Set up pipe-pane for output capture
        await execShellInContainer(
          container,
          `tmux pipe-pane -t agent -o 'cat >> ${logFile}'`,
          { timeout: 5000 }
        );

        // 4. Start tail -f to stream output to user (fire and forget)
        void execShellInContainer(
          container,
          `tail -f ${logFile}`,
          {
            timeout: effectiveTimeout,
            onOutput: onOutputChunk,
          }
        ).catch(() => {
          // Ignore errors from tail being killed
        });

        // 5. Send command to tmux session
        // When running as non-root, use the launcher script to avoid quoting issues
        const scriptToRun = runAsNonRoot ? launcherScriptFile : agentScriptFile;
        if (record) {
          // Recording: wrap in asciinema so recording contains only agent output (no tmux escape codes)
          const asciinemaCmd = `asciinema rec --overwrite --cols ${cols} --rows ${rows} -c ${scriptToRun} ${recordingPath}`;
          await execShellInContainer(
            container,
            `tmux send-keys -t agent '${asciinemaCmd}' Enter`,
            { timeout: 5000 }
          );
        } else {
          // Supervisor-only: run agent script directly in tmux (no recording)
          await execShellInContainer(
            container,
            `tmux send-keys -t agent '${scriptToRun}' Enter`,
            { timeout: 5000 }
          );
        }

        // 6. Start supervisor agent (if available) to handle interactive prompts
        if (hasSupervisorBundle && platformApiKey && useSupervisor) {
          const supervisorCmd = needsNodeRuntime ? '/bunsen/runtime/node' : 'node';
          log('Starting supervisor agent for interactive prompt handling...');

          // Run supervisor in background - it monitors the log file and handles prompts
          void execInContainer(
            container,
            [supervisorCmd, '/bunsen/lib/supervisor.cjs'],
            {
              env: {
                BUNSEN_ANTHROPIC_API_KEY: platformApiKey,
                BUNSEN_TASK_DESCRIPTION: experiment.task.prompt,
                BUNSEN_LOG_FILE: logFile,
                BUNSEN_OUTPUT_FILE: '/bunsen/run/supervisor.json',
                BUNSEN_TMUX_SESSION: 'agent',
                BUNSEN_MARKER_FILE: markerFile,
                BUNSEN_TRACE_SOURCE: 'supervisor',
                ...(proxyInfo ? getProxyEnv(proxyInfo) : {}),
              },
              timeout: effectiveTimeout,
              onOutput: (chunk, stream) => {
                if (stream === 'stderr') {
                  log(chunk.trim());
                }
              },
            }
          ).catch((err) => {
            // Supervisor errors shouldn't fail the run
            log(`Supervisor exited: ${err instanceof Error ? err.message : err}`);
          });

          // Give supervisor a moment to start
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        // 7. Poll for completion (marker file written by agent script)
        const pollInterval = 500;
        const startPoll = Date.now();
        let completed = false;

        while (Date.now() - startPoll < effectiveTimeout) {
          const checkResult = await execShellInContainer(
            container,
            `test -f ${markerFile} && echo "done" || echo "waiting"`,
            { timeout: 5000 }
          );

          if (checkResult.stdout.trim() === 'done') {
            completed = true;
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, pollInterval));
        }

        if (!completed) {
          log('Warning: Agent execution timed out');
        }

        // 8. Clean up (supervisor will exit on its own when it sees the marker file, but kill it just in case)
        await execShellInContainer(container, `tmux pipe-pane -t agent || true`, { timeout: 5000 });
        await execShellInContainer(container, `tmux kill-session -t agent 2>/dev/null || true`, { timeout: 5000 });
        await execShellInContainer(container, `pkill -f "tail -f ${logFile}" || true`, { timeout: 5000 });
        await execShellInContainer(container, `pkill -f "supervisor.cjs" || true`, { timeout: 5000 });

        // Give a moment for files to be flushed and supervisor to write its log
        await new Promise((resolve) => setTimeout(resolve, 500));

        // 9. Read logs and exit code
        const logResult = await execShellInContainer(container, `cat ${logFile}`, { timeout: artifactCaptureTimeoutMs });

        // Read exit code from marker file
        const markerResult = await execShellInContainer(container, `cat ${markerFile} 2>/dev/null || echo 0`, { timeout: 5000 });
        const agentExitCode = parseInt(markerResult.stdout.trim(), 10) || (completed ? 0 : 1);

        // Strip ANSI escape codes from logs for readability.
        // Raw terminal bytes are preserved in recording.cast for full-fidelity replay.
        const logs = stripAnsiCodes(logResult.stdout);
        saveLogs(runId, logs, baseDir);

        // Create result object
        result = {
          exitCode: agentExitCode,
          stdout: logResult.stdout,
          stderr: '',
          durationMs: Date.now() - startTime,
        };

        // Get recording info (only when recording)
        if (record) {
          const recordingInfo = await getRecordingInfo(container);
          if (recordingInfo.exists) {
            log(`Recording saved: ${recordingInfo.size} bytes`);
          }
        }

        if (onLog) {
          onLog(logs);
        }
      } else {
        // Direct execution mode: no tmux, no recording, no supervisor
        // When running as non-root, wrap the script to run as the bunsen user
        let directScript = agentScript;
        if (runAsNonRoot) {
          const envExports = Object.entries(agentEnv)
            .map(([k, v]) => `export ${k}="${v.replace(/"/g, '\\"')}"`)
            .join('\n');
          // Write script to file (base64-encoded to avoid shell escaping issues)
          // and run as bunsen user
          const directScriptContent = `#!/bin/bash
export HOME=/home/bunsen
export PATH=${depsPathPrefix}:$HOME/.local/bin:$PATH
${envExports}
cd /workspace
${agentScript}
`;
          await writeFileInContainer(container, '/bunsen/run/agent-script.sh', directScriptContent, { mode: '755' });
          directScript = `chown bunsen:bunsen /bunsen/run/agent-script.sh && su bunsen -c /bunsen/run/agent-script.sh`;
        }
        try {
          result = await execShellInContainer(container, directScript, {
            env: runAsNonRoot ? {} : agentEnv,
            workdir: runAsNonRoot ? '/' : '/workspace',
            timeout: effectiveTimeout,
            onOutput: onOutputChunk,
          });

          const logs = buildExecLogs(result);
          saveLogs(runId, logs, baseDir);

          if (onLog) {
            onLog(logs);
          }
        } catch (error) {
          if (error instanceof ExecTimeoutError) {
            const logs = buildExecLogs(error);
            saveLogs(runId, logs, baseDir);

            if (onLog) {
              onLog(logs);
            }
          }
          throw error;
        }
      }

      emit({
        event: 'agent.completed',
        data: { exitCode: result.exitCode, durationMs: Date.now() - agentStartTime },
      });
      activeRun.phase = 'capture';

      // Build structured traces for scorer context (don't overwrite traces/agent.jsonl —
      // the proxy is still running and will append scorer/platform traces to it).
      // Streams the file line-by-line; bounded memory regardless of trace size.
      if (!skipTraces) {
        const inputPath = path.join(tracesDir, 'agent.jsonl');
        if (fs.existsSync(inputPath) && fs.statSync(inputPath).size > 0) {
          log('Processing agent traces...');
          await buildThreadsForScorer(runId, baseDir);
        }
      }

      if (hasInitialWorkspaceSource(experiment)) {
        log('Capturing workspace diff...');

        if (hasGitignoreFilterBundle) {
          // Use gitignore-filter for proper gitignore semantics
          // (handles nested .gitignore files, negation patterns, etc.)
          const gitignoreCmd = needsNodeRuntime
            ? '/bunsen/runtime/node /bunsen/lib/gitignore-filter.cjs'
            : 'node /bunsen/lib/gitignore-filter.cjs';

          const diffScript = `
            # Get non-ignored file lists from both directories
            ${gitignoreCmd} /workspace --output /tmp/diff-ws.txt 2>/dev/null
            ${gitignoreCmd} /workspace-source --output /tmp/diff-src.txt 2>/dev/null

            # Union, deduplicate, exclude .claude directory and empty lines
            sort -u /tmp/diff-ws.txt /tmp/diff-src.txt | grep -v '^\\.claude/' | grep -v '^$' > /tmp/diff-files.txt 2>/dev/null || true

            # Generate unified diff for each non-ignored file
            while IFS= read -r file; do
              diff -Nu "/workspace-source/$file" "/workspace/$file"
            done < /tmp/diff-files.txt > /output/workspace.diff 2>&1 || true

            # Clean up
            rm -f /tmp/diff-ws.txt /tmp/diff-src.txt /tmp/diff-files.txt
          `;

          await execShellInContainer(
            container,
            diffScript,
            {
              env,
              workdir: '/',
              timeout: artifactCaptureTimeoutMs,
            }
          );
        } else {
          // Fallback: shell-based .gitignore parsing (root .gitignore only)
          const diffScript = `
            cd /workspace
            EXCLUDES="--exclude=.git --exclude=.claude"
            if [ -f .gitignore ]; then
              # Parse .gitignore: skip comments, empty lines, negations; remove trailing slashes
              while IFS= read -r line || [ -n "$line" ]; do
                line=$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
                [ -z "$line" ] && continue
                [ "\${line:0:1}" = "#" ] && continue
                [ "\${line:0:1}" = "!" ] && continue
                pattern=$(echo "$line" | sed 's|/\\+$||')
                EXCLUDES="$EXCLUDES --exclude=$pattern"
              done < .gitignore
            else
              # Fallback exclusions when no .gitignore
              for p in node_modules .pnpm-store vendor __pycache__ .venv venv .pytest_cache dist build out .next .nuxt .output .turbo coverage .nyc_output .idea .vscode .DS_Store; do
                EXCLUDES="$EXCLUDES --exclude=$p"
              done
            fi
            diff -rNu $EXCLUDES /workspace-source /workspace > /output/workspace.diff 2>&1 || true
          `;

          await execShellInContainer(
            container,
            diffScript,
            {
              env,
              workdir: '/',
              timeout: artifactCaptureTimeoutMs,
            }
          );
        }

        // Export workspace as tar.gz if requested
        if (options.exportWorkspace) {
          log('Exporting workspace...');

          if (hasGitignoreFilterBundle) {
            // Use gitignore-filter for proper gitignore semantics
            // (handles nested .gitignore files, negation patterns, etc.)
            const gitignoreCmd = needsNodeRuntime
              ? '/bunsen/runtime/node /bunsen/lib/gitignore-filter.cjs'
              : 'node /bunsen/lib/gitignore-filter.cjs';
            await execShellInContainer(
              container,
              `${gitignoreCmd} /workspace --output /output/tar-files.txt`,
              {
                env,
                workdir: '/',
                timeout: artifactCaptureTimeoutMs,
              }
            );

            await execShellInContainer(
              container,
              'tar -czf /output/workspace.tar.gz -C /workspace -T /output/tar-files.txt && rm /output/tar-files.txt',
              {
                env,
                workdir: '/',
                timeout: artifactCaptureTimeoutMs,
              }
            );
          } else {
            // Fallback: use git ls-files if available, otherwise shell-based filtering
            const exportScript = `
              cd /workspace
              if git rev-parse --git-dir > /dev/null 2>&1; then
                # Git repo: use git ls-files for proper gitignore handling
                (git ls-files; git ls-files --others --exclude-standard) | sort -u > /output/tar-files.txt
              else
                # Not a git repo: use find with exclusions
                EXCLUDES=""
                if [ -f .gitignore ]; then
                  while IFS= read -r line || [ -n "$line" ]; do
                    line=$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
                    [ -z "$line" ] && continue
                    [ "\${line:0:1}" = "#" ] && continue
                    [ "\${line:0:1}" = "!" ] && continue
                    pattern=$(echo "$line" | sed 's|/\\+$||')
                    EXCLUDES="$EXCLUDES -not -path './$pattern' -not -path './$pattern/*'"
                  done < .gitignore
                else
                  for p in node_modules .pnpm-store vendor __pycache__ .venv venv .pytest_cache dist build out .next .nuxt .output .turbo coverage .nyc_output .idea .vscode .DS_Store .git; do
                    EXCLUDES="$EXCLUDES -not -path './$p' -not -path './$p/*'"
                  done
                fi
                eval "find . -type f $EXCLUDES" | sed 's|^\\./||' | sort > /output/tar-files.txt
              fi
              tar -czf /output/workspace.tar.gz -C /workspace -T /output/tar-files.txt
              rm /output/tar-files.txt
            `;

            await execShellInContainer(
              container,
              exportScript,
              {
                env,
                workdir: '/',
                timeout: artifactCaptureTimeoutMs,
              }
            );
          }

          log('Workspace exported to workspace.tar.gz');
        }
      }

      // Promote the bunsen-written workspace artifacts from the temp /output
      // mount into their v1 run-dir locations:
      //   /output/workspace.diff    -> workspace/diff.patch
      //   /output/workspace.tar.gz  -> workspace/export.tar.gz
      log('Capturing workspace artifacts...');
      if (hasInitialWorkspaceSource(experiment)) {
        const diffPath = path.join(tempOutputDir, 'workspace.diff');
        if (fs.existsSync(diffPath)) {
          const diff = fs.readFileSync(diffPath, 'utf-8');
          saveWorkspaceDiff(runId, diff, baseDir);
        }
      }
      const tarSrc = path.join(tempOutputDir, 'workspace.tar.gz');
      if (fs.existsSync(tarSrc)) {
        const tarDst = path.join(getRunDir(runId, baseDir), RUN_PATHS.workspaceTar);
        fs.mkdirSync(path.dirname(tarDst), { recursive: true });
        fs.copyFileSync(tarSrc, tarDst);
      }

      // Auto-capture whatever the agent wrote to /bunsen/output/. Destination
      // matches the design doc's `runs/<id>/artifacts/output/` layout so the
      // run-manifest writer (task 13) can ingest it without a re-shuffle.
      const agentOutputDestDir = path.join(
        getRunDir(runId, baseDir),
        'artifacts',
        'output',
      );
      const outputCapture = captureAgentOutput({
        hostOutputDir: agentOutputHostDir,
        destDir: agentOutputDestDir,
      });
      if (outputCapture.artifacts.length > 0 || outputCapture.flags.length > 0) {
        fs.writeFileSync(
          path.join(agentOutputDestDir, '.capture.json'),
          JSON.stringify(
            {
              artifacts: outputCapture.artifacts,
              flags: outputCapture.flags,
              totalBytes: outputCapture.totalBytes,
              totalLimitExceeded: outputCapture.totalLimitExceeded,
            },
            null,
            2,
          ),
        );
      }
      log(
        `Captured ${outputCapture.artifacts.length} agent output file(s) ` +
          `(${outputCapture.totalBytes} bytes` +
          (outputCapture.totalLimitExceeded ? ', total cap exceeded' : '') +
          `)`,
      );

      // Clean up temp output directories
      fs.rmSync(tempOutputDir, { recursive: true, force: true });
      fs.rmSync(agentOutputHostDir, { recursive: true, force: true });

      // Record the agent's exit code on the manifest, but don't flip status
      // to a terminal value yet — evaluation still needs to run, and the
      // run's terminal status reflects the entire run (agent + eval), not
      // just the agent.
      mutateRunManifest(runId, baseDir, (m) => {
        m.exit_code = result.exitCode;
      });

      // Run evaluation (if not skipped)
      if (!skipEvaluation) {
        activeRun.phase = 'evaluation';
        emit({
          event: 'evaluation.started',
          data: { criterionCount: experiment.evaluation.criteria.length },
        });
        progress('Running evaluation...');

        // Check if any rubric criteria need a scorer container (anything
        // except aggregate), or if we need the scorer bundle for the report.
        const hasContainerScorers =
          experiment.evaluation.criteria.some((c) => {
            const t = determineScorerType(c);
            return t !== 'aggregate';
          }) || experiment.evaluation.report !== undefined;

        let extractedWorkspaceDir: string | undefined;
        let extractedWorkspaceSourceDir: string | undefined;
        let scorerContainerInfo: ScorerContainerInfo | undefined;
        let usedAgentContainerForScoring = false;

        try {
          // Validate rubric
          validateRubric(experiment.evaluation.criteria);

          if (scoreInAgentContainer && hasContainerScorers) {
            // Agent-container scoring: reuse the agent's container
            log('Setting up scoring in agent container...');

            // Write bunsen-score helper into agent container and symlink to PATH
            await writeFileInContainer(container, '/bunsen/bin/bunsen-score', BUNSEN_SCORE_SCRIPT, { mode: '755' });
            await execShellInContainer(
              container,
              `ln -sf /bunsen/bin/bunsen-score /usr/local/bin/bunsen-score`,
              { timeout: 10000 }
            );

            // Wrap agent container as ScorerContainerInfo
            scorerContainerInfo = {
              container,
              outputDir: agentScorerOutputDir!,
              execUser: runAsNonRoot ? 'bunsen' : undefined,
              execEnv: runAsNonRoot ? { HOME: '/home/bunsen' } : undefined,
            };
            usedAgentContainerForScoring = true;
            // Don't set activeRun.scorerContainer — we don't want the signal
            // handler to stop the agent container twice.
          } else if (hasContainerScorers) {
            // Default path: extract workspace and create separate scorer container
            log('Extracting workspace for scorer container...');
            const extractedScorerInputDir = path.join(os.tmpdir(), `bunsen-scorer-input-${runId}`);
            extractedWorkspaceDir = await extractContainerDirectory(
              container.id,
              '/workspace',
              path.join(extractedScorerInputDir, 'workspace')
            );
            extractedWorkspaceSourceDir = await extractContainerDirectory(
              container.id,
              '/workspace-source',
              path.join(extractedScorerInputDir, 'workspace-source')
            );
          }

          // Resolve criteria and get execution order
          const resolvedCriteria = resolveCriteria(experiment.evaluation.criteria);
          const executionOrder = getExecutionOrder(experiment.evaluation.criteria);

          log(`Evaluating ${executionOrder.length} criteria: ${executionOrder.join(', ')}`);

          // Track results and dependency scores
          const criterionResults: CriterionResult[] = [];
          const dependencyScores: Record<string, DependencyScore> = {};
          let report: string | undefined;

          // Track gate failure for early exit
          let gateFailure: { criterion: string; score: number | null; threshold: string } | null =
            null;

          // Evaluate each criterion in dependency order
          for (const criterionName of executionOrder) {
            const criterion = resolvedCriteria.find((c) => c.id === criterionName)!;
            const criterionStart = Date.now();
            emit({ event: 'criterion.started', data: { id: criterion.id } });

            // If a gate failed, skip all remaining criteria (report is run
            // separately after the loop and is unaffected by gate failures).
            if (gateFailure) {
              progress(`Skipping: ${criterion.id} (gate failed: ${gateFailure.criterion})`);

              const skippedResult: CriterionResult = {
                id: criterion.id,
                weight: criterion.resolvedWeight,
                score: null,
                summary: `Skipped: gate criterion "${gateFailure.criterion}" failed (scored ${gateFailure.score ?? 'null'}, required ${gateFailure.threshold})`,
                status: 'skipped',
                scorerType: criterion.type,
              };

              if (criterion.scores) {
                skippedResult.allowedScores = criterion.scores;
              }

              criterionResults.push(skippedResult);
              dependencyScores[criterion.id] = {
                score: null,
                summary: skippedResult.summary,
              };

              log(`  ${criterion.id}: SKIPPED - ${skippedResult.summary}`);
              emit({
                event: 'criterion.completed',
                data: {
                  id: criterion.id,
                  score: null,
                  durationMs: Date.now() - criterionStart,
                  status: 'skipped',
                },
              });
              continue;
            }

            progress(`Scoring: ${criterion.id}`);

            let output: ScorerOutput;

            if (criterion.type === 'aggregate') {
              // Run aggregate locally (no LLM needed)
              output = runAggregate(
                criterion.aggregate.function,
                Object.fromEntries(
                  criterion.resolvedDependencies.map((name) => [name, dependencyScores[name]])
                ),
                experiment.evaluation.criteria
              );
            } else {
              // All non-aggregate scorers run in a container
              // Lazy-create scorer container on first non-aggregate criterion (default path only)
              if (!scorerContainerInfo) {
                log('Creating scorer container...');
                scorerContainerInfo = await createScorerContainer({
                  image: imageName,
                  workspaceDir: extractedWorkspaceDir || runDir,
                  workspaceSourceDir: extractedWorkspaceSourceDir,
                  runDir,
                  verifiersPath: experiment.verifiersPath,
                  runId: runId,
                  platform: runPlatform,
                  scorerBundlePath: hasScorerBundle ? scorerBundlePath : undefined,
                  nodeRuntimePath: needsNodeRuntime ? nodeRuntimePath : undefined,
                  apiKey: platformApiKey,
                  reservedEnv: reserved,
                  proxyCertsDir: proxyInfo?.certsDir,
                  proxyBootstrapBundlePath: proxyInfo
                    ? getPlatformBundlePath('proxy-bootstrap')
                    : undefined,
                });
                activeRun.scorerContainer = scorerContainerInfo;
              }

              if (criterion.type === 'script') {
                // Script scorer: run shell command.
                const scriptTimeoutMs = parseOptionalDuration(criterion.timeout) ?? 60_000;
                output = await runCodeScorer(scorerContainerInfo, {
                  code: criterion.run,
                  criterion: criterion.id,
                  runDir,
                  timeout: Math.ceil(scriptTimeoutMs / 1000),
                });
              } else {
                // LLM-based scorer (judge, agent, browser-agent): run scorer binary.
                const scorerConfig: ScorerConfig = buildScorerConfig(
                  criterion,
                  '/bunsen/run',
                  '/workspace',
                  Object.fromEntries(
                    criterion.resolvedDependencies.map((name) => [name, dependencyScores[name]])
                  )
                );

                const criterionTimeout =
                  parseOptionalDuration(criterion.timeout) ?? DEFAULT_CRITERION_TIMEOUT_MS;

                output = await runLLMScorer(scorerContainerInfo, {
                  configJson: JSON.stringify(scorerConfig, null, 2),
                  criterion: criterion.id,
                  nodeCmd: needsNodeRuntime ? '/bunsen/runtime/node' : 'node',
                  timeout: criterionTimeout,
                  proxyEnv: proxyInfo ? getProxyEnv(proxyInfo) : undefined,
                  onLog: (msg) => log(msg),
                });

                // Copy screenshots from scorer output to artifacts/screenshots/ (if any)
                const scorerScreenshotsDir = path.join(scorerContainerInfo.outputDir, 'screenshots');
                if (fs.existsSync(scorerScreenshotsDir)) {
                  const runScreenshotsDir = getScreenshotsDir(runId, baseDir);
                  fs.mkdirSync(runScreenshotsDir, { recursive: true });
                  const screenshotFiles = fs.readdirSync(scorerScreenshotsDir);
                  for (const file of screenshotFiles) {
                    fs.copyFileSync(
                      path.join(scorerScreenshotsDir, file),
                      path.join(runScreenshotsDir, file)
                    );
                  }
                  // Clean up scorer screenshots dir for next criterion
                  fs.rmSync(scorerScreenshotsDir, { recursive: true, force: true });
                  log(`Copied ${screenshotFiles.length} screenshots to artifacts/screenshots/`);
                }
              }
            }

            // Store result
            const criterionResult: CriterionResult = {
              id: criterion.id,
              weight: criterion.resolvedWeight,
              score: output.score,
              summary: output.summary,
              status: 'completed',
              scorerType: criterion.type,
            };

            if (criterion.scores) {
              criterionResult.allowedScores = criterion.scores;
            }

            // Add log path for script scorers
            if (criterion.type === 'script') {
              criterionResult.logPath = `${RUN_PATHS.evaluationCriteriaDir}/${slugifyCriterion(criterion.id)}.log`;
            }

            // Include screenshots if present (browser-agent scorers)
            if (output.screenshots && output.screenshots.length > 0) {
              criterionResult.screenshots = output.screenshots.map(
                (filename) => `${RUN_PATHS.artifactsScreenshots}/${filename}`
              );
            }

            // Forward script-scorer artifacts (`result.json`) to the criterion result.
            if (output.artifacts && output.artifacts.length > 0) {
              criterionResult.artifacts = output.artifacts;
            }

            criterionResults.push(criterionResult);
            dependencyScores[criterion.id] = {
              score: output.score,
              summary: output.summary,
            };

            log(`  ${criterion.id}: ${output.score !== null ? output.score.toFixed(2) : 'N/A'} - ${output.summary}`);
            emit({
              event: 'criterion.completed',
              data: {
                id: criterion.id,
                score: output.score,
                durationMs: Date.now() - criterionStart,
                status: 'completed',
              },
            });

            // Check gate condition (if this criterion has one)
            if (criterion.gate !== undefined && !gateFailure) {
              const gatePassed = checkGate(output.score, criterion.gate);
              if (!gatePassed) {
                const threshold = getGateThreshold(criterion.gate);
                gateFailure = {
                  criterion: criterion.id,
                  score: output.score,
                  threshold,
                };
                progress(
                  `Gate failed: ${criterion.id} scored ${output.score ?? 'null'} (required ${threshold}). Skipping remaining criteria.`
                );
              }
            }
          }

          // Run the dedicated `evaluation.report` step if configured. Runs
          // regardless of gate state — the report is the narrative record.
          if (experiment.evaluation.report && scorerContainerInfo) {
            activeRun.phase = 'evaluation.report';
            emit({ event: 'evaluation.report.started', data: {} });
            const reportStart = Date.now();
            report = await runReportStep({
              reportConfig: experiment.evaluation.report,
              scorerContainerInfo,
              criteria: experiment.evaluation.criteria,
              dependencyScores,
              needsNodeRuntime,
              proxyInfo,
              log,
              progress,
            });
            emit({
              event: 'evaluation.report.completed',
              data: { durationMs: Date.now() - reportStart },
            });
          }

          // Build and save evaluation result
          const evaluationResult = buildEvaluationResult(criterionResults, report);

          // If a gate failed, override weighted score to 0
          if (gateFailure) {
            evaluationResult.weightedScore = 0;
          }

          saveEvaluationResult(runId, evaluationResult, baseDir);

          if (gateFailure) {
            progress(
              `Evaluation complete (weighted score: 0.00 - gate "${gateFailure.criterion}" failed)`
            );
          } else {
            progress(`Evaluation complete (weighted score: ${evaluationResult.weightedScore.toFixed(2)})`);
          }
        } catch (evalError) {
          // Always show evaluation errors (not just in verbose mode)
          const errorMessage = evalError instanceof Error ? evalError.message : String(evalError);
          progress(`Evaluation failed: ${errorMessage}`);
          // Also append to logs for debugging
          appendLogs(runId, `\n--- EVALUATION ERROR ---\n${errorMessage}`, baseDir);
          evaluationThrew = true;
        } finally {
          if (usedAgentContainerForScoring) {
            // Agent-container scoring: only clean up the scorer output temp dir
            // (agent container is stopped in the outer finally block)
            if (agentScorerOutputDir) {
              try {
                fs.rmSync(agentScorerOutputDir, { recursive: true, force: true });
              } catch {
                // Ignore cleanup errors
              }
            }
          } else {
            // Default path: clean up scorer container and extracted workspace
            if (scorerContainerInfo) {
              log('Stopping scorer container...');
              await stopScorerContainer(scorerContainerInfo).catch(() => {
                // Ignore cleanup errors
              });
              if (activeRun) activeRun.scorerContainer = null;
            }
            if (extractedWorkspaceDir) {
              try {
                fs.rmSync(path.dirname(extractedWorkspaceDir), { recursive: true, force: true });
              } catch {
                // Ignore cleanup errors
              }
            }
          }
        }
      }

    } finally {
      // Finalize trace accounting FIRST, ahead of container teardown. The
      // `finally` runs on every path this executor can exit by — clean
      // success, agent timeout, mid-flight `bn runs cancel`, or an evaluation
      // error — so the proxy capture is folded into the cost summary +
      // manifest + index even for a run that burned tokens before failing.
      // (A foreground Ctrl-C still bypasses this via the signal handler's
      // process.exit; see COST_NOT_CAPTURED_ON_SIGINT.) Stop the proxy first
      // so agent.jsonl is flushed, and wrap the lot so a torn trace file from
      // an abrupt cancel can't throw out of `finally` and mask the real cause.
      try {
        if (proxyInfo) {
          log('Stopping trace capture proxy...');
          await stopProxyContainer(proxyInfo);
          proxyInfo = undefined;
          if (activeRun) activeRun.proxyInfo = null;
          // Give file writes a moment to complete before we read agent.jsonl.
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        await finalizeRunTraces({ runId, baseDir, skipTraces, log });
      } catch (err) {
        log(
          `Warning: trace finalization failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (debugKeepContainer) {
        // Keep container running for debugging
        log('--debug-keep-container: Container kept running for debugging');
        log(`Container ID: ${container.id}`);
        log(`To exec into container: docker exec -it ${container.id.slice(0, 12)} /bin/bash`);
        log(`Workspace is at: /workspace`);
        log(`Run context is at: /bunsen/run`);
        log(`Note: Scorers run in ${scoreInAgentContainer ? 'this container (agent-container scoring)' : 'the scorer container, not the agent container'}.`);
        log(`To stop container: docker stop ${container.id.slice(0, 12)}`);
      } else {
        // Always stop the container
        await stopContainer(container);
      }
      if (activeRun) activeRun.container = null;

      // agent-script.sh contains API keys and agent-complete.marker/launcher.sh are only needed during execution
      cleanupInternalRunFiles(runDir);
    }

    // Compute the final run status. The run encompasses both the agent and
    // evaluation phases, so either failing fails the run. Gate failures are
    // a scored outcome, not an error, and don't mark the run failed.
    const agentFailed = result.exitCode !== 0;
    const finalStatus: 'succeeded' | 'failed' =
      agentFailed || evaluationThrew ? 'failed' : 'succeeded';
    const failurePhase: 'agent' | 'evaluation' | null = agentFailed
      ? 'agent'
      : evaluationThrew
        ? 'evaluation'
        : null;
    log(`Run ${runId} ${finalStatus}`);

    // Flip the manifest from 'running' to its terminal status now that
    // every phase has finished. updateRunStatus stamps completed_at and
    // duration_ms.
    updateRunStatus(runId, finalStatus, result.exitCode, baseDir);

    if (finalStatus === 'succeeded') {
      emit({
        event: 'run.completed',
        data: { id: runId, durationMs: Date.now() - runStartedAt },
      });
    } else if (failurePhase === 'agent') {
      emit({
        event: 'run.failed',
        data: { phase: 'agent', reason: `agent exited with code ${result.exitCode}` },
      });
    } else {
      emit({
        event: 'run.failed',
        data: { phase: 'evaluation', reason: 'evaluation phase threw' },
      });
    }
    if (activeRun) activeRun.terminalEventEmitted = true;

    // Write the canonical RunManifestV1 projection (and refresh the SQLite
    // index). All legacy files have been written by this point, so the
    // manifest reflects final state. Failures are non-fatal — `bn
    // rebuild-index` reconstructs both from disk later.
    try {
      refreshRunManifest(runId, baseDir);
    } catch (manifestError) {
      const message = manifestError instanceof Error ? manifestError.message : String(manifestError);
      log(`Warning: failed to write manifest.json: ${message}`);
    }

    // Clear signal handler tracking - run completed normally
    activeRun = null;

    const finalManifest = loadRunManifest(runId, baseDir);
    if (!finalManifest) {
      throw new Error(`Run ${runId} disappeared before completion`);
    }
    return finalManifest;
  } catch (error) {
    // If the signal handler is mid-cleanup (SIGINT) or the manifest was
    // flipped to `canceled` out-of-band (external `cancelRun()`), the docker
    // exec that just rejected is fallout from the container being stopped,
    // not the real failure. Don't overwrite `canceled` with `failed` and
    // don't surface the dockerode 409 — throw a typed cancellation instead
    // so the CLI can render it cleanly.
    const cancelingFromSignal = activeRun?.cleaningUp === true;
    const cancelingFromExternal = (() => {
      if (cancelingFromSignal) return false;
      const m = loadRunManifest(runId, baseDir);
      return m?.status === 'canceled';
    })();

    if (cancelingFromSignal || cancelingFromExternal) {
      const reason: 'SIGINT' | 'external' = cancelingFromSignal ? 'SIGINT' : 'external';
      // External cancel: emit the terminal event ourselves (signal handler
      // already does this in the SIGINT path).
      if (cancelingFromExternal && activeRun && !activeRun.terminalEventEmitted) {
        emit({ event: 'run.canceled', data: { reason: 'external' } });
        activeRun.terminalEventEmitted = true;
      }
      try {
        refreshRunManifest(runId, baseDir);
      } catch {
        // best-effort
      }
      activeRun = null;
      throw new RunCanceledError(runId, reason);
    }

    // Update run status to failed
    updateRunStatus(runId, 'failed', 1, baseDir);

    const errorMessage = error instanceof Error ? error.message : String(error);
    appendLogs(runId, `\n--- ERROR ---\n${errorMessage}`, baseDir);

    // If a signal handler already emitted the terminal event for this run,
    // don't duplicate it from the catch path.
    if (activeRun && !activeRun.terminalEventEmitted) {
      emit({
        event: 'run.failed',
        data: { phase: activeRun.phase, reason: errorMessage },
      });
      activeRun.terminalEventEmitted = true;
    }

    // Best-effort manifest + index write so failed runs still leave a
    // queryable record. Swallow any secondary error — the original
    // failure is what we want to surface.
    try {
      refreshRunManifest(runId, baseDir);
    } catch {
      // best-effort
    }

    // Clear signal handler tracking - run failed with error
    activeRun = null;

    throw error;
  }
}

/**
 * Compute a short hash for image caching based on content
 */
function computeImageHash(base: string, setup: string[], platform: RunPlatform): string {
  const content = JSON.stringify({ base, setup, platform });
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
}

export interface ResolveRunPlatformOptions {
  /** Explicit platform from CLI / SDK. Wins over everything else. */
  cliPlatform?: RunPlatform | string;
  /** `experiment.run.platform`. `'auto'` is treated as unset. */
  experimentRunPlatform?: 'auto' | RunPlatform;
  /** `project.defaults.run.platform`. `'auto'` is treated as unset. */
  projectDefaultPlatform?: 'auto' | RunPlatform;
  /** Docker daemon architecture (final fallback). */
  dockerArch: string;
  /** `experiment.environment.platforms`. Membership-checked at the end. */
  supportedPlatforms?: RunPlatform[];
}

/**
 * Resolve a single authoritative run platform for the entire run/build.
 *
 * Precedence:
 * 1. Explicit CLI/API platform
 * 2. `experiment.run.platform` (if not `auto`)
 * 3. `project.defaults.run.platform` (if not `auto`)
 * 4. Docker daemon architecture
 *
 * After resolution, if `supportedPlatforms` is declared the result must be a
 * member; if exactly one is declared it short-circuits the daemon fallback.
 */
export function resolveRunPlatform(options: ResolveRunPlatformOptions): RunPlatform {
  const {
    cliPlatform,
    experimentRunPlatform,
    projectDefaultPlatform,
    dockerArch,
    supportedPlatforms,
  } = options;

  const enforceSupported = (platform: RunPlatform, source: string): RunPlatform => {
    if (supportedPlatforms && !supportedPlatforms.includes(platform)) {
      throw new Error(
        `Experiment supports [${supportedPlatforms.join(', ')}], but ${source} is ${platform}.`
      );
    }
    return platform;
  };

  if (cliPlatform) {
    return enforceSupported(normalizeRunPlatform(cliPlatform), 'requested platform');
  }

  if (experimentRunPlatform && experimentRunPlatform !== 'auto') {
    return enforceSupported(
      normalizeRunPlatform(experimentRunPlatform),
      'experiment.run.platform'
    );
  }

  if (projectDefaultPlatform && projectDefaultPlatform !== 'auto') {
    return enforceSupported(
      normalizeRunPlatform(projectDefaultPlatform),
      'defaults.run.platform'
    );
  }

  if (supportedPlatforms?.length === 1) {
    return supportedPlatforms[0];
  }

  const resolved = archToRunPlatform(dockerArch);
  if (supportedPlatforms && !supportedPlatforms.includes(resolved)) {
    throw new Error(
      `Experiment supports [${supportedPlatforms.join(', ')}], but Docker resolved ${resolved}. ` +
      `Rerun with a compatible --platform.`
    );
  }

  return resolved;
}

function platformTagSuffix(platform: RunPlatform): string {
  return runPlatformToArch(platform);
}

/**
 * Recursively collect file metadata/content for deterministic directory hashing.
 */
function hashDirectoryTree(rootDir: string): string {
  const hash = crypto.createHash('sha256');
  const ignoredRoots = new Set(['.git', '.bunsen']);

  const walk = (dir: string, relPrefix = ''): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !ignoredRoots.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const absPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        hash.update(`dir:${relPath}\n`);
        walk(absPath, relPath);
      } else if (entry.isFile()) {
        const stat = fs.statSync(absPath);
        hash.update(`file:${relPath}:${stat.mode}:${stat.size}\n`);
        hash.update(fs.readFileSync(absPath));
      } else if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(absPath);
        hash.update(`symlink:${relPath}->${target}\n`);
      }
    }
  };

  walk(rootDir);
  return hash.digest('hex');
}

/**
 * Compute total byte size of a directory tree.
 */
function getDirectorySizeBytes(rootDir: string): number {
  let total = 0;
  const stack = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absPath);
      } else if (entry.isFile()) {
        total += fs.statSync(absPath).size;
      }
    }
  }

  return total;
}

/**
 * Compute per-file SHA-256 checksums for artifact metadata.
 */
function getFileChecksums(rootDir: string): Record<string, string> {
  const checksums: Record<string, string> = {};
  const stack = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absPath);
      } else if (entry.isFile()) {
        const relPath = path.relative(rootDir, absPath);
        checksums[relPath] = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
      }
    }
  }

  return checksums;
}

/**
 * Validate artifact tree for unsafe symlinks and path traversal.
 */
function validateArtifacts(outputDir: string): void {
  const root = fs.realpathSync(outputDir);
  const stack = [outputDir];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absPath);
        continue;
      }

      if (entry.isSymbolicLink()) {
        const targetPath = fs.readlinkSync(absPath);
        const resolved = path.resolve(path.dirname(absPath), targetPath);
        const resolvedReal = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
        if (!resolvedReal.startsWith(`${root}${path.sep}`) && resolvedReal !== root) {
          throw new Error(`Build artifact contains unsafe symlink: ${absPath} -> ${targetPath}`);
        }
      }
    }
  }
}

/**
 * Build and cache agent artifacts (if `install.build` is configured).
 * Returns an absolute path to cached artifacts, or undefined when build is not
 * configured.
 */
async function prepareAgentArtifacts(
  agent: ResolvedAgent,
  agentPath: string,
  runPlatform: RunPlatform,
  baseDir: string,
  onProgress?: (message: string) => void,
  forceRebuild = false,
  onCacheHit?: (hit: boolean) => void,
  preparedDeps: PreparedAgentDep[] = [],
): Promise<string | undefined> {
  const build = agent.install.build;
  // No build configured = nothing to do = effectively a cache hit.
  if (!build) {
    onCacheHit?.(true);
    return undefined;
  }

  const runArch = runPlatformToArch(runPlatform);
  const buildTimeoutMs =
    parseOptionalDuration(build.timeout) ?? DEFAULT_AGENT_BUILD_TIMEOUT_SECONDS * 1000;

  const buildContextHash = hashDirectoryTree(agentPath);
  const buildKeyContent = JSON.stringify({
    // Bump when this hash's *inputs or their meaning* change in a way the
    // field set alone can't express — adding/removing a field, changing what
    // gets mounted into the build container, or changing the artifact
    // contract. Flipping this forces every existing cached entry to miss.
    // Not user-visible; unrelated to agent.yaml's `version`.
    schemaVersion: 3,
    agentName: agent.name,
    buildRun: build.run,
    image: build.image,
    platform: runPlatform,
    arch: runArch,
    timeoutMs: buildTimeoutMs,
    network: build.network ?? 'default',
    cacheSalt: build.cacheSalt ?? '',
    contextHash: buildContextHash,
    // Deps are part of the build environment when they're mounted into the
    // build container, so their cache keys must invalidate install.build too.
    depKeys: preparedDeps.map((d) => ({ name: d.name, key: d.cacheKey })),
  });
  const cacheKey = crypto.createHash('sha256').update(buildKeyContent).digest('hex').slice(0, 16);

  const buildCacheRoot = getBuildCacheDir(baseDir);
  const cacheDir = path.join(buildCacheRoot, cacheKey);
  const metadataPath = path.join(cacheDir, 'metadata.json');

  if (!forceRebuild && fs.existsSync(cacheDir) && fs.existsSync(metadataPath)) {
    onProgress?.(`Using cached agent artifacts ${cacheKey}`);
    onCacheHit?.(true);
    return cacheDir;
  }
  onCacheHit?.(false);

  if (forceRebuild && fs.existsSync(cacheDir)) {
    onProgress?.(`Rebuilding agent artifacts (${cacheKey})...`);
  }

  onProgress?.(`Building agent artifacts (${cacheKey})...`);
  fs.mkdirSync(buildCacheRoot, { recursive: true });
  await ensureImage(build.image, onProgress, runPlatform);

  const tempOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), `bunsen-agent-build-${cacheKey}-`));
  const buildContainer = await createPersistentContainer({
    image: build.image,
    mounts: [
      { source: agentPath, target: '/agent', readonly: true },
      { source: tempOutputDir, target: '/output', readonly: false },
      ...preparedDeps.map((dep) => ({
        source: dep.artifactsPath,
        target: `/bunsen/deps/${dep.name}`,
        readonly: true,
      })),
    ],
    workdir: '/agent',
    networkMode: build.network === 'none' ? 'none' : 'bridge',
    platform: runPlatform,
  });

  try {
    const buildScript = [buildArtifactsPathExport(preparedDeps), ...build.run].join('\n');
    const result = await execShellInContainer(buildContainer, buildScript, {
      workdir: '/agent',
      timeout: buildTimeoutMs,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Agent build failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`
      );
    }
  } finally {
    await stopContainer(buildContainer).catch(() => {
      // best effort
    });
  }

  const outputEntries = fs.readdirSync(tempOutputDir);
  if (outputEntries.length === 0) {
    fs.rmSync(tempOutputDir, { recursive: true, force: true });
    throw new Error(`Agent build produced no artifacts in /output.`);
  }

  validateArtifacts(tempOutputDir);
  const totalSize = getDirectorySizeBytes(tempOutputDir);
  if (totalSize > MAX_AGENT_ARTIFACT_BYTES) {
    fs.rmSync(tempOutputDir, { recursive: true, force: true });
    throw new Error(
      `Agent build artifacts exceed ${MAX_AGENT_ARTIFACT_BYTES} bytes (got ${totalSize}).`
    );
  }

  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  // `verbatimSymlinks: true` is load-bearing — without it, fs.cpSync resolves
  // relative symlinks against the source's absolute path and writes the
  // resolved absolute target into the destination. That turns portable
  // distributions (Node's `npm -> ../lib/node_modules/npm/bin/npm-cli.js`,
  // python-build-standalone's `python -> python3.11`) into dead symlinks
  // pointing back at the host build tmpdir, breaking the dep at mount time.
  fs.cpSync(tempOutputDir, cacheDir, { recursive: true, verbatimSymlinks: true });
  const checksums = getFileChecksums(cacheDir);
  fs.writeFileSync(
    metadataPath,
    JSON.stringify(
      {
        cacheKey,
        createdAt: new Date().toISOString(),
        platform: runPlatform,
        arch: runArch,
        image: build.image,
        network: build.network ?? 'default',
        timeoutMs: buildTimeoutMs,
        contextHash: buildContextHash,
        totalArtifactBytes: totalSize,
        checksums,
      },
      null,
      2
    )
  );
  fs.rmSync(tempOutputDir, { recursive: true, force: true });

  return cacheDir;
}

// ---------------------------------------------------------------------------
// install.deps build pipeline
// ---------------------------------------------------------------------------

/** A single dep built and cached on disk, ready to mount at runtime. */
export interface PreparedAgentDep {
  /** Stable name from the dep spec; used as the mount path under /bunsen/deps/. */
  name: string;
  /** Declared version, if any. Recorded in the run manifest. */
  version?: string;
  /** Cache key (sha256-prefixed) identifying the build. */
  cacheKey: string;
  /** Absolute path to the cached artifact tree. */
  artifactsPath: string;
  /** Whether the cache was hit (true) or rebuilt (false) on this call. */
  cacheHit: boolean;
  /** Binary names declared in `provides.binaries`. */
  binaries: string[];
}

export interface AgentDepBuildOptions {
  baseDir?: string;
  platform?: RunPlatform | string;
  rebuild?: boolean;
  onProgress?: (message: string) => void;
}

/**
 * Build (or fetch from cache) every dep declared in `agent.install.deps`
 * for the given run platform.
 *
 * Returns one entry per dep in declared order. Throws on conflict
 * (two deps claiming the same binary) and on `provides` verification
 * failures (declared binary missing from `/output/bin/`).
 */
export async function prepareAgentDeps(
  agent: { install: { deps?: AgentDepSpec[] }; name: string },
  runPlatform: RunPlatform,
  baseDir: string,
  options: { forceRebuild?: boolean; onProgress?: (msg: string) => void } = {},
): Promise<PreparedAgentDep[]> {
  const deps = agent.install.deps;
  if (!deps || deps.length === 0) return [];

  // Conflict detection: build the binary→contributors map up front so we fail
  // fast (before any builds run) when two deps claim the same binary.
  detectDepConflicts(deps);

  const { forceRebuild = false, onProgress } = options;
  const out: PreparedAgentDep[] = [];
  for (const dep of deps) {
    const target = dep.install.find((entry) => entry.target === runPlatform);
    if (!target) {
      const supported = dep.install.map((e) => e.target).join(', ');
      throw new Error(
        `install.deps[${dep.name}]: no install entry for target ${runPlatform} (declared: ${supported}).`,
      );
    }
    const prepared = await buildOrCacheAgentDep(dep, target, runPlatform, baseDir, {
      forceRebuild,
      onProgress,
    });
    out.push(prepared);
  }
  return out;
}

/**
 * Walk `provides.binaries` from each dep and surface collisions:
 *  - same binary from two deps at any version → error
 *  - (warnings for dep vs install.build / experiment apt aren't done here
 *    because we don't have that info at this layer; they live in the
 *    runtime when PATH is composed)
 */
export function detectDepConflicts(deps: AgentDepSpec[]): void {
  const owners = new Map<string, { name: string; version?: string }[]>();
  for (const dep of deps) {
    for (const bin of dep.provides?.binaries ?? []) {
      const list = owners.get(bin) ?? [];
      list.push({ name: dep.name, version: dep.version });
      owners.set(bin, list);
    }
  }
  const errors: string[] = [];
  for (const [bin, contributors] of owners) {
    if (contributors.length <= 1) continue;
    const labels = contributors
      .map((c) => `${c.name}${c.version ? `@${c.version}` : ''}`)
      .join(', ');
    errors.push(`binary ${JSON.stringify(bin)} is provided by multiple deps: ${labels}`);
  }
  if (errors.length > 0) {
    throw new Error(
      `install.deps conflict detected:\n  - ${errors.join('\n  - ')}\n` +
        `Each binary may be provided by at most one dep — drop or rename the duplicate.`,
    );
  }
}

/**
 * Surface every binary that the agent ships AND the experiment substrate
 * installs under the same name. The agent always wins on PATH (see
 * `buildDepsPathPrefix`), so this is a record-and-proceed diagnostic — not
 * a build blocker. The point is to make the shadowing visible in the run
 * manifest so cross-run comparisons cannot be silently corrupted by a
 * package the substrate happens to ship.
 *
 * Matching is name-based against every substrate package manager
 * (`apt` / `npm` / `pip`): an agent dep with `provides.binaries: [rg]` is
 * considered to shadow a substrate package called `rg`. Substrate packages
 * whose installed binary has a different name than the package itself
 * won't be caught — we don't introspect package contents — but the common
 * cases (`ripgrep`, `jq`, `prettier`, `black`, `curl`, `git`) name their
 * binary after their package.
 */
export type ShadowedSubstrateSource = 'substrate-apt' | 'substrate-npm' | 'substrate-pip';

/**
 * Human-readable labels for log lines / CLI output. Kept adjacent to
 * {@link ShadowedSubstrateSource} so a future source (cargo, gem, ...) lands
 * in both places in the same commit.
 */
export const SHADOWED_SUBSTRATE_SOURCE_LABEL: Record<ShadowedSubstrateSource, string> = {
  'substrate-apt': 'substrate apt',
  'substrate-npm': 'substrate npm',
  'substrate-pip': 'substrate pip',
};

export interface CrossBoundaryShadow {
  diagnostic: 'cross-boundary-binary-shadow';
  binary: string;
  winner: { source: 'agent-dep'; name: string; version?: string };
  shadowed: { source: ShadowedSubstrateSource; name: string; version?: string };
  resolution: string;
}

export function detectCrossBoundaryShadows(
  deps: PreparedAgentDep[],
  substratePackages: {
    apt?: readonly string[];
    npm?: readonly string[];
    pip?: readonly string[];
  },
): CrossBoundaryShadow[] {
  if (deps.length === 0) return [];

  // Build (binary-name → first substrate manager that ships it) maps. Order
  // doesn't matter much; we deterministically pick apt → npm → pip when
  // multiple managers claim the same name (apt is the dominant case).
  const sources: Array<[ShadowedSubstrateSource, readonly string[] | undefined]> = [
    ['substrate-apt', substratePackages.apt],
    ['substrate-npm', substratePackages.npm],
    ['substrate-pip', substratePackages.pip],
  ];

  // `seen` maps binary-name → first matching source. Multiple matches in
  // the same managers list resolve to the first; we don't emit one shadow
  // per manager because the run-time precedence story is the same either
  // way (the dep wins).
  const seen = new Map<string, ShadowedSubstrateSource>();
  for (const [source, list] of sources) {
    if (!list || list.length === 0) continue;
    for (const name of list) {
      if (!seen.has(name)) seen.set(name, source);
    }
  }
  if (seen.size === 0) return [];

  const shadows: CrossBoundaryShadow[] = [];
  for (const dep of deps) {
    for (const bin of dep.binaries) {
      const source = seen.get(bin);
      if (!source) continue;
      shadows.push({
        diagnostic: 'cross-boundary-binary-shadow',
        binary: bin,
        winner: {
          source: 'agent-dep',
          name: dep.name,
          ...(dep.version !== undefined ? { version: dep.version } : {}),
        },
        shadowed: { source, name: bin },
        resolution:
          'agent dep wins on PATH (deterministic precedence: ' +
          '/bunsen/artifacts/bin → /bunsen/deps/<name>/bin → substrate).',
      });
    }
  }
  return shadows;
}

async function buildOrCacheAgentDep(
  dep: AgentDepSpec,
  target: NonNullable<AgentDepSpec['install'][number]>,
  runPlatform: RunPlatform,
  baseDir: string,
  options: { forceRebuild: boolean; onProgress?: (msg: string) => void },
): Promise<PreparedAgentDep> {
  const { forceRebuild, onProgress } = options;
  const runArch = runPlatformToArch(runPlatform);
  const buildImage = target.image;
  if (!buildImage) {
    // Should be caught at parse time, but belt-and-braces.
    throw new Error(`install.deps[${dep.name}]: no build image declared for target ${runPlatform}.`);
  }
  const buildTimeoutMs =
    parseOptionalDuration(target.timeout) ?? DEFAULT_AGENT_DEP_BUILD_TIMEOUT_SECONDS * 1000;
  const network: 'default' | 'none' = target.network ?? 'default';

  const cacheKeyContent = JSON.stringify({
    // See the matching comment on the install.build cache key above —
    // bump when the inputs or their meaning change in a way the field set
    // alone can't express, to force every existing cached entry to miss.
    // schemaVersion bumped to 2 when linkage/abi joined the cache key
    // (asymmetric-ownership change).
    schemaVersion: 2,
    name: dep.name,
    version: dep.version ?? null,
    target: target.target,
    arch: runArch,
    image: buildImage,
    network,
    timeoutMs: buildTimeoutMs,
    run: target.run,
    provides: dep.provides?.binaries ?? [],
    linkage: dep.linkage ?? null,
    abi: dep.abi ?? null,
    requires: dep.requires ?? null,
  });
  const cacheKey = crypto.createHash('sha256').update(cacheKeyContent).digest('hex').slice(0, 16);

  const cacheRoot = getDepsCacheDir(baseDir);
  const cacheDir = path.join(cacheRoot, `${dep.name}-${cacheKey}`);
  const metadataPath = path.join(cacheDir, 'metadata.json');

  if (!forceRebuild && fs.existsSync(cacheDir) && fs.existsSync(metadataPath)) {
    onProgress?.(`Using cached dep ${dep.name}${dep.version ? `@${dep.version}` : ''} (${cacheKey})`);
    return {
      name: dep.name,
      version: dep.version,
      cacheKey,
      artifactsPath: cacheDir,
      cacheHit: true,
      binaries: dep.provides?.binaries ?? [],
    };
  }

  if (forceRebuild && fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }

  onProgress?.(
    `Building dep ${dep.name}${dep.version ? `@${dep.version}` : ''} for ${runPlatform} (${cacheKey})...`,
  );

  fs.mkdirSync(cacheRoot, { recursive: true });
  await ensureImage(buildImage, onProgress, runPlatform);

  const tempOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), `bunsen-dep-build-${dep.name}-`));
  const buildContainer = await createPersistentContainer({
    image: buildImage,
    mounts: [{ source: tempOutputDir, target: '/output', readonly: false }],
    workdir: '/output',
    networkMode: network === 'none' ? 'none' : 'bridge',
    platform: runPlatform,
  });

  try {
    // Pre-create /output/bin so common `cp` patterns Just Work without each
    // author having to `mkdir -p /output/bin` first.
    const buildScript = ['set -euo pipefail', 'mkdir -p /output/bin', ...target.run].join('\n');
    const result = await execShellInContainer(buildContainer, buildScript, {
      workdir: '/output',
      timeout: buildTimeoutMs,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Dep ${dep.name} build failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`,
      );
    }
  } finally {
    await stopContainer(buildContainer).catch(() => {
      // best effort
    });
  }

  const outputEntries = fs.readdirSync(tempOutputDir);
  if (outputEntries.length === 0) {
    fs.rmSync(tempOutputDir, { recursive: true, force: true });
    throw new Error(`Dep ${dep.name} build produced no artifacts in /output.`);
  }

  validateArtifacts(tempOutputDir);
  const totalSize = getDirectorySizeBytes(tempOutputDir);
  if (totalSize > MAX_AGENT_DEP_ARTIFACT_BYTES) {
    fs.rmSync(tempOutputDir, { recursive: true, force: true });
    throw new Error(
      `Dep ${dep.name} artifacts exceed ${MAX_AGENT_DEP_ARTIFACT_BYTES} bytes (got ${totalSize}).`,
    );
  }

  // Verify provides.binaries actually exist at /output/bin/.
  verifyDepProvides(dep, tempOutputDir);

  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  // `verbatimSymlinks: true` is load-bearing — without it, fs.cpSync resolves
  // relative symlinks against the source's absolute path and writes the
  // resolved absolute target into the destination. That turns portable
  // distributions (Node's `npm -> ../lib/node_modules/npm/bin/npm-cli.js`,
  // python-build-standalone's `python -> python3.11`) into dead symlinks
  // pointing back at the host build tmpdir, breaking the dep at mount time.
  fs.cpSync(tempOutputDir, cacheDir, { recursive: true, verbatimSymlinks: true });
  const checksums = getFileChecksums(cacheDir);
  fs.writeFileSync(
    metadataPath,
    JSON.stringify(
      {
        cacheKey,
        name: dep.name,
        version: dep.version ?? null,
        createdAt: new Date().toISOString(),
        target: target.target,
        platform: runPlatform,
        arch: runArch,
        image: buildImage,
        network,
        timeoutMs: buildTimeoutMs,
        provides: dep.provides?.binaries ?? [],
        linkage: dep.linkage ?? null,
        abi: dep.abi ?? null,
        requires: dep.requires ?? null,
        totalArtifactBytes: totalSize,
        checksums,
      },
      null,
      2,
    ),
  );
  fs.rmSync(tempOutputDir, { recursive: true, force: true });

  return {
    name: dep.name,
    version: dep.version,
    cacheKey,
    artifactsPath: cacheDir,
    cacheHit: false,
    binaries: dep.provides?.binaries ?? [],
  };
}

function verifyDepProvides(dep: AgentDepSpec, outputDir: string): void {
  const declared = dep.provides?.binaries ?? [];
  if (declared.length === 0) return;
  const missing: string[] = [];
  for (const bin of declared) {
    const candidate = path.join(outputDir, 'bin', bin);
    if (!fs.existsSync(candidate)) {
      missing.push(bin);
      continue;
    }
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) {
      missing.push(`${bin} (not a regular file at /output/bin/${bin})`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Dep ${dep.name} declared provides.binaries=[${declared.join(', ')}] but the following were missing from /output/bin/: ${missing.join(', ')}. ` +
        `Either copy the binary to /output/bin/<name> in your install steps, or remove it from provides.binaries.`,
    );
  }
}

/** Get the absolute path to the install.deps cache directory. */
export function getDepsCacheDir(baseDir: string = process.cwd()): string {
  return path.join(baseDir, DEPS_CACHE_RELATIVE_DIR);
}

/** One install.deps cache entry as surfaced by `bn cache list`. */
export interface DepsCacheEntry {
  /** Directory name under `.bunsen/deps-cache/` — i.e. `<dep-name>-<cacheKey>`. */
  key: string;
  /** Absolute path to the cached artifact tree. */
  path: string;
  sizeBytes: number;
  /** Dep name from the spec (also the prefix of `key`). */
  name?: string;
  /** Dep version from the spec, if declared. */
  version?: string;
  /** Cache-key suffix of `key` (matches `cacheKey` in metadata). */
  cacheKey?: string;
  createdAt?: string;
  platform?: RunPlatform;
  arch?: string;
  image?: string;
  network?: 'default' | 'none';
  timeoutMs?: number;
  /** `provides.binaries` declared by the dep. */
  provides?: string[];
  totalArtifactBytes?: number;
}

/** List install.deps cache entries. */
export function listDepsCacheEntries(baseDir: string = process.cwd()): DepsCacheEntry[] {
  const cacheRoot = getDepsCacheDir(baseDir);
  if (!fs.existsSync(cacheRoot)) return [];

  const entries: DepsCacheEntry[] = [];
  for (const key of fs.readdirSync(cacheRoot)) {
    const entryPath = path.join(cacheRoot, key);
    if (!fs.statSync(entryPath).isDirectory()) continue;

    const metadataPath = path.join(entryPath, 'metadata.json');
    let metadata: Record<string, unknown> = {};
    if (fs.existsSync(metadataPath)) {
      try {
        metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) as Record<string, unknown>;
      } catch {
        metadata = {};
      }
    }

    let resolvedPlatform: RunPlatform | undefined;
    if (typeof metadata.platform === 'string') {
      try {
        resolvedPlatform = normalizeRunPlatform(metadata.platform);
      } catch {
        resolvedPlatform = undefined;
      }
    }

    const entry: DepsCacheEntry = {
      key,
      path: entryPath,
      sizeBytes: getDirectorySizeBytes(entryPath),
    };
    if (typeof metadata.name === 'string') entry.name = metadata.name;
    if (typeof metadata.version === 'string') entry.version = metadata.version;
    if (typeof metadata.cacheKey === 'string') entry.cacheKey = metadata.cacheKey;
    if (typeof metadata.createdAt === 'string') entry.createdAt = metadata.createdAt;
    if (resolvedPlatform !== undefined) entry.platform = resolvedPlatform;
    if (typeof metadata.arch === 'string') entry.arch = metadata.arch;
    if (typeof metadata.image === 'string') entry.image = metadata.image;
    if (metadata.network === 'default' || metadata.network === 'none') entry.network = metadata.network;
    if (typeof metadata.timeoutMs === 'number') entry.timeoutMs = metadata.timeoutMs;
    if (Array.isArray(metadata.provides))
      entry.provides = metadata.provides.filter((s): s is string => typeof s === 'string');
    if (typeof metadata.totalArtifactBytes === 'number')
      entry.totalArtifactBytes = metadata.totalArtifactBytes;
    entries.push(entry);
  }

  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Remove install.deps cache entries. Pass a `name-cacheKey` directory name to
 * remove a single entry, omit to clear the whole cache.
 */
export function clearDepsCache(baseDir: string = process.cwd(), key?: string): number {
  const cacheRoot = getDepsCacheDir(baseDir);
  if (!fs.existsSync(cacheRoot)) return 0;
  if (key) {
    const rootResolved = path.resolve(cacheRoot);
    const entryPath = path.resolve(cacheRoot, key);
    if (!entryPath.startsWith(`${rootResolved}${path.sep}`)) {
      throw new Error(`Invalid deps cache key: ${key}`);
    }
    if (!fs.existsSync(entryPath)) return 0;
    fs.rmSync(entryPath, { recursive: true, force: true });
    return 1;
  }
  const entries = fs
    .readdirSync(cacheRoot)
    .filter((entry) => fs.statSync(path.join(cacheRoot, entry)).isDirectory());
  fs.rmSync(cacheRoot, { recursive: true, force: true });
  return entries.length;
}

/**
 * Get the absolute path to the runtime.build cache directory.
 */
export function getBuildCacheDir(baseDir: string = process.cwd()): string {
  return path.join(baseDir, BUILD_CACHE_RELATIVE_DIR);
}

/**
 * List runtime.build cache entries.
 */
export function listBuildCacheEntries(baseDir: string = process.cwd()): BuildCacheEntry[] {
  const buildCacheRoot = getBuildCacheDir(baseDir);
  if (!fs.existsSync(buildCacheRoot)) return [];

  const entries: BuildCacheEntry[] = [];
  for (const key of fs.readdirSync(buildCacheRoot)) {
    const entryPath = path.join(buildCacheRoot, key);
    if (!fs.statSync(entryPath).isDirectory()) continue;

    const metadataPath = path.join(entryPath, 'metadata.json');
    let metadata: Record<string, unknown> = {};
    if (fs.existsSync(metadataPath)) {
      try {
        metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) as Record<string, unknown>;
      } catch {
        metadata = {};
      }
    }

    let resolvedPlatform: RunPlatform | undefined;
    if (typeof metadata.platform === 'string') {
      try {
        resolvedPlatform = normalizeRunPlatform(metadata.platform);
      } catch {
        resolvedPlatform = undefined;
      }
    }

    entries.push({
      key,
      path: entryPath,
      sizeBytes: getDirectorySizeBytes(entryPath),
      createdAt: typeof metadata.createdAt === 'string' ? metadata.createdAt : undefined,
      platform: resolvedPlatform,
      arch: typeof metadata.arch === 'string' ? metadata.arch : undefined,
      image: typeof metadata.image === 'string' ? metadata.image : undefined,
      timeoutMs: typeof metadata.timeoutMs === 'number' ? metadata.timeoutMs : undefined,
      totalArtifactBytes: typeof metadata.totalArtifactBytes === 'number' ? metadata.totalArtifactBytes : undefined,
    });
  }

  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Remove build cache entries.
 */
export function clearBuildCache(baseDir: string = process.cwd(), key?: string): number {
  const buildCacheRoot = getBuildCacheDir(baseDir);
  if (!fs.existsSync(buildCacheRoot)) return 0;

  if (key) {
    const rootResolved = path.resolve(buildCacheRoot);
    const entryPath = path.resolve(buildCacheRoot, key);
    if (!entryPath.startsWith(`${rootResolved}${path.sep}`)) {
      throw new Error(`Invalid build cache key: ${key}`);
    }
    if (!fs.existsSync(entryPath)) return 0;
    fs.rmSync(entryPath, { recursive: true, force: true });
    return 1;
  }

  const entries = fs.readdirSync(buildCacheRoot)
    .filter((entry) => fs.statSync(path.join(buildCacheRoot, entry)).isDirectory());
  fs.rmSync(buildCacheRoot, { recursive: true, force: true });
  return entries.length;
}

/**
 * Result of `buildAgentArtifacts`: deps and (optionally) install.build artifacts.
 *
 * `artifactsPath` is set when the agent defines `install.build`; `deps` is set
 * when the agent defines `install.deps`. At least one is non-empty whenever
 * this function returns a non-null result.
 */
export interface AgentArtifactBuildResult {
  /** Absolute path to install.build cache dir, or undefined when no install.build is defined. */
  artifactsPath?: string;
  /** Prepared deps in declared order. Empty when the agent has no install.deps. */
  deps: PreparedAgentDep[];
  /** Resolved run platform the artifacts were built for. */
  platform: RunPlatform;
}

/**
 * Build `install.deps` and `install.build` artifacts for an agent.
 *
 * Returns `null` when there is nothing to build (no `install.deps` and no
 * `install.build`). Otherwise returns the resolved deps plus the install.build
 * cache dir (when defined).
 */
export async function buildAgentArtifacts(
  agent: ResolvedAgent,
  options: AgentArtifactBuildOptions
): Promise<AgentArtifactBuildResult | null> {
  const {
    agentPath,
    baseDir = process.cwd(),
    platform,
    rebuild = false,
    onProgress,
  } = options;

  if (!agent.install.build && (!agent.install.deps || agent.install.deps.length === 0)) {
    return null;
  }

  if (!(await isDockerAvailable())) {
    throw new Error('Docker is not available. Please ensure Docker is running.');
  }

  const project = loadProject(baseDir);
  const resolvedPlatform = resolveRunPlatform({
    cliPlatform: platform,
    projectDefaultPlatform: project.config.defaults?.run?.platform,
    dockerArch: (await getDockerInfo()).arch,
  });

  // Build deps first so install.build sees them.
  const preparedDeps = await prepareAgentDeps(agent, resolvedPlatform, baseDir, {
    forceRebuild: rebuild,
    onProgress,
  });

  if (!agent.install.build) {
    return { deps: preparedDeps, platform: resolvedPlatform };
  }

  const artifactsPath = await prepareAgentArtifacts(
    agent,
    agentPath,
    resolvedPlatform,
    baseDir,
    onProgress,
    rebuild,
    undefined,
    preparedDeps,
  );

  return {
    ...(artifactsPath !== undefined ? { artifactsPath } : {}),
    deps: preparedDeps,
    platform: resolvedPlatform,
  };
}

/**
 * Prepare the Docker image for an experiment
 * Uses content-based caching to avoid rebuilding identical images
 *
 * Image preparation considers:
 * 1. Dockerfile (if present, takes precedence)
 * 2. Resolved environment packages (experiment + agent)
 */
async function prepareExperimentImage(
  experiment: ResolvedExperiment,
  resolvedEnv: ResolvedEnvironment,
  _runId: string,
  runPlatform: RunPlatform,
  onProgress?: (message: string) => void,
  onCacheHit?: (hit: boolean) => void
): Promise<string> {
  if (experiment.hasDockerfile) {
    // Warn if package requirements are declared — Dockerfile experiments bypass package layer setup.
    const droppedPkgs: string[] = [];
    if (resolvedEnv.packages.apt.length > 0) droppedPkgs.push(`apt: ${resolvedEnv.packages.apt.join(', ')}`);
    if (resolvedEnv.packages.npm.length > 0) droppedPkgs.push(`npm: ${resolvedEnv.packages.npm.join(', ')}`);
    if (resolvedEnv.packages.pip.length > 0) droppedPkgs.push(`pip: ${resolvedEnv.packages.pip.join(', ')}`);
    if (droppedPkgs.length > 0) {
      onProgress?.(
        `Warning: environment/runtime packages [${droppedPkgs.join('; ')}] are ignored for Dockerfile experiments. ` +
          `Install dependencies in your Dockerfile, or use runtime.build for agent artifacts.`
      );
    }

    // For Dockerfile builds, use a hash of the Dockerfile content
    const dockerfilePath = path.join(experiment.dir, 'Dockerfile');
    const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');
    const hash = crypto.createHash('sha256').update(dockerfileContent).digest('hex').slice(0, 8);
    const targetImageName = `bunsen-experiment-${experiment.name}:${hash}-${platformTagSuffix(runPlatform)}`;

    // Check if image already exists
    if (await imageExists(targetImageName)) {
      onProgress?.(`Using cached image ${targetImageName}`);
      onCacheHit?.(true);
      return targetImageName;
    }

    onCacheHit?.(false);
    onProgress?.(`Building image from Dockerfile for ${runPlatform}...`);
    try {
      await buildImage(dockerfilePath, targetImageName, onProgress, runPlatform);
    } catch (err) {
      throw new Error(
        `Failed to build experiment image for ${runPlatform}: ${err instanceof Error ? err.message : err}`
      );
    }
    return targetImageName;
  }

  // Use resolved environment's base image
  const baseImage = resolvedEnv.baseImage;
  onProgress?.(`Ensuring base image ${baseImage} exists for ${runPlatform}...`);

  // Probe base-image presence so we can report cacheHit honestly even when
  // there are no setup commands (no overlay image to look up).
  const baseImagePreExisted = await imageExists(baseImage).catch(() => false);

  // For bunsen/* images, use the bunsen image handler which builds locally or pulls from registry
  if (isBunsenImage(baseImage)) {
    await ensureBunsenImage(baseImage, onProgress, runPlatform);
  } else {
    try {
      await ensureImage(baseImage, onProgress, runPlatform);
    } catch (err) {
      throw new Error(
        `Failed to prepare base image "${baseImage}" for ${runPlatform}: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  // Collect package install commands from resolved environment
  const allSetupCommands: string[] = [];

  if (hasPackageRequirements(resolvedEnv)) {
    allSetupCommands.push(...generatePackageInstallCommands(resolvedEnv.packages));
  }

  if (allSetupCommands.length > 0) {
    // Compute content-based hash for caching
    const hash = computeImageHash(baseImage, allSetupCommands, runPlatform);
    const targetImageName = `bunsen-experiment-${experiment.name}:${hash}-${platformTagSuffix(runPlatform)}`;

    // Check if image already exists
    if (await imageExists(targetImageName)) {
      onProgress?.(`Using cached image ${targetImageName}`);
      onCacheHit?.(true);
      return targetImageName;
    }

    onCacheHit?.(false);
    onProgress?.(`Running setup commands for ${runPlatform}...`);
    try {
      await prepareImage(baseImage, allSetupCommands, targetImageName, onProgress, runPlatform);
    } catch (err) {
      throw new Error(
        `Failed to prepare experiment image for ${runPlatform}: ${err instanceof Error ? err.message : err}`
      );
    }
    return targetImageName;
  }

  // Just use the base image directly
  onCacheHit?.(baseImagePreExisted);
  return baseImage;
}

/**
 * Build a `wrapAs` callback for `install.configure`. install.configure
 * defaults to `as: root`, so most calls return the script unchanged. A step
 * that opts into `as: user` in non-root mode gets the bunsen su wrapper so
 * it lands user-owned (matters when the step is a writeFile dropping into
 * `$BUNSEN_AGENT_HOME`).
 */
function makeInstallConfigureWrapAs(
  container: PersistentContainer,
  runAsNonRoot: boolean,
  depsPathPrefix: string,
): (script: string, asUser: 'root' | 'user', batchIdx: number) => Promise<string> {
  return async (script, asUser, batchIdx) => {
    if (asUser === 'root' || !runAsNonRoot) return script;
    const wrapped = `#!/bin/bash
export HOME=/home/bunsen
export PATH=${depsPathPrefix}:$HOME/.local/bin:$PATH
${script}
`;
    const tmpPath = `/tmp/bunsen-install-configure.${batchIdx}.sh`;
    await writeFileInContainer(container, tmpPath, wrapped, { mode: '755' });
    return `su bunsen -c ${tmpPath}`;
  };
}

/**
 * Build a `wrapAs` callback for `workspace.setup`. workspace.setup defaults
 * to `as: user`. In non-root mode that means wrapping run-batches AND
 * writeFile steps in `su bunsen -c <file>` so files land bunsen-owned. A
 * step that explicitly sets `as: root` returns unchanged (docker exec runs
 * as root by default). Per-batch temp script paths include `batchIdx` so a
 * mid-phase failure leaves earlier scripts intact for post-mortem.
 *
 * Cwd is owned by the dispatcher's `workdir: '/workspace'`, not the
 * wrapper. The outer docker exec lands in /workspace before `su bunsen -c
 * ...` runs, and su inherits the cwd. That keeps `as: root` steps (which
 * skip the wrapper entirely) at /workspace too — see REVIEW_2.md.
 */
function makeWorkspaceSetupWrapAs(
  container: PersistentContainer,
  runAsNonRoot: boolean,
  depsPathPrefix: string,
): (script: string, asUser: 'root' | 'user', batchIdx: number) => Promise<string> {
  return async (script, asUser, batchIdx) => {
    if (asUser === 'root' || !runAsNonRoot) return script;
    const wrapped = `#!/bin/bash
export HOME=/home/bunsen
export PATH=${depsPathPrefix}:$HOME/.local/bin:$PATH
${script}
`;
    const tmpPath = `/tmp/bunsen-workspace-setup.${batchIdx}.sh`;
    await writeFileInContainer(container, tmpPath, wrapped, { mode: '755' });
    return `su bunsen -c ${tmpPath}`;
  };
}

function createMounts(
  experiment: ResolvedExperiment,
  agentPath: string,
  artifactsPath?: string,
  deps: PreparedAgentDep[] = [],
): ContainerMount[] {
  const mounts: ContainerMount[] = [];

  const localWorkspaceSources = experiment.workspaceSources.filter((source) => source.type === 'path');
  for (const [index, source] of localWorkspaceSources.entries()) {
    mounts.push({
      source: source.sourcePath,
      target: `/bunsen/workspace-sources/local/${index}`,
      readonly: true,
    });
  }

  mounts.push({
    source: experiment.dir,
    target: '/input/experiment',
    readonly: true,
  });

  mounts.push({
    source: agentPath,
    target: '/agent',
    readonly: true,
  });

  if (artifactsPath) {
    mounts.push({
      source: artifactsPath,
      target: '/bunsen/artifacts',
      readonly: true,
    });
  }

  for (const dep of deps) {
    mounts.push({
      source: dep.artifactsPath,
      target: `/bunsen/deps/${dep.name}`,
      readonly: true,
    });
  }

  return mounts;
}

async function extractContainerDirectory(
  containerId: string,
  containerPath: string,
  hostDir: string
): Promise<string> {
  const { execSync } = await import('node:child_process');
  fs.mkdirSync(hostDir, { recursive: true });
  execSync(
    `docker cp ${containerId}:${containerPath}/. "${hostDir}/"`,
    { timeout: 120000 }
  );
  return hostDir;
}

function hasInitialWorkspaceSource(experiment: ResolvedExperiment): boolean {
  return experiment.workspaceSources.length > 0;
}

/**
 * Assemble declared `workspace.sources` into `/workspace-source` only.
 *
 * The materialization step (`/workspace` populated from `/workspace-source`)
 * is deliberately separate so it can run AFTER the non-root user has taken
 * ownership of `/workspace`. Running the big copy as the execution user
 * avoids a recursive `chown -R /workspace` over a large immutable seed.
 * See `docs/ENVIRONMENT.md`.
 */
export function buildWorkspaceSourceAssemblyScript(experiment: ResolvedExperiment): string {
  const sources = experiment.workspaceSources;
  let localSourceIndex = 0;
  const sourceScripts = sources.map((source) => {
    let sourcePath = source.sourcePath;
    if (source.type === 'path') {
      sourcePath = `/bunsen/workspace-sources/local/${localSourceIndex}`;
      localSourceIndex += 1;
    }
    const sourcePathLiteral = JSON.stringify(sourcePath);
    const targetLiteral = JSON.stringify(source.target ?? '');
    return `copy_workspace_source ${sourcePathLiteral} ${targetLiteral}`;
  });

  return `
    set -euo pipefail
    mkdir -p /workspace-source /workspace

    copy_workspace_source() {
      local source_path="$1"
      local target_rel="$2"
      local destination_root="/workspace-source"

      if [ ! -e "$source_path" ]; then
        echo "Workspace source path does not exist: $source_path" >&2
        exit 1
      fi

      if [ -d "$source_path" ]; then
        while IFS= read -r -d '' source_entry; do
          local rel_path="\${source_entry#./}"
          local dest_rel="$rel_path"
          if [ -n "$target_rel" ]; then
            dest_rel="$target_rel/$rel_path"
          fi
          if [ -e "$destination_root/$dest_rel" ]; then
            echo "Workspace source collision at: $dest_rel" >&2
            exit 1
          fi
        done < <(cd "$source_path" && find . -mindepth 1 -print0)

        if [ -n "$target_rel" ]; then
          mkdir -p "$destination_root/$target_rel"
          cp -a "$source_path"/. "$destination_root/$target_rel/"
        else
          cp -a "$source_path"/. "$destination_root/"
        fi
        return
      fi

      local dest_rel
      if [ -n "$target_rel" ]; then
        dest_rel="$target_rel"
      else
        dest_rel="$(basename "$source_path")"
      fi

      if [ -e "$destination_root/$dest_rel" ]; then
        echo "Workspace source collision at: $dest_rel" >&2
        exit 1
      fi

      mkdir -p "$(dirname "$destination_root/$dest_rel")"
      cp -a "$source_path" "$destination_root/$dest_rel"
    }

    ${sourceScripts.join('\n    ')}

    # Ensure /workspace-source is world-readable so the non-root execution
    # user can materialize /workspace from it. Host-path sources may mirror
    # restrictive host perms (e.g. 0700 on a user-owned directory); image-path
    # sources typically already arrive world-readable from the image tar.
    # Running this unconditionally keeps the invariant simple. It is O(N) on
    # file count but stays inside the generous assembly timeout.
    chmod -R u+rwX,go+rX /workspace-source 2>/dev/null || true
  `;
}

/**
 * Materialize `/workspace` from `/workspace-source`. Run as the execution
 * user — when running as `bunsen`, `cp -a` produces bunsen-owned files in
 * `/workspace` without any recursive chown afterwards. `/workspace-source`
 * stays root-owned and readable via standard world-readable perms.
 */
export function buildWorkspaceMaterializationScript(): string {
  return `
    set -euo pipefail
    cp -a /workspace-source/. /workspace/
  `;
}

/**
 * Run the dedicated `evaluation.report` step after all criteria have been
 * scored. Produces a narrative string that gets attached to the
 * {@link EvaluationResult}. Runs regardless of gate state — the report is the
 * narrative record and must never be blocked by a pipeline gate.
 */
async function runReportStep(opts: {
  reportConfig: ReportConfig;
  scorerContainerInfo: ScorerContainerInfo;
  criteria: Criterion[];
  dependencyScores: Record<string, DependencyScore>;
  needsNodeRuntime: boolean;
  proxyInfo?: ProxyContainerInfo;
  log: (msg: string) => void;
  progress: (msg: string) => void;
}): Promise<string | undefined> {
  const { reportConfig, scorerContainerInfo, criteria, dependencyScores, needsNodeRuntime, proxyInfo, log, progress } =
    opts;

  progress('Generating evaluation report...');

  // Expand `needs: 'all'` against the full criteria list so the scorer sees
  // every prior result as dependency context. Unknown ids are already
  // rejected by validateCriteriaGraph, so we trust them here.
  const allIds = criteria.map((c) => c.id);
  const resolvedNeeds: string[] =
    reportConfig.needs === undefined
      ? allIds
      : reportConfig.needs === 'all'
        ? allIds
        : [...reportConfig.needs];
  const dependencyScoresForReport: Record<string, DependencyScore> = {};
  for (const id of resolvedNeeds) {
    if (dependencyScores[id]) dependencyScoresForReport[id] = dependencyScores[id];
  }

  const scorerConfig: ScorerConfig = {
    criterion: 'summary-report',
    instructions: reportConfig.instructions,
    type: 'report',
    contextDir: '/bunsen/run',
    workspacePath: '/workspace',
  };
  if (reportConfig.model) scorerConfig.model = reportConfig.model;
  if (reportConfig.evidence) scorerConfig.context = reportConfig.evidence;
  if (Object.keys(dependencyScoresForReport).length > 0) {
    scorerConfig.dependencyScores = dependencyScoresForReport;
  }

  const reportTimeoutMs =
    parseOptionalDuration(reportConfig.timeout) ?? DEFAULT_CRITERION_TIMEOUT_MS;

  try {
    const output = await runLLMScorer(scorerContainerInfo, {
      configJson: JSON.stringify(scorerConfig, null, 2),
      criterion: 'summary-report',
      nodeCmd: needsNodeRuntime ? '/bunsen/runtime/node' : 'node',
      timeout: reportTimeoutMs,
      proxyEnv: proxyInfo ? getProxyEnv(proxyInfo) : undefined,
      onLog: (msg) => log(msg),
    });
    return output.report ?? output.summary;
  } catch (err) {
    log(`Report generation failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Get the directory listing of a path for orchestration context
 */
export function getDirectoryListing(dirPath: string): string {
  if (!fs.existsSync(dirPath)) {
    return '(directory does not exist)';
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const lines = entries.map((entry) => {
    const prefix = entry.isDirectory() ? 'd ' : '- ';
    return `${prefix}${entry.name}`;
  });

  return lines.join('\n');
}
