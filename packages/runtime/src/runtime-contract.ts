// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Runtime contract surface for the agent container.
 *
 * See the reserved names section of `docs/ENVIRONMENT.md`:
 * stable paths and reserved `BUNSEN_*` env vars the agent may rely on.
 */

// ---------------------------------------------------------------------------
// Stable paths inside the agent container
// ---------------------------------------------------------------------------

export const STABLE_PATHS = {
  /** Writable task workspace. */
  workspace: '/workspace',
  /** Read-only immutable initial snapshot. Public scorer contract. */
  workspaceSource: '/workspace-source',
  /** Directory holding the canonical task prompt. */
  taskDir: '/bunsen/task',
  /** Canonical task prompt file. */
  taskFile: '/bunsen/task/prompt.md',
  /** Agent output artifacts (auto-captured). */
  outputDir: '/bunsen/output',
  /** Platform-generated run metadata. */
  runDir: '/bunsen/run',
  /** Experiment-provided scorer scripts. */
  verifiersDir: '/bunsen/verifiers',
  /** Platform helper binaries (`bunsen-score`, etc). */
  binDir: '/bunsen/bin',
  /** Agent `install.build` artifacts, read-only. */
  artifactsDir: '/bunsen/artifacts',
} as const;

/**
 * Shell snippet that creates every stable directory that is *not* bind-mounted
 * from the host. Idempotent — safe to run more than once.
 *
 * `/workspace` and `/workspace-source` are created by the workspace-source
 * assembly step and are deliberately omitted here. `/bunsen/artifacts` and
 * `/bunsen/verifiers` are read-only mounts set up at container creation.
 */
export function buildStablePathsMkdirScript(): string {
  const dirs = [
    STABLE_PATHS.taskDir,
    STABLE_PATHS.outputDir,
    STABLE_PATHS.runDir,
    STABLE_PATHS.binDir,
  ];
  return `mkdir -p ${dirs.join(' ')}`;
}

// ---------------------------------------------------------------------------
// Reserved BUNSEN_* environment variables
// ---------------------------------------------------------------------------

export interface ReservedEnvOptions {
  runId: string;
  experimentName: string;
  agentName: string;
  platform: string;
  /**
   * Whether the experiment runs the agent as root.
   * - `false` (default): agent runs as the non-root `bunsen` user; home is `/home/bunsen`.
   * - `true`: agent runs as root; home is `/root`.
   *
   * Used to populate `BUNSEN_AGENT_HOME` so `install.configure` scripts can
   * write to a single, predictable location regardless of execution user.
   */
  requiresRoot?: boolean;
  experimentVariant?: string;
  agentVariant?: string;
  suiteId?: string;
  suiteVersion?: string;
}

/**
 * Build the reserved `BUNSEN_*` environment that Bunsen injects into the
 * agent container. These names are immutable — the env merge rejects any
 * user attempt to override them.
 *
 * Suite vars (`BUNSEN_SUITE_ID`, `BUNSEN_SUITE_VERSION`) are only set when
 * the experiment is running via a suite. Variant vars are only set when
 * the corresponding variant was selected.
 */
export function buildReservedEnv(options: ReservedEnvOptions): Record<string, string> {
  const reserved: Record<string, string> = {
    BUNSEN_RUN_ID: options.runId,
    BUNSEN_EXPERIMENT: options.experimentName,
    BUNSEN_AGENT: options.agentName,
    BUNSEN_WORKSPACE_DIR: STABLE_PATHS.workspace,
    BUNSEN_WORKSPACE_SOURCE_DIR: STABLE_PATHS.workspaceSource,
    BUNSEN_OUTPUT_DIR: STABLE_PATHS.outputDir,
    BUNSEN_TASK_FILE: STABLE_PATHS.taskFile,
    BUNSEN_TASK_DIR: STABLE_PATHS.taskDir,
    BUNSEN_RUN_DIR: STABLE_PATHS.runDir,
    BUNSEN_AGENT_HOME: options.requiresRoot ? '/root' : '/home/bunsen',
    BUNSEN_PLATFORM: options.platform,
  };
  if (options.experimentVariant !== undefined) {
    reserved.BUNSEN_EXPERIMENT_VARIANT = options.experimentVariant;
  }
  if (options.agentVariant !== undefined) {
    reserved.BUNSEN_AGENT_VARIANT = options.agentVariant;
  }
  if (options.suiteId !== undefined) {
    reserved.BUNSEN_SUITE_ID = options.suiteId;
  }
  if (options.suiteVersion !== undefined) {
    reserved.BUNSEN_SUITE_VERSION = options.suiteVersion;
  }
  return reserved;
}
