// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Shared primitives referenced by more than one v1 resource type.
 */

/** Supported Linux execution platforms for Docker-backed runs. */
export type RunPlatform = 'linux/amd64' | 'linux/arm64';

/** Runtime requirement names recognized by `environment.requires.runtimes`. */
export type RuntimeName = 'node' | 'python' | 'go' | 'rust' | 'ruby';

/** A version specifier — exact ("20") or range (">=18 <22"). */
export type VersionSpec = string;

/** Package requirements grouped by package manager. */
export interface PackageSpecs {
  apt?: string[];
  npm?: string[];
  pip?: string[];
  cargo?: string[];
}

/**
 * Declarative substrate requirements (`environment.requires`). Drives image
 * preparation only; the agent does not contribute to it. See
 * `docs/ENVIRONMENT.md#asymmetric-composition`.
 */
export interface RuntimeRequirements {
  runtimes?: Partial<Record<RuntimeName, VersionSpec>>;
  packages?: PackageSpecs;
}

/**
 * Allowed score values for a criterion.
 *
 * - Array of numbers: discrete allowed scores (`[0, 0.5, 1]`).
 * - Record: labeled scores (`{ 0: 'none', 1: 'severe' }`).
 */
export type AllowedScores = number[] | Record<number, string>;

/** Execution user for workspace / build / configure steps. */
export type ExecutionUser = 'user' | 'root';

/**
 * Shared shape for step-style commands used in `workspace.setup`,
 * `install.configure`, and similar ordered command lists.
 *
 * Discriminated union: each step is either a shell command (`run`) or a file
 * write (`writeFile`). Exactly one of `run` / `writeFile` is set per step.
 */
export type StepConfig = RunStep | WriteFileStep;

/** Step that executes a shell command. */
export interface RunStep {
  /** Shell command to execute. */
  run: string;
  /** Execution user (default: `user`). */
  as?: ExecutionUser;
  /** Step-level timeout. Duration string. */
  timeout?: string;
}

/**
 * Step that drops a file at a known path inside the container. Solves the
 * heredoc-quoting footgun for inline content and lets agent authors keep
 * non-trivial content (system prompts, settings files) in `.md` / `.json`
 * files alongside `agent.yaml` instead of inside shell heredocs. See
 * `docs/SYSTEM_PROMPTS.md` for the motivating use case.
 *
 * Exactly one of `from` / `content` must be set:
 * - `from`: path relative to the directory containing `agent.yaml` /
 *   `experiment.yaml`. Resolved on the host; path-safety check ensures the
 *   resolved path stays within the source directory.
 * - `content`: inline UTF-8 content. No env interpolation — treated as a
 *   literal byte stream so secrets in env vars never leak into the manifest.
 *
 * The `writeFile` target path itself accepts shell-style variable expansion
 * (e.g. `$BUNSEN_AGENT_HOME/.claude/CLAUDE.md`); the container shell expands
 * it at execution time.
 *
 * Parent directories are auto-created; existing files are silently
 * overwritten (matches `cp`). File mode is `644`; if you need executable
 * mode, add a `run: chmod ...` follow-up step.
 */
export interface WriteFileStep {
  /** Target path inside the container. Supports shell variable expansion. */
  writeFile: string;
  /** Source file relative to the agent / experiment directory. */
  from?: string;
  /** Inline UTF-8 content. No env interpolation. */
  content?: string;
  /** Execution user (default: `user`). */
  as?: ExecutionUser;
  /** Step-level timeout. Duration string. */
  timeout?: string;
}

/** Fixed artifact-kind vocabulary shared by `RunManifestV1` and run descriptors. */
export type ArtifactKind =
  | 'output'
  | 'screenshot'
  | 'recording'
  | 'workspace'
  | 'report'
  | 'trace'
  | 'scores'
  | 'criterion_result'
  | 'human_scores'
  | 'logs'
  | 'task_prompt'
  | 'orchestration_result'
  | 'workspace_diff'
  | 'workspace_tar'
  | 'recording_cast'
  | 'trace_raw'
  | 'trace_platform'
  | 'trace_structured'
  | 'trace_summary'
  | 'supervisor'
  | 'scorer_log';

/** Verification tier stored in `RunManifestV1.provenance`. */
export type VerificationTier = 'self_reported' | 'reproducible' | 'attested';

/** Whether the run was executed locally or on a remote backend. */
export type RunSource = 'local' | 'remote';

/** Redaction status of a captured artifact, shared by manifest + run descriptors. */
export type RedactionState = 'unknown' | 'clean' | 'redacted' | 'blocked';
