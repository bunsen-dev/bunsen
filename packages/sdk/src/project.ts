// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Public SDK entry point. Implementation is scaffolded here; individual
 * methods will be wired to `@bunsen-dev/runtime` internals by future SDK work.
 * Today, every operation rejects with `NotImplementedError`.
 */

export class NotImplementedError extends Error {
  constructor(surface: string) {
    super(`${surface} is not yet implemented.`);
    this.name = 'NotImplementedError';
  }
}

import type { ArtifactDescriptor, RunEvent } from '@bunsen-dev/types';

export interface ProjectOptions {
  /** Optional override for the storage root. Defaults to the project's configured `.bunsen` directory. */
  storageRoot?: string;
}

export interface RunInput {
  experiment: string;
  experimentVariant?: string;
  agent: string;
  agentVariant?: string;
  platform?: string;
  env?: Record<string, string>;
  passEnv?: string[];
  envFile?: string;
  timeout?: string;
  skipEvaluation?: boolean;
  skipTraces?: boolean;
  record?: boolean;
  /** Reserved for future remote execution. Currently unsupported. */
  remote?: boolean;
}

export interface RunResult {
  id: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled';
  summary: {
    score: number | null;
  };
}

export interface RunHandle {
  id: string;
  stream(): AsyncIterable<RunEvent>;
  wait(): Promise<RunResult>;
  cancel(): Promise<void>;
  artifacts(): Promise<ArtifactDescriptor[]>;
  readArtifact(key: string): Promise<Uint8Array>;
}

export interface ResourceCollection<T> {
  list(): Promise<T[]>;
  get(name: string): Promise<T>;
}

export interface SuiteAddInput {
  url: string;
  ref?: string;
  id?: string;
}

export interface SuiteInfo {
  id: string;
  name: string;
  version_tag?: string;
  commit?: string;
  source_url?: string;
}

export interface SuiteCollection {
  list(): Promise<SuiteInfo[]>;
  add(input: SuiteAddInput): Promise<SuiteInfo>;
  update(id: string): Promise<SuiteInfo>;
  remove(id: string): Promise<void>;
  info(id: string): Promise<SuiteInfo>;
}

export interface RunCollection {
  list(options?: { experiment?: string; agent?: string; limit?: number }): Promise<RunResult[]>;
  get(id: string): Promise<RunResult>;
}

export interface ValidateInput {
  experiment?: string;
  agent?: string;
  all?: boolean;
}

export interface ValidationReport {
  ok: boolean;
  issues: Array<{ resource: string; path: string; message: string }>;
}

export interface Project {
  root: string;
  experiments: ResourceCollection<unknown>;
  agents: ResourceCollection<unknown>;
  suites: SuiteCollection;
  runs: RunCollection;
  validate(input?: ValidateInput): Promise<ValidationReport>;
  run(input: RunInput): Promise<RunHandle>;
}

const notImplemented = (surface: string) =>
  Promise.reject<never>(new NotImplementedError(surface));

/**
 * Open a Bunsen project rooted at `cwd`. The project discovers configuration
 * from the nearest `bunsen.config.yaml` (or falls back to the nearest `.git`
 * ancestor, else `cwd` itself).
 *
 * Currently a scaffold: the returned object carries the shape of the public
 * API but every operation rejects with `NotImplementedError`. Wiring these
 * methods to `@bunsen-dev/runtime` is outstanding, unscheduled work — the `bn`
 * CLI currently calls `@bunsen-dev/runtime` directly rather than through this
 * surface.
 */
export async function openProject(cwd: string, _options: ProjectOptions = {}): Promise<Project> {
  const project: Project = {
    root: cwd,
    experiments: {
      list: () => notImplemented('project.experiments.list'),
      get: () => notImplemented('project.experiments.get'),
    },
    agents: {
      list: () => notImplemented('project.agents.list'),
      get: () => notImplemented('project.agents.get'),
    },
    suites: {
      list: () => notImplemented('project.suites.list'),
      add: () => notImplemented('project.suites.add'),
      update: () => notImplemented('project.suites.update'),
      remove: () => notImplemented('project.suites.remove'),
      info: () => notImplemented('project.suites.info'),
    },
    runs: {
      list: () => notImplemented('project.runs.list'),
      get: () => notImplemented('project.runs.get'),
    },
    validate: () => notImplemented('project.validate'),
    run: (input) => {
      if (input.remote) {
        return notImplemented('project.run({ remote: true })');
      }
      return notImplemented('project.run');
    },
  };
  return project;
}
