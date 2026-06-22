// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Environment resolution — substrate-only.
 *
 * The experiment provides task substrate (runtimes, packages, services the
 * codebase under test depends on). The agent is a sealed closure that ships
 * everything it pins via `install.deps` / `install.build`; it does **not**
 * contribute to the resolved environment. There is no agent/experiment merge.
 *
 * Asymmetric composition: any-agent × any-experiment works because the agent
 * walks in self-contained. See `docs/ENVIRONMENT.md#asymmetric-composition`.
 */

import type {
  ExperimentConfig,
  AgentConfig,
  RuntimeName,
  StepConfig,
} from '@bunsen-dev/types';
import { DEFAULT_BASE_IMAGE } from './config.js';

/**
 * Substrate-resolved environment fed to the experiment-image prep step and to
 * the executor. Owns only what the experiment side determines:
 * - The base image (or Dockerfile-derived equivalent).
 * - Substrate runtimes/packages the task depends on.
 * - The two ordered command lists that downstream phases consume
 *   (`workspace.setup` from the experiment, `install.configure` from the
 *   agent — kept distinct because they run at different phases against
 *   different working directories).
 */
export interface ResolvedEnvironment {
  baseImage: string;
  runtimes: Record<string, string>;
  packages: {
    apt: string[];
    npm: string[];
    pip: string[];
  };
  /**
   * Ordered `workspace.setup` steps from the experiment. Step shape is
   * preserved so the executor can dispatch per-type (`run` vs `writeFile`).
   */
  experimentSetup?: StepConfig[];
  /**
   * Ordered `install.configure` steps from the agent. Step shape is
   * preserved so the executor can dispatch per-type (`run` vs `writeFile`).
   */
  agentConfigure?: StepConfig[];
}

/** Default substrate runtime versions in the universal base image. */
const DEFAULT_RUNTIMES: Partial<Record<RuntimeName, string>> = {
  node: '20',
  python: '3.11',
};

/**
 * Resolve the run environment from the experiment alone.
 *
 * The agent is still passed in because the caller wires `install.configure`
 * commands through the same plumbing (they belong to the agent, not the
 * substrate). They are kept distinct in the resolved shape so the executor
 * can run them at the right phase against the right working directory.
 */
export function resolveEnvironment(
  experiment: ExperimentConfig,
  agent?: AgentConfig,
): ResolvedEnvironment {
  const experimentRequires = experiment.environment.requires ?? {};

  const runtimes: Partial<Record<RuntimeName, string>> = { ...DEFAULT_RUNTIMES };
  if (experimentRequires.runtimes) {
    for (const [name, version] of Object.entries(experimentRequires.runtimes)) {
      if (version !== undefined) runtimes[name as RuntimeName] = version;
    }
  }

  const packages = {
    apt: [...(experimentRequires.packages?.apt ?? [])],
    npm: [...(experimentRequires.packages?.npm ?? [])],
    pip: [...(experimentRequires.packages?.pip ?? [])],
  };

  const experimentSetup = experiment.workspace?.setup;
  const agentConfigure = agent?.install.configure;

  const baseImage =
    'base' in experiment.environment.image
      ? experiment.environment.image.base
      : DEFAULT_BASE_IMAGE;

  return {
    baseImage,
    runtimes,
    packages,
    experimentSetup,
    agentConfigure,
  };
}

/** Generate Dockerfile commands for installing substrate packages. */
export function generatePackageInstallCommands(packages: ResolvedEnvironment['packages']): string[] {
  const commands: string[] = [];
  if (packages.apt.length > 0) {
    commands.push(`apt-get update && apt-get install -y ${packages.apt.join(' ')}`);
  }
  if (packages.npm.length > 0) {
    commands.push(`npm install -g ${packages.npm.join(' ')}`);
  }
  if (packages.pip.length > 0) {
    commands.push(`pip install ${packages.pip.join(' ')}`);
  }
  return commands;
}

export function hasPackageRequirements(env: ResolvedEnvironment): boolean {
  return (
    env.packages.apt.length > 0 ||
    env.packages.npm.length > 0 ||
    env.packages.pip.length > 0
  );
}
