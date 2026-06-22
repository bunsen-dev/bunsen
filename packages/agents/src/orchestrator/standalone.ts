#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Standalone entry point for the orchestrator.
 *
 * This is the entry point for the orchestrator bundle. It reads configuration
 * from environment variables and container paths, runs the orchestration,
 * and writes results.
 *
 * This runs inside the container with direct file access (no path translation).
 *
 * Environment variables:
 *   BUNSEN_ANTHROPIC_API_KEY - API key for Claude (required)
 *   BUNSEN_EXPERIMENT_PATH - Path to experiment.yaml (default: /input/experiment/experiment.yaml)
 *   BUNSEN_AGENT_PATH - Path to agent.yaml (default: /agent/agent.yaml)
 *   BUNSEN_CLI_ARGS - JSON array of CLI args to pass to agent (default: [])
 *
 * Container paths (direct access, no translation needed):
 *   /input/experiment/    - Experiment definition
 *   /agent/               - Agent code and config
 *   /workspace/           - Agent workspace (always exists, writable)
 *   /workspace-source/    - Original workspace (read-only, only if experiment provides starter files)
 *
 * Output:
 *   Writes JSON to stdout matching `OrchestrationResult` from `@bunsen-dev/types`:
 *     { "setupCommands": [...], "invocation": { "command": "...", "args": [...] } }
 */

import * as fs from 'node:fs';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  ExperimentConfig,
  Criterion,
  AgentConfig,
  OrchestrationResult,
} from '@bunsen-dev/types';
import { createAgent, tool, type ToolWithFunc } from '../common/index.js';

// =============================================================================
// State and Context
// =============================================================================

interface OrchestratorState {
  result: OrchestrationResult | null;
}

interface ResolvedVariantContext {
  guaranteedArgs?: string[];
  variantEnvVarNames?: string[];
}

function buildExecutorAppliedContextSection({
  guaranteedArgs = [],
  variantEnvVarNames = [],
}: ResolvedVariantContext): string {
  const lines = ['## Executor-Applied Context'];

  if (guaranteedArgs.length > 0) {
    lines.push('');
    lines.push('Resolved guaranteed args (auto-appended by the executor to your invocation.args, so do NOT include them yourself):');
    lines.push(...guaranteedArgs.map((arg) => `- ${arg}`));
  }

  if (variantEnvVarNames.length > 0) {
    lines.push('');
    lines.push('Resolved variant env var names (already applied to the agent container env):');
    lines.push(...variantEnvVarNames.map((name) => `- ${name}`));
  }

  if (lines.length === 1) {
    return '';
  }

  return lines.join('\n');
}

// =============================================================================
// In-Container Tools
// =============================================================================

const submitOrchestrationSchema = z.object({
  setup_commands: z
    .array(z.string())
    .describe(
      'Pre-invocation shell commands chained with `&&` (cd, export, etc.). Use these for env vars or working directory; they run before invocation.command.'
    ),
  invocation: z
    .object({
      command: z
        .string()
        .describe('The executable to run, e.g. "claude", "node", "/agent/my-agent".'),
      args: z
        .array(z.string())
        .describe(
          'Argv tokens passed to command. Each entry is one argument as the agent will receive it — DO NOT add shell quoting, escaping, or quote characters yourself. The executor passes args without shell reinterpretation, so backticks, dollar signs, quotes, and newlines in task text are safe.'
        ),
    })
    .describe('Structured argv invocation. No shell metacharacters are interpreted in args.'),
});

function createSubmitOrchestrationTool(state: OrchestratorState): ToolWithFunc {
  return tool({
    name: 'submit_orchestration',
    description: `Submit the orchestration result. Call this exactly once.

Provide:
- setup_commands: Pre-invocation shell commands (cd, export, etc.) — joined with &&.
- invocation.command: The executable.
- invocation.args: Argv tokens. Pass the task prompt as one entry; do NOT shell-quote.`,
    schema: submitOrchestrationSchema,
    func: (input: z.infer<typeof submitOrchestrationSchema>): string => {
      // Re-validate at runtime: Anthropic's forced tool_choice usually emits a
      // schema-conformant input, but we own correctness here — bad shape from
      // the model should fail loudly, not silently miscompose the agent script.
      const parsed = submitOrchestrationSchema.parse(input);
      state.result = {
        setupCommands: parsed.setup_commands,
        invocation: {
          command: parsed.invocation.command,
          args: parsed.invocation.args,
        },
      };
      return 'Orchestration submitted successfully';
    },
  });
}

// =============================================================================
// Prompts
// =============================================================================

function buildSystemPrompt(): string {
  return `You are the Bunsen Orchestrator Agent. Your job is to figure out how to invoke an agent-under-test for a given experiment.

You receive:
1. An experiment definition (task description, environment info)
2. An agent definition (description, command, examples)
3. Any CLI args to pass to the agent

You must call submit_orchestration EXACTLY ONCE with:
- setup_commands: Shell commands to run before the invocation (cd, export, etc.) chained with &&.
- invocation.command: The executable to run.
- invocation.args: An array of argument tokens. Each entry is exactly one argv element.

## Argv Contract — Important

The invocation is structured (command + args array), NOT a shell string. The executor runs each arg as a separate argv token without any shell reinterpretation. This means:

- DO NOT wrap the task prompt in quotes. Pass it as a single args entry verbatim.
- DO NOT escape backticks, dollar signs, backslashes, or newlines. The agent will receive them exactly as written.
- DO NOT include shell features like pipes (\`|\`), redirects (\`>\`), or env prefixes (\`FOO=1 cmd\`) inside command/args. Use setup_commands for env (\`export FOO=1\`) and a wrapper script for pipes/redirects.

Example for an agent that takes the task as its first positional arg:

\`\`\`json
{
  "setup_commands": ["cd /workspace"],
  "invocation": {
    "command": "claude",
    "args": ["Fix the bug in main.py"]
  }
}
\`\`\`

If the agent's example shows \`my-agent "Some task"\`, the args entry is just \`"Some task"\` (no surrounding quotes).

Key principles:
- The agent should receive a clean, focused prompt (no platform boilerplate).
- Use the agent's examples to understand invocation patterns and which args are needed.
- IMPORTANT: If the agent definition includes guaranteed args, the executor appends them to invocation.args automatically. Do NOT include them yourself.
- Work from the concrete experiment and agent configs provided in the prompt. Do not assume you can browse for extra files; orchestration should be determined from those configs alone.
- Do not ask to inspect the filesystem; produce the orchestration directly from the provided config details.`;
}

function describeCriterion(c: Criterion): string {
  const weight = c.weight ?? 1;
  const typeTag = `[${c.type}]`;
  switch (c.type) {
    case 'script':
      return `- ${c.id} (${typeTag}, weight: ${weight}): ${c.title} — run: ${c.run}`;
    case 'judge':
    case 'agent':
    case 'browser-agent':
      return `- ${c.id} (${typeTag}, weight: ${weight}): ${c.title} — ${c.instructions}`;
    case 'aggregate':
      return `- ${c.id} (${typeTag}, weight: ${weight}): ${c.title} — aggregate: ${c.aggregate.function}`;
  }
}

function buildUserPrompt(
  experiment: ExperimentConfig,
  agent: AgentConfig,
  cliArgs: string[],
  variantContext: ResolvedVariantContext
): string {
  const imageLabel =
    'base' in experiment.environment.image
      ? experiment.environment.image.base
      : `Dockerfile: ${experiment.environment.image.dockerfile}`;

  const entrypointArgs = agent.entrypoint.args ?? [];
  const entrypointStr = [agent.entrypoint.command, ...entrypointArgs].join(' ');

  let prompt = `## Experiment

Name: ${experiment.name}
${experiment.description ? `Description: ${experiment.description}` : ''}
Image: ${imageLabel}

### Task
${experiment.task.prompt}

### Rubric Criteria
${experiment.evaluation.criteria.map(describeCriterion).join('\n')}${experiment.evaluation.report ? `\n- summary-report [report]: ${experiment.evaluation.report.instructions}` : ''}

## Agent

Name: ${agent.name}
${agent.description ? `Description: ${agent.description}` : ''}
Entrypoint: ${entrypointStr}
Interaction mode: ${agent.interaction.mode}`;

  if (agent.examples && agent.examples.length > 0) {
    prompt += `\n\n### Examples`;
    for (const example of agent.examples) {
      prompt += `\n- Prompt: ${example.prompt}\n  Invocation: ${example.invocation}`;
    }
    prompt += `\n\nNote: example invocations above are shown as shell strings for human readability. Translate them into the structured argv shape — strip surrounding quotes from arg tokens, do not escape inner characters.`;
  }

  if (agent.entrypoint.help) {
    prompt += `\n\nHelp Command: ${agent.entrypoint.help}`;
  }

  if (entrypointArgs.length > 0) {
    prompt += `\n\n### Guaranteed Args (auto-appended)
The following arguments will be automatically appended to invocation.args by the executor. Do NOT include them yourself:
${entrypointArgs.map((a) => `- ${a}`).join('\n')}`;
  }

  const executorAppliedContext = buildExecutorAppliedContextSection(variantContext);
  if (executorAppliedContext) {
    prompt += `\n\n${executorAppliedContext}`;
  }

  if (cliArgs.length > 0) {
    prompt += `\n\n## CLI Args to Pass
The following CLI args were provided by the user. Add them to invocation.args:
${cliArgs.map((a) => `- ${a}`).join('\n')}`;
  }

  prompt += `\n\nCall submit_orchestration now with the structured argv invocation.`;

  return prompt;
}
// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  // Get configuration from environment
  const apiKey = process.env.BUNSEN_ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Error: BUNSEN_ANTHROPIC_API_KEY environment variable is required');
    process.exit(1);
  }

  const experimentPath = process.env.BUNSEN_EXPERIMENT_PATH || '/input/experiment/experiment.yaml';
  const agentPath = process.env.BUNSEN_AGENT_PATH || '/agent/agent.yaml';
  const cliArgsJson = process.env.BUNSEN_CLI_ARGS || '[]';
  const guaranteedArgsJson = process.env.BUNSEN_GUARANTEED_ARGS || '[]';
  const variantEnvVarNamesJson = process.env.BUNSEN_VARIANT_ENV_VAR_NAMES || '[]';

  let cliArgs: string[];
  try {
    cliArgs = JSON.parse(cliArgsJson);
  } catch {
    console.error('Error: BUNSEN_CLI_ARGS must be a valid JSON array');
    process.exit(1);
  }

  let guaranteedArgs: string[];
  try {
    guaranteedArgs = JSON.parse(guaranteedArgsJson);
  } catch {
    console.error('Error: BUNSEN_GUARANTEED_ARGS must be a valid JSON array');
    process.exit(1);
  }

  let variantEnvVarNames: string[];
  try {
    variantEnvVarNames = JSON.parse(variantEnvVarNamesJson);
  } catch {
    console.error('Error: BUNSEN_VARIANT_ENV_VAR_NAMES must be a valid JSON array');
    process.exit(1);
  }

  // Load experiment configuration (v1 schema). Since this bundle cannot
  // import @bunsen-dev/runtime (see packages/agents/CLAUDE.md) we parse the YAML
  // locally and trust it — the runtime has already validated it via the v1
  // parser before mounting it into the container. The prompt only needs a
  // handful of fields, so a shallow trust here is safe.
  let experiment: ExperimentConfig;
  try {
    console.error('[orchestrator] Loading experiment configuration...');
    const configContent = fs.readFileSync(experimentPath, 'utf-8');
    experiment = yaml.load(configContent) as ExperimentConfig;
    if (!experiment || typeof experiment !== 'object') {
      throw new Error('experiment.yaml is not a YAML mapping');
    }
  } catch (error) {
    console.error(`Error loading experiment config from ${experimentPath}:`, error);
    process.exit(1);
  }

  // Load agent configuration (v1 schema). Same rationale as experiment.yaml
  // above: the runtime has already validated via the v1 parser before mounting.
  let agent: AgentConfig;
  try {
    console.error('[orchestrator] Loading agent configuration...');
    const configContent = fs.readFileSync(agentPath, 'utf-8');
    agent = yaml.load(configContent) as AgentConfig;
    if (!agent || typeof agent !== 'object') {
      throw new Error('agent.yaml is not a YAML mapping');
    }
  } catch (error) {
    console.error(`Error loading agent config from ${agentPath}:`, error);
    process.exit(1);
  }

  // Create state and tools
  const state: OrchestratorState = { result: null };
  const submitTool = createSubmitOrchestrationTool(state);

  // Create agent (single tool, single forced call — no agent loop)
  const orchestratorAgent = createAgent({
    model: 'claude-haiku-4-5',
    tools: [submitTool],
    system: buildSystemPrompt(),
    apiKey,
    temperature: 0,
  });

  // Run a single forced tool call. runOnce returns the raw Anthropic response;
  // we extract the submit_orchestration input directly. With
  // tool_choice: { type: 'tool', name: 'submit_orchestration' } the model is
  // guaranteed to emit exactly that tool call — no free-text path.
  console.error('[orchestrator] Running orchestrator (single forced tool call)...');
  const userPrompt = buildUserPrompt(experiment, agent, cliArgs, {
    guaranteedArgs,
    variantEnvVarNames,
  });

  const { raw } = await orchestratorAgent.runOnce({
    toolChoice: { type: 'tool', name: 'submit_orchestration' },
    messages: [{ role: 'user', content: userPrompt }],
  });

  // Find the forced tool_use block and run the tool function to populate state.
  const toolUse = raw.content.find(
    (block): block is Anthropic.ToolUseBlock =>
      block.type === 'tool_use' && block.name === 'submit_orchestration'
  );

  if (!toolUse) {
    console.error(
      'Error: Orchestrator response did not contain a submit_orchestration tool call. Response content:',
      JSON.stringify(raw.content, null, 2)
    );
    process.exit(1);
  }

  try {
    await submitTool.func(toolUse.input);
  } catch (error) {
    console.error(
      `Error: submit_orchestration tool input did not match the schema: ${error instanceof Error ? error.message : error}\n` +
        `Input was: ${JSON.stringify(toolUse.input, null, 2)}`
    );
    process.exit(1);
  }

  if (!state.result) {
    console.error('Error: Orchestrator did not submit an orchestration result');
    process.exit(1);
  }

  // Output result as JSON to stdout
  console.log(JSON.stringify(state.result, null, 2));
}

main().catch((error) => {
  console.error('Orchestration failed:', error);
  process.exit(1);
});
