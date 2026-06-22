// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * @bunsen-dev/sdk — public programmatic API for Bunsen.
 *
 * The surface in this package is the stable contract for tools that embed
 * Bunsen. Internals (container orchestration, proxy, platform agents, trace
 * capture) live in private workspace packages and are not exported here.
 *
 * Most methods are scaffolds: `openProject()` returns an object whose
 * operations reject with `NotImplementedError`. Wiring them to the runtime
 * is outstanding, unscheduled work.
 */

export { openProject, NotImplementedError } from './project.js';
export type {
  Project,
  ProjectOptions,
  RunInput,
  RunHandle,
  RunResult,
  ValidateInput,
  ValidationReport,
  ResourceCollection,
  SuiteCollection,
  SuiteAddInput,
  SuiteInfo,
  RunCollection,
} from './project.js';
