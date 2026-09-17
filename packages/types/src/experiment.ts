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
  /**
   * What to do when the agent hits `timeout`. `'score'` captures the workspace and
   * runs evaluation against whatever the agent left (the run completes, flagged as
   * timed-out) — the right choice for open-ended "do your best in a fixed budget"
   * tasks. `'fail'` (default) fails the run, suitable for bounded tasks.
   */
  onTimeout?: 'score' | 'fail';
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

/**
 * Exploration tools an `agent` scorer can be restricted to via `scorer.tools`.
 * The verdict tool (`submit_score`) is always present and cannot be listed.
 */
export type AgentScorerToolName = 'run_command' | 'read_file' | 'list_threads' | 'read_thread_turns';

/** `browser-agent` scorers add the Playwright pair to the agent tool set. */
export type BrowserAgentScorerToolName = AgentScorerToolName | 'screenshot' | 'run_playwright_script';

/** Every tool name a `scorer.tools` allowlist may contain, across both agentic types. */
export type ScorerToolName = BrowserAgentScorerToolName;

export const AGENT_SCORER_TOOLS: readonly AgentScorerToolName[] = [
  'run_command',
  'read_file',
  'list_threads',
  'read_thread_turns',
];

export const BROWSER_AGENT_SCORER_TOOLS: readonly BrowserAgentScorerToolName[] = [
  ...AGENT_SCORER_TOOLS,
  'screenshot',
  'run_playwright_script',
];

/** Fields shared by every LLM-backed scorer block. */
interface LLMScorerConfigBase {
  /**
   * Model to score with, in `<provider>/<model>` form — `anthropic/claude-sonnet-4-6`,
   * `openai/gpt-5.5`, `google/gemini-2.5-pro`. Bare ids are rejected. Default:
   * `anthropic/claude-sonnet-4-6`. The provider's API key must be available on
   * the host (see docs/SCORERS.md, "Models and providers").
   */
  model?: string;
  /**
   * Replaces the default system prompt wholesale — nothing is appended. The
   * criterion, its instructions, the allowed scores, the evidence, and the
   * verdict tool all travel in the user turn and the tool definitions, so
   * they survive any override.
   */
  systemPrompt?: string;
}

export interface JudgeScorerConfig extends LLMScorerConfigBase {}

/** Full agentic scorer with tools. */
export interface AgentCriterion extends CriterionBase {
  type: 'agent';
  instructions: string;
  scorer?: AgentScorerConfig;
}

export interface AgentScorerConfig extends LLMScorerConfigBase {
  /**
   * Allowlist of exploration tools the scorer may use. Omit for all of them.
   * `submit_score` is always available. Unknown names fail validation.
   */
  tools?: AgentScorerToolName[];
}

/** Agentic scorer with browser / Playwright tooling. */
export interface BrowserAgentCriterion extends CriterionBase {
  type: 'browser-agent';
  instructions: string;
  scorer?: BrowserAgentScorerConfig;
}

export interface BrowserAgentScorerConfig extends LLMScorerConfigBase {
  /** As {@link AgentScorerConfig.tools}, plus `screenshot` and `run_playwright_script`. */
  tools?: BrowserAgentScorerToolName[];
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
  /**
   * Threshold for `function: threshold` — 1.0 if every dependency scores
   * `>= at`, else 0.0. Required for `threshold`, rejected for other functions.
   */
  at?: number;
}

export type AggregateFunction = 'weighted_average' | 'all' | 'any' | 'min' | 'max' | 'threshold';

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface ReportConfig {
  /** As {@link JudgeScorerConfig.model}: `<provider>/<model>`; default `anthropic/claude-sonnet-4-6`. */
  model?: string;
  /** Evidence categories inlined into the report prompt. Default: `['diff']`. */
  evidence?: JudgeEvidence[];
  instructions: string;
  /** Dependencies by id, or `'all'`. */
  needs?: string[] | 'all';
  timeout?: string;
  /** Replaces the default report system prompt wholesale (see {@link JudgeScorerConfig.systemPrompt}). */
  systemPrompt?: string;
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
