// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `bn experiments list` / `bn agents list`.
 *
 * Both commands emit the same machine shape under `--format json|yaml`; the
 * `text` rendering is split into the experiment and agent sections.
 */

import * as path from 'node:path';
import chalk from 'chalk';
import {
  loadExperiment,
  loadAgent,
  findAllExperiments,
  findAllAgents,
} from '@bunsen-dev/runtime';
import { resolveFormat, isMachineFormat, renderMachine } from '../format.js';

interface ListOptions {
  format?: string;
}

interface ExperimentEntry {
  name: string;
  description?: string;
  baseImage?: string;
  dockerfile?: string;
  path: string;
  hasDockerfile: boolean;
  platforms?: string[];
}

interface AgentEntry {
  name: string;
  description?: string;
  entrypoint: string;
  path: string;
}

export async function listCommand(
  type: 'experiments' | 'agents' | undefined,
  options: ListOptions = {},
): Promise<void> {
  const format = resolveFormat(options);
  const showExperiments = !type || type === 'experiments';
  const showAgents = !type || type === 'agents';
  const cwd = process.cwd();

  const experiments: ExperimentEntry[] = showExperiments ? collectExperiments(cwd) : [];
  const agents: AgentEntry[] = showAgents ? collectAgents(cwd) : [];

  if (isMachineFormat(format)) {
    const payload: Record<string, unknown> = {};
    if (showExperiments) payload.experiments = experiments;
    if (showAgents) payload.agents = agents;
    process.stdout.write(renderMachine(payload, format));
    return;
  }

  renderText(showExperiments ? experiments : null, showAgents ? agents : null);
}

function collectExperiments(cwd: string): ExperimentEntry[] {
  const out: ExperimentEntry[] = [];
  for (const expPath of findAllExperiments()) {
    try {
      const exp = loadExperiment(expPath);
      const baseImage = 'base' in exp.environment.image ? exp.environment.image.base : undefined;
      const dockerfile =
        'dockerfile' in exp.environment.image ? exp.environment.image.dockerfile : undefined;
      const entry: ExperimentEntry = {
        name: exp.name,
        path: path.relative(cwd, expPath),
        hasDockerfile: exp.hasDockerfile,
      };
      if (exp.description) entry.description = exp.description;
      if (baseImage) entry.baseImage = baseImage;
      if (dockerfile) entry.dockerfile = dockerfile;
      if (exp.environment.platforms && exp.environment.platforms.length > 0) {
        entry.platforms = [...exp.environment.platforms];
      }
      out.push(entry);
    } catch {
      // Skip invalid configs — `bn experiments validate` is the surface that
      // surfaces them.
    }
  }
  return out;
}

function collectAgents(cwd: string): AgentEntry[] {
  const out: AgentEntry[] = [];
  for (const agentPath of findAllAgents()) {
    try {
      const agent = loadAgent(agentPath);
      const entrypoint = [agent.entrypoint.command, ...(agent.entrypoint.args ?? [])].join(' ');
      const entry: AgentEntry = {
        name: agent.name,
        entrypoint,
        path: path.relative(cwd, agentPath),
      };
      if (agent.description) entry.description = agent.description.split('\n')[0];
      out.push(entry);
    } catch {
      // Skip invalid agents.
    }
  }
  return out;
}

function renderText(
  experiments: ExperimentEntry[] | null,
  agents: AgentEntry[] | null,
): void {
  if (experiments) {
    console.log();
    console.log(chalk.bold('Experiments'));
    console.log(chalk.dim('═'.repeat(50)));
    if (experiments.length === 0) {
      console.log(chalk.dim('No experiments found'));
      console.log(chalk.dim('Create one with: bn new experiment <name>'));
    } else {
      for (const exp of experiments) {
        console.log();
        console.log(chalk.cyan(exp.name));
        if (exp.description) console.log(chalk.dim(`  ${exp.description}`));
        const baseLabel = exp.baseImage ?? exp.dockerfile;
        if (baseLabel) console.log(chalk.dim(`  Base: ${baseLabel}`));
        console.log(chalk.dim(`  Path: ${exp.path}`));
      }
    }
  }

  if (agents) {
    console.log();
    console.log(chalk.bold('Agents'));
    console.log(chalk.dim('═'.repeat(50)));
    if (agents.length === 0) {
      console.log(chalk.dim('No agents found'));
      console.log(chalk.dim('Create one with: bn new agent <name>'));
    } else {
      for (const agent of agents) {
        console.log();
        console.log(chalk.cyan(agent.name));
        if (agent.description) console.log(chalk.dim(`  ${agent.description}`));
        console.log(chalk.dim(`  Entrypoint: ${agent.entrypoint}`));
        console.log(chalk.dim(`  Path: ${agent.path}`));
      }
    }
  }

  console.log();
}
