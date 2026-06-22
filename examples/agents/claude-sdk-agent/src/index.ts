#!/usr/bin/env node
import { runAgent } from "./agent.js";

async function main() {
  const args = process.argv.slice(2);

  // Parse flags
  const readOnly = args.includes("--read-only");
  const task = args.filter(arg => !arg.startsWith("--")).join(" ");

  if (!task) {
    console.error("Usage: node dist/index.js <task> [--read-only]");
    console.error("");
    console.error("Options:");
    console.error("  --read-only    Disable file editing tools");
    console.error("");
    console.error("Environment variables:");
    console.error("  CLAUDE_MODEL      Model to use (e.g., claude-sonnet-4-6)");
    console.error("  CLAUDE_MAX_TURNS  Maximum conversation turns (default: 50)");
    console.error("  ANTHROPIC_API_KEY API key for Claude");
    process.exit(1);
  }

  console.log("Starting Claude SDK Agent...\n");

  const result = await runAgent(task, { readOnly });

  if (!result.success) {
    console.error("\nAgent failed:", result.errors?.join(", "));
    process.exit(1);
  }

  console.log("\nTask completed successfully");
  console.log(`Total turns: ${result.turns}`);
  console.log(`Total cost: $${result.totalCostUsd.toFixed(4)}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
