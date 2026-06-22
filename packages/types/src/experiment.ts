// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Public v1 shape for `experiment.yaml`.
 *
 * The matching JSON Schema lives at `@bunsen-dev/types/schemas/experiment.v1.json`.
 */

import type {
  AllowedScores,
  ExecutionUser,
  PackageSpecs,
  RunPlatform,
  RuntimeRequirements,
  StepConfig,
} from './common.js';

// ---------------------------------------------------------------------------
// Top-level experiment
// ---------------------------------------------------------------------------

/** Parsed `experiment.yaml` resource. */
export interface ExperimentConfig {
  $schema?: string;
  /** Schema version — always `v1` today. */
  version: 'v1';
  /** Stable identifier; ASCII, kebab-case. */
  name: string;
  /** Short human-readable summary. */
  description?: string;
  /** Free-form labels used for filtering and grouping runs. */
  labels?: Record<string, string>;

  task: TaskConfig;
  workspace?: WorkspaceConfig;
  environment: EnvironmentConfig;
  run?: RunConfig;
  evaluation: EvaluationConfig;

  /** Env vars added by this experiment (merged per the 8-source env order). */
  env?: Record<string, string>;
  /** Host env vars allowed to pass through from the shell. */
  passEnv?: string[];

  /** Named overlays applied on top of the base experiment. */
  variants?: Record<string, ExperimentVariant>;
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export interface TaskConfig {
  /** Required main instruction given to the agent under test. */
  prompt: string;
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export interface WorkspaceConfig {
  /** Ordered immutable inputs assembled into `/workspace-source`. */
  sources?: WorkspaceSourceEntry[];
  /** Ordered per-run setup commands applied after workspace materialization. */
  setup?: StepConfig[];
}

/**
 * A single workspace-source entry.
 *
 * Each entry declares exactly one of `path` (a file or directory in the
 * experiment repo) or `imagePath` (a file or directory present in the built
 * image).
 */
export type WorkspaceSourceEntry = WorkspaceSourcePath | WorkspaceSourceImagePath;

export interface WorkspaceSourcePath {
  /** File or directory in the experiment repo, resolved relative to the experiment directory. */
  path: string;
  /** Destination path inside the workspace, relative to the workspace root. */
  target?: string;
}

export interface WorkspaceSourceImagePath {
  /** File or directory in the built image. */
  imagePath: string;
  /** Destination path inside the workspace, relative to the workspace root. */
  target?: string;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export interface EnvironmentConfig {
  image: EnvironmentImage;
  requires?: RuntimeRequirements & { packages?: PackageSpecs };
  /** Declared experiment platforms. Runtime resolution must pick one of them. */
  platforms?: RunPlatform[];
  /** Execution user for the agent. */
  user?: ExecutionUser;
}

/** Either a base image tag or a Dockerfile reference. Exactly one. */
export type EnvironmentImage = EnvironmentImageBase | EnvironmentImageDockerfile;

export interface EnvironmentImageBase {
  base: string;
}

export interface EnvironmentImageDockerfile {
  dockerfile: string;
}

// ---------------------------------------------------------------------------
// Run settings (per experiment)
// ---------------------------------------------------------------------------

/** `run:` block inside `experiment.yaml`. */
export interface RunConfig {
  /** Overall agent timeout. Duration string. */
  timeout?: string;
  /** Single resolved platform for this run. */
  platform?: 'auto' | RunPlatform;
  /** Post-run artifact capture timeout. Duration string. */
  artifactCaptureTimeout?: string;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface EvaluationConfig {
  /** Where scorers execute. */
  container: EvaluationContainer;
  /** Ordered list of criteria. */
  criteria: Criterion[];
  /** Optional report configuration. Omitted = no report produced. */
  report?: ReportConfig;
}

export type EvaluationContainer = 'dedicated' | 'agent';

// ---------------------------------------------------------------------------
// Criterion types (discriminated union on `type`)
// ---------------------------------------------------------------------------

export type Criterion =
  | ScriptCriterion
  | JudgeCriterion
  | AgentCriterion
  | BrowserAgentCriterion
  | AggregateCriterion;

/** Fields common to every criterion type. */
interface CriterionBase {
  /** Stable machine id — used in dependencies and artifact paths. */
  id: string;
  /** Human-readable label. */
  title: string;
  /** Per-criterion timeout. Duration string. */
  timeout?: string;
  /** Numeric weight (default 1). */
  weight?: number;
  /** Allowed discrete score values. */
  scores?: AllowedScores;
  /** Dependencies by id, or `'all'` for every prior criterion. */
  needs?: string[] | 'all';
  /** If the resolved score falls below the threshold, skip remaining criteria. */
  gate?: CriterionGate;
}

export interface CriterionGate {
  /** If resolved score is below this threshold, skip remaining criteria. */
  ifBelow: number;
}

/** Shell command executed in the scorer container. */
export interface ScriptCriterion extends CriterionBase {
  type: 'script';
  /** Shell command to run. */
  run: string;
}

/** Single LLM call with specified evidence. */
export interface JudgeCriterion extends CriterionBase {
  type: 'judge';
  /** LLM prompt for evaluation. */
  instructions: string;
  /** Which run artifacts to expose in the prompt. Default: `['diff']`. */
  evidence?: JudgeEvidence[];
  /** Optional scorer-specific overrides. */
  scorer?: JudgeScorerConfig;
}

export type JudgeEvidence = 'diff' | 'logs' | 'traces';

export interface JudgeScorerConfig {
  model?: string;
}

/** Full agentic scorer with tools. */
export interface AgentCriterion extends CriterionBase {
  type: 'agent';
  instructions: string;
  scorer?: AgentScorerConfig;
}

export interface AgentScorerConfig {
  model?: string;
  tools?: string[];
}

/** Agentic scorer with browser / Playwright tooling. */
export interface BrowserAgentCriterion extends CriterionBase {
  type: 'browser-agent';
  instructions: string;
  scorer?: AgentScorerConfig;
}

/** Deterministic math over other criteria, no LLM. */
export interface AggregateCriterion extends CriterionBase {
  type: 'aggregate';
  /** Dependency criterion ids, or `'all'`. */
  needs: string[] | 'all';
  aggregate: AggregateSettings;
}

export interface AggregateSettings {
  function: AggregateFunction;
}

export type AggregateFunction = 'weighted_average' | 'all' | 'any' | 'min' | 'max';

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface ReportConfig {
  model?: string;
  /** Evidence categories to include in the report prompt. */
  evidence?: JudgeEvidence[];
  instructions: string;
  /** Dependencies by id, or `'all'`. */
  needs?: string[] | 'all';
  timeout?: string;
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

/**
 * Overlay applied on top of the base experiment.
 *
 * Merge semantics:
 * - Scalar/object fields shallow-merge.
 * - Arrays replace wholesale — except `evaluation.criteria`.
 * - In `evaluation.criteria`, entries with the same `id` replace the base
 *   entry; new ids append. Variants cannot delete criteria (set
 *   `weight: 0` to neutralize).
 */
export interface ExperimentVariant {
  description?: string;
  labels?: Record<string, string>;
  task?: Partial<TaskConfig>;
  workspace?: Partial<WorkspaceConfig>;
  environment?: Partial<EnvironmentConfig>;
  run?: Partial<RunConfig>;
  evaluation?: Partial<EvaluationConfig>;
  env?: Record<string, string>;
  passEnv?: string[];
}
