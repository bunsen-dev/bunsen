#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Standalone entry point for the supervisor agent.
 *
 * The supervisor monitors an agent running in a tmux session and handles
 * interactive prompts automatically using an LLM for detection and response.
 *
 * Uses a conversational agent pattern: maintains a rolling buffer of recent
 * interactions so the LLM can see what keys it previously sent and whether
 * they had any effect on the terminal. This enables self-correction when
 * a response doesn't work (e.g., typing "y" at an arrow-key menu).
 *
 * The LLM communicates via tool_use with three tools:
 *   - send_keys: send keystrokes to the terminal
 *   - not_waiting: report that the agent is actively working
 *   - agent_finished: report that the agent has completed its task
 *
 * When agent_finished is called twice consecutively, the supervisor enters
 * "exit mode" and prompts the LLM to send exit commands until the agent
 * process actually terminates (marker file appears).
 *
 * Environment variables:
 *   BUNSEN_ANTHROPIC_API_KEY - API key for Claude (required)
 *   BUNSEN_TASK_DESCRIPTION - Description of what the agent is doing (required)
 *   BUNSEN_LOG_FILE - Path to the log file being written by tmux pipe-pane (default: /bunsen/run/logs.txt)
 *   BUNSEN_OUTPUT_FILE - Path to write supervisor.json (default: /bunsen/run/supervisor.json)
 *   BUNSEN_TMUX_SESSION - tmux session name (default: agent)
 *   BUNSEN_STALL_TIMEOUT - Milliseconds to wait before checking for prompts (default: 5000)
 *   BUNSEN_BACKOFF_PERIOD - Milliseconds to wait after no prompt detected (default: 3000)
 *   BUNSEN_MAX_BACKOFF - Maximum backoff period in milliseconds (default: 15000)
 *   BUNSEN_MAX_CHECK_INTERVAL - Maximum time between forced LLM checks in milliseconds, even if output is active (default: 30000)
 *   BUNSEN_MAX_TERMINAL_CHARS - Maximum characters to include from terminal state (default: 3000)
 *   BUNSEN_MARKER_FILE - Path to marker file that signals agent completion (default: /bunsen/run/agent-complete.marker)
 *
 * The supervisor exits when:
 *   1. The marker file is detected (agent completed)
 *   2. SIGTERM is received
 *   3. An unrecoverable error occurs
 */

import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient } from '../common/anthropic-client.js';
import type {
  SupervisorInteraction,
  SupervisorLog,
} from '@bunsen-dev/types';

// =============================================================================
// Tool Definitions
// =============================================================================

const SUPERVISOR_TOOLS: Anthropic.Tool[] = [
  {
    name: 'send_keys',
    description:
      'Send keystrokes to the terminal where the agent is running. Use this when the agent is waiting for input. ' +
      'For text input, send the literal text. For special keys, use: ENTER, TAB, ESCAPE, UP, DOWN, LEFT, RIGHT, CTRL_C. ' +
      'Separate multiple keys with spaces (e.g., "DOWN DOWN ENTER" or "/exit ENTER").',
    input_schema: {
      type: 'object' as const,
      properties: {
        keys: {
          type: 'string',
          description:
            'The keys to send, space-separated. Examples: "y", "yes", "ENTER", "DOWN ENTER", "/exit ENTER", "UP ENTER"',
        },
      },
      required: ['keys'],
    },
  },
  {
    name: 'not_waiting',
    description:
      'Report that the agent is actively working and NOT waiting for input. ' +
      'Use this when you see: active output being generated, commands executing, loading indicators, ' +
      'progress bars, or recent command output without a prompt.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'agent_finished',
    description:
      'Report that the agent has completed its task and is idle, waiting for the next command. ' +
      'Signs: a summary of completed work followed by a blank input prompt (e.g., ❯). ' +
      'Two consecutive agent_finished calls will trigger exit mode, where you will be asked to send exit commands.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

// =============================================================================
// Configuration
// =============================================================================

interface SupervisorConfig {
  apiKey: string;
  taskDescription: string;
  logFile: string;
  outputFile: string;
  tmuxSession: string;
  stallTimeout: number;
  backoffPeriod: number;
  maxBackoff: number;
  maxCheckInterval: number;
  markerFile: string;
  maxTerminalChars: number;
}

function loadConfig(): SupervisorConfig {
  const apiKey = process.env.BUNSEN_ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Error: BUNSEN_ANTHROPIC_API_KEY environment variable is required');
    process.exit(1);
  }

  const taskDescription = process.env.BUNSEN_TASK_DESCRIPTION;
  if (!taskDescription) {
    console.error('Error: BUNSEN_TASK_DESCRIPTION environment variable is required');
    process.exit(1);
  }

  return {
    apiKey,
    taskDescription,
    logFile: process.env.BUNSEN_LOG_FILE || '/bunsen/run/logs.txt',
    outputFile: process.env.BUNSEN_OUTPUT_FILE || '/bunsen/run/supervisor.json',
    tmuxSession: process.env.BUNSEN_TMUX_SESSION || 'agent',
    stallTimeout: parseInt(process.env.BUNSEN_STALL_TIMEOUT || '5000', 10),
    backoffPeriod: parseInt(process.env.BUNSEN_BACKOFF_PERIOD || '3000', 10),
    maxBackoff: parseInt(process.env.BUNSEN_MAX_BACKOFF || '15000', 10),
    maxCheckInterval: parseInt(process.env.BUNSEN_MAX_CHECK_INTERVAL || '30000', 10),
    markerFile: process.env.BUNSEN_MARKER_FILE || '/bunsen/run/agent-complete.marker',
    maxTerminalChars: parseInt(process.env.BUNSEN_MAX_TERMINAL_CHARS || '3000', 10),
  };
}

// =============================================================================
// tmux Interaction
// =============================================================================

/**
 * Capture the current terminal state from tmux.
 * Uses -S - -E - to capture full scrollback.
 */
function captureTmuxPane(session: string): string {
  const cmd = `tmux capture-pane -t ${session} -p -S - -E -`;
  try {
    const result = childProcess.execSync(cmd, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const stripped = stripAnsiCodes(result);
    console.error(`[supervisor] Captured terminal: ${result.length} raw chars -> ${stripped.length} stripped`);
    return stripped;
  } catch (error) {
    console.error('[supervisor] Error capturing tmux pane:', error);
    return '';
  }
}

/**
 * Strip ANSI escape codes from text for cleaner LLM processing.
 */
function stripAnsiCodes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?<>=]*[a-zA-Z]/g, '') // CSI sequences (DEC private modes, mouse reports, etc.)
             .replace(/\x1b\][^\x07]*\x07/g, '')        // OSC sequences (title bar, etc.)
             .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')  // DCS, SOS, PM, APC sequences
             .replace(/\x1b[()#][^\n]*/g, '')            // Charset/line attribute sequences
             .replace(/\x1b[a-zA-Z]/g, '')               // Two-byte escape sequences
             .replace(/[\x00-\x09\x0b-\x1f]/g, '');     // Other control chars except newline
}

/**
 * Send keys to the tmux session.
 */
function sendKeysToTmux(session: string, keys: string): void {
  console.error(`[supervisor] Sending keys: "${keys}"`);

  try {
    const tmuxKeys = keys
      .replace(/ENTER/g, 'Enter')
      .replace(/TAB/g, 'Tab')
      .replace(/ESCAPE/g, 'Escape')
      .replace(/UP/g, 'Up')
      .replace(/DOWN/g, 'Down')
      .replace(/LEFT/g, 'Left')
      .replace(/RIGHT/g, 'Right')
      .replace(/CTRL_C/g, 'C-c');

    const keyParts = tmuxKeys.split(' ').filter((k) => k.length > 0);

    for (const key of keyParts) {
      const specialKeys = ['Enter', 'Tab', 'Escape', 'Up', 'Down', 'Left', 'Right', 'C-c'];

      // Add delay before Enter so viewers can see the selection in recordings
      if (key === 'Enter') {
        console.error(`[supervisor] Pausing 500ms before Enter for visibility...`);
        childProcess.execSync('sleep 0.5', { timeout: 5000 });
      }

      if (specialKeys.includes(key)) {
        const cmd = `tmux send-keys -t ${session} ${key}`;
        childProcess.execSync(cmd, { timeout: 5000 });
        console.error(`[supervisor] Sent special key: ${key}`);
      } else {
        const cmd = `tmux send-keys -t ${session} -l '${key.replace(/'/g, "'\\''")}'`;
        childProcess.execSync(cmd, { timeout: 5000 });
        console.error(`[supervisor] Sent literal: "${key}"`);
      }
    }
  } catch (error) {
    console.error('[supervisor] Error sending keys to tmux:', error);
    throw error;
  }
}

function isAgentComplete(markerFile: string): boolean {
  return fs.existsSync(markerFile);
}

function getLogFileSize(logFile: string): number {
  try {
    const stat = fs.statSync(logFile);
    return stat.size;
  } catch {
    return 0;
  }
}

// =============================================================================
// LLM Conversation Management
// =============================================================================

type Message = Anthropic.Messages.MessageParam;

const MAX_HISTORY_MESSAGES = 8; // 4 user/assistant pairs

const SYSTEM_PROMPT = `You are a supervisor agent monitoring a CLI agent working in a terminal during an AUTOMATED EXPERIMENT.

Your job is to detect if the agent is waiting for user input and, if so, provide the appropriate response using the send_keys tool. You have three tools available — always call exactly one per response.

CRITICAL CONTEXT: This is an automated experiment environment. The agent being monitored is an AI coding assistant (like Claude Code) running a task. You should:
- ALWAYS approve/confirm actions when asked (the experiment requires the agent to proceed)
- ALWAYS say "yes" to permission requests, confirmations, or "proceed?" prompts
- ALWAYS allow the agent to make changes, run commands, install packages, etc.
- When multiple options are presented, ALWAYS choose the agent's recommended/default option (look for indicators like "(recommended)", asterisks, or the first/highlighted option)
- Your job is to UNBLOCK the agent, not to influence its decisions - defer to the agent's judgment
- Let the agent do its work without blocking it

SPECIAL CASE - Login/Authentication menus:
- If you see a login method selection (e.g., "Claude account", "Anthropic Console account", "3rd-party platform"), select "Anthropic Console account" - this uses the API key from the environment
- These menus typically use ARROW KEYS to navigate (not number keys) - look for a > or ❯ indicator showing current selection
- To select "Anthropic Console account" when "Claude account" is highlighted: use send_keys with keys "DOWN ENTER"
- If asked to confirm using API billing, confirm yes

SPECIAL CASE - API key detection:
- If you see "Do you want to use this API key?" with options like "Yes" and "No (recommended)", ALWAYS select "Yes"
- The experiment needs the API key to authenticate. Even though "No" may be marked as recommended, we must select "Yes"
- If ❯ is on "No", use send_keys with keys "UP ENTER" to move up to "Yes" and select it

SPECIAL CASE - Edit/command permission prompts:
- Agents like Claude Code show prompts like "Do you want to make this edit?" or "Do you want to run this command?" with arrow-key menus
- These are NOT text input prompts. Typing "y" does nothing. You MUST use arrow keys and ENTER.
- ALWAYS select the MOST PERMISSIVE option available to minimize future prompts. Examples:
  - "Yes, allow all edits during this session" over plain "Yes"
  - "Yes, and don't ask again for [command] commands in [path]" over plain "Yes"
  - "Yes, and always allow [tool]" over plain "Yes"
- The most permissive option is typically the 2nd item in the list. Use send_keys with keys "DOWN ENTER" to select it.
- When you see options like:
  ❯ 1. Yes
    2. Yes, allow all edits during this session (shift+tab)
    3. No
  Select option 2 with send_keys keys "DOWN ENTER"
- This avoids being prompted repeatedly. We want to approve all actions with maximum permission.

SPECIAL CASE - Agent finished / waiting for next prompt:
- If the agent has completed its task and is showing an idle prompt waiting for the next message/command, the agent is DONE
- Signs: a summary of completed work (e.g., "tests now pass", "bug has been fixed"), followed by a blank input prompt
- Call the agent_finished tool to signal this. After two consecutive agent_finished calls, you will enter exit mode and be asked to send exit commands.

SPECIAL CASE - Arrow-based selection menus (general):
- Menus with > or ❯ indicators use arrow keys to navigate, then Enter to select
- CRITICAL: First check which option the ❯ is currently on. If it's already on the right option, just use send_keys with keys "ENTER"
- Only use DOWN if you need to move to a DIFFERENT option from where ❯ currently is
- Count how many DOWN presses needed from the current ❯ position to reach the desired option
- For theme/style selection menus, just press ENTER to accept the default
- For trust/safety confirmations ("trust this folder", etc.), the correct answer is always the affirmative option
- NEVER type literal text like "y" or "yes" at arrow-key menus - it won't work. Use ENTER or DOWN ENTER etc.

SELF-CORRECTION:
- If you previously sent keys and the terminal hasn't changed (you'll see "IMPORTANT: The terminal has NOT changed since your last action"), your previous response DID NOT WORK
- Try a completely different approach. Common mistakes and fixes:
  - Sent "y" or text at an arrow-key menu → try send_keys with keys "ENTER" or "DOWN ENTER" instead
  - Sent DOWN ENTER but menu didn't move → try send_keys with keys "ENTER" (maybe ❯ was already on the right option)
  - Sent a number but nothing happened → this is an arrow-key menu, use DOWN/UP + ENTER
- Do NOT repeat the same keys that already failed

Signs that the agent is waiting for input:
- A prompt like [y/n], [Y/n], (yes/no), y/N
- Permission requests like "Allow?" or "Proceed?" or "Continue?"
- A selection menu with > indicator or numbered options
- "Press Enter to continue" or similar
- A question ending with ? followed by a cursor
- The agent explicitly asking for confirmation or choice
- A prompt showing options to select from

Signs that the agent is NOT waiting (still working):
- Active output is being generated
- A command is visibly executing
- Loading indicators or progress bars
- The terminal shows recent command output without a prompt

IMPORTANT - Focus on the BOTTOM of the terminal:
- Prompts and selection menus always appear at the bottom of the terminal output
- There may be a long history of errors, build output, or command results ABOVE the prompt — this does not mean the agent is still working
- Always check the last few lines of the terminal carefully for any prompt indicators, regardless of what appears above them
- Spinner animations or progress text can appear alongside prompts — the spinner is a UI artifact, not proof of active work

IMPORTANT - When uncertain:
- If you see ANY sign of a prompt or selection menu at the bottom of the terminal, respond to it
- If you're unsure whether the agent is finished or waiting for input, try to help it proceed — it's better to keep the agent moving than to leave it stuck or exit prematurely
- Only call not_waiting when you're confident the agent is actively working with no prompt visible
- Only call agent_finished when you're confident the agent has completed its entire task and is idle

Examples:
- "[y/n]" prompt → send_keys with keys "y"
- "[Y/n]" prompt (capital Y = default yes) → send_keys with keys "y" (always be explicit)
- "Allow this action? [y/n]" → send_keys with keys "y"
- "Proceed with changes? (yes/no)" → send_keys with keys "yes"
- "❯ Yes, I trust this folder" / "No, exit" → ❯ is ALREADY on Yes → send_keys with keys "ENTER"
- "❯ Claude account" / "Anthropic Console account" → ❯ is on wrong option → send_keys with keys "DOWN ENTER"
- "Do you want to use this API key?" with "Yes" / "❯ No (recommended)" → we need Yes, ❯ is on No → send_keys with keys "UP ENTER"
- "Do you want to make this edit?" with "❯ 1. Yes" / "2. Yes, allow all edits" / "3. No" → select allow all → send_keys with keys "DOWN ENTER"
- Arrow-based menu with ❯ already on the desired option → send_keys with keys "ENTER"
- Arrow-based menu with ❯ NOT on desired option → send_keys with keys "DOWN ENTER" (or "DOWN DOWN ENTER", "UP ENTER", etc.)
- Theme/style selection menu → send_keys with keys "ENTER" (accept default)
- "Press Enter to continue" → send_keys with keys "ENTER"
- Agent is outputting build logs → call not_waiting
- WRONG: "Do you want to make this edit?" → send_keys with keys "y" (THIS DOES NOT WORK - it's an arrow menu, not text input!)
- CORRECT: "Do you want to make this edit?" → send_keys with keys "DOWN ENTER" (to select "allow all edits")
- Agent shows summary of completed work then idle prompt → call agent_finished
- You previously sent "y" and terminal didn't change → try send_keys with keys "ENTER" (it's probably an arrow menu)`;

/**
 * Truncate terminal state to the last N characters.
 * Prompts always appear at the bottom, so keeping the tail is safe.
 */
function truncateTerminalState(terminalState: string, maxChars: number): string {
  if (terminalState.length <= maxChars) {
    return terminalState;
  }
  // Keep the last maxChars characters, adding a truncation indicator
  const truncated = terminalState.slice(-maxChars);
  return `[...truncated ${terminalState.length - maxChars} chars...]\n${truncated}`;
}

/**
 * Build the user message for the current terminal check.
 * Includes change detection relative to the previous terminal state.
 */
function buildUserMessage(
  terminalState: string,
  taskDescription: string,
  previousTerminalState: string | null,
  previousKeysSent: string | null,
  isExitMode: boolean = false,
  maxTerminalChars: number = 10000,
): string {
  // Truncate terminal state to reduce token usage - prompts are always at the bottom
  const truncatedTerminal = truncateTerminalState(terminalState, maxTerminalChars);

  let message = `Current terminal state:
---
${truncatedTerminal}
---

Task context: ${taskDescription}
`;

  if (previousTerminalState) {
    const changed = terminalState !== previousTerminalState;
    if (!changed && previousKeysSent) {
      // Keys were sent but terminal didn't change — the action failed
      message += `\nIMPORTANT: The terminal has NOT changed since your last action ("${previousKeysSent}"). Your previous response did NOT work. Try a completely different approach.`;
    } else if (!changed && !previousKeysSent) {
      // No keys sent and terminal is identical — nudge toward agent_finished
      message += `\nNOTE: The terminal is IDENTICAL to the previous check. No new output has appeared. If the agent has completed its task and no prompt is visible, call agent_finished.`;
    } else if (changed && previousKeysSent) {
      // Keys were sent and terminal changed — check what happened
      message += `\nI sent the keys you suggested ("${previousKeysSent}") and the terminal has changed. Check if the agent is now waiting for more input or if it's working.`;
    }
    // changed && !previousKeysSent: terminal changed on its own (agent produced output), no extra context needed
  }

  if (isExitMode) {
    message += '\n\nEXIT MODE: The agent has finished its task. Send the appropriate exit command to terminate the agent so the experiment can complete. If your previous exit attempt didn\'t work, try a different approach (e.g., different command, CTRL_C first, etc.).';
  } else {
    message += '\n\nIs the agent waiting for input? If yes, what keys should we send?';
  }

  return message;
}

/**
 * Trim the message history to keep only the most recent messages.
 * Preserves the first user message (which has the task context) if within budget,
 * otherwise just keeps the rolling window.
 */
function trimHistory(messages: Message[]): Message[] {
  if (messages.length <= MAX_HISTORY_MESSAGES) {
    return messages;
  }
  // Keep the last MAX_HISTORY_MESSAGES messages
  // Ensure we start on a user message (messages alternate user/assistant)
  const trimmed = messages.slice(-MAX_HISTORY_MESSAGES);
  // If the first message is an assistant message, drop it so we start with user
  if (trimmed.length > 0 && trimmed[0].role === 'assistant') {
    trimmed.shift();
  }
  // If the first user message has an orphaned tool_result block (from trimming away
  // the preceding assistant tool_use), strip it and keep only text blocks
  if (trimmed.length > 0 && trimmed[0].role === 'user' && Array.isArray(trimmed[0].content)) {
    const content = trimmed[0].content as Anthropic.Messages.ContentBlockParam[];
    const nonToolResult = content.filter(
      (block) => (block as { type: string }).type !== 'tool_result'
    );
    if (nonToolResult.length > 0 && nonToolResult.length < content.length) {
      trimmed[0] = { role: 'user', content: nonToolResult };
    }
  }
  return trimmed;
}

// =============================================================================
// LLM Check (Tool Use)
// =============================================================================

type CheckResult =
  | { action: 'send_keys'; keys: string; toolUseId: string }
  | { action: 'not_waiting'; toolUseId: string }
  | { action: 'agent_finished'; toolUseId: string };

/**
 * Call the LLM with the full conversation history using tool_use.
 * The LLM must call exactly one of: send_keys, not_waiting, or agent_finished.
 */
async function checkForPrompt(
  anthropic: Anthropic,
  messages: Message[],
): Promise<CheckResult> {
  console.error(`[supervisor] Calling LLM (claude-haiku-4-5) with ${messages.length} messages...`);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 300,
    temperature: 0,
    system: SYSTEM_PROMPT,
    tools: SUPERVISOR_TOOLS,
    tool_choice: { type: 'any' },
    messages,
  });

  // With tool_choice: 'any', the response always contains a tool_use block
  const toolUse = response.content.find(
    (block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use'
  );

  if (!toolUse) {
    // Should not happen with tool_choice: 'any', but handle defensively
    console.error('[supervisor] No tool_use in response, treating as not_waiting');
    return { action: 'not_waiting', toolUseId: 'fallback' };
  }

  console.error(`[supervisor] LLM called tool: ${toolUse.name}(${JSON.stringify(toolUse.input)})`);

  switch (toolUse.name) {
    case 'send_keys': {
      const input = toolUse.input as { keys: string };
      return { action: 'send_keys', keys: input.keys, toolUseId: toolUse.id };
    }
    case 'not_waiting':
      return { action: 'not_waiting', toolUseId: toolUse.id };
    case 'agent_finished':
      return { action: 'agent_finished', toolUseId: toolUse.id };
    default:
      console.error(`[supervisor] Unknown tool: ${toolUse.name}, treating as not_waiting`);
      return { action: 'not_waiting', toolUseId: toolUse.id };
  }
}

// =============================================================================
// Main Supervisor Loop
// =============================================================================

async function runSupervisor(config: SupervisorConfig): Promise<void> {
  const anthropic = createAnthropicClient(config.apiKey);

  const log: SupervisorLog = {
    interactions: [],
    totalDetections: 0,
    totalInteractions: 0,
    startTime: new Date().toISOString(),
  };

  // Conversation history for the LLM agent
  let messages: Message[] = [];
  let previousTerminalState: string | null = null;
  let previousKeysSent: string | null = null;

  // Exit mode state
  let consecutiveFinished = 0;
  let exitMode = false;

  // Tool use tracking for message history pairing
  let lastToolUseId: string | null = null;
  let lastToolResultContent: string | null = null;

  console.error('[supervisor] Starting supervisor agent...');
  console.error(`[supervisor] Monitoring tmux session: ${config.tmuxSession}`);
  console.error(`[supervisor] Stall timeout: ${config.stallTimeout}ms`);
  console.error(`[supervisor] Max check interval: ${config.maxCheckInterval}ms`);
  console.error(`[supervisor] Max terminal chars: ${config.maxTerminalChars}`);
  console.error(`[supervisor] Log file: ${config.logFile}`);
  console.error(`[supervisor] Max conversation history: ${MAX_HISTORY_MESSAGES} messages`);

  let lastLogSize = getLogFileSize(config.logFile);
  let lastOutputTime = Date.now();
  let lastCheckTime = 0;
  let currentBackoff = config.backoffPeriod;

  console.error(`[supervisor] Entering main monitoring loop...`);

  let loopCount = 0;
  while (true) {
    loopCount++;

    // Check if agent completed
    if (isAgentComplete(config.markerFile)) {
      console.error('[supervisor] Agent completed (marker file detected)');
      break;
    }

    // Check for new output (log file size changed)
    const currentLogSize = getLogFileSize(config.logFile);
    if (currentLogSize > lastLogSize) {
      if (currentLogSize - lastLogSize > 100) {
        console.error(`[supervisor] Log file grew: ${lastLogSize} -> ${currentLogSize} bytes (+${currentLogSize - lastLogSize})`);
      }
      lastLogSize = currentLogSize;
      lastOutputTime = Date.now();
      currentBackoff = config.backoffPeriod;
    }

    // Check if output has stalled or if it's time for a forced periodic check
    const timeSinceOutput = Date.now() - lastOutputTime;
    const timeSinceLastCheck = Date.now() - lastCheckTime;
    const forceCheck = lastCheckTime > 0 && timeSinceLastCheck >= config.maxCheckInterval;

    if (timeSinceOutput >= config.stallTimeout || forceCheck || exitMode) {
      if (exitMode) {
        console.error(`[supervisor] ===== EXIT MODE CHECK (loop ${loopCount}) =====`);
      } else if (forceCheck && timeSinceOutput < config.stallTimeout) {
        console.error(`[supervisor] ===== FORCED PERIODIC CHECK (loop ${loopCount}) =====`);
        console.error(`[supervisor] Output active but ${timeSinceLastCheck}ms since last check (max ${config.maxCheckInterval}ms), checking for prompt...`);
      } else {
        console.error(`[supervisor] ===== STALL DETECTED (loop ${loopCount}) =====`);
        console.error(`[supervisor] Output stalled for ${timeSinceOutput}ms, checking for prompt...`);
      }

      const terminalState = captureTmuxPane(config.tmuxSession);
      if (!terminalState) {
        console.error('[supervisor] Failed to capture terminal state');
        await sleep(1000);
        continue;
      }

      lastCheckTime = Date.now();

      // Log last 500 chars for debugging
      console.error(`[supervisor] Terminal state (${terminalState.length} chars, last 500):`);
      console.error(terminalState.slice(-500));

      const interaction: SupervisorInteraction = {
        timestamp: new Date().toISOString(),
        terminalState: terminalState.slice(-2000),
        detected: false,
      };

      try {
        // Build user message with change detection
        const userMessageText = buildUserMessage(
          terminalState,
          config.taskDescription,
          previousTerminalState,
          previousKeysSent,
          exitMode,
          config.maxTerminalChars,
        );

        // Build the user message, combining tool_result from previous call if needed
        if (lastToolUseId && lastToolResultContent) {
          messages.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: lastToolUseId,
                content: lastToolResultContent,
              } as Anthropic.Messages.ToolResultBlockParam,
              { type: 'text', text: userMessageText } as Anthropic.Messages.TextBlockParam,
            ],
          });
        } else {
          // First check — no previous tool_result to pair
          messages.push({ role: 'user', content: userMessageText });
        }
        messages = trimHistory(messages);

        const result = await checkForPrompt(anthropic, messages);
        log.totalInteractions++;

        // Add the assistant's tool_use response to history
        messages.push({
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: result.toolUseId,
              name: result.action === 'send_keys' ? 'send_keys' : result.action,
              input: result.action === 'send_keys' ? { keys: result.keys } : {},
            } as Anthropic.Messages.ToolUseBlockParam,
          ],
        });

        switch (result.action) {
          case 'send_keys': {
            const keys = result.keys;
            console.error(`[supervisor] Prompt detected, sending keys: "${keys}"`);
            interaction.detected = true;
            interaction.response = keys;

            try {
              sendKeysToTmux(config.tmuxSession, keys);
              interaction.keysSent = keys;
              log.totalDetections++;

              previousTerminalState = terminalState;
              previousKeysSent = keys;
              lastOutputTime = Date.now();
              currentBackoff = config.backoffPeriod;
            } catch (sendError) {
              interaction.error = `Failed to send keys: ${sendError instanceof Error ? sendError.message : String(sendError)}`;
              console.error(`[supervisor] ${interaction.error}`);
            }

            lastToolUseId = result.toolUseId;
            lastToolResultContent = 'Keys sent to terminal.';
            consecutiveFinished = 0;
            break;
          }

          case 'not_waiting': {
            console.error('[supervisor] Agent not waiting, backing off...');
            previousKeysSent = null;
            // Keep previousTerminalState so next check can detect unchanged terminal
            // and nudge the LLM toward agent_finished if nothing has changed
            previousTerminalState = terminalState;
            currentBackoff = Math.min(currentBackoff * 1.5, config.maxBackoff);

            lastToolUseId = result.toolUseId;
            lastToolResultContent = 'Acknowledged. Will check again later.';
            consecutiveFinished = 0;
            break;
          }

          case 'agent_finished': {
            consecutiveFinished++;
            console.error(`[supervisor] Agent finished signal (${consecutiveFinished}/2 confirmations)`);

            if (consecutiveFinished >= 2 && !exitMode) {
              exitMode = true;
              console.error('[supervisor] Entering exit mode — will prompt for exit commands');
              lastToolResultContent = 'Confirmed. Entering exit mode — please send the appropriate exit command to terminate the agent.';
              currentBackoff = config.backoffPeriod;
            } else if (exitMode) {
              lastToolResultContent = 'Still in exit mode. The agent process has not exited yet. Please send the exit command to terminate it.';
              currentBackoff = config.backoffPeriod;
            } else {
              lastToolResultContent = `Acknowledged. (${consecutiveFinished}/2 confirmations needed before exit mode)`;
              currentBackoff = Math.min(currentBackoff * 1.5, config.maxBackoff);
            }

            previousKeysSent = null;
            // Keep previousTerminalState for change detection on next check
            previousTerminalState = terminalState;
            lastToolUseId = result.toolUseId;
            break;
          }
        }
      } catch (checkError) {
        interaction.error = `LLM check failed: ${checkError instanceof Error ? checkError.message : String(checkError)}`;
        console.error(`[supervisor] ${interaction.error}`);
        // Reset tool tracking on error so next message is text-only
        lastToolUseId = null;
        lastToolResultContent = null;
      }

      log.interactions.push(interaction);
      fs.writeFileSync(config.outputFile, JSON.stringify(log, null, 2));

      console.error(`[supervisor] Conversation history: ${messages.length} messages`);
      if (exitMode) {
        console.error(`[supervisor] Exit mode active, waiting ${currentBackoff}ms before next check...`);
      } else {
        console.error(`[supervisor] Waiting ${currentBackoff}ms before next check...`);
      }
      await sleep(currentBackoff);
      console.error(`[supervisor] ===== END CHECK =====`);
    } else {
      if (loopCount % 20 === 0) {
        console.error(`[supervisor] Loop ${loopCount}: waiting for stall (${timeSinceOutput}ms < ${config.stallTimeout}ms)`);
      }
      await sleep(500);
    }
  }

  // Save final supervisor log
  log.endTime = new Date().toISOString();
  fs.writeFileSync(config.outputFile, JSON.stringify(log, null, 2));
  console.error(`[supervisor] Saved log to ${config.outputFile}`);
  console.error(
    `[supervisor] Total interactions: ${log.totalInteractions}, detections: ${log.totalDetections}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Signal Handling
// =============================================================================

let shuttingDown = false;

function handleShutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error('[supervisor] Received shutdown signal');
  process.exit(0);
}

process.on('SIGTERM', handleShutdown);
process.on('SIGINT', handleShutdown);

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const config = loadConfig();

  try {
    await runSupervisor(config);
  } catch (error) {
    console.error('[supervisor] Fatal error:', error);
    process.exit(1);
  }
}

main();
