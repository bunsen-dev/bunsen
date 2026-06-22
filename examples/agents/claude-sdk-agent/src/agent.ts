import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export interface AgentConfig {
  model?: string;
  maxTurns?: number;
  permissionMode?: "acceptEdits" | "bypassPermissions" | "default" | "plan";
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  allowedTools?: string[];
  readOnly?: boolean;
}

export interface AgentResult {
  success: boolean;
  result: string;
  turns: number;
  totalCostUsd: number;
  errors?: string[];
}

const DEFAULT_TOOLS = ["Read", "Edit", "Write", "Bash", "Glob", "Grep"];
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "Bash"];

const DEFAULT_SYSTEM_PROMPT: AgentConfig['systemPrompt'] = {
  type: 'preset',
  preset: 'claude_code',
  append: 'Never ask for confirmation or approval. Execute the task directly and completely.',
};

export async function runAgent(
  task: string,
  config: AgentConfig = {}
): Promise<AgentResult> {
  const {
    model = process.env.CLAUDE_MODEL,
    maxTurns = parseInt(process.env.CLAUDE_MAX_TURNS || "50", 10),
    permissionMode = "acceptEdits",
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    readOnly = false,
  } = config;

  const allowedTools = config.allowedTools ?? (readOnly ? READ_ONLY_TOOLS : DEFAULT_TOOLS);

  const messages: string[] = [];
  let finalResult = "";
  let totalTurns = 0;
  let totalCostUsd = 0;
  const errors: string[] = [];

  console.log("=".repeat(60));
  console.log("CLAUDE SDK AGENT");
  console.log("=".repeat(60));
  console.log("Task:", task);
  console.log("Model:", model || "default");
  console.log("Max turns:", maxTurns);
  console.log("Permission mode:", permissionMode);
  console.log("Allowed tools:", allowedTools.join(", "));
  console.log("=".repeat(60));

  try {
    for await (const message of query({
      prompt: task,
      options: {
        model,
        maxTurns,
        allowedTools,
        permissionMode,
        systemPrompt,
        cwd: "/workspace",
        stderr: (data: string) => {
          process.stderr.write(data);
        },
        // Required when using bypassPermissions
        ...(permissionMode === "bypassPermissions" && {
          allowDangerouslySkipPermissions: true,
        }),
      },
    })) {
      processMessage(message, messages);

      // Handle result message
      if (message.type === "result") {
        totalTurns = message.num_turns;
        totalCostUsd = message.total_cost_usd;

        if (message.subtype === "success") {
          finalResult = message.result;
        } else {
          const resultErrors = "errors" in message ? message.errors : [];
          errors.push(...(resultErrors || [`Agent ended with: ${message.subtype}`]));
        }
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    errors.push(errorMsg);
    console.error("\nAgent error:", errorMsg);
  }

  return {
    success: errors.length === 0,
    result: finalResult,
    turns: totalTurns,
    totalCostUsd,
    errors: errors.length > 0 ? errors : undefined,
  };
}

function processMessage(message: SDKMessage, log: string[]): void {
  if (message.type === "assistant" && message.message?.content) {
    for (const block of message.message.content) {
      if ("text" in block) {
        console.log("\n[Assistant]", block.text);
        log.push(`[ASSISTANT]\n${block.text}`);
      } else if ("name" in block) {
        console.log(`\n[Tool: ${block.name}]`);
        log.push(`[TOOL: ${block.name}]`);
        if ("input" in block) {
          const inputStr = JSON.stringify(block.input, null, 2);
          const truncated =
            inputStr.length > 500
              ? inputStr.substring(0, 500) + "..."
              : inputStr;
          console.log("Input:", truncated);
        }
      }
    }
  } else if (message.type === "result") {
    console.log("\n" + "=".repeat(60));
    console.log(`RESULT: ${message.subtype}`);
    console.log(`Turns: ${message.num_turns}, Cost: $${message.total_cost_usd.toFixed(4)}`);
    console.log("=".repeat(60));
    log.push(
      `[RESULT]\nStatus: ${message.subtype}\nTurns: ${message.num_turns}\nCost: $${message.total_cost_usd.toFixed(4)}`
    );
  } else if (message.type === "system" && message.subtype === "init") {
    console.log("\n[System] Session initialized");
    console.log("  Model:", message.model);
    console.log("  Tools:", message.tools.join(", "));
  }
}
