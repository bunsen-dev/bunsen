// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Run command - Execute an experiment with an agent
 */

import chalk from 'chalk';
import ora from 'ora';
import {
  loadExperiment,
  loadAgent,
  executeRun,
  loadEvaluationResult,
  parseAgentVariantSyntax,
  resolveExperiment,
  resolveAgent,
  resolveModelSelection,
  describeSearchedLocations,
  AgentConfigError,
  RunCanceledError,
} from '@bunsen-dev/runtime';
import { parseDuration } from '@bunsen-dev/types';
import { formatEvaluationForTerminal } from './helpers/format-scores-for-terminal.js';
import { runDryRun } from './dry-run.js';
import { resolveFormat } from '../format.js';
import { reportError, BunsenCliError } from '../errors.js';
import { EXIT_CODES } from '../exit-codes.js';

interface RunOptions {
  agent?: string;
  agentVariant?: string;
  experimentVariant?: string;
  model?: string;
  env?: string[];
  envFile?: string[];
  passEnv?: string[];
  skipEval?: boolean;
  skipTraces?: boolean;
  verbose?: boolean;
  timeout?: string;
  debugKeepContainer?: boolean;
  exportWorkspace?: boolean;
  record?: boolean;
  terminalSize?: string;
  rebuildAgent?: boolean;
  platform?: string;
  dryRun?: boolean;
  remote?: boolean;
  format?: string;
}

function parseTimeoutMs(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  // Pure-number input is interpreted as milliseconds (preserves the previous
  // CLI contract); other forms (`30s`, `5m`, `1h`) go through the v1 duration
  // parser.
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return parseDuration(value);
}

export async function runCommand(
  experimentArg: string,
  agentArgPositional: string | undefined,
  options: RunOptions,
  _command: { args: string[] }
): Promise<void> {
  const spinner = ora();
  const format = resolveFormat(options);

  // Validate constrained flag formats up front so a typo fails fast with a
  // usage error rather than surfacing deep in Docker setup (or silently).
  if (options.platform !== undefined && !/^linux\/(amd64|arm64)$/.test(options.platform)) {
    reportError(
      new BunsenCliError(
        'run_bad_platform',
        `Invalid --platform: ${options.platform}. Expected linux/amd64 or linux/arm64.`,
        { exitCode: EXIT_CODES.USAGE, details: { value: options.platform } },
      ),
      format,
    );
    return;
  }
  if (options.terminalSize !== undefined && !/^\d+x\d+$/.test(options.terminalSize)) {
    reportError(
      new BunsenCliError(
        'run_bad_terminal_size',
        `Invalid --terminal-size: ${options.terminalSize}. Expected <cols>x<rows>, e.g. 120x40.`,
        { exitCode: EXIT_CODES.USAGE, details: { value: options.terminalSize } },
      ),
      format,
    );
    return;
  }

  // --remote is a reserved namespace; the runtime has no remote backend yet.
  // Reject before any Docker work or flag interpretation so the message is
  // identical regardless of other flags.
  if (options.remote) {
    reportError(
      new BunsenCliError(
        'not_implemented',
        '`bn run --remote` is reserved for a future remote-execution backend and is not implemented yet.',
        {
          exitCode: EXIT_CODES.GENERIC,
          details: { feature: 'remote-execution' },
        },
      ),
      format,
    );
    return;
  }

  // --dry-run is a fully separate code path — bail before we touch Docker.
  if (options.dryRun) {
    try {
      const dashDashIndex = process.argv.indexOf('--');
      const cliArgs = dashDashIndex !== -1 ? process.argv.slice(dashDashIndex + 1) : [];
      const agentArg = agentArgPositional ?? options.agent;
      await runDryRun({
        experimentArg,
        ...(agentArg !== undefined ? { agentArg } : {}),
        ...(options.agentVariant !== undefined ? { agentVariantOverride: options.agentVariant } : {}),
        ...(options.experimentVariant !== undefined ? { experimentVariantOverride: options.experimentVariant } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        cliArgs,
        envFlags: options.env || [],
        envFiles: options.envFile || [],
        passEnv: options.passEnv || [],
        ...(options.platform !== undefined ? { platform: options.platform } : {}),
        timeoutMs: parseTimeoutMs(options.timeout, 900000),
        ...(options.skipEval !== undefined ? { skipEval: options.skipEval } : {}),
        ...(options.skipTraces !== undefined ? { skipTraces: options.skipTraces } : {}),
        ...(options.record !== undefined ? { record: options.record } : {}),
        format,
      });
      process.exit(EXIT_CODES.SUCCESS);
    } catch (error) {
      reportError(error, format);
    }
    return;
  }

  try {
    // Parse CLI args (everything after --)
    const dashDashIndex = process.argv.indexOf('--');
    const cliArgs = dashDashIndex !== -1 ? process.argv.slice(dashDashIndex + 1) : [];

    // Resolve experiment path (with optional :variant syntax)
    const [experimentName, expVariantInline] = parseAgentVariantSyntax(experimentArg);
    const experimentVariant = options.experimentVariant ?? expVariantInline;
    const experimentResult = resolveExperiment(experimentName);
    if (!experimentResult) {
      throw new BunsenCliError(
        'experiment_not_found',
        `Experiment not found: ${experimentName}`,
        { exitCode: EXIT_CODES.GENERIC, details: { searched: describeSearchedLocations('experiment') } },
      );
    }
    const experimentPath = experimentResult.path;

    // Determine agent: positional argument wins, falls back to --agent flag.
    const agentArg = agentArgPositional ?? options.agent;
    if (!agentArg) {
      throw new BunsenCliError(
        'usage_missing_agent',
        'Agent is required: pass it as a positional argument or with --agent.',
        { exitCode: EXIT_CODES.USAGE },
      );
    }
    const [agentName, variantInline] = parseAgentVariantSyntax(agentArg);
    const variantName = options.agentVariant ?? variantInline;

    const agentResult = resolveAgent(agentName);
    if (!agentResult) {
      throw new BunsenCliError('agent_not_found', `Agent not found: ${agentName}`, {
        exitCode: EXIT_CODES.GENERIC,
        details: { searched: describeSearchedLocations('agent') },
      });
    }
    const agentPath = agentResult.path;

    const experiment = loadExperiment(experimentPath, experimentVariant);
    const resolvedAgent = loadAgent(agentPath, { variant: variantName });

    // Validate `--model` against the agent's declared model wiring before any
    // Docker work, so an unsupported agent fails fast with a usage error.
    let modelSelection;
    try {
      modelSelection = resolveModelSelection(resolvedAgent, options.model);
    } catch (err) {
      if (err instanceof AgentConfigError) {
        throw new BunsenCliError('run_model_unsupported', err.message, {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      throw err;
    }
    // What the agent will run with: --model wins, else a variant's pinned model
    // (folded into defaults.env by variant application), else the declared default.
    const displayModel = modelSelection
      ? options.model ??
        resolvedAgent.defaults?.env?.[modelSelection.envName] ??
        modelSelection.defaultValue
      : undefined;

    const guaranteedArgs = resolvedAgent.entrypoint.args ?? [];
    const resolvedSupervisor = resolvedAgent.interaction.mode === 'supervised';

    const cliEnvFiles = options.envFile || [];
    const cliEnvFlags = options.env || [];
    const cliPassEnv = options.passEnv || [];

    console.log(chalk.dim(`\nExperiment: ${experiment.name}${experimentVariant ? `:${experimentVariant}` : ''}`));
    if (variantName) {
      console.log(chalk.dim(`Agent: ${resolvedAgent.name}:${variantName}`));
    } else {
      console.log(chalk.dim(`Agent: ${resolvedAgent.name}`));
    }
    if (displayModel) {
      const overridden = options.model !== undefined ? ' (--model)' : '';
      console.log(chalk.dim(`Model: ${displayModel}${overridden}`));
    }
    if (cliArgs.length > 0) {
      console.log(chalk.dim(`Args: ${cliArgs.join(' ')}`));
    }
    if (guaranteedArgs.length > 0) {
      console.log(chalk.dim(`Agent args: ${guaranteedArgs.join(' ')}`));
    }
    if (cliEnvFlags.length > 0 || cliEnvFiles.length > 0) {
      const parts: string[] = [];
      if (cliEnvFiles.length > 0) parts.push(`${cliEnvFiles.length} file(s)`);
      if (cliEnvFlags.length > 0) parts.push(`${cliEnvFlags.length} flag(s)`);
      console.log(chalk.dim(`Env overrides: ${parts.join(', ')}`));
    }
    console.log();

    let hasStartedOutput = false;

    let transientLogs: string[] = [];
    let renderedTransientLineCount = 0;
    const getMaxTransientLogLines = () => {
      const rows = process.stdout.rows ?? 24;
      return Math.max(6, Math.min(20, Math.floor(rows * 0.4)));
    };
    const formatTransientLine = (line: string) => {
      const columns = process.stdout.columns ?? 120;
      const maxWidth = Math.max(20, columns - 4);
      if (line.length <= maxWidth) return line;
      return `${line.slice(0, Math.max(0, maxWidth - 3))}...`;
    };

    const clearTransientLogArea = () => {
      if (renderedTransientLineCount === 0) return;
      spinner.clear();
      process.stdout.write('\x1b7');
      process.stdout.write('\n');
      for (let i = 0; i < renderedTransientLineCount; i++) {
        process.stdout.write('\x1b[2K');
        if (i < renderedTransientLineCount - 1) process.stdout.write('\n');
      }
      process.stdout.write('\x1b8');
      renderedTransientLineCount = 0;
    };

    const renderTransientLogs = () => {
      if (transientLogs.length === 0) {
        spinner.render();
        return;
      }
      spinner.clear();
      spinner.render();
      process.stdout.write('\x1b7');
      process.stdout.write('\n');
      transientLogs.forEach((line, index) => {
        process.stdout.write('\x1b[2K');
        process.stdout.write(chalk.dim(line));
        if (index < transientLogs.length - 1) process.stdout.write('\n');
      });
      process.stdout.write('\x1b8');
      renderedTransientLineCount = transientLogs.length;
    };

    if (options.record) {
      console.log(chalk.cyan(`Recording enabled (terminal size: ${options.terminalSize || '120x40'})`));
      console.log();
    }

    const result = await executeRun(
      {
        experimentPath,
        agentPath,
        args: cliArgs,
        agentVariant: variantName,
        experimentVariant,
        model: options.model,
        guaranteedArgs,
        resolvedSupervisor,
        cliEnvFiles,
        cliEnvFlags,
        cliPassEnv,
        skipEvaluation: options.skipEval,
        skipTraces: options.skipTraces,
        verbose: options.verbose,
        timeout: parseTimeoutMs(options.timeout, 900000),
        debugKeepContainer: options.debugKeepContainer,
        exportWorkspace: options.exportWorkspace,
        record: options.record,
        terminalSize: options.terminalSize,
        rebuildAgent: options.rebuildAgent,
        platform: options.platform,
      },
      {
        onProgress: (message) => {
          if (hasStartedOutput) {
            // Agent output already streamed and ended; we're past the
            // streaming phase (typically evaluation). Surface progress as a
            // plain log so the user can see eval making progress — the
            // spinner UI doesn't compose with the live agent stream that
            // just printed.
            spinner.stop();
            console.log(chalk.dim(message));
            return;
          }
          spinner.start(message);
          if (transientLogs.length > 0) renderTransientLogs();
        },
        onLog: (log) => {
          if (options.verbose) {
            if (hasStartedOutput) {
              spinner.stop();
              console.log(chalk.dim(log));
            } else {
              console.log(chalk.dim(log));
            }
          }
        },
        onOutputChunk: (chunk, stream) => {
          if (!hasStartedOutput) {
            clearTransientLogArea();
            transientLogs = [];
            spinner.stop();
            console.log();
            hasStartedOutput = true;
          }
          if (stream === 'stderr') process.stderr.write(chalk.dim(chunk));
          else process.stdout.write(chunk);
        },
        onInfo: (message) => {
          clearTransientLogArea();
          transientLogs = [];
          spinner.stop();
          console.log(chalk.cyan(message));
        },
        onTransientLog: (message) => {
          if (hasStartedOutput) return;
          clearTransientLogArea();
          const formatted = formatTransientLine(message);
          if (!formatted) return;
          transientLogs.push(formatted);
          const maxTransientLogLines = getMaxTransientLogLines();
          if (transientLogs.length > maxTransientLogLines) {
            transientLogs = transientLogs.slice(-maxTransientLogLines);
          }
          renderTransientLogs();
        },
        onClearTransientLogs: () => {
          if (hasStartedOutput) return;
          clearTransientLogArea();
          transientLogs = [];
          spinner.render();
        },
      }
    );

    console.log();
    console.log(chalk.bold('Run completed'));
    console.log(chalk.dim(`Run ID: ${result.run_id}`));
    console.log(chalk.dim(`Status: ${result.status}`));
    console.log(chalk.dim(`Duration: ${(result.duration_ms / 1000).toFixed(1)}s`));

    const weighted = result.evaluation?.weighted_score;
    if (typeof weighted === 'number') {
      console.log(chalk.dim(`Score: ${weighted.toFixed(2)}`));
    }

    if (!options.skipEval) {
      const evaluation = loadEvaluationResult(result.run_id);
      if (evaluation) {
        console.log();
        console.log(formatEvaluationForTerminal(evaluation));
      }
    }

    console.log();
    console.log(chalk.dim(`View details: bn runs show ${result.run_id}`));

    process.exit(EXIT_CODES.SUCCESS);
  } catch (error) {
    if (error instanceof RunCanceledError) {
      // The executor or an out-of-band `bn runs cancel` already flipped the
      // manifest to `canceled` and stopped the containers; surface that
      // cleanly instead of the dockerode 409 fallout.
      if (format === 'text') {
        spinner.stop();
        console.log();
        console.log(chalk.yellow(`Run canceled (${error.reason === 'SIGINT' ? 'SIGINT' : 'external'})`));
        console.log(chalk.dim(`Run ID: ${error.runId}`));
      } else {
        spinner.stop();
        const wrapped = new BunsenCliError(
          'run_canceled',
          error.message,
          { exitCode: EXIT_CODES.RUNTIME, cause: error },
        );
        reportError(wrapped, format);
        return;
      }
      // SIGINT convention: 128 + signal number. The signal handler in the
      // executor calls process.exit(130) directly when SIGINT is delivered,
      // so this branch is mainly hit for the external-cancel case.
      process.exit(error.reason === 'SIGINT' ? 130 : EXIT_CODES.RUNTIME);
    }
    if (format === 'text') spinner.fail('Run failed');
    else spinner.stop();
    if (error instanceof BunsenCliError) {
      reportError(error, format);
    }
    // Differentiating between RUNTIME (4) and EVALUATION (5) requires deeper
    // executor introspection; the executor layer can throw typed errors in a
    // future pass. For now everything in this catch-all is a generic runtime
    // failure.
    const wrapped = new BunsenCliError(
      'run_failed',
      error instanceof Error ? error.message : String(error),
      { exitCode: EXIT_CODES.RUNTIME, cause: error },
    );
    reportError(wrapped, format);
  }
}
