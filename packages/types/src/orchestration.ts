// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Public `OrchestrationResult` shape.
 *
 * Invocations are structured as a command + argv array so dynamic task text
 * never has to survive shell reinterpretation. `setupCommands` remains a
 * shell-string list because it is orchestrator-authored (cd, export, etc.) and
 * never carries task text.
 */

export interface OrchestrationResult {
  /** Ordered pre-invocation commands executed inside the agent container. */
  setupCommands: string[];
  invocation: OrchestrationInvocation;
}

export interface OrchestrationInvocation {
  command: string;
  args: string[];
}
