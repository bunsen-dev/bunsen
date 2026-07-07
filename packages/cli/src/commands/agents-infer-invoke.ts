// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `bn agents infer-invoke <agent>` — infer `entrypoint.invoke` at authoring time.
 *
 * Agent invocation is composed deterministically from a committed
 * `entrypoint.invoke` template (see `docs/PLATFORM_TOOLS.md` and
 * `packages/agents/src/scaffolder/scaffold.ts`), with no model in the run path —
 * which keeps runs reproducible. A model is genuinely useful for one thing:
 * onboarding a brand-new CLI — figuring out how to call it from its `--help` and
 * a couple of `examples`. This command does exactly that, paying for a model call
 * once per agent: it emits an `invoke` template and writes it into `agent.yaml`
 * as a reviewable diff. The human reviewing the diff absorbs any nondeterminism;
 * the thing that *runs* stays deterministic.
 *
 * It is a **suggestion tool** — the committed template is the contract, not the
 * model. The suggestion is a pure function of the agent (`command`, `examples`,
 * `--help`, `description`); it sees no experiment, task, or rubric.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import {
  resolveAgent,
  loadProject,
  loadAgent,
  parseAgentConfig,
} from '@bunsen-dev/runtime';
import type { AgentConfig } from '@bunsen-dev/types';
import { scaffoldInvokeTemplate, DEFAULT_SCAFFOLD_MODEL } from '@bunsen-dev/agents';
import { BunsenCliError } from '../errors.js';
import { isMachineFormat, renderMachine, resolveFormat } from '../format.js';
import {
  spliceInvokeIntoAgentYaml,
  hasBlockStyleEntrypoint,
  formatInvokeFlow,
  hostHelpPlan,
  isExecutableOnPath,
  runHostHelp,
  composeInvokePreview,
  INFER_INVOKE_COMMENT_MARKER,
} from './agents-infer-invoke-support.js';

interface AgentsInferInvokeOptions {
  force?: boolean;
  helpText?: string;
  /** From `--skip-help` (a distinct flag from commander's built-in `--help`). */
  skipHelp?: boolean;
  dryRun?: boolean;
  model?: string;
  format?: string;
}

/** How `--help` output was obtained (surfaced so the reviewer knows the basis). */
type HelpSource = 'file' | 'host' | 'host-failed' | 'absent' | 'skipped';

const DEFAULT_SAMPLE_PROMPT = 'Fix the failing test in the workspace.';
const INFER_INVOKE_COMMENT = `${INFER_INVOKE_COMMENT_MARKER}: inferred invoke template — review before committing.`;

export async function agentsInferInvokeCommand(
  name: string,
  options: AgentsInferInvokeOptions,
): Promise<void> {
  const format = resolveFormat(options);
  const machine = isMachineFormat(format);
  const say = (line = ''): void => {
    if (!machine) console.log(line);
  };

  // 1. Resolve the agent + read its agent.yaml.
  const project = loadProject(process.cwd());
  const resolved = resolveAgent(name, project);
  if (!resolved) {
    throw new BunsenCliError('agent_not_found', `Agent not found: ${name}`, {
      details: { hint: 'Run `bn agents list` to see available agents.' },
    });
  }
  const agentYamlPath = path.join(resolved.path, 'agent.yaml');
  const raw = fs.readFileSync(agentYamlPath, 'utf8');
  const config = parseAgentConfig(raw, { source: agentYamlPath }) as AgentConfig;

  // 2. Idempotence — never clobber a hand-written invoke without --force.
  if (config.entrypoint.invoke !== undefined && !options.force) {
    throw new BunsenCliError(
      'agent_invoke_exists',
      `${name} already declares entrypoint.invoke — refusing to overwrite it.`,
      {
        details: {
          current: JSON.stringify(config.entrypoint.invoke),
          hint: 'Pass --force to re-infer and overwrite it (written as a reviewable diff).',
        },
      },
    );
  }

  // 3. If we'll write, confirm the entrypoint is a block-style mapping the
  // splicer can edit — fail fast here rather than after a spent model call.
  if (!options.dryRun && !hasBlockStyleEntrypoint(raw)) {
    throw new BunsenCliError(
      'infer_invoke_entrypoint_unsupported',
      `${name}'s agent.yaml does not use a block-style \`entrypoint:\` mapping, so \`invoke\` can't be placed automatically.`,
      {
        details: {
          hint: 'Reformat `entrypoint` as a block mapping, add `entrypoint.invoke` by hand, or use --dry-run to just print the suggestion.',
        },
      },
    );
  }

  // 4. API key (host-side, authoring time).
  const apiKey = process.env.BUNSEN_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new BunsenCliError(
      'infer_invoke_api_key_missing',
      'An Anthropic API key is required to infer the invoke template.',
      {
        details: { hint: 'Set ANTHROPIC_API_KEY (or BUNSEN_ANTHROPIC_API_KEY) in your environment or .env.' },
      },
    );
  }

  // 4. Acquire --help text (best-effort), per the resolved strategy.
  const { helpText, helpSource } = acquireHelpText(config, resolved.path, options, say);

  // 5. Infer the template (single forced tool call).
  const model = options.model || DEFAULT_SCAFFOLD_MODEL;
  say(chalk.dim(`Inferring entrypoint.invoke for ${chalk.cyan(config.name)} with ${model}…`));
  const suggestion = await scaffoldInvokeTemplate({ agent: config, helpText, apiKey, model });

  const samplePrompt = config.examples?.[0]?.prompt || DEFAULT_SAMPLE_PROMPT;
  const preview = composeInvokePreview(config.entrypoint, suggestion.invoke, samplePrompt);
  const rel = path.relative(process.cwd(), agentYamlPath) || agentYamlPath;
  const byHandHint = `Add it by hand:  invoke: ${formatInvokeFlow(suggestion.invoke)}`;

  // 6. Write (or, with --dry-run, don't).
  const written = !options.dryRun;
  if (written) {
    let text: string;
    try {
      text = spliceInvokeIntoAgentYaml(raw, suggestion.invoke, { comment: INFER_INVOKE_COMMENT }).text;
    } catch (err) {
      // The splice couldn't place invoke in this entrypoint shape. Blame the
      // shape, not the (already-validated) template.
      throw new BunsenCliError(
        'infer_invoke_entrypoint_unsupported',
        `Could not place \`invoke\` in ${rel} automatically: ${err instanceof Error ? err.message : String(err)}`,
        { details: { hint: byHandHint } },
      );
    }
    fs.writeFileSync(agentYamlPath, text);
    // Re-parse through the canonical loader — the committed template is the
    // contract, so prove the file still validates before declaring success.
    try {
      loadAgent(resolved.path);
    } catch (err) {
      fs.writeFileSync(agentYamlPath, raw); // restore; leave no broken file behind
      throw new BunsenCliError(
        'infer_invoke_write_invalid',
        `Writing \`invoke\` into ${rel} produced YAML the loader rejected (its entrypoint block shape may be unusual); the file was left unchanged.`,
        {
          details: {
            reason: err instanceof Error ? err.message : String(err),
            hint: byHandHint,
          },
        },
      );
    }
  }

  // 7. Report.
  if (machine) {
    process.stdout.write(
      renderMachine(
        {
          agent: config.name,
          path: path.relative(process.cwd(), agentYamlPath) || agentYamlPath,
          invoke: suggestion.invoke,
          reasoning: suggestion.reasoning,
          basis: suggestion.basis,
          help: helpSource,
          preview,
          written,
        },
        format,
      ),
    );
    return;
  }

  const invokeLine = `invoke: ${formatInvokeFlow(suggestion.invoke)}`;
  say();
  say(`${chalk.bold('Inferred')} ${chalk.green(invokeLine)}`);
  say(chalk.dim(`  ${suggestion.reasoning}`));
  say(chalk.dim(`  Based on: ${suggestion.basis.join(', ')}`));
  say();
  say(chalk.dim(`Sample invocation (prompt = ${JSON.stringify(samplePrompt)}):`));
  say(`  ${preview}`);
  say();
  if (written) {
    say(chalk.green(`✓ Wrote entrypoint.invoke to ${rel}`));
    say(chalk.dim(`  Review the diff before committing:  git diff ${rel}`));
  } else {
    say(chalk.yellow('• Dry run — agent.yaml was not modified.'));
    say(chalk.dim('  Re-run without --dry-run to write it.'));
  }
}

/**
 * Resolve the `--help` text per the strategy: an explicit `--help-text` file (or
 * `-` for stdin) wins; `--skip-help` skips; otherwise best-effort host capture,
 * gated on the base command actually resolving on PATH, degrading to
 * examples-only on any miss. `say` prints progress in text mode only.
 */
function acquireHelpText(
  config: AgentConfig,
  agentDir: string,
  options: AgentsInferInvokeOptions,
  say: (line?: string) => void,
): { helpText?: string; helpSource: HelpSource } {
  if (options.helpText) {
    const fromStdin = options.helpText === '-';
    let helpText: string;
    try {
      helpText = fromStdin
        ? fs.readFileSync(0, 'utf8')
        : fs.readFileSync(path.resolve(options.helpText), 'utf8');
    } catch (err) {
      throw new BunsenCliError(
        'infer_invoke_help_text_unreadable',
        `Could not read --help-text ${fromStdin ? 'from stdin' : options.helpText}: ${err instanceof Error ? err.message : String(err)}`,
        { details: { hint: 'Pass a readable file path, or "-" to read the help text from stdin.' } },
      );
    }
    say(chalk.dim(`Using help text from ${fromStdin ? 'stdin' : options.helpText}.`));
    return { helpText, helpSource: 'file' };
  }

  if (options.skipHelp) {
    return { helpSource: 'skipped' };
  }

  const plan = hostHelpPlan(config.entrypoint);
  if (!isExecutableOnPath(plan.executable)) {
    say(chalk.dim(`\`${plan.executable}\` is not on PATH — inferring from examples only.`));
    return { helpSource: 'absent' };
  }
  // For an interpreter form (`python <script>`), the interpreter is on PATH but
  // the script is often an in-container path (`/agent/main.py`) absent on the
  // host — running help would capture the interpreter's file-not-found error and
  // feed it to the model as if it were help. Require the script to exist first.
  if (plan.scriptArg && !fs.existsSync(path.resolve(agentDir, plan.scriptArg))) {
    say(chalk.dim(`\`${plan.scriptArg}\` is not present on the host — inferring from examples only.`));
    return { helpSource: 'absent' };
  }
  say(chalk.dim(`Running \`${plan.command}\`…`));
  const result = runHostHelp(plan, { cwd: agentDir });
  if (result.ok) {
    return { helpText: result.output, helpSource: 'host' };
  }
  say(chalk.dim(`Could not capture help (${result.reason}) — inferring from examples only.`));
  return { helpSource: 'host-failed' };
}
