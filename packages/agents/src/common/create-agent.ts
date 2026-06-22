// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Simplified agent creation for Anthropic models.
 *
 * Message history is kept as native `Anthropic.MessageParam[]` and tools as
 * native `Anthropic.Tool` — the loop talks to `@anthropic-ai/sdk` directly with
 * no intermediate message format.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient } from './anthropic-client.js';
import type { ToolWithFunc } from './tool.js';

export type { ToolWithFunc };

export type CreateAgentParams = {
  model: string;
  tools: ToolWithFunc[];
  messages?: Anthropic.MessageParam[];
  temperature?: number;
  system?: string;
  apiKey?: string;
};

/**
 * Creates an agent that works with Anthropic models.
 */
export const createAgent = ({
  model: defaultModel,
  tools: defaultTools,
  messages: initialMessages = [],
  temperature: defaultTemperature = 0.2,
  system: defaultSystem,
  apiKey,
}: CreateAgentParams) => {
  const anthropic = createAnthropicClient(apiKey || process.env.ANTHROPIC_API_KEY || '');

  let messageHistory: Anthropic.MessageParam[] = [...initialMessages];

  /**
   * Run tools in a loop until the model returns a response without tool calls.
   */
  const runTools = async (
    messages: Anthropic.MessageParam[] = [],
    {
      tools,
      temperature,
      system,
    }: {
      tools?: ToolWithFunc[];
      temperature?: number;
      system?: string;
    } = {}
  ): Promise<string | null> => {
    // Add new messages to history
    if (messages.length > 0) {
      messageHistory.push(...messages);
    }

    const toolsForRun = tools ?? defaultTools;
    const toolDefinitions = toolsForRun.map((t) => t.definition);
    const systemForRun = system ?? defaultSystem;
    const tempForRun = temperature ?? defaultTemperature;

    let isDone = false;
    let finalContent: string | null = null;

    while (!isDone) {
      const response = await runAnthropicCompletion({
        anthropic,
        model: defaultModel,
        messages: messageHistory,
        tools: toolDefinitions,
        temperature: tempForRun,
        system: systemForRun,
      });

      // Add assistant message to history verbatim (preserves thinking-block
      // signatures, which Anthropic requires alongside tool_use blocks).
      messageHistory.push({ role: 'assistant', content: response.content });

      // Check for tool calls
      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
      );

      if (toolUses.length > 0) {
        // Execute tool calls and collect tool_result blocks
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const toolUse of toolUses) {
          const matchingTool = toolsForRun.find(
            (t) => t.definition.name === toolUse.name
          );

          if (!matchingTool) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `Error: Tool '${toolUse.name}' not found`,
              is_error: true,
            });
            continue;
          }

          try {
            const result = await matchingTool.func(toolUse.input);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: typeof result === 'string' ? result : JSON.stringify(result),
            });
          } catch (error) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
              is_error: true,
            });
          }
        }

        // Tool results go back as a user message (Anthropic's tool-result contract)
        messageHistory.push({ role: 'user', content: toolResults });

        // Continue loop to get next response
        continue;
      }

      // No tool calls - we're done
      isDone = true;
      finalContent = extractTextContent(response);
    }

    return finalContent;
  };

  /**
   * Run a single completion (no tool execution loop).
   * Useful for forcing a specific tool call.
   */
  const runOnce = async ({
    toolChoice,
    tools,
    messages,
    temperature,
    model,
    system,
  }: {
    toolChoice: { type: 'tool'; name: string };
    tools?: ToolWithFunc[];
    messages: Anthropic.MessageParam[] | ((history: Anthropic.MessageParam[]) => Anthropic.MessageParam[]);
    temperature?: number;
    model?: string;
    system?: string;
  }): Promise<{ raw: Anthropic.Message }> => {
    // Update message history
    messageHistory = Array.isArray(messages)
      ? [...messageHistory, ...messages]
      : messages(messageHistory);

    const toolsForRun = tools ?? defaultTools;
    const toolDefinitions = toolsForRun.map((t) => t.definition);
    const modelForRun = model ?? defaultModel;
    const systemForRun = system ?? defaultSystem;
    const tempForRun = temperature ?? defaultTemperature;

    const response = await anthropic.messages.create({
      model: modelForRun,
      messages: messageHistory,
      temperature: tempForRun,
      max_tokens: 8192,
      system: systemForRun,
      tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
      tool_choice: { type: 'tool', name: toolChoice.name },
    });

    return { raw: response };
  };

  return {
    runTools,
    runOnce,
  };
};

export type Agent = ReturnType<typeof createAgent>;

// Helper: Run an Anthropic completion and return the raw message
async function runAnthropicCompletion({
  anthropic,
  model,
  messages,
  tools,
  temperature,
  system,
}: {
  anthropic: Anthropic;
  model: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  temperature: number;
  system?: string;
}): Promise<Anthropic.Message> {
  return anthropic.messages.create({
    model,
    messages,
    max_tokens: 8192,
    temperature,
    system,
    tools: tools.length > 0 ? tools : undefined,
    tool_choice: tools.length > 0 ? { type: 'auto' } : undefined,
  });
}

// Helper: Extract text content from an Anthropic message
function extractTextContent(message: Anthropic.Message): string | null {
  const textBlock = message.content.find(
    (block): block is Anthropic.TextBlock => block.type === 'text'
  );
  return textBlock ? textBlock.text : null;
}
