// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `bn experiments show` / `bn agents show`.
 *
 * Looks up either an experiment or an agent by name and renders detail. The
 * machine payload (`--format json|yaml`) returns the parsed config object so
 * agents can post-process it with the same schemas authors write.
 */

import * as path from 'node:path';
import chalk from 'chalk';
import {
  loadExperiment,
  loadAgent,
  resolveExperiment,
  resolveAgent,
  describeSearchedLocations,
  DEFAULT_BASE_IMAGE,
} from '@bunsen-dev/runtime';
import { resolveFormat, isMachineFormat, renderMachine } from '../format.js';
import { BunsenCliError } from '../errors.js';
import { EXIT_CODES } from '../exit-codes.js';

interface InfoOptions {
  format?: string;
}

export async function infoCommand(name: string, options: InfoOptions = {}): Promise<void> {
  const format = resolveFormat(options);
  const cwd = process.cwd();

  const experimentResult = resolveExperiment(name);
  if (experimentResult) {
    const exp = loadExperiment(experimentResult.path);
    if (isMachineFormat(format)) {
      process.stdout.write(
        renderMachine(
          {
            kind: 'experiment',
            path: path.relative(cwd, experimentResult.path),
            experiment: exp,
          },
          format,
        ),
      );
      return;
    }
    renderExperiment(exp, cwd);
    return;
  }

  const agentResult = resolveAgent(name);
  if (agentResult) {
    const agent = loadAgent(agentResult.path);
    if (isMachineFormat(format)) {
      process.stdout.write(
        renderMachine(
          {
            kind: 'agent',
            path: path.relative(cwd, agentResult.path),
            agent,
          },
          format,
        ),
      );
      return;
    }
    renderAgent(agent);
    return;
  }

  throw new BunsenCliError('not_found', `Not found: ${name}`, {
    exitCode: EXIT_CODES.GENERIC,
    details: {
      searched_experiments: describeSearchedLocations('experiment'),
      searched_agents: describeSearchedLocations('agent'),
    },
  });
}

function renderExperiment(exp: ReturnType<typeof loadExperiment>, cwd: string): void {
  const baseImage = 'base' in exp.environment.image ? exp.environment.image.base : undefined;
  const dockerfile =
    'dockerfile' in exp.environment.image ? exp.environment.image.dockerfile : undefined;

  console.log();
  console.log(chalk.bold(`Experiment: ${exp.name}`));
  console.log(chalk.dim('═'.repeat(50)));
  console.log();
  if (exp.description) {
    console.log(chalk.bold('Description'));
    console.log(exp.description);
    console.log();
  }
  console.log(chalk.bold('Configuration'));
  console.log(`Base Image: ${baseImage ?? dockerfile ?? DEFAULT_BASE_IMAGE}`);
  if (exp.environment.platforms && exp.environment.platforms.length > 0) {
    console.log(`Platforms: ${exp.environment.platforms.join(', ')}`);
  }
  console.log(`Path: ${path.relative(cwd, exp.dir)}`);
  console.log(`Has Dockerfile: ${exp.hasDockerfile}`);
  const workspaceSources = exp.workspaceSources.map((source) => {
    const label =
      source.type === 'path'
        ? `path (${path.relative(cwd, source.sourcePath)})`
        : `image (${source.sourcePath})`;
    return source.target ? `${label} -> ${source.target}` : label;
  });
  console.log(`Workspace Sources: ${workspaceSources.join(', ') || 'None'}`);
  console.log(`Has Verifiers: ${exp.hasVerifiers ? 'Yes' : 'No'}`);

  if (exp.workspace?.setup && exp.workspace.setup.length > 0) {
    console.log();
    console.log(chalk.bold('Workspace Setup'));
    for (const step of exp.workspace.setup) {
      if ('writeFile' in step) {
        const source = step.from
          ? `from ${step.from}`
          : `${(step.content ?? '').length} bytes inline`;
        console.log(chalk.dim(`  > writeFile ${step.writeFile} (${source})`));
      } else {
        console.log(chalk.dim(`  $ ${step.run}`));
      }
    }
  }

  console.log();
  console.log(chalk.bold('Task'));
  console.log(exp.task.prompt);

  console.log();
  console.log(chalk.bold('Rubric'));
  for (const criterion of exp.evaluation.criteria) {
    console.log();
    const scorerType = criterion.type;
    const typePrefix = scorerType !== 'judge' ? `[${scorerType}] ` : '';
    console.log(`${typePrefix}${criterion.id} (weight: ${criterion.weight ?? 1})`);
    let detail: string | undefined;
    switch (criterion.type) {
      case 'script':
        detail = criterion.run;
        break;
      case 'judge':
      case 'agent':
      case 'browser-agent':
        detail = criterion.instructions;
        break;
      case 'aggregate':
        detail = `aggregate: ${criterion.aggregate.function}`;
        break;
    }
    if (detail) {
      console.log(chalk.dim(`  ${detail}`));
    }
  }
  if (exp.evaluation.report) {
    console.log();
    console.log(`[report] summary-report`);
    console.log(chalk.dim(`  ${exp.evaluation.report.instructions}`));
  }

  console.log();
}

function renderAgent(agent: ReturnType<typeof loadAgent>): void {
  console.log();
  console.log(chalk.bold(`Agent: ${agent.name}`));
  console.log(chalk.dim('═'.repeat(50)));
  console.log();
  if (agent.description) {
    console.log(chalk.bold('Description'));
    console.log(agent.description);
    console.log();
  }
  console.log(chalk.bold('Configuration'));
  const entrypointStr = [agent.entrypoint.command, ...(agent.entrypoint.args ?? [])].join(' ');
  console.log(`Entrypoint: ${entrypointStr}`);
  console.log(`Interaction: ${agent.interaction.mode}`);
  console.log(`Path: ${agent.path}`);

  if (agent.entrypoint.help) {
    console.log(`Help Command: ${agent.entrypoint.help}`);
  }

  if (agent.examples && agent.examples.length > 0) {
    console.log();
    console.log(chalk.bold('Examples'));
    for (const example of agent.examples) {
      console.log();
      console.log(chalk.dim(`Prompt: ${example.prompt}`));
      console.log(chalk.cyan(`$ ${example.invocation}`));
    }
  }

  if (agent.variants && Object.keys(agent.variants).length > 0) {
    console.log();
    console.log(chalk.bold('Variants'));
    console.log(chalk.dim(`Use with: bn run <experiment> ${agent.name}:<variant>`));
    console.log();
    for (const [variantName, variant] of Object.entries(agent.variants)) {
      console.log(`  ${chalk.cyan(variantName)}`);
      if (variant.description) {
        console.log(chalk.dim(`    ${variant.description}`));
      }
      if (variant.entrypoint?.args && variant.entrypoint.args.length > 0) {
        console.log(chalk.dim(`    args: ${variant.entrypoint.args.join(' ')}`));
      }
      if (variant.defaults?.env && Object.keys(variant.defaults.env).length > 0) {
        const envStr = Object.entries(variant.defaults.env)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        console.log(chalk.dim(`    env: ${envStr}`));
      }
      if (variant.interaction?.mode) {
        console.log(chalk.dim(`    interaction: ${variant.interaction.mode}`));
      }
    }
  }

  const source = agent.install.source;
  console.log();
  console.log(chalk.bold('Source'));
  console.log(`Type: ${source.type}`);
  if (source.type === 'git') {
    console.log(`Repo: ${source.repo}`);
    if (source.ref) console.log(`Ref: ${source.ref}`);
  } else if (source.type === 'npm') {
    console.log(`Package: ${source.package}`);
    if (source.version) console.log(`Version: ${source.version}`);
  } else if (source.type === 'binary') {
    console.log(`URL: ${source.url}`);
    if (source.sha256) console.log(`SHA256: ${source.sha256}`);
  }

  console.log();
}
