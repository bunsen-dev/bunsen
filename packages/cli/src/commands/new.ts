// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * New command - Create a new experiment or agent
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import chalk from 'chalk';

interface NewOptions {
  template?: string;
}

export async function newCommand(
  type: string,
  name: string,
  options: NewOptions
): Promise<void> {
  try {
    const cwd = process.cwd();

    if (type === 'experiment' || type === 'exp') {
      createExperiment(name, cwd, options.template);
    } else if (type === 'agent') {
      createAgent(name, cwd, options.template);
    } else {
      console.error(chalk.red(`Unknown type: ${type}`));
      console.error(chalk.dim('Use "experiment" or "agent"'));
      process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Error: ${message}`));
    process.exit(1);
  }
}

function createExperiment(name: string, cwd: string, template?: string): void {
  const experimentsDir = path.join(cwd, 'experiments');
  const experimentPath = path.join(experimentsDir, name);

  if (fs.existsSync(experimentPath)) {
    console.error(chalk.red(`Experiment already exists: ${name}`));
    process.exit(1);
  }

  // Create directory structure
  fs.mkdirSync(experimentPath, { recursive: true });
  fs.mkdirSync(path.join(experimentPath, 'workspace'), { recursive: true });

  // Write experiment.yaml
  const experimentYaml = getExperimentTemplate(name, template);
  fs.writeFileSync(path.join(experimentPath, 'experiment.yaml'), experimentYaml);

  // Write a sample file in workspace
  fs.writeFileSync(
    path.join(experimentPath, 'workspace', 'README.md'),
    `# ${name}\n\nThis is the workspace for the ${name} experiment.\n`
  );

  console.log(chalk.green(`Created experiment: ${name}`));
  console.log(chalk.dim(`Path: experiments/${name}/`));
  console.log();
  console.log('Files created:');
  console.log(chalk.dim('  experiment.yaml'));
  console.log(chalk.dim('  workspace/README.md'));
  console.log();
  console.log('Next steps:');
  console.log(chalk.dim(`  1. Edit experiments/${name}/experiment.yaml`));
  console.log(chalk.dim(`  2. Add files to experiments/${name}/workspace/`));
  console.log(chalk.dim(`  3. Run: bn run ${name} <agent>`));
}

function createAgent(name: string, cwd: string, template?: string): void {
  const agentsDir = path.join(cwd, 'agents');
  const agentPath = path.join(agentsDir, name);

  if (fs.existsSync(agentPath)) {
    console.error(chalk.red(`Agent already exists: ${name}`));
    process.exit(1);
  }

  // Create directory structure
  fs.mkdirSync(agentPath, { recursive: true });
  fs.mkdirSync(path.join(agentPath, 'src'), { recursive: true });

  // Write agent.yaml
  const agentYaml = getAgentTemplate(name, template);
  fs.writeFileSync(path.join(agentPath, 'agent.yaml'), agentYaml);

  // Write a sample agent script
  const agentScript = getAgentScript(template);
  fs.writeFileSync(path.join(agentPath, 'src', 'main.py'), agentScript);
  fs.chmodSync(path.join(agentPath, 'src', 'main.py'), 0o755);

  console.log(chalk.green(`Created agent: ${name}`));
  console.log(chalk.dim(`Path: agents/${name}/`));
  console.log();
  console.log('Files created:');
  console.log(chalk.dim('  agent.yaml'));
  console.log(chalk.dim('  src/main.py'));
  console.log();
  console.log('Next steps:');
  console.log(chalk.dim(`  1. Edit agents/${name}/agent.yaml`));
  console.log(chalk.dim(`  2. Implement agents/${name}/src/main.py`));
  console.log(chalk.dim(`  3. Run: bn run <experiment> ${name}`));
}

export function getExperimentTemplate(name: string, template?: string): string {
  const templates: Record<string, string> = {
    'coding-task': `$schema: https://schemas.bunsen.dev/experiment.v1.json
version: v1
name: ${name}
description: A coding task experiment.

environment:
  image:
    base: python:3.11-slim
  requires:
    packages:
      pip: [pytest]

task:
  prompt: |
    Fix the bug in the code.

    The code in the workspace has an issue. Debug and fix it.
    Run the tests to verify your fix works.

evaluation:
  container: dedicated
  criteria:
    - id: tests-pass
      title: Tests pass
      type: script
      weight: 0.6
      run: pytest -q

    - id: code-quality
      title: Code quality
      type: judge
      weight: 0.3
      instructions: |
        Is the fix clean, idiomatic, and easy to follow? Reward focused,
        readable changes; penalize unnecessary churn or hacks.

    - id: minimal-changes
      title: Minimal changes
      type: judge
      weight: 0.1
      instructions: Did the agent change only what was needed to fix the bug?
`,
    default: `$schema: https://schemas.bunsen.dev/experiment.v1.json
version: v1
name: ${name}
description: Describe what this experiment tests.

environment:
  image:
    base: python:3.11-slim
  # Optional extra runtimes/packages:
  # requires:
  #   packages:
  #     pip: [some-package]

# Optional: seed the agent's /workspace from local files.
# workspace:
#   sources:
#     - path: ./workspace

task:
  prompt: |
    Describe the task for the agent here.

    Be specific about what needs to be done and what success looks like.

evaluation:
  container: dedicated
  criteria:
    - id: correctness
      title: Correctness
      type: judge
      weight: 0.7
      instructions: Did the agent complete the task correctly and completely?

    - id: quality
      title: Quality
      type: judge
      weight: 0.3
      instructions: Was the approach reasonable, efficient, and high quality?
`,
  };

  return templates[template || 'default'] || templates.default;
}

export function getAgentTemplate(name: string, _template?: string): string {
  return `$schema: https://schemas.bunsen.dev/agent.v1.json
version: v1
name: ${name}
description: |
  Describe what this agent does.
  Include details about how it expects to be invoked.

install:
  source:
    type: local

entrypoint:
  command: python src/main.py
  # help: python src/main.py --help

interaction:
  mode: direct

# Optional: examples help the orchestrator understand invocation
examples:
  - prompt: Do the task
    invocation: python src/main.py "Do the task"
`;
}

function getAgentScript(_template?: string): string {
  return `#!/usr/bin/env python3
"""
Sample agent implementation.
Replace this with your actual agent logic.
"""

import sys

def main():
    # Get the task from command line args
    if len(sys.argv) < 2:
        print("Usage: python main.py <task>")
        sys.exit(1)

    task = sys.argv[1]

    print(f"Task received: {task}")
    print()

    # TODO: Implement your agent logic here
    #
    # The agent should:
    # 1. Parse and understand the task
    # 2. Do the work
    # 3. Print progress to stdout

    print("Agent completed (placeholder implementation)")

if __name__ == "__main__":
    main()
`;
}
