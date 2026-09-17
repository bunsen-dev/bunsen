/**
 * One runner, four shapes (DESIGN.md D4).
 *
 * `judge` is a single forced call over inlined evidence; `agent`,
 * `browser-agent` and `report` run a capped tool-calling loop that stops the
 * moment a verdict is **recorded** — not on a raw tool call, so a rejected
 * verdict feeds its error back and the model gets to fix it. If the loop ends
 * with no verdict, one forced call closes it out. If that also produces
 * nothing, the criterion errors: the scorer never synthesizes a score.
 */

import * as fs from 'node:fs';
import {
  APICallError,
  RetryError,
  ToolChoiceViolationError,
  generateText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type StepResult,
  type StopCondition,
  type ToolSet,
} from 'ai';
import type { ScorerConfig, ScorerOutput } from '@bunsen-dev/types';
import {
  MAX_OUTPUT_TOKENS,
  MAX_REPORT_OUTPUT_TOKENS,
  MAX_REPORT_SUMMARY_CHARS,
  MAX_STEPS,
  TOOL_RESULT_LOG_PREVIEW_CHARS,
  VERIFIERS_DIR,
  MAX_TOOL_RESULT_CHARS,
} from './config.js';
import { loadDiff, loadLogs, loadTaskPrompt } from './evidence.js';
import { formatThreadsForPrompt } from './traces.js';
import { systemPrompt, userPrompt, type PromptEvidence } from './prompts.js';
import {
  buildTools,
  createScorerContext,
  createScorerState,
  explorationToolNames,
  verdictToolName,
  type ScorerState,
} from './tools.js';
import { closeBrowser } from './browser-tools.js';

/** A criterion that could not be graded. The host records it as `status: 'error'`. */
export class ScorerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScorerError';
  }
}

export interface RunScorerOptions {
  /** The model to grade with. Built by `standalone.ts`; a mock in tests. */
  model: LanguageModel;
  /** One line of scorer stderr. Defaults to `console.error`. */
  log?: (line: string) => void;
}

const FORCE_SUBMIT_SCORE =
  'Submit now from what you have. If you could not get the evidence this criterion needs, do not guess: score it as unmet and say what was missing.';

const FORCE_SUBMIT_REPORT =
  'Submit the report now from what you have. If you could not get the evidence you needed, do not guess: say what was missing.';

/**
 * Shapes of provider credentials a tool result can plausibly contain (a scorer
 * that reads `agent-script.sh` sees the agent's exported keys). The host also
 * scrubs every secret value it knows before persisting the log; this is the
 * bundle's own defense for previews it prints.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI (also matches sk-proj-…)
  /AIza[0-9A-Za-z_-]{30,}/g, // Google
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, // Authorization headers
];

export function redactSecretPatterns(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

/**
 * Chars of transcript a forced verdict call may resend after the provider
 * rejected the full one as too long: four tool results' worth. Enough for the
 * model to recall what it last saw; small enough to fit any supported context.
 */
const FORCED_TRANSCRIPT_BUDGET_CHARS = 4 * MAX_TOOL_RESULT_CHARS;

function toolCallIds(message: ModelMessage): string[] {
  if (message.role !== 'assistant' || typeof message.content === 'string') return [];
  return message.content
    .filter((part): part is Extract<typeof part, { type: 'tool-call' }> => part.type === 'tool-call')
    .map((part) => part.toolCallId);
}

/**
 * The transcript a forced verdict call may safely resend.
 *
 * - A trailing assistant message whose tool calls were never answered is
 *   dropped: the SDK executes tools only when a step ends on `stop` or
 *   `tool-calls`, so after `length` / `content-filter` the last assistant turn
 *   has calls with no results, and a user message appended after it is
 *   rejected (`MissingToolResultsError`).
 * - After a context-window overflow the whole transcript is exactly what
 *   overflowed, so only its most recent messages (within `budgetChars`) are
 *   kept, cut at an assistant boundary so no tool result is orphaned.
 */
export function transcriptForForcedCall(
  transcript: readonly ModelMessage[],
  options: { overflowed: boolean; budgetChars?: number },
): { messages: ModelMessage[]; dropped: number } {
  const messages = [...transcript];
  while (messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last.role === 'assistant' && toolCallIds(last).length > 0) {
      messages.pop();
      continue;
    }
    break;
  }
  if (!options.overflowed) return { messages, dropped: transcript.length - messages.length };

  const budget = options.budgetChars ?? FORCED_TRANSCRIPT_BUDGET_CHARS;
  let chars = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    chars += JSON.stringify(messages[i]).length;
    if (chars > budget) break;
    start = i;
  }
  while (start < messages.length && messages[start].role !== 'assistant') start++;
  const kept = messages.slice(start);
  return { messages: kept, dropped: transcript.length - kept.length };
}

function preview(text: string): string {
  const flat = redactSecretPatterns(text).replace(/\s+/g, ' ').trim();
  return flat.length > TOOL_RESULT_LOG_PREVIEW_CHARS
    ? `${flat.slice(0, TOOL_RESULT_LOG_PREVIEW_CHARS)}…`
    : flat;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A provider-side "your prompt is too long" failure. It is not a bug in the
 * criterion, so it goes to the forced submit rather than erroring the run:
 * the model can still commit to a verdict from what it already read.
 */
function isContextWindowError(error: unknown): boolean {
  const target = RetryError.isInstance(error) ? (error.lastError ?? error) : error;
  if (!APICallError.isInstance(target)) return false;
  return /context (window|length)|maximum context|too many tokens|token limit|exceeds?.{0,20}tokens|prompt is too long/i.test(
    messageOf(target),
  );
}

function loadEvidence(config: ScorerConfig): PromptEvidence {
  const evidence: PromptEvidence = { taskPrompt: loadTaskPrompt(config.contextDir) };
  // Only the two types that cannot go and fetch evidence get it inlined.
  if (config.type !== 'judge' && config.type !== 'report') return evidence;
  for (const kind of config.evidence ?? ['diff']) {
    if (kind === 'diff') evidence.diff = loadDiff(config.contextDir);
    else if (kind === 'logs') evidence.logs = loadLogs(config.contextDir);
    else if (kind === 'traces') evidence.traces = formatThreadsForPrompt(config.contextDir);
  }
  return evidence;
}

/** The report's list-view summary: the first real paragraph, clipped. */
function reportSummary(report: string): string {
  const paragraphs = report
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const first = paragraphs.find((paragraph) => !paragraph.startsWith('#')) ?? paragraphs[0] ?? '';
  const flat = first.replace(/\s+/g, ' ').trim() || 'Evaluation report submitted.';
  return flat.length > MAX_REPORT_SUMMARY_CHARS
    ? `${flat.slice(0, MAX_REPORT_SUMMARY_CHARS - 1).trimEnd()}…`
    : flat;
}

function buildOutput(state: ScorerState): ScorerOutput {
  const verdict = state.verdict;
  if (verdict === null) throw new ScorerError('no verdict was recorded');
  const screenshots = state.screenshots.length > 0 ? { screenshots: state.screenshots } : {};
  if ('report' in verdict) {
    return { score: null, summary: reportSummary(verdict.report), report: verdict.report, ...screenshots };
  }
  return { score: verdict.score, summary: verdict.summary, ...screenshots };
}

/**
 * Grade one criterion (or write the run's report).
 *
 * Throws {@link ScorerError} when no verdict could be obtained; every other
 * failure (a provider outage, a malformed config) propagates as-is.
 */
export async function runScorer(config: ScorerConfig, options: RunScorerOptions): Promise<ScorerOutput> {
  const log = options.log ?? ((line: string) => console.error(line));
  const state = createScorerState();
  const ctx = createScorerContext(config, log);
  const tools = buildTools(config, state, ctx);
  const toolNames = explorationToolNames(tools);
  const verdictTool = verdictToolName(config.type);
  const maxOutputTokens = config.type === 'report' ? MAX_REPORT_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS;

  log(
    `[scorer] ${config.type} "${config.title}" (${config.id}) on ${config.model}; ` +
      `tools: ${toolNames.length > 0 ? toolNames.join(', ') : 'none'}`,
  );

  const instructions = systemPrompt(config);
  const initialMessages: ModelMessage[] = [
    {
      role: 'user',
      content: userPrompt(config, loadEvidence(config), {
        tools: toolNames,
        verifiersDir: fs.existsSync(VERIFIERS_DIR) ? VERIFIERS_DIR : undefined,
      }),
    },
  ];

  /** Every response message of every step, so the forced call sees the whole transcript. */
  const transcript: ModelMessage[] = [];

  const onStepFinish = (step: StepResult<ToolSet>): void => {
    transcript.push(...step.response.messages);
    const called = step.toolCalls.map((call) => call.toolName);
    log(`[scorer] step ${step.stepNumber + 1}: ${called.length > 0 ? called.join(', ') : 'no tool call'}`);
    if (step.text.trim()) log(`[scorer]   assistant: ${preview(step.text)}`);
    for (const part of step.content) {
      if (part.type === 'tool-result') {
        log(`[scorer]   ${part.toolName} → ${preview(asText(part.output))}`);
      } else if (part.type === 'tool-error') {
        log(`[scorer]   ${part.toolName} rejected: ${preview(messageOf(part.error))}`);
      }
    }
  };

  const logWarnings = (warnings: unknown): void => {
    if (Array.isArray(warnings) && warnings.length > 0) {
      for (const warning of warnings) log(`[scorer] provider warning: ${asText(warning)}`);
    }
  };

  /** State-based, so a rejected verdict keeps the loop alive for a repair step. */
  const verdictRecorded: StopCondition<ToolSet> = () => state.verdict !== null;
  /** Set when the provider rejected the full transcript, so the forced call sends less. */
  let overflowed = false;

  try {
    try {
      const result =
        config.type === 'judge'
          ? await generateText({
              model: options.model,
              instructions,
              messages: initialMessages,
              tools,
              toolChoice: { type: 'tool', toolName: verdictTool },
              stopWhen: stepCountIs(1),
              maxOutputTokens,
              onStepFinish,
            })
          : await generateText({
              model: options.model,
              instructions,
              messages: initialMessages,
              tools,
              stopWhen: [stepCountIs(MAX_STEPS), verdictRecorded],
              maxOutputTokens,
              onStepFinish,
            });
      logWarnings(result.warnings);
    } catch (error) {
      if (isContextWindowError(error)) {
        overflowed = true;
        if (transcript.length === 0) {
          throw new ScorerError(
            `the evidence alone exceeds the model's context window (${messageOf(error)}); ` +
              'reduce `evidence` or choose a model with a larger context',
          );
        }
        log(`[scorer] the context window filled up (${messageOf(error)}); forcing a verdict from a shortened transcript.`);
      } else if (ToolChoiceViolationError.isInstance(error)) {
        log(`[scorer] the model did not call ${verdictTool} (${messageOf(error)}); forcing a verdict.`);
      } else {
        throw error;
      }
    }

    if (state.verdict === null) {
      log(`[scorer] no verdict recorded; forcing ${verdictTool}.`);
      const resend = transcriptForForcedCall(transcript, { overflowed });
      if (resend.dropped > 0) {
        log(`[scorer] resending ${resend.messages.length} of ${transcript.length} transcript messages (${resend.dropped} dropped).`);
      }
      const forceText = config.type === 'report' ? FORCE_SUBMIT_REPORT : FORCE_SUBMIT_SCORE;
      try {
        const forced = await generateText({
          model: options.model,
          instructions,
          messages: [
            ...initialMessages,
            ...resend.messages,
            {
              role: 'user',
              content:
                resend.dropped > 0
                  ? `${forceText} (Earlier exploration — ${resend.dropped} messages — was dropped to fit the context window.)`
                  : forceText,
            },
          ],
          tools,
          toolChoice: { type: 'tool', toolName: verdictTool },
          stopWhen: stepCountIs(1),
          maxOutputTokens,
          onStepFinish,
        });
        logWarnings(forced.warnings);
      } catch (error) {
        throw new ScorerError(
          `no verdict: the forced ${verdictTool} call failed: ${messageOf(error)}`,
        );
      }
      if (state.verdict === null) {
        throw new ScorerError(
          `no verdict: ${verdictTool} was not called, or its input was rejected, on the forced call`,
        );
      }
    }

    return buildOutput(state);
  } finally {
    await closeBrowser(state);
  }
}
