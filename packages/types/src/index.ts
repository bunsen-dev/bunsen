// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `@bunsen-dev/types` — public type surface for the Bunsen v1 API.
 *
 * The v1 symbols below are the stable, externally-facing surface. The package
 * also exports an `@internal` runtime/CLI/agent type layer (see `./internal.js`
 * and the section at the bottom of this file): in-memory and on-disk-artifact
 * shapes the engine projects onto the canonical `RunManifestV1`. Those live
 * here only because the bundled platform agents can import nothing heavier than
 * a dependency-free package.
 */

// ---------------------------------------------------------------------------
// Schema / helpers
// ---------------------------------------------------------------------------

export {
  parseDuration,
  parseOptionalDuration,
  InvalidDurationError,
  type DurationString,
  type DurationUnit,
} from './duration.js';

export {
  parseSchemaMeta,
  tryParseSchemaMeta,
  SchemaMetaError,
  type SchemaMeta,
  type SchemaVersion,
  type ParseSchemaMetaOptions,
} from './schema-meta.js';

export {
  loadSchema,
  listSchemaIds,
  schemaUrl,
  type SchemaId,
  type JsonSchema,
} from './schemas.js';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export type {
  RunPlatform,
  RuntimeName,
  VersionSpec,
  PackageSpecs,
  RuntimeRequirements,
  AllowedScores,
  ExecutionUser,
  StepConfig,
  RunStep,
  WriteFileStep,
  ArtifactKind,
  VerificationTier,
  RunSource,
  RedactionState,
} from './common.js';

// ---------------------------------------------------------------------------
// Experiment config (v1)
// ---------------------------------------------------------------------------

export type {
  ExperimentConfig,
  TaskConfig,
  WorkspaceConfig,
  WorkspaceSourceEntry,
  WorkspaceSourcePath,
  WorkspaceSourceImagePath,
  EnvironmentConfig,
  EnvironmentImage,
  EnvironmentImageBase,
  EnvironmentImageDockerfile,
  RunConfig,
  EvaluationConfig,
  EvaluationContainer,
  Criterion,
  ScriptCriterion,
  JudgeCriterion,
  JudgeEvidence,
  JudgeScorerConfig,
  AgentCriterion,
  AgentScorerConfig,
  BrowserAgentCriterion,
  AggregateCriterion,
  AggregateSettings,
  AggregateFunction,
  CriterionGate,
  ReportConfig,
  ExperimentVariant,
} from './experiment.js';

// ---------------------------------------------------------------------------
// Agent config (v1)
// ---------------------------------------------------------------------------

export type {
  AgentConfig,
  InstallConfig,
  InstallSource,
  InstallSourceLocal,
  InstallSourceGit,
  InstallSourceNpm,
  InstallSourceBinary,
  BuildConfig,
  AgentDepSpec,
  AgentDepInstall,
  AgentDepProvides,
  AgentDepLinkage,
  AgentDepAbi,
  AgentDepRequires,
  AgentDepLibraryRequirement,
  ConfigureStep,
  Entrypoint,
  InteractionMode,
  InteractionConfig,
  ModelConfig,
  AgentDefaults,
  AgentExample,
  AgentVariant,
  VariantInstallConfig,
  VariantInstallSource,
  VariantConfigureSteps,
  MergeableArray,
} from './agent.js';

// ---------------------------------------------------------------------------
// Project config (v1)
// ---------------------------------------------------------------------------

export type {
  ProjectConfig,
  ProjectPaths,
  ProjectSuiteEntry,
  ProjectSuiteSource,
  ProjectSuiteSourceGit,
  ProjectStorageConfig,
  ProjectDefaults,
  ProjectRunDefaults,
  ProjectCaptureConfig,
  ProjectSupervisorConfig,
  ProjectRegistries,
  ProjectImageRegistry,
} from './project.js';

// ---------------------------------------------------------------------------
// Suite manifest (v1)
// ---------------------------------------------------------------------------

export type {
  SuiteManifestV1,
  SuiteCompatibility,
  SuiteTrack,
  SuiteAggregation,
  SuiteWeightConfig,
  ResolvedSuite,
} from './suite.js';

// ---------------------------------------------------------------------------
// Run (v1)
// ---------------------------------------------------------------------------

export type { RunStatus, RunSummary, RunFilter, ArtifactDescriptor } from './run.js';

// ---------------------------------------------------------------------------
// Run events (v1)
// ---------------------------------------------------------------------------

export type {
  RunEvent,
  RunEventName,
  InstallBuildStartedEvent,
  InstallBuildCompletedEvent,
  WorkspaceSourcesStartedEvent,
  WorkspaceSourcesCompletedEvent,
  InstallConfigureStartedEvent,
  InstallConfigureCompletedEvent,
  WorkspaceSetupStartedEvent,
  WorkspaceSetupCompletedEvent,
  RunStartedEvent,
  AgentStartedEvent,
  AgentCompletedEvent,
  EvaluationStartedEvent,
  CriterionStartedEvent,
  CriterionCompletedEvent,
  EvaluationReportStartedEvent,
  EvaluationReportCompletedEvent,
  RunCompletedEvent,
  RunFailedEvent,
  RunCanceledEvent,
} from './events.js';

// ---------------------------------------------------------------------------
// Orchestration (v1)
// ---------------------------------------------------------------------------

export type {
  OrchestrationResult,
  OrchestrationInvocation,
} from './orchestration.js';

// ---------------------------------------------------------------------------
// Evaluation (v1)
// ---------------------------------------------------------------------------

export type {
  EvaluationResult,
  CriterionResult,
  CriterionStatus,
  ScriptResult,
  ScriptResultArtifact,
} from './evaluation.js';

// ---------------------------------------------------------------------------
// Run manifest (v1)
// ---------------------------------------------------------------------------

export type {
  RunManifestV1,
  RunManifestExperiment,
  RunManifestAgent,
  RunManifestAgentDep,
  AgentModelUsage,
  RunManifestOrchestration,
  RunManifestUsage,
  RunManifestUsageSource,
  RunManifestEvaluation,
  RunManifestCriterion,
  RunManifestScorerType,
  RunManifestHumanScoring,
  RunManifestHumanCriterion,
  RunManifestProvenance,
  RunManifestArtifact,
  RunManifestDiagnostic,
  RunManifestCrossBoundaryShadow,
} from './manifest.js';

// ---------------------------------------------------------------------------
// Validation (v1)
// ---------------------------------------------------------------------------

export type { ValidationError, ValidationErrorLocation } from './validation.js';

// ---------------------------------------------------------------------------
// Internal runtime/CLI/agent type layer (@internal — not part of the public v1
// API). In-memory + on-disk-artifact shapes the engine projects onto
// `RunManifestV1`. Exported here only because the bundled platform agents can
// import nothing heavier than this dependency-free package.
// ---------------------------------------------------------------------------

export type {
  AITrace,
  SourceCostBreakdown,
  TracesSummary,
  HumanCriterionScore,
  HumanScores,
  CalibrationCriterionStats,
  CalibrationResult,
  ContainerOptions,
  ContainerMount,
  ScorerType,
  DependencyScore,
  ScorerConfig,
  ScorerOutput,
  SupervisorInteraction,
  SupervisorLog,
} from './internal.js';
