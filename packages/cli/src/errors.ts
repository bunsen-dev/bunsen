// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Structured CLI errors.
 *
 * Every user-facing error funnels through {@link BunsenCliError} so that:
 *  - exit codes are stable (see {@link EXIT_CODES}),
 *  - stderr carries a human-readable line,
 *  - `--format json` callers receive `{ error: { code, message, details } }`
 *    on stdout and a non-zero exit.
 */

import chalk from 'chalk';
import {
  ProjectConfigError,
  ExperimentConfigError,
  AgentConfigError,
} from '@bunsen-dev/runtime';
import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import { isMachineFormat, FormatFlagError, type OutputFormat } from './format.js';

export interface CliErrorPayload {
  /** Stable error code (e.g. `experiment_not_found`, `docker_unavailable`). */
  code: string;
  /** Single-line human-readable message. */
  message: string;
  /** Structured detail object — JSON-serializable. */
  details?: Record<string, unknown>;
}

export class BunsenCliError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { exitCode?: ExitCode; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'BunsenCliError';
    this.code = code;
    this.exitCode = options.exitCode ?? EXIT_CODES.GENERIC;
    this.details = options.details;
  }

  toPayload(): CliErrorPayload {
    const payload: CliErrorPayload = {
      code: this.code,
      message: this.message,
    };
    if (this.details) payload.details = this.details;
    return payload;
  }
}

/**
 * Convert a thrown value into a CliError. Recognized runtime errors map to
 * stable codes; everything else becomes a generic `internal_error`.
 */
export function toCliError(error: unknown): BunsenCliError {
  if (error instanceof BunsenCliError) return error;

  if (error instanceof FormatFlagError) {
    return new BunsenCliError('usage_invalid_format', error.message, {
      exitCode: EXIT_CODES.USAGE,
      details: { value: error.value },
      cause: error,
    });
  }

  if (error instanceof ProjectConfigError) {
    const details: Record<string, unknown> = {};
    if (error.path) details.path = error.path;
    if (error.resource) details.resource = error.resource;
    return new BunsenCliError(`project_config.${error.code}`, error.message, {
      exitCode: EXIT_CODES.VALIDATION,
      details: Object.keys(details).length > 0 ? details : undefined,
      cause: error,
    });
  }

  if (error instanceof ExperimentConfigError) {
    return new BunsenCliError('experiment_config_invalid', error.message, {
      exitCode: EXIT_CODES.VALIDATION,
      cause: error,
    });
  }

  if (error instanceof AgentConfigError) {
    return new BunsenCliError('agent_config_invalid', error.message, {
      exitCode: EXIT_CODES.VALIDATION,
      cause: error,
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new BunsenCliError('internal_error', message, {
    exitCode: EXIT_CODES.GENERIC,
    cause: error,
  });
}

/**
 * Print a CLI error and exit. `--format json` emits a single JSON object on
 * stdout; other formats print to stderr in red.
 */
export function reportError(error: unknown, format: OutputFormat = 'text'): never {
  const cliError = toCliError(error);
  if (isMachineFormat(format)) {
    process.stdout.write(JSON.stringify({ error: cliError.toPayload() }) + '\n');
  } else {
    process.stderr.write(`${chalk.red(`Error [${cliError.code}]:`)} ${cliError.message}\n`);
    if (cliError.details) {
      const lines = Object.entries(cliError.details)
        .map(([k, v]) => `  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('\n');
      if (lines) process.stderr.write(chalk.dim(lines) + '\n');
    }
  }
  process.exit(cliError.exitCode);
}

/**
 * Wrap an async command action so any thrown error is rendered through
 * {@link reportError}. Commander invokes the wrapper directly.
 */
export function wrapCommand<TArgs extends unknown[]>(
  action: (...args: TArgs) => Promise<void> | void,
): (...args: TArgs) => Promise<void> {
  return async (...args: TArgs) => {
    try {
      await action(...args);
    } catch (error) {
      const format = pickFormatFromArgs(args);
      reportError(error, format);
    }
  };
}

function pickFormatFromArgs(args: unknown[]): OutputFormat {
  for (const arg of args) {
    if (
      arg &&
      typeof arg === 'object' &&
      'format' in arg &&
      typeof (arg as { format?: unknown }).format === 'string'
    ) {
      const value = (arg as { format: string }).format;
      if (value === 'text' || value === 'json' || value === 'yaml') return value;
    }
  }
  return 'text';
}
