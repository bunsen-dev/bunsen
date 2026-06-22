#!/usr/bin/env python3
"""
Basic coding agent with file and bash tools.

A minimal but functional coding agent that can:
- Read files
- List directory contents
- Edit files (find and replace)
- Run bash commands

Uses Claude via the Anthropic SDK with tool use.
"""

import os
import sys
import json
import subprocess
from pathlib import Path

import anthropic


# Tool definitions for Claude
TOOLS = [
    {
        "name": "list_files",
        "description": "List files and directories at the specified path. Returns names with '/' suffix for directories.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Directory path to list. Defaults to current directory if not specified."
                }
            },
            "required": []
        }
    },
    {
        "name": "read_file",
        "description": "Read the entire contents of a file.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the file to read."
                }
            },
            "required": ["path"]
        }
    },
    {
        "name": "edit_file",
        "description": "Edit a file by replacing the first occurrence of old_text with new_text. Use this for making targeted changes to files.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the file to edit."
                },
                "old_text": {
                    "type": "string",
                    "description": "The exact text to find and replace (first occurrence only)."
                },
                "new_text": {
                    "type": "string",
                    "description": "The text to replace it with."
                }
            },
            "required": ["path", "old_text", "new_text"]
        }
    },
    {
        "name": "bash",
        "description": "Run a bash command and return its output. Use this for running tests, checking syntax, installing packages, etc.",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The bash command to execute."
                }
            },
            "required": ["command"]
        }
    }
]


def list_files(path: str = ".") -> str:
    """List files and directories at the given path."""
    try:
        p = Path(path)
        if not p.exists():
            return f"Error: Path does not exist: {path}"
        if not p.is_dir():
            return f"Error: Not a directory: {path}"

        entries = []
        for entry in sorted(p.iterdir()):
            name = entry.name
            if entry.is_dir():
                name += "/"
            entries.append(name)

        if not entries:
            return "(empty directory)"
        return "\n".join(entries)
    except Exception as e:
        return f"Error listing directory: {e}"


def read_file(path: str) -> str:
    """Read the entire contents of a file."""
    try:
        p = Path(path)
        if not p.exists():
            return f"Error: File does not exist: {path}"
        if not p.is_file():
            return f"Error: Not a file: {path}"

        content = p.read_text()
        return content
    except Exception as e:
        return f"Error reading file: {e}"


def edit_file(path: str, old_text: str, new_text: str) -> str:
    """Edit a file by replacing the first occurrence of old_text with new_text."""
    try:
        p = Path(path)
        if not p.exists():
            return f"Error: File does not exist: {path}"
        if not p.is_file():
            return f"Error: Not a file: {path}"

        content = p.read_text()

        if old_text not in content:
            return f"Error: Could not find the specified text in {path}"

        # Replace first occurrence only
        new_content = content.replace(old_text, new_text, 1)
        p.write_text(new_content)

        return f"Successfully edited {path}"
    except Exception as e:
        return f"Error editing file: {e}"


def run_bash(command: str) -> str:
    """Run a bash command and return its output."""
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=60  # 1 minute timeout
        )

        output = ""
        if result.stdout:
            output += result.stdout
        if result.stderr:
            if output:
                output += "\n--- STDERR ---\n"
            output += result.stderr

        if result.returncode != 0:
            output += f"\n(exit code: {result.returncode})"

        return output if output else "(no output)"
    except subprocess.TimeoutExpired:
        return "Error: Command timed out after 60 seconds"
    except Exception as e:
        return f"Error running command: {e}"


def execute_tool(name: str, input_data: dict) -> str:
    """Execute a tool and return its result."""
    if name == "list_files":
        return list_files(input_data.get("path", "."))
    elif name == "read_file":
        return read_file(input_data["path"])
    elif name == "edit_file":
        return edit_file(input_data["path"], input_data["old_text"], input_data["new_text"])
    elif name == "bash":
        return run_bash(input_data["command"])
    else:
        return f"Error: Unknown tool: {name}"


def run_agent(task: str, model: str = "claude-sonnet-4-6", max_turns: int = 20):
    """Run the agent loop until task completion or max turns reached."""

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("Error: ANTHROPIC_API_KEY not set")
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key)

    # System prompt
    system = """You are a skilled coding agent. Your job is to complete the given task by reading files, understanding the code, making necessary edits, and verifying your changes.

Guidelines:
- Start by exploring the codebase to understand the structure
- Read relevant files before making changes
- Make minimal, targeted changes to fix issues
- After making changes, run tests or validation commands to verify your fix
- If a fix doesn't work, analyze the error and try again

You have access to these tools:
- list_files: See what files exist in a directory
- read_file: Read file contents
- edit_file: Make targeted find-and-replace edits
- bash: Run commands (tests, linters, etc.)

When you've completed the task successfully, provide a brief summary of what you did."""

    messages = [{"role": "user", "content": task}]

    print(f"\n{'='*60}", flush=True)
    print("TASK:", flush=True)
    print(task, flush=True)
    print(f"{'='*60}\n", flush=True)

    turn = 0
    while turn < max_turns:
        turn += 1

        # Call Claude
        response = client.messages.create(
            model=model,
            max_tokens=4096,
            system=system,
            tools=TOOLS,
            messages=messages
        )

        # Process the response
        assistant_content = []
        tool_results = []

        for block in response.content:
            if block.type == "text":
                print(f"\nAssistant: {block.text}", flush=True)
                assistant_content.append({"type": "text", "text": block.text})
            elif block.type == "tool_use":
                print(f"\nTool: {block.name}", flush=True)
                print(f"Input: {json.dumps(block.input, indent=2)}", flush=True)

                # Execute the tool
                result = execute_tool(block.name, block.input)
                print(f"Result: {result[:500]}{'...' if len(result) > 500 else ''}", flush=True)

                assistant_content.append({
                    "type": "tool_use",
                    "id": block.id,
                    "name": block.name,
                    "input": block.input
                })
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": result
                })

        # Add assistant message
        messages.append({"role": "assistant", "content": assistant_content})

        # Check if we're done
        if response.stop_reason == "end_turn" and not tool_results:
            print(f"\n{'='*60}", flush=True)
            print("TASK COMPLETED", flush=True)
            print(f"{'='*60}", flush=True)
            break

        # Add tool results if any
        if tool_results:
            messages.append({"role": "user", "content": tool_results})

    if turn >= max_turns:
        print(f"\nWarning: Reached maximum turns ({max_turns})", flush=True)

    return messages


def main():
    task = sys.argv[1] if len(sys.argv) > 1 else "Explore the current directory and describe what you find."

    # Optional: specify model via env var
    model = os.environ.get("AGENT_MODEL", "claude-sonnet-4-6")

    # Optional: max turns via env var
    max_turns = int(os.environ.get("AGENT_MAX_TURNS", "50"))

    run_agent(task, model=model, max_turns=max_turns)


if __name__ == "__main__":
    main()
