// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Structured validation error used across the v1 public surface.
 *
 * Every parser (`experiment.yaml`, `agent.yaml`, `bunsen.config.yaml`,
 * `bunsen-suite.yaml`) emits `ValidationError` objects on failure. The SDK's
 * `Project.validate()` returns them grouped per resource.
 */

export interface ValidationError {
  /** Machine-readable error code, e.g. `experiment.task.prompt.required`. */
  code: string;
  /** Human-readable message. */
  message: string;
  /** The resource being validated — file path or logical name. */
  resource?: string;
  /** Dotted path inside the resource, e.g. `evaluation.criteria[0].id`. */
  path?: string;
  /** Optional line/column hint for YAML-source errors. */
  location?: ValidationErrorLocation;
  /** Optional suggested fix surfaced by `--fix` flows. */
  suggestion?: string;
  /**
   * Severity. `error` blocks validation; `warning` surfaces hygiene signals
   * without failing.
   */
  severity?: 'error' | 'warning';
}

export interface ValidationErrorLocation {
  line: number;
  column?: number;
}
