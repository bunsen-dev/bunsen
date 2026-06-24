// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `bn init` — scaffold `bunsen.config.yaml` (and optional starter resources).
 *
 * Idempotent: if `bunsen.config.yaml` already exists, the command refuses to
 * overwrite unless `--force` is passed. With `--example`, also writes a
 * minimal experiment + agent under `experiments/` and `agents/`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { BunsenCliError } from '../errors.js';
import { EXIT_CODES } from '../exit-codes.js';
import { bundledAgentsDir, installAgentsInto, listBundledAgents } from './agents-add.js';

interface InitOptions {
  force?: boolean;
  example?: boolean;
  starterAgents?: boolean;
}

const CONFIG_FILENAME = 'bunsen.config.yaml';

const DEFAULT_CONFIG = `$schema: https://schemas.bunsen.dev/project.v1.json
version: v1

# Where bn looks for experiments/agents. Local paths win over suite-provided
# resources by default; flip 'precedence' to 'suites' to invert.
paths:
  experiments:
    - experiments
  agents:
    - agents
  precedence: local

# Default behavior for every \`bn run\`. CLI flags override these.
defaults:
  run:
    timeout: 15m
    platform: auto
    capture:
      traces: true
      recording: false

# Suites pulled in via \`bn suites add\`. Empty by default.
suites: []

# Optional: env-files automatically loaded from this directory before
# resolving any config that references env vars. .env is auto-loaded.
# envFiles:
#   - .env
#   - .env.local
`;

const EXAMPLE_EXPERIMENT_YAML = `$schema: https://schemas.bunsen.dev/experiment.v1.json
version: v1
name: hello-world
description: Smoke-test experiment that asks the agent to print "hello, world".

environment:
  image:
    base: python:3.11-slim

task:
  prompt: |
    Print the literal text 'hello, world' to stdout, then stop.

evaluation:
  container: dedicated
  criteria:
    - id: prints-greeting
      title: Agent prints "hello, world"
      type: script
      run: grep -F 'hello, world' /workspace-source/.bunsen/agent-output.log
`;

const EXAMPLE_AGENT_YAML = `$schema: https://schemas.bunsen.dev/agent.v1.json
version: v1
name: echo-agent
description: |
  Trivial smoke-test agent: prints whatever prompt the orchestrator hands it.

install:
  source:
    type: local

entrypoint:
  # Bunsen invokes \`<command> <task-prompt> <entrypoint.args…>\` — the prompt is
  # the leading positional arg, and any entrypoint.args are appended AFTER it
  # (see docs/AGENT_YAML.md). So a trivial echo agent is just \`echo\` with no
  # args: \`echo '<prompt>'\`. Do NOT use \`/bin/sh -c '…' --\` here — that needs
  # its args BEFORE the prompt, which the prompt-first contract can't express, so
  # the prompt would be mis-read as a script name.
  command: echo

interaction:
  mode: direct
`;

export async function initCommand(options: InitOptions): Promise<void> {
  const cwd = process.cwd();
  const target = path.join(cwd, CONFIG_FILENAME);
  const created: string[] = [];
  const existed: string[] = [];

  if (fs.existsSync(target) && !options.force) {
    throw new BunsenCliError(
      'init_config_exists',
      `${CONFIG_FILENAME} already exists at ${cwd}`,
      {
        exitCode: EXIT_CODES.GENERIC,
        details: { path: target, hint: 'Pass --force to overwrite.' },
      },
    );
  }

  fs.writeFileSync(target, DEFAULT_CONFIG);
  created.push(CONFIG_FILENAME);

  if (options.example) {
    const expDir = path.join(cwd, 'experiments', 'hello-world');
    if (!fs.existsSync(expDir)) {
      fs.mkdirSync(expDir, { recursive: true });
      fs.writeFileSync(path.join(expDir, 'experiment.yaml'), EXAMPLE_EXPERIMENT_YAML);
      created.push(path.join('experiments', 'hello-world', 'experiment.yaml'));
    } else {
      existed.push(path.join('experiments', 'hello-world'));
    }

    const agentDir = path.join(cwd, 'agents', 'echo-agent');
    if (!fs.existsSync(agentDir)) {
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, 'agent.yaml'), EXAMPLE_AGENT_YAML);
      created.push(path.join('agents', 'echo-agent', 'agent.yaml'));
    } else {
      existed.push(path.join('agents', 'echo-agent'));
    }
  }

  if (options.starterAgents) {
    // Copy the bundled starter agents into `agents/` (the default paths.agents
    // entry the DEFAULT_CONFIG above declares). Existing dirs are skipped unless
    // --force is passed, so re-running init never clobbers a customized agent.
    const sourceDir = bundledAgentsDir();
    const starters = listBundledAgents(sourceDir);
    const agentsDir = path.join(cwd, 'agents');
    const results = installAgentsInto(sourceDir, agentsDir, starters, { force: options.force });
    for (const r of results) {
      if (r.status === 'skipped') existed.push(path.join('agents', r.name));
      else created.push(path.join('agents', r.name));
    }
  }

  console.log(chalk.green(`Initialized Bunsen project at ${cwd}`));
  console.log();
  for (const file of created) {
    console.log(`  ${chalk.green('+')} ${file}`);
  }
  for (const file of existed) {
    console.log(`  ${chalk.dim('=')} ${file} ${chalk.dim('(unchanged)')}`);
  }
  console.log();
  console.log(chalk.dim('Next steps:'));
  console.log(chalk.dim('  bn doctor                  Verify environment'));
  console.log(chalk.dim('  bn experiments list        List experiments'));
  if (options.example) {
    console.log(chalk.dim('  bn run hello-world echo-agent'));
  }
  if (options.starterAgents) {
    console.log(chalk.dim('  bn agents list             See the starter agents you just added'));
    console.log(chalk.dim('  bn run <experiment> claude-code   (set ANTHROPIC_API_KEY in .env first)'));
  } else {
    console.log(chalk.dim('  bn agents add              Add a starter agent (claude-code, codex-cli, gemini-cli)'));
  }
}
