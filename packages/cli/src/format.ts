// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Global `--format text|json|yaml` flag.
 *
 * The CLI is the public agent contract for Bunsen, so structured output is a
 * first-class surface — not a best-effort feature. JSON and YAML payloads are
 * written to stdout; human-oriented spinners, progress, and warnings go to
 * stderr so a script can pipe stdout into `jq` without contamination.
 */

import yaml from 'js-yaml';

export type OutputFormat = 'text' | 'json' | 'yaml';

export const VALID_FORMATS: ReadonlySet<OutputFormat> = new Set(['text', 'json', 'yaml']);

export function isOutputFormat(value: unknown): value is OutputFormat {
  return typeof value === 'string' && VALID_FORMATS.has(value as OutputFormat);
}

export function isMachineFormat(format: OutputFormat): boolean {
  return format === 'json' || format === 'yaml';
}

/**
 * Resolve and validate `options.format` (Commander's parsed `--format` value),
 * defaulting to `text`.
 */
export function resolveFormat(options: { format?: string }): OutputFormat {
  if (options.format) {
    if (!isOutputFormat(options.format)) {
      throw new FormatFlagError(options.format);
    }
    return options.format;
  }
  return 'text';
}

export class FormatFlagError extends Error {
  readonly value: string;
  constructor(value: string) {
    super(
      `Invalid --format value: ${JSON.stringify(value)}. Expected one of: text, json, yaml.`,
    );
    this.name = 'FormatFlagError';
    this.value = value;
  }
}

/**
 * Serialize a payload for the chosen machine format. `text` is rejected here
 * because the human renderer is always command-specific.
 */
export function renderMachine(payload: unknown, format: OutputFormat): string {
  if (format === 'json') return JSON.stringify(payload, null, 2) + '\n';
  if (format === 'yaml') return yaml.dump(payload, { lineWidth: 100, noRefs: true });
  throw new Error(`renderMachine called with non-machine format: ${format}`);
}
