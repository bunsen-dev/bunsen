// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * @bunsen-dev/runtime - Internal execution engine for Bunsen.
 *
 * Not public API. See `@bunsen-dev/sdk` for the stable surface.
 */

// Configuration
export {
  parseExperimentConfig,
  loadExperiment,
  applyVariant,
  validateCriteriaGraph,
  resolveWorkspaceSources,
  ExperimentConfigError,
  parseAgentConfig,
  loadAgent,
  applyAgentVariant,
  parseAgentVariantSyntax,
  getAgentVariants,
  resolveModelSelection,
  AgentConfigError,
  findExperiments,
  findAgents,
  DEFAULT_BASE_IMAGE,
} from './config.js';
export type {
  ResolvedExperiment,
  ResolvedWorkspaceSource,
  ResolvedAgent,
  AgentWarning,
  LoadAgentOptions,
  ParseAgentOptions,
  ModelSelection,
} from './config.js';

// Environment resolution
export {
  resolveEnvironment,
  generatePackageInstallCommands,
  hasPackageRequirements,
} from './environment.js';

// Storage
export {
  RUN_PATHS,
  RUN_MANIFEST_FILENAME,
  RUN_MANIFEST_SCHEMA_VERSION,
  getBunsenDir,
  getRunsDir,
  getRunDir,
  ensureStorageDir,
  generateRunId,
  createRun,
  mutateRunManifest,
  updateRunStatus,
  saveLogs,
  appendLogs,
  loadLogs,
  saveTaskPrompt,
  loadTaskPrompt,
  saveOrchestrationResult,
  loadOrchestrationResult,
  parseTracesJsonl,
  loadTraces,
  loadTracesSummary,
  loadThreadsIndex,
  loadThreadTurns,
  loadThreadHeadTail,
  buildThreadsForScorer,
  finalizeTracesStreaming,
  finalizeRunTraces,
  markTraceCaptureMissing,
  markTraceCaptureSkipped,
  saveEvaluationResult,
  loadEvaluationResult,
  saveHumanScores,
  loadHumanScores,
  copyArtifacts,
  saveWorkspaceDiff,
  loadWorkspaceDiff,
  getWorkspaceTarPath,
  getRecordingPath,
  getScreenshotsDir,
  getCriterionLogPath,
  listArtifacts,
  readArtifact,
  listRuns,
  saveRunManifest,
  loadRunManifest,
} from './storage.js';

// Evaluation Coordinator
export {
  resolveDependencies,
  topologicalSort,
  determineScorerType,
  resolveCriteria,
  getExecutionOrder,
  buildScorerConfig,
  calculateWeightedScore,
  runAggregate,
  buildEvaluationResult,
  validateRubric,
} from './evaluation-coordinator.js';
export type { ResolvedCriterion } from './evaluation-coordinator.js';

// Calibration
export { computeCalibration } from './calibration.js';
export type { RunScorePair } from './calibration.js';

// Run cancellation (out-of-band)
export { cancelRun } from './run-cancel.js';
export type { CancelRunResult } from './run-cancel.js';

// Diff filtering
export { filterLockfilesFromDiff, LOCKFILE_BASENAMES } from './diff-filter.js';

// Trace filtering
export {
  ThreadDetector,
  filterTracesInMemory,
  formatThreadsForAgent,
} from './trace-filter.js';
export type {
  ThreadsIndex,
  ThreadIndexEntry,
  ThreadTurn,
  ThreadContext,
  ThreadStats,
  TimelineEntry,
  FilteredTraceSummary,
  FilteredTracesInMemory,
  ProcessTraceResult,
} from './trace-filter.js';

// Trace streaming
export {
  streamProcessTraces,
} from './trace-stream.js';
export type {
  StreamProcessOptions,
  StreamProcessResult,
} from './trace-stream.js';

// Re-export the storage-side load options so consumers needing it have one
// import surface alongside the run-aware loaders.
export type { LoadThreadTurnsOptions } from './storage.js';

// Container execution
export {
  buildImage,
  imageExists,
  ensureImage,
  prepareImage,
  getDockerInfo,
  isDockerAvailable,
  normalizeDockerArch,
  archToRunPlatform,
  runPlatformToArch,
  normalizeRunPlatform,
  inspectImagePlatform,
  // Network and proxy management
  createNetwork,
  removeNetwork,
  startProxyContainer,
  stopProxyContainer,
  getAddonScriptPath,
  getPricingDataPath,
  getProxyEnv,
  getCAInjectionCommands,
  // Persistent container management (for in-container platform agents)
  createPersistentContainer,
  execInContainer,
  execShellInContainer,
  ExecTimeoutError,
  writeFileInContainer,
  stopContainer,
  // tmux and asciinema for recording
  initTmuxSession,
  startAsciinemaRecording,
  stopAsciinemaRecording,
  sendKeysToTmux,
  sendEnterToTmux,
  captureTmuxPane,
  startTmuxLogCapture,
  stopTmuxLogCapture,
  isTmuxSessionActive,
  getRecordingInfo,
  // Platform tool paths
  getAssetDir,
  getPlatformBundlePath,
  // Bunsen image management
  isBunsenImage,
  getBunsenImageDockerfilePath,
  getBunsenRegistryImage,
  ensureBunsenImage,
  // Bunsen container labels
  BUNSEN_LABEL,
  BUNSEN_RUN_ID_LABEL,
  BUNSEN_COMPONENT_LABEL,
  // Cleanup
  listBunsenContainers,
  listBunsenNetworks,
  cleanupBunsenContainers,
} from './container.js';
export type { ProxyContainerInfo, PersistentContainer, ExecResult, ContainerLabelOptions, BunsenContainerInfo, CleanupResult } from './container.js';

// Container Node runtime resolution (custom / non-bunsen images)
export {
  getNodeRuntimePath,
  resolveContainerNodeRuntime,
  getHostCacheDir,
  getNodeRuntimeManifest,
  nodeRuntimeTarget,
  nodeRuntimeBinName,
  NODE_RUNTIME_VERSION,
} from './node-runtime.js';
export type { NodeRuntimeTarget } from './node-runtime.js';

// Executor
export {
  executeRun,
  RunCanceledError,
  buildExecLogs,
  cleanupInternalRunFiles,
  getDirectoryListing,
  buildAgentArtifacts,
  getBuildCacheDir,
  getDepsCacheDir,
  clearDepsCache,
  listDepsCacheEntries,
  listBuildCacheEntries,
  clearBuildCache,
  prepareAgentDeps,
  detectDepConflicts,
  detectCrossBoundaryShadows,
  resolveRunPlatform,
} from './executor.js';
export type {
  ExecutorOptions,
  ExecutorCallbacks,
  AgentArtifactBuildOptions,
  AgentArtifactBuildResult,
  AgentDepBuildOptions,
  PreparedAgentDep,
  ResolveRunPlatformOptions,
  BuildCacheEntry,
  DepsCacheEntry,
  CrossBoundaryShadow,
} from './executor.js';

// Sources
export {
  resolveAgentSource,
  getSourcesDir,
  generateSourceCacheKey,
  isSourceCached,
  getCachedSourcePath,
  clearSourceCache,
  listCachedSources,
} from './sources.js';

// Environment utilities
export {
  parseEnvFile,
  parseEnvContent,
  parseEnvFlag,
  parseEnvFlags,
  loadEnvFromSources,
  loadProjectEnv,
  mergeRunEnvironment,
} from './env.js';
export type { RunEnvSource, MergeRunEnvironmentOptions } from './env.js';

// Runtime contract (stable paths + reserved BUNSEN_* env vars)
export {
  STABLE_PATHS,
  buildStablePathsMkdirScript,
  buildReservedEnv,
} from './runtime-contract.js';
export type { ReservedEnvOptions } from './runtime-contract.js';

// Output auto-capture
export {
  captureAgentOutput,
  OUTPUT_CAPTURE_PER_FILE_LIMIT_BYTES,
  OUTPUT_CAPTURE_TOTAL_LIMIT_BYTES,
} from './output-capture.js';
export type {
  OutputCaptureOptions,
  OutputCaptureResult,
  OutputCaptureArtifactFlag,
  OutputManifest,
  OutputManifestFileOverride,
} from './output-capture.js';

// Project loader (bunsen.config.yaml v1)
export {
  parseProjectConfig,
  loadProject,
  findProjectRoot,
  resolveStoragePaths,
  getExperimentSearchPaths,
  getAgentSearchPaths,
  clearProjectCache,
  assertNoReservedEnvKeys,
  isReservedEnvKey,
  ProjectConfigError,
} from './project-loader.js';
export type {
  ResolvedProject,
  ResolvedStoragePaths,
  ProjectConfigWarning,
} from './project-loader.js';

// Suite loader (bunsen-suite.yaml v1)
export {
  parseSuiteManifest,
  loadSuiteFromDir,
  loadProjectSuites,
  detectSuiteProvenance,
  resolveSuiteCacheDir,
  getSuiteExperimentSearchPaths,
  suiteIdFromUrl,
  localSuiteId,
  SuiteManifestError,
} from './suite-loader.js';
export type { ResolvedSuite } from '@bunsen-dev/types';

// Suite cache (git clone/update/remove)
export {
  cloneSuite,
  updateSuite,
  removeSuiteCache,
  getSuiteCacheStatus,
  isGitAvailable,
  SuiteCacheError,
} from './suite-cache.js';
export type {
  CloneOptions,
  UpdateOptions,
  CacheStatus,
} from './suite-cache.js';

// Project config edit (bn suites add/remove)
export {
  getProjectConfigPath,
  replaceSuitesBlock,
  updateProjectSuites,
  ProjectConfigEditError,
} from './project-config-edit.js';

// Resolution
export {
  resolveExperiment,
  resolveAgent,
  describeSearchedLocations,
  findAllExperiments,
  findAllAgents,
  clearProjectInfoCache,
} from './resolve.js';
export type { ResolveResult } from './resolve.js';

// Gitignore exclusions
export {
  buildGitignoreFilter,
  buildGitignoreFilterFromContents,
  listNonIgnoredFiles,
  collectAllExclusionPatterns,
  parseGitignore,
  FALLBACK_EXCLUSIONS,
} from './gitignore.js';
export type { ExclusionResult, GitignoreFilter, GitignoreContent } from './gitignore.js';

export { formatInvocationForLog } from './orchestration.js';

// Run manifest helpers — manifest.json is the on-disk source of truth.
// All field-level mutations go through the storage.ts writers; the helpers
// here cover artifact classification + the artifacts[] re-walk used at
// end-of-run.
export {
  getRunManifestPath,
  refreshRunManifest,
  discoverArtifacts,
  classifyArtifact,
} from './manifest.js';

// Run events (append-only events.jsonl — task 13c)
export {
  RUN_EVENTS_FILENAME,
  getRunEventsPath,
  appendRunEvent,
  loadRunEvents,
} from './run-events.js';
export type { RunEventInput } from './run-events.js';

// Run index (SQLite projection over manifest.json — task 13 phase 2)
export {
  RUN_INDEX_FILENAME,
  RUN_INDEX_SCHEMA_VERSION,
  getRunIndexPath,
  openRunIndex,
  upsertManifest,
  upsertManifestSafely,
  deleteRun,
  getRunSummary,
  listRunSummaries,
  listRunCriteria,
  listRunAgentModels,
  findRunIdsByModel,
  countRuns,
  rebuildIndex,
} from './run-index.js';
export type {
  RunFilter,
  RunSummary,
  RebuildOptions,
  RebuildReport,
  CriterionRow,
  OpenIndexOptions,
} from './run-index.js';
