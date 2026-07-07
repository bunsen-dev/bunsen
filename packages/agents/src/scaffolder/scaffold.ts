// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Authoring-time inference of an agent's `entrypoint.invoke` template.
 *
 * At run time the invocation is composed deterministically from committed config
 * by `packages/runtime/src/orchestration.ts`, with no model in the path — that is
 * what keeps runs reproducible and comparable. A model is genuinely useful for
 * one thing, though: onboarding a brand-new CLI — point Bunsen at a tool and let
 * it infer how to call it from the CLI's `--help` and a couple of `examples`.
 * That is this module's job.
 *
 * It runs **once per agent** at authoring time (host-side, driven by
 * `bn agents infer-invoke`), and its output is a committed, human-reviewed
 * `invoke` template — never a per-run invocation. The human reviewing the diff
 * absorbs any nondeterminism before commit: what *runs* is deterministic, and
 * only the thing that *helps you write config* is a model.
 *
 * The suggestion is a **pure function of the agent** — `command`, `examples`,
 * `entrypoint.help`, `description`. It sees no experiment, task prompt, or
 * rubric: how you call `codex` must not depend on which bug you're fixing (that
 * coupling would make invocations task-dependent and break comparability).
 *
 * Unlike the platform bundles (scorer/supervisor/…), this is NOT compiled into a
 * container `.cjs` — it is host code, inlined into the `bn` binary via the CLI's
 * esbuild step (which externalizes `@anthropic-ai/sdk`). So it can use the full
 * `common/` agent framework directly.
 */

import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { AgentConfig } from '@bunsen-dev/types';
import { createAgent, tool, type ToolWithFunc } from '../common/index.js';

/**
 * Model the scaffolder runs on. Opus, deliberately: this runs once per agent and
 * is human-reviewed, so inference quality matters far more than per-call cost.
 */
export const DEFAULT_SCAFFOLD_MODEL = 'claude-opus-4-8';

/**
 * Placeholders allowed inside an `invoke` token — kept in lockstep with the
 * canonical validator in `@bunsen-dev/runtime`'s `agent-loader.ts` (`parseInvoke`).
 * We re-implement the rule here rather than import it because `@bunsen-dev/agents`
 * must not depend on `@bunsen-dev/runtime` (native deps that don't bundle). The
 * CLI re-parses the written file through the real loader afterward, so this is a
 * fast-fail check, not the authority.
 */
const KNOWN_INVOKE_PLACEHOLDERS: ReadonlySet<string> = new Set(['{prompt}', '{promptFile}']);
/** Matches any `{…}` brace group so unknown placeholder attempts fail loudly. */
const INVOKE_PLACEHOLDER_PATTERN = /\{[^}]*\}/g;

// =============================================================================
// Public shapes
// =============================================================================

export interface ScaffoldInvokeInput {
  /**
   * The base agent config (no variant applied). Only `name`, `description`,
   * `entrypoint`, `interaction`, and `examples` inform the suggestion.
   */
  agent: AgentConfig;
  /**
   * Captured `--help` output, if the caller could run it (host best-effort). The
   * scaffolder folds it into the prompt when present; absent, it works from
   * `examples` + `command` alone.
   */
  helpText?: string;
  /** Anthropic API key (host-side; the platform key at authoring time). */
  apiKey: string;
  /** Override the model. Defaults to {@link DEFAULT_SCAFFOLD_MODEL}. */
  model?: string;
}

/** Which inputs actually informed a suggestion — surfaced so the reviewer knows what it was based on. */
export type ScaffoldBasis = 'help' | 'examples' | 'command';

export interface ScaffoldInvokeResult {
  /** The inferred argv template, e.g. `["exec", "{prompt}"]`. */
  invoke: string[];
  /** One or two sentences on why the model chose this template. */
  reasoning: string;
  /** The inputs available to the model, most-informative first. */
  basis: ScaffoldBasis[];
}

// =============================================================================
// Validation (mirrors agent-loader's parseInvoke; see note above)
// =============================================================================

/**
 * Validate an inferred `invoke` template against the same contract the runtime
 * agent-loader enforces. Throws {@link Error} on violation. Kept intentionally
 * close to `parseInvoke` in `agent-loader.ts` so the model can't hand back a
 * template the loader would later reject.
 */
export function validateInvokeTemplate(tokens: unknown): asserts tokens is string[] {
  if (!Array.isArray(tokens) || !tokens.every((t) => typeof t === 'string')) {
    throw new Error('invoke must be an array of strings');
  }
  const kinds = new Set<string>();
  let occurrences = 0;
  tokens.forEach((token, i) => {
    for (const match of token.match(INVOKE_PLACEHOLDER_PATTERN) ?? []) {
      if (!KNOWN_INVOKE_PLACEHOLDERS.has(match)) {
        throw new Error(
          `invoke[${i}]: unknown placeholder ${JSON.stringify(match)}. ` +
            `Known placeholders: ${[...KNOWN_INVOKE_PLACEHOLDERS].join(', ')}.`,
        );
      }
      kinds.add(match);
      occurrences++;
    }
  });
  if (kinds.size > 1) {
    throw new Error(
      `invoke: at most one placeholder kind may be used, but found ${[...kinds].join(' and ')}. ` +
        `Deliver the prompt through a single channel.`,
    );
  }
  if (tokens.length > 0 && occurrences === 0) {
    throw new Error(
      `invoke: a non-empty template must contain a prompt placeholder ` +
        `(${[...KNOWN_INVOKE_PLACEHOLDERS].join(' or ')}). ` +
        `Use an empty array only for a wrapper command that reads $BUNSEN_TASK_FILE itself.`,
    );
  }
}

// =============================================================================
// Tool
// =============================================================================

interface ScaffolderState {
  result: { invoke: string[]; reasoning: string } | null;
}

const submitInvokeTemplateSchema = z.object({
  invoke: z
    .array(z.string())
    .describe(
      'The argv TEMPLATE — the tokens from the first argument through the prompt slot. ' +
        'Use the placeholder {prompt} where the task prompt goes (one argv token), or {promptFile} ' +
        'for a CLI that reads the task from a file. Examples: ["{prompt}"] (bare positional), ' +
        '["exec", "{prompt}"] (after a subcommand), ["-p", "{prompt}"] (after a flag), ' +
        '["--message-file", "{promptFile}"] (file-reading CLI). Do NOT include the executable itself, ' +
        'and do NOT include persistent flags from entrypoint.args (the executor appends those). ' +
        'No shell quoting — each entry is one literal argv token.',
    ),
  reasoning: z
    .string()
    .describe(
      'One or two sentences: where does this CLI want the task prompt in its argv, and why this template ' +
        '(cite the example/help detail you inferred it from).',
    ),
});

function createSubmitInvokeTemplateTool(state: ScaffolderState): ToolWithFunc {
  return tool({
    name: 'submit_invoke_template',
    description: `Submit the inferred entrypoint.invoke template. Call this exactly once.

Provide:
- invoke: The argv template through the prompt slot, using {prompt} (or {promptFile}) for the task prompt.
- reasoning: A short explanation of the prompt placement.`,
    schema: submitInvokeTemplateSchema,
    func: (input: z.infer<typeof submitInvokeTemplateSchema>): string => {
      const parsed = submitInvokeTemplateSchema.parse(input);
      // We own correctness: reject a template the runtime loader would reject,
      // loudly, rather than writing a broken invoke into agent.yaml.
      validateInvokeTemplate(parsed.invoke);
      state.result = { invoke: parsed.invoke, reasoning: parsed.reasoning };
      return 'Invoke template submitted successfully';
    },
  });
}

// =============================================================================
// Prompts
// =============================================================================

export function buildScaffoldSystemPrompt(): string {
  return `You help onboard a command-line agent into Bunsen. Your job: infer the agent's \`entrypoint.invoke\` template — the argv shape that places the task prompt where the CLI wants it.

You must call submit_invoke_template EXACTLY ONCE.

## How Bunsen composes the final argv

At run time Bunsen builds the agent's command line deterministically:

    <command> [interpreter/script split]  <expanded invoke…>  <cli passthrough>  <entrypoint.args>

- \`command\` is the executable (already known — do NOT put it in invoke).
- \`invoke\` is the ONLY thing you infer: the ordered tokens from the first
  argument through the prompt slot. This is where an order-sensitive prefix lives
  — a subcommand or a prompt flag.
- \`entrypoint.args\` are persistent, order-insensitive flags the executor appends
  LAST. They are given to you for context — do NOT repeat them in invoke.

## The invoke template

- Put the task prompt where the CLI expects it using a placeholder:
  - \`{prompt}\` — the task prompt as one literal argv token (the common case).
  - \`{promptFile}\` — a path to a file containing the task, for CLIs that read
    the prompt from a file (e.g. \`["--message-file", "{promptFile}"]\`).
- Use at most ONE placeholder kind (the prompt is delivered through one channel).
- Each entry is exactly one argv token. NO shell quoting, NO surrounding quotes,
  NO escaping — Bunsen passes tokens without shell reinterpretation.

## The three shapes you are choosing between

| CLI pattern                         | invoke template          |
| ----------------------------------- | ------------------------ |
| prompt is a bare positional arg     | \`["{prompt}"]\`           |
| prompt follows a subcommand         | \`["exec", "{prompt}"]\`   |
| prompt follows a flag               | \`["-p", "{prompt}"]\`     |
| CLI reads the task from a file      | \`["--message-file", "{promptFile}"]\` |

If the agent's \`command\` is a wrapper script that reads the task itself (e.g.
from \`$BUNSEN_TASK_FILE\`) and takes no prompt argument, return an empty invoke \`[]\`.

## Reading the inputs

- The strongest signal is \`examples\`: each shows a concrete command line for a
  given prompt. Find where the prompt text sits relative to subcommands/flags and
  generalize it into the template. Strip the example's surrounding quotes — those
  are shell display, not argv tokens.
- \`--help\` output (when provided) confirms the subcommand/flag the prompt goes
  with. Prefer the shape the examples demonstrate; use help to disambiguate.
- Work only from the agent details provided. Do not assume filesystem access.`;
}

export function buildScaffoldUserPrompt(agent: AgentConfig, helpText?: string): string {
  const entrypointArgs = agent.entrypoint.args ?? [];

  let prompt = `## Agent

Name: ${agent.name}
${agent.description ? `Description: ${agent.description}\n` : ''}Command (the executable — do NOT include in invoke): ${agent.entrypoint.command}
Interaction mode: ${agent.interaction.mode}`;

  if (entrypointArgs.length > 0) {
    prompt += `\n\n### Persistent args (entrypoint.args — appended by the executor; do NOT repeat in invoke)
${entrypointArgs.map((a) => `- ${a}`).join('\n')}`;
  }

  if (agent.examples && agent.examples.length > 0) {
    prompt += `\n\n### Examples (prompt → the command line it maps to)`;
    for (const example of agent.examples) {
      prompt += `\n- Prompt: ${example.prompt}\n  Invocation: ${example.invocation}`;
    }
    prompt += `\n\nExample invocations are shown as shell strings for readability. Translate the prompt's position into the argv template; strip surrounding quotes.`;
  } else {
    prompt += `\n\n(No examples were provided — infer the template from the command name, help output, and conventional CLI shape.)`;
  }

  if (helpText && helpText.trim().length > 0) {
    // Guard against a runaway help dump blowing the context budget.
    const trimmed = helpText.length > 12000 ? `${helpText.slice(0, 12000)}\n…(truncated)` : helpText;
    prompt += `\n\n### \`--help\` output\n\`\`\`\n${trimmed}\n\`\`\``;
  }

  prompt += `\n\nCall submit_invoke_template now with the inferred argv template.`;

  return prompt;
}

// =============================================================================
// Entry point
// =============================================================================

/** Which inputs are available to base a suggestion on, most-informative first. */
export function scaffoldBasis(agent: AgentConfig, helpText?: string): ScaffoldBasis[] {
  const basis: ScaffoldBasis[] = [];
  if (agent.examples && agent.examples.length > 0) basis.push('examples');
  if (helpText && helpText.trim().length > 0) basis.push('help');
  basis.push('command');
  return basis;
}

/**
 * Infer an `entrypoint.invoke` template for the given agent via a single forced
 * tool call. Pure function of the agent (+ optional captured help) — no
 * experiment context. Throws if the model returns no tool call or an invalid
 * template.
 */
export async function scaffoldInvokeTemplate(
  input: ScaffoldInvokeInput,
): Promise<ScaffoldInvokeResult> {
  const { agent, helpText, apiKey } = input;
  if (!apiKey) {
    throw new Error('An Anthropic API key is required to run the scaffolder.');
  }

  const state: ScaffolderState = { result: null };
  const submitTool = createSubmitInvokeTemplateTool(state);

  const scaffolder = createAgent({
    model: input.model ?? DEFAULT_SCAFFOLD_MODEL,
    tools: [submitTool],
    system: buildScaffoldSystemPrompt(),
    apiKey,
    // No temperature: claude-opus-4-8 rejects the deprecated parameter, and a
    // forced single tool call needs no sampling knob anyway.
  });

  // Single forced tool call — the model has no free-text path.
  const { raw } = await scaffolder.runOnce({
    toolChoice: { type: 'tool', name: 'submit_invoke_template' },
    messages: [{ role: 'user', content: buildScaffoldUserPrompt(agent, helpText) }],
  });

  const toolUse = raw.content.find(
    (block): block is Anthropic.ToolUseBlock =>
      block.type === 'tool_use' && block.name === 'submit_invoke_template',
  );
  if (!toolUse) {
    throw new Error(
      'The scaffolder model did not return a submit_invoke_template tool call.',
    );
  }

  // Runs validateInvokeTemplate; throws on a template the loader would reject.
  await submitTool.func(toolUse.input);

  if (!state.result) {
    throw new Error('The scaffolder did not produce an invoke template.');
  }

  return {
    invoke: state.result.invoke,
    reasoning: state.result.reasoning,
    basis: scaffoldBasis(agent, helpText),
  };
}
