// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Prompts for different scorer types
 */

import type {
  ScorerConfig,
  AllowedScores,
} from '@bunsen-dev/types';

/**
 * Format allowed scores for inclusion in prompts
 */
function formatAllowedScores(scores?: AllowedScores): string {
  if (!scores) {
    return 'Any value between 0 and 1 (continuous scale)';
  }

  if (Array.isArray(scores)) {
    return `Choose from: ${scores.join(', ')}`;
  }

  // Labeled scores
  const entries = Object.entries(scores)
    .sort(([a], [b]) => parseFloat(a) - parseFloat(b))
    .map(([value, label]) => `${value} (${label})`);
  return `Choose from: ${entries.join(', ')}`;
}

/**
 * Build system prompt for LLM-as-judge scorer
 */
export function buildLLMJudgeSystemPrompt(config: ScorerConfig): string {
  const scoreGuidance = formatAllowedScores(config.scores);

  return `You are an expert evaluator assessing a specific criterion for a software project.

## Your Task

Evaluate the following criterion based on the evidence provided:

**Criterion**: ${config.criterion}
**Description**: ${config.instructions}

## Scoring

${scoreGuidance}

All scores are normalized to 0-1 where:
- 0 = Complete failure / Does not meet requirements
- 0.5 = Partial success / Meets some requirements
- 1 = Full success / Exceeds requirements

## Evidence

You will be provided with context about the agent's work${config.context ? `, specifically: ${config.context.join(', ')}` : ''}.
Evaluate based only on the evidence provided. Prioritize evidence in this order: diff > logs > traces

## Output Format

Respond with a JSON object containing:
- \`score\`: A number between 0 and 1${config.scores ? ' from the allowed values' : ''}
- \`summary\`: A brief explanation (1-3 sentences) of your assessment

Example:
\`\`\`json
{
  "score": 0.8,
  "summary": "The implementation correctly handles the main use case but misses edge case handling for empty inputs."
}
\`\`\`

${config.prompt ? `\n## Additional Instructions\n\n${config.prompt}` : ''}

Be objective and evidence-based. Cite specific examples from the provided context when possible.`;
}

/**
 * Build system prompt for agentic scorer
 */
export function buildAgenticScorerSystemPrompt(config: ScorerConfig): string {
  const scoreGuidance = formatAllowedScores(config.scores);

  return `You are an expert evaluator with access to tools for assessing a specific criterion.

## Your Task

Evaluate the following criterion:

**Criterion**: ${config.criterion}
**Description**: ${config.instructions}

## Scoring

${scoreGuidance}

All scores are normalized to 0-1 where:
- 0 = Complete failure / Does not meet requirements
- 0.5 = Partial success / Meets some requirements
- 1 = Full success / Exceeds requirements

## Available Tools

- **run_command**: Execute shell commands. For commands with large output (test suites), use run_in_background=true and then read_file to inspect the output.
- **read_file**: Read files or line ranges. Supports workspace files (relative paths), command output files (/tmp/...), diffs (/bunsen/run/workspace/diff.patch), and logs (/bunsen/run/logs.txt). Use start_line=-N for the last N lines.
- **list_files**: List directory contents.
- **list_threads**: List the agent-under-test conversation threads with model, system prompt summary, and turn counts. Use this before reading turns.
- **read_thread_turns**: Read a slice of turns from a thread (each turn is the new-message delta from the previous turn). Pass \`thread_id\`, optional \`start\` (0-based, inclusive), and optional \`end\` (exclusive). Read narrow slices — large slices return an error.

If you need a development server or other service running to verify functionality, start it yourself.

## Key Files

- **/bunsen/run/workspace/diff.patch** — Changes the agent made to the workspace
- **/bunsen/run/logs.txt** — Agent execution logs (stdout/stderr)
- **/bunsen/run/traces/threads/index.json** — Per-thread index: model, context, turn counts, stats (use list_threads to read)
- **/bunsen/run/traces/threads/<thread-id>.jsonl** — One conversation turn per line (use read_thread_turns to navigate)

## Workflow

1. Read the workspace diff to understand what the agent changed
2. If you need to understand the agent's reasoning, call list_threads first, then read_thread_turns on the relevant thread
3. Run any necessary commands to verify the work (tests, builds, etc.)
4. Read relevant source files for deeper review if needed
5. Submit your evaluation using the submit_score tool

${config.prompt ? `\n## Additional Instructions\n\n${config.prompt}` : ''}

Be thorough but efficient. Focus on evidence that directly relates to the criterion being evaluated.`;
}

/**
 * Build system prompt for visual scorer
 */
export function buildVisualScorerSystemPrompt(config: ScorerConfig): string {
  const scoreGuidance = formatAllowedScores(config.scores);

  return `You are an expert evaluator with visual capabilities for assessing UI/UX criteria.

## Your Task

Evaluate the following visual criterion:

**Criterion**: ${config.criterion}
**Description**: ${config.instructions}

## Scoring

${scoreGuidance}

All scores are normalized to 0-1 where:
- 0 = Complete failure / Does not meet visual requirements
- 0.5 = Partial success / Some visual elements correct
- 1 = Full success / Excellent visual implementation

## Available Tools

You have access to tools for:
- **screenshot**: Take a screenshot of a URL. Use for simple visual inspection.
- **run_playwright_script**: Execute Playwright JavaScript for browser interactions. **Use this when you need to interact with the page** (mouse movements, clicks, typing, hovering) or take multiple screenshots in sequence.
- **run_command**: Execute shell commands (including starting dev servers). Use run_in_background=true for servers or commands with large output.
- **read_file**: Read files or line ranges. Supports workspace files (relative paths), diffs (/bunsen/run/workspace/diff.patch), and logs (/bunsen/run/logs.txt). Use start_line=-N for last N lines. (For traces, prefer list_threads / read_thread_turns.)
- **list_files**: List directory contents.
- **list_threads**: List agent-under-test conversation threads with model, system prompt summary, and turn counts.
- **read_thread_turns**: Read a slice of turns from a thread (each turn is the new-message delta). Pass \`thread_id\`, optional \`start\`, optional \`end\`.

## Key Files

- **/bunsen/run/workspace/diff.patch** — Changes the agent made to the workspace
- **/bunsen/run/logs.txt** — Agent execution logs (stdout/stderr)
- **/bunsen/run/traces/threads/index.json** — Per-thread index (use list_threads)
- **/bunsen/run/traces/threads/<thread-id>.jsonl** — Per-thread turn bodies (use read_thread_turns)

## When to Use run_playwright_script

Use run_playwright_script instead of screenshot when you need to:
- Move the mouse to test hover effects or mouse-responsive visuals
- Click buttons or interact with UI elements
- Type text into input fields
- Take multiple screenshots at different states
- Test animations or transitions

Example for testing mouse interaction (pass this as the "code" parameter):

  await page.goto('http://localhost:5173');
  await page.waitForTimeout(1000);
  await screenshot();  // Initial state

  await page.mouse.move(100, 100);
  await page.waitForTimeout(500);
  await screenshot();  // After mouse move to top-left

  await page.mouse.move(640, 360);
  await page.waitForTimeout(500);
  await screenshot();  // After mouse move to center

## Workflow

1. Start any necessary servers (dev server, etc.) using run_command with run_in_background=true
2. Wait for server to be ready (check output file or use a short delay)
3. Take screenshots or run Playwright scripts to evaluate visual aspects
4. Compare screenshots if testing interactive behavior
5. Submit your evaluation using the submit_score tool

${config.prompt ? `\n## Additional Instructions\n\n${config.prompt}` : ''}

Focus on visual aspects: layout, spacing, colors, typography, responsiveness, and overall polish.`;
}

/**
 * Build system prompt for report scorer
 */
export function buildReportScorerSystemPrompt(config: ScorerConfig): string {
  // Report scorers don't have descriptions - the report format is standardized
  return `You are synthesizing evaluation results into a comprehensive report.

## Your Task

Create a detailed evaluation report based on the scores and summaries from other criteria.

**Criterion**: ${config.criterion}

## Available Information

You have access to:
- Scores and summaries from all dependent criteria
- The workspace diff showing what was changed
- Files in the workspace for additional context

## Report Requirements

Your report should:
1. Summarize overall performance
2. Highlight key strengths
3. Identify areas for improvement
4. Cite specific evidence from criterion evaluations
5. Provide actionable feedback

## Output

Use the submit_score tool with:
- \`score\`: null (reports don't have a score)
- \`summary\`: Brief summary of the report
- \`report\`: Full markdown report

${config.prompt ? `\n## Additional Instructions\n\n${config.prompt}` : ''}

Write in a constructive, helpful tone. Focus on actionable insights.`;
}

/**
 * Build initial user prompt with context
 */
export function buildInitialPrompt(
  config: ScorerConfig,
  context: {
    diff?: string;
    logs?: string;
    traces?: string;
  }
): string {
  const parts: string[] = [];

  parts.push(`Please evaluate the criterion: **${config.criterion}**\n`);

  // Add context in priority order (diff > logs > traces)
  if (context.diff) {
    parts.push('## Workspace Changes (Diff)\n');
    parts.push('```diff\n' + context.diff + '\n```\n');
  }

  if (context.logs) {
    parts.push('## Agent Execution Logs\n');
    parts.push('```\n' + context.logs + '\n```\n');
  }

  if (context.traces) {
    parts.push('## Agent Conversation Traces\n');
    parts.push(context.traces);
  }

  if (!context.diff && !context.logs && !context.traces) {
    parts.push('(No context available - workspace may not have been modified)\n');
  }

  return parts.join('\n');
}

/**
 * Build initial prompt for agentic scorers
 */
export function buildAgenticInitialPrompt(config: ScorerConfig): string {
  return `Please evaluate the criterion: **${config.criterion}**

Use the available tools to explore the workspace and verify the agent's work.
When you have gathered sufficient evidence, use the submit_score tool to submit your evaluation.`;
}

/**
 * Build initial prompt for report scorer with dependency scores
 */
export function buildReportInitialPrompt(
  dependencyScores: Record<string, { score: number | null; summary: string }>
): string {
  const parts: string[] = [];

  parts.push('## Evaluation Results to Synthesize\n');

  for (const [name, data] of Object.entries(dependencyScores)) {
    const scoreStr = data.score !== null ? data.score.toFixed(2) : 'N/A';
    parts.push(`### ${name}`);
    parts.push(`**Score**: ${scoreStr}`);
    parts.push(`**Summary**: ${data.summary}\n`);
  }

  parts.push('\nPlease synthesize these results into a comprehensive evaluation report.');
  parts.push('Use the available tools if you need additional context from the workspace.');

  return parts.join('\n');
}
