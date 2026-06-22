// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Public `RunEvent` discriminated union.
 *
 * The event-name vocabulary and the payload shapes are both public contract.
 * See `docs/RUN_MANIFEST.md`.
 */

export type RunEvent =
  | InstallBuildStartedEvent
  | InstallBuildCompletedEvent
  | WorkspaceSourcesStartedEvent
  | WorkspaceSourcesCompletedEvent
  | InstallConfigureStartedEvent
  | InstallConfigureCompletedEvent
  | WorkspaceSetupStartedEvent
  | WorkspaceSetupCompletedEvent
  | RunStartedEvent
  | AgentStartedEvent
  | AgentCompletedEvent
  | EvaluationStartedEvent
  | CriterionStartedEvent
  | CriterionCompletedEvent
  | EvaluationReportStartedEvent
  | EvaluationReportCompletedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCanceledEvent;

export type RunEventName = RunEvent['event'];

interface RunEventBase {
  /** ISO8601 timestamp. */
  ts: string;
}

// ---------------------------------------------------------------------------
// install.build
// ---------------------------------------------------------------------------

export interface InstallBuildStartedEvent extends RunEventBase {
  event: 'install.build.started';
  data: { agent: string; variant?: string };
}

export interface InstallBuildCompletedEvent extends RunEventBase {
  event: 'install.build.completed';
  data: { cacheHit: boolean; durationMs: number };
}

// ---------------------------------------------------------------------------
// workspace.sources
// ---------------------------------------------------------------------------

export interface WorkspaceSourcesStartedEvent extends RunEventBase {
  event: 'workspace.sources.started';
  data: Record<string, never>;
}

export interface WorkspaceSourcesCompletedEvent extends RunEventBase {
  event: 'workspace.sources.completed';
  data: { sourceCount: number; durationMs: number };
}

// ---------------------------------------------------------------------------
// install.configure
// ---------------------------------------------------------------------------

export interface InstallConfigureStartedEvent extends RunEventBase {
  event: 'install.configure.started';
  data: Record<string, never>;
}

export interface InstallConfigureCompletedEvent extends RunEventBase {
  event: 'install.configure.completed';
  data: { stepCount: number; durationMs: number };
}

// ---------------------------------------------------------------------------
// workspace.setup
// ---------------------------------------------------------------------------

export interface WorkspaceSetupStartedEvent extends RunEventBase {
  event: 'workspace.setup.started';
  data: Record<string, never>;
}

export interface WorkspaceSetupCompletedEvent extends RunEventBase {
  event: 'workspace.setup.completed';
  data: { stepCount: number; durationMs: number };
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

export interface RunStartedEvent extends RunEventBase {
  event: 'run.started';
  data: { id: string };
}

export interface AgentStartedEvent extends RunEventBase {
  event: 'agent.started';
  data: { id: string };
}

export interface AgentCompletedEvent extends RunEventBase {
  event: 'agent.completed';
  data: { exitCode: number; durationMs: number };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface EvaluationStartedEvent extends RunEventBase {
  event: 'evaluation.started';
  data: { criterionCount: number };
}

export interface CriterionStartedEvent extends RunEventBase {
  event: 'criterion.started';
  data: { id: string };
}

export interface CriterionCompletedEvent extends RunEventBase {
  event: 'criterion.completed';
  data: {
    id: string;
    score: number | null;
    durationMs: number;
    status?: 'completed' | 'skipped';
  };
}

export interface EvaluationReportStartedEvent extends RunEventBase {
  event: 'evaluation.report.started';
  data: Record<string, never>;
}

export interface EvaluationReportCompletedEvent extends RunEventBase {
  event: 'evaluation.report.completed';
  data: { durationMs: number };
}

// ---------------------------------------------------------------------------
// Terminal events
// ---------------------------------------------------------------------------

export interface RunCompletedEvent extends RunEventBase {
  event: 'run.completed';
  data: { id: string; durationMs: number };
}

export interface RunFailedEvent extends RunEventBase {
  event: 'run.failed';
  data: { phase: string; reason: string };
}

export interface RunCanceledEvent extends RunEventBase {
  event: 'run.canceled';
  data: { reason?: string };
}
