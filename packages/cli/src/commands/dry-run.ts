// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `bn run --dry-run` implementation.
 *
 * Resolves everything we can know without touching Docker or the agent and
 * emits a `RunManifestV1` with `status: "pending"`. The shape matches a real
 * post-run manifest so an agent can post-process either with the same
 * schemas.
 *
 * Effectively a pre-built manifest.json with status: pending — same shape as
 * every real run.
 */

import * as path from 'node:path';
import chalk from 'chalk';
import {
  loadAgent,
  loadExperiment,
  loadProject,
  mergeRunEnvironment,
  parseAgentVariantSyntax,
  resolveAgent,
  resolveExperiment,
  resolveModelSelection,
  resolveRunPlatform,
  describeSearchedLocations,
  generateRunId,
  isDockerAvailable,
  getDockerInfo,
  archToRunPlatform,
  AgentConfigError,
  type RunEnvSource,
} from '@bunsen-dev/runtime';
import type { RunManifestV1, RunPlatform } from '@bunsen-dev/types';
import { renderMachine, type OutputFormat } from '../format.js';
import { BunsenCliError } from '../errors.js';
import { EXIT_CODES } from '../exit-codes.js';

export interface DryRunOptions {
  experimentArg: string;
  agentArg?: string;
  agentVariantOverride?: string;
  experimentVariantOverride?: string;
  model?: string;
  cliArgs: string[];
  envFlags: string[];
  envFiles: string[];
  passEnv: string[];
  platform?: string;
  timeoutMs: number;
  skipEval?: boolean;
  skipTraces?: boolean;
  record?: boolean;
  format: OutputFormat;
}

interface PlatformProvenance {
  resolved: RunPlatform;
  source: 'cli' | 'experiment' | 'project' | 'docker' | 'experiment.environment.platforms';
  reason?: string;
  detail?: string;
}

interface DryRunPlan {
  manifest: RunManifestV1;
  platformProvenance: PlatformProvenance;
  environment: {
    merged: Record<string, string>;
    source: Record<string, string>;
  };
  evaluation: {
    criteria: Array<{ id: string; type: string; weight: number }>;
    skipped: boolean;
  };
  capture: {
    traces: boolean;
    recording: boolean;
  };
  workspace: {
    sources: Array<{ type: string; from: string; target: string }>;
  };
}

export async function runDryRun(options: DryRunOptions): Promise<void> {
  const cwd = process.cwd();
  const project = loadProject(cwd);

  const [experimentName, expVariantInline] = parseAgentVariantSyntax(options.experimentArg);
  const experimentVariant = options.experimentVariantOverride ?? expVariantInline;

  const experimentResolution = resolveExperiment(experimentName);
  if (!experimentResolution) {
    throw new BunsenCliError(
      'experiment_not_found',
      `Experiment not found: ${experimentName}`,
      {
        exitCode: EXIT_CODES.GENERIC,
        details: { searched: describeSearchedLocations('experiment') },
      },
    );
  }

  if (!options.agentArg) {
    throw new BunsenCliError(
      'usage_missing_agent',
      'Agent is required: pass it as a positional argument or with --agent.',
      { exitCode: EXIT_CODES.USAGE },
    );
  }

  const [agentName, agentVariantInline] = parseAgentVariantSyntax(options.agentArg);
  const agentVariant = options.agentVariantOverride ?? agentVariantInline;
  const agentResolution = resolveAgent(agentName);
  if (!agentResolution) {
    throw new BunsenCliError('agent_not_found', `Agent not found: ${agentName}`, {
      exitCode: EXIT_CODES.GENERIC,
      details: { searched: describeSearchedLocations('agent') },
    });
  }

  const experiment = loadExperiment(experimentResolution.path, experimentVariant);
  const agent = loadAgent(agentResolution.path, { variant: agentVariant });

  let modelSelection;
  try {
    modelSelection = resolveModelSelection(agent, options.model);
  } catch (err) {
    if (err instanceof AgentConfigError) {
      throw new BunsenCliError('run_model_unsupported', err.message, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    throw err;
  }

  const platformProvenance = await resolvePlatformWithProvenance({
    cliPlatform: options.platform,
    experimentRunPlatform: experiment.run?.platform,
    projectDefaultPlatform: project.config.defaults?.run?.platform,
    supportedPlatforms: experiment.environment.platforms,
  });

  // Mirror the executor's model wiring: the declared `default` seeds the model
  // env var at the agent-defaults tier; `--model` rides the CLI `--env` tier.
  const agentDefaultsEnv: Record<string, string> | undefined =
    modelSelection?.defaultValue !== undefined
      ? { [modelSelection.envName]: modelSelection.defaultValue, ...agent.defaults?.env }
      : agent.defaults?.env;
  const modelOverrideFlags =
    modelSelection?.overrideValue !== undefined
      ? [`${modelSelection.envName}=${modelSelection.overrideValue}`]
      : [];
  const cliEnvFlags = [...modelOverrideFlags, ...options.envFlags];

  const envSources: RunEnvSource[] = [];
  if (project.config.defaults?.env) {
    envSources.push({ label: 'project.defaults.env', env: project.config.defaults.env });
  }
  if (project.config.defaults?.passEnv) {
    envSources.push({ label: 'project.defaults.passEnv', passEnv: project.config.defaults.passEnv });
  }
  if (agentDefaultsEnv) envSources.push({ label: 'agent.defaults.env', env: agentDefaultsEnv });
  if (agent.defaults?.passEnv) envSources.push({ label: 'agent.defaults.passEnv', passEnv: agent.defaults.passEnv });
  if (experiment.env) envSources.push({ label: 'experiment.env', env: experiment.env });
  if (experiment.passEnv) envSources.push({ label: 'experiment.passEnv', passEnv: experiment.passEnv });

  let mergedEnv: Record<string, string> = {};
  let envProvenance: Record<string, string> = {};
  try {
    mergedEnv = mergeRunEnvironment({
      sources: envSources,
      cliEnvFiles: options.envFiles,
      cliEnvFlags,
      cliPassEnv: options.passEnv,
    });
    envProvenance = computeEnvProvenance({
      sources: envSources,
      cliEnvFiles: options.envFiles,
      cliEnvFlags,
      cliPassEnv: options.passEnv,
    });
  } catch (error) {
    throw new BunsenCliError(
      'env_merge_failed',
      error instanceof Error ? error.message : String(error),
      { exitCode: EXIT_CODES.VALIDATION },
    );
  }

  const guaranteedArgs = agent.entrypoint.args ?? [];
  const finalArgs = [...options.cliArgs, ...guaranteedArgs];

  // The model the agent will actually be configured with, read straight from
  // the merged env (covers --model, variant pin, and declared default).
  const configuredModel = modelSelection ? mergedEnv[modelSelection.envName] : undefined;

  const runId = generateRunId();
  const now = new Date().toISOString();

  const baseImage = 'base' in experiment.environment.image ? experiment.environment.image.base : undefined;
  const dockerfile =
    'dockerfile' in experiment.environment.image ? experiment.environment.image.dockerfile : undefined;

  const workspaceSources = experiment.workspaceSources.map((source) => ({
    type: source.type,
    from:
      source.type === 'path'
        ? path.relative(cwd, source.sourcePath)
        : source.sourcePath,
    target: source.target ?? '/workspace',
  }));

  const evaluationCriteria = experiment.evaluation.criteria.map((c) => ({
    id: c.id,
    type: c.type,
    weight: c.weight ?? 1,
  }));

  const captureDefaults = project.config.defaults?.run?.capture;
  const captureRecording = options.record ?? captureDefaults?.recording ?? false;
  const captureTraces = options.skipTraces ? false : (captureDefaults?.traces ?? true);

  const redactedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(mergedEnv)) {
    redactedEnv[key] = isSensitive(key) ? '<redacted>' : value;
  }

  const manifest: RunManifestV1 = {
    schema_version: 1,
    run_id: runId,
    manifest_revision: 1,
    run_source: 'local',
    created_at: now,
    updated_at: now,
    status: 'pending',
    started_at: now,
    duration_ms: 0,
    platform: platformProvenance.resolved,
    experiment: {
      id: experiment.name,
      path: path.relative(cwd, experimentResolution.path),
      ...(experimentVariant ? { variant: experimentVariant } : {}),
    },
    agent: {
      id: agent.name,
      path: path.relative(cwd, agentResolution.path),
      ...(agentVariant ? { variant: agentVariant } : {}),
      ...(configuredModel ? { model: configuredModel } : {}),
      args: finalArgs,
    },
    usage: {
      total_ai_calls: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      estimated_cost_usd: 0,
    },
    provenance: {
      verification_tier: 'self_reported',
      replayable: false,
    },
    artifacts: [],
    extensions: {
      dry_run: {
        platform: platformProvenance,
        environment: {
          merged: redactedEnv,
          provenance: envProvenance,
        },
        image: {
          base: baseImage,
          dockerfile: dockerfile ? path.relative(cwd, dockerfile) : undefined,
        },
        workspace_sources: workspaceSources,
        evaluation: {
          skipped: Boolean(options.skipEval),
          criteria: evaluationCriteria,
        },
        capture: {
          traces: captureTraces,
          recording: captureRecording,
        },
        timeout_ms: options.timeoutMs,
        cli_args: options.cliArgs,
        guaranteed_args: guaranteedArgs,
      },
    },
  };

  if (options.format === 'json' || options.format === 'yaml') {
    process.stdout.write(renderMachine(manifest, options.format));
    return;
  }

  renderText({
    manifest,
    platformProvenance,
    environment: { merged: redactedEnv, source: envProvenance },
    workspace: { sources: workspaceSources },
    evaluation: { criteria: evaluationCriteria, skipped: Boolean(options.skipEval) },
    capture: { traces: captureTraces, recording: captureRecording },
  });
}

async function resolvePlatformWithProvenance(input: {
  cliPlatform?: string;
  experimentRunPlatform?: string;
  projectDefaultPlatform?: string;
  supportedPlatforms?: RunPlatform[];
}): Promise<PlatformProvenance> {
  let dockerArch = 'amd64';
  let dockerReachable = false;
  if (await isDockerAvailable().catch(() => false)) {
    try {
      const info = await getDockerInfo();
      dockerArch = info.arch;
      dockerReachable = true;
    } catch {
      // ignore; we'll fall back to amd64
    }
  }

  if (input.cliPlatform) {
    return {
      resolved: resolveRunPlatform({
        cliPlatform: input.cliPlatform,
        dockerArch,
        ...(input.supportedPlatforms ? { supportedPlatforms: input.supportedPlatforms } : {}),
      }),
      source: 'cli',
      reason: '--platform flag',
    };
  }
  if (input.experimentRunPlatform && input.experimentRunPlatform !== 'auto') {
    return {
      resolved: resolveRunPlatform({
        experimentRunPlatform: input.experimentRunPlatform as 'auto' | RunPlatform,
        dockerArch,
        ...(input.supportedPlatforms ? { supportedPlatforms: input.supportedPlatforms } : {}),
      }),
      source: 'experiment',
      reason: 'experiment.run.platform',
    };
  }
  if (input.projectDefaultPlatform && input.projectDefaultPlatform !== 'auto') {
    return {
      resolved: resolveRunPlatform({
        projectDefaultPlatform: input.projectDefaultPlatform as 'auto' | RunPlatform,
        dockerArch,
        ...(input.supportedPlatforms ? { supportedPlatforms: input.supportedPlatforms } : {}),
      }),
      source: 'project',
      reason: 'defaults.run.platform',
    };
  }
  if (input.supportedPlatforms?.length === 1) {
    return {
      resolved: input.supportedPlatforms[0],
      source: 'experiment.environment.platforms',
      reason: 'single supported platform',
    };
  }
  return {
    resolved: archToRunPlatform(dockerArch),
    source: 'docker',
    reason: dockerReachable ? `docker daemon arch=${dockerArch}` : `docker unreachable; default arch=${dockerArch}`,
  };
}

function computeEnvProvenance(input: {
  sources: RunEnvSource[];
  cliEnvFiles: string[];
  cliEnvFlags: string[];
  cliPassEnv: string[];
}): Record<string, string> {
  const provenance: Record<string, string> = {};
  // Apply in the same low-to-high precedence order as `mergeRunEnvironment`,
  // so the recorded label matches the source that actually wins.
  for (const source of input.sources) {
    for (const key of source.passEnv ?? []) {
      if (process.env[key] !== undefined) provenance[key] = `${source.label} (host)`;
    }
  }
  for (const passKey of input.cliPassEnv) {
    if (process.env[passKey] !== undefined) provenance[passKey] = 'cli --pass-env (host)';
  }
  for (const source of input.sources) {
    if (!source.env) continue;
    for (const key of Object.keys(source.env)) provenance[key] = source.label;
  }
  for (const file of input.cliEnvFiles) {
    provenance[`<${path.basename(file)}>`] = `cli --env-file ${file}`;
  }
  for (const flag of input.cliEnvFlags) {
    const eq = flag.indexOf('=');
    if (eq > 0) provenance[flag.slice(0, eq)] = 'cli --env';
  }
  return provenance;
}

function renderText(plan: DryRunPlan): void {
  console.log();
  console.log(chalk.bold('Dry run — pending manifest'));
  console.log(chalk.dim('═'.repeat(60)));
  console.log(`Run ID:      ${plan.manifest.run_id}`);
  console.log(`Status:      ${chalk.yellow('pending')}`);
  const expVariant = plan.manifest.experiment.variant ? `:${plan.manifest.experiment.variant}` : '';
  const agentVariant = plan.manifest.agent.variant ? `:${plan.manifest.agent.variant}` : '';
  console.log(`Experiment:  ${plan.manifest.experiment.id}${expVariant}`);
  console.log(`Agent:       ${plan.manifest.agent.id}${agentVariant}`);
  if (plan.manifest.agent.model) {
    console.log(`Model:       ${plan.manifest.agent.model}`);
  }
  console.log(
    `Platform:    ${plan.platformProvenance.resolved}` +
      chalk.dim(` (${plan.platformProvenance.source}${plan.platformProvenance.reason ? ': ' + plan.platformProvenance.reason : ''})`),
  );

  if (plan.manifest.agent.args.length > 0) {
    console.log(`Args:        ${plan.manifest.agent.args.join(' ')}`);
  }

  console.log();
  console.log(chalk.bold('Environment'));
  console.log(chalk.dim('─'.repeat(60)));
  if (Object.keys(plan.environment.merged).length === 0) {
    console.log(chalk.dim('  (no env contributions before reserved BUNSEN_* vars)'));
  } else {
    for (const [key, value] of Object.entries(plan.environment.merged)) {
      const provenance = plan.environment.source[key] ?? 'unknown';
      console.log(`  ${key}=${value} ${chalk.dim(`(${provenance})`)}`);
    }
  }

  if (plan.workspace.sources.length > 0) {
    console.log();
    console.log(chalk.bold('Workspace sources'));
    console.log(chalk.dim('─'.repeat(60)));
    for (const source of plan.workspace.sources) {
      console.log(`  [${source.type}] ${source.from} → ${source.target}`);
    }
  }

  console.log();
  console.log(chalk.bold('Evaluation'));
  console.log(chalk.dim('─'.repeat(60)));
  if (plan.evaluation.skipped) {
    console.log(chalk.dim('  Skipped (--skip-eval)'));
  } else if (plan.evaluation.criteria.length === 0) {
    console.log(chalk.dim('  (no criteria)'));
  } else {
    for (const c of plan.evaluation.criteria) {
      console.log(`  ${c.id} ${chalk.dim(`[${c.type}, weight=${c.weight}]`)}`);
    }
  }

  console.log();
  console.log(chalk.bold('Capture'));
  console.log(chalk.dim('─'.repeat(60)));
  console.log(`  traces:    ${plan.capture.traces ? 'yes' : 'no'}`);
  console.log(`  recording: ${plan.capture.recording ? 'yes' : 'no'}`);

  console.log();
  console.log(chalk.dim('No run was executed. Re-run without --dry-run to actually run.'));
  console.log();
  console.log(chalk.dim('Tip: --format json|yaml emits the same plan as a RunManifestV1 with status="pending".'));
  console.log();
}

const SENSITIVE_KEYS = [
  'API_KEY',
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'PRIVATE_KEY',
];

function isSensitive(key: string): boolean {
  const upper = key.toUpperCase();
  return SENSITIVE_KEYS.some((suffix) => upper.includes(suffix));
}
