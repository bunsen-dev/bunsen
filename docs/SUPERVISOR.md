# Supervised Mode

In **supervised mode**, the agent under test runs inside a tmux session and a platform **supervisor agent** watches its terminal. The supervisor detects interactive prompts (confirmation dialogs, permission requests, selection menus) and sends keystrokes to keep the agent moving. When the agent finishes its task, the supervisor exits the session so the experiment can complete.

The supervisor is one of Bunsen's three platform agents (orchestrator, supervisor, scorer) — it runs inside the container alongside the agent under test, not on the host.

## When to use supervised vs direct

`interaction.mode` in `agent.yaml` selects how Bunsen drives the agent:

- **`supervised`** — the agent runs inside tmux and the supervisor agent answers interactive prompts on its behalf. Use this for interactive CLI agents that present prompts and don't expose a flag to suppress all of them — for example, Claude Code's `headed` variant, which runs a live interactive session instead of `-p` print mode.
- **`direct`** (default) — a straight exec with no tmux and no supervisor. Cheaper and simpler. Use it when the agent handles its own prompts, such as any `-p`/print-mode or auto-approve flow (e.g. `--dangerously-skip-permissions`).

Many CLI agents present prompts that block automated execution — trust/safety confirmations ("Do you trust this folder?"), permission requests ("Allow this action?"), API-key selection menus, or bypass-permissions warnings. Without a supervisor, these stall the experiment indefinitely. Supervised mode watches for them and responds automatically.

## Container prerequisites

Supervised mode requires `tmux` in the container. The Bunsen base images include it. If you build a custom Dockerfile, install `tmux` (and `asciinema` if you also enable terminal recording) in your image, or supervised mode and recording will not work.

## Enabling supervised mode

Set `interaction.mode: supervised` on the agent — at the base level, or on a
variant. Claude Code defaults to `direct` (print mode) and ships supervised mode as
its `headed` variant, which overrides the interaction mode and drops `-p` for a live
interactive session:

```yaml
$schema: https://schemas.bunsen.dev/agent.v1.json
version: v1
name: claude-code
# Base entrypoint/interaction default to direct print mode (-p); omitted here.
variants:
  headed:
    interaction:
      mode: supervised
    entrypoint:
      args:
        - --dangerously-skip-permissions   # interactive: no -p
```

Bunsen automatically starts the supervisor process alongside the agent when `interaction.mode` is `supervised`. The supervisor uses a separate API key so its cost is tracked separately from the agent's. See [System Prompts & Agent Config Files](./SYSTEM_PROMPTS.md) for the full `agent.yaml` reference.

Supervised agents often run with permissive flags such as `--dangerously-skip-permissions`. That is a trust-relevant choice — see the [Trust Model](./TRUST_MODEL.md) for what those flags mean inside the sandbox.

## How it works

The supervisor runs as a separate process inside the same container. It communicates with the agent exclusively through tmux — capturing the terminal state and sending keystrokes.

```
┌─────────────────────────────────────────┐
│  Docker Container                       │
│                                         │
│  ┌──────────────────────┐               │
│  │  tmux session        │               │
│  │  ┌────────────────┐  │               │
│  │  │  agent under   │  │  captures     │
│  │  │  test          │◄─┼───────────┐   │
│  │  └────────────────┘  │  sends    │   │
│  └──────────────────────┘  keys     │   │
│                                     │   │
│  ┌──────────────────────────────┐   │   │
│  │  supervisor agent            │   │   │
│  │                              │───┘   │
│  │  - Monitors log file size    │       │
│  │  - Captures tmux pane        │       │
│  │  - Calls the supervisor LLM  │       │
│  │  - Sends keystrokes via tmux │       │
│  └──────────────────────────────┘       │
└─────────────────────────────────────────┘
```

### Main loop

1. **Monitor log file size.** The agent's terminal output is piped to a log file. When the file grows, the agent is producing output (actively working). Reset the stall timer.

2. **Detect stalls.** When output stops for the stall timeout (5s), the supervisor suspects a prompt. It also does forced periodic checks every 30s even during active output, to catch prompts that appear mid-stream.

3. **Capture terminal.** Run `tmux capture-pane` to get the current terminal state. ANSI escape codes are stripped, and the state is truncated to the last 3000 characters — prompts always appear at the bottom.

4. **Ask the LLM.** Send the terminal state to the supervisor LLM with three tools:
   - `send_keys` — send keystrokes to the terminal
   - `not_waiting` — agent is actively working, back off
   - `agent_finished` — agent has completed its task

5. **Act on the result.** Send keys via tmux, back off, or accumulate finish confirmations.

6. **Repeat** until the agent writes a completion marker file or the process is terminated.

### Change detection

Each LLM check includes context about whether the terminal has changed since the last check:

- **Keys sent, terminal changed:** "The terminal has changed. Check if the agent is now waiting for more input."
- **Keys sent, terminal unchanged:** "IMPORTANT: Your previous action did NOT work. Try a completely different approach."
- **No keys sent, terminal unchanged:** "The terminal is IDENTICAL to the previous check. If the agent has completed its task, call agent_finished."
- **Terminal changed on its own:** No extra context (agent produced new output).

This change detection prevents the LLM from getting stuck in loops — if the terminal is static, the supervisor explicitly tells the LLM so it doesn't have to diff large text blocks on its own.

### Conversation history

The supervisor maintains a rolling conversation history (8 messages / 4 exchanges). Each check adds:
- A **user message** with the terminal state + change-detection hint + any pending tool result from the previous call
- An **assistant message** with the tool call

Old messages are trimmed from the front. This gives the LLM context about recent interactions without unbounded growth.

### Exit mode

The supervisor requires **two consecutive `agent_finished` calls** before entering exit mode. This prevents premature exits — the agent might briefly show an idle prompt between actions, so requiring two consecutive confirmations gives it time to resume.

Once in exit mode:
- Checks happen at the base backoff rate (no exponential increase)
- The user message includes "EXIT MODE: Send the appropriate exit command to terminate the agent"
- The LLM sends exit commands (`/exit ENTER`, `CTRL_C`, etc.)
- If one approach doesn't work (terminal unchanged), the LLM tries different approaches

The experiment completes when the agent process writes its exit code to the marker file.

### Backoff strategy

- **Base period:** 3000ms
- **After `not_waiting`:** Backoff increases by 1.5x, capped at 15000ms
- **After `send_keys`:** Reset to base period
- **New output detected:** Reset to base period
- **Exit mode:** Always uses base period (fast exit)

## Output

The supervisor writes `supervisor.json` to the run directory with a log of all interactions:

```json
{
  "interactions": [
    {
      "timestamp": "2026-02-28T02:41:01.236Z",
      "terminalState": "...(last 3000 chars)...",
      "detected": true,
      "response": "UP ENTER",
      "keysSent": "UP ENTER"
    }
  ],
  "totalDetections": 6,
  "totalInteractions": 10,
  "startTime": "2026-02-28T02:40:45.945Z",
  "endTime": "2026-02-28T02:42:07.538Z"
}
```

- `detected: true` — the supervisor sent keystrokes
- `detected: false` — the supervisor called `not_waiting` or `agent_finished` (no keys sent)
- `totalDetections` — number of interactions where keys were sent
- `totalInteractions` — total LLM checks performed

If a run stalls on a prompt the supervisor could not navigate, `supervisor.json` is where to look: a series of `detected: true` interactions whose `terminalState` never changes means the supervisor kept trying keystrokes that didn't advance the prompt.

## Cost

The supervisor uses Claude Haiku (`claude-haiku-4-5`), which is fast and cheap enough to call frequently without dominating experiment cost. Each check sends roughly 3000 characters of terminal state plus a short rolling conversation history; typical runs use 5–15 LLM calls. Supervisor cost is tracked separately from the agent's in `manifest.json` under `usage.platform_cost_usd`. See [Cost Accounting](./COST.md) for the full breakdown.

## See also

- [System Prompts & Agent Config Files](./SYSTEM_PROMPTS.md) — the full `agent.yaml` reference, including `interaction.mode`
- [The Environment Model](./ENVIRONMENT.md) — how the agent under test and platform agents share the container
- [Trust Model](./TRUST_MODEL.md) — sandbox guarantees and what permissive agent flags mean
