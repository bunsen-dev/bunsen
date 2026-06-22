# System Prompts & Agent Config Files

Bunsen does **not** have a `systemPrompt` field on `agent.yaml`. System-prompt wiring varies too much per agent — `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `--append-system-prompt`, SDK options — and folding any of it into the platform schema would force Bunsen to learn one contract per agent. Bunsen keeps the platform thin and lets the agent author wire their own prompt, the same way the rest of the agent contract works.

This page is the cookbook. Agent authors compose system prompts themselves using two small primitives:

- **`writeFile:` step** — a peer of `run:` inside `install.configure` (and `workspace.setup`). Drops a file at a known path inside the container. Source is either an inline `content:` literal or a `from: <path>` file alongside `agent.yaml`. No heredoc shell-quoting risk; base64 underneath.
- **Variant `install.configure` with `mergeMode: append`** — variant adds one extra step on top of base configure without redeclaring the base.

Both primitives are generic. System prompts are the motivating use case, not the only one — config files, ruleset drops, license text, fixture data all use the same shape.

Same philosophy as the asymmetric composition model in [The Environment Model](./ENVIRONMENT.md): Bunsen
carries less, the agent author wires their own way.

## The recommended pattern (Pattern A: drop a config file)

The recommended approach — **Pattern A** — is to drop a config file the agent reads at startup via a
`writeFile:` step in `install.configure`:

```yaml
# agent.yaml
install:
  source: { type: local }
  configure:
    - run: |
        # base configure (whatever the agent needs)
        ...

variants:
  cautious:
    install:
      configure:
        mergeMode: append          # add to base, don't replace
        items:
          - writeFile: $BUNSEN_AGENT_HOME/.claude/CLAUDE.md
            from: prompts/cautious.md
  yolo:
    install:
      configure:
        mergeMode: append
        items:
          - writeFile: $BUNSEN_AGENT_HOME/.claude/CLAUDE.md
            from: prompts/yolo.md
```

Layout in the agent directory:

```
agents/my-agent/
├── agent.yaml
└── prompts/
    ├── cautious.md
    └── yolo.md
```

Run it:

```sh
bn run experiments/my-experiment --agent claude-code:cautious
```

## Pattern details

### `writeFile:` step shape

The full step schema is defined alongside the rest of the agent config — see
[agent.yaml Reference](./AGENT_YAML.md) and [The Environment Model](./ENVIRONMENT.md) for the
authoritative `writeFile`/`run` step shape (and the hosted [`agent.v1.json`](https://schemas.bunsen.dev/agent.v1.json)
schema). The summary below covers the fields you need for prompt wiring.

```yaml
- writeFile: <target-path-inside-container>
  from: <path-relative-to-agent.yaml>   # OR
  content: |
    inline UTF-8 content here
  as: root                              # optional, default 'user'
  timeout: 30s                          # optional
```

- Exactly one of `from` / `content` is set per step.
- The target path supports `$VAR` shell expansion at execution time — `$BUNSEN_AGENT_HOME` is the recommended way to write into the agent's home regardless of root vs non-root execution. `BUNSEN_AGENT_HOME` resolves to `/home/bunsen` for non-root execution and `/root` for root experiments.
- Inline `content:` is treated as a literal byte stream. **No env interpolation** — secrets in env vars never reach the manifest. If you need a secret in file content, use `run:` plus `envsubst` (the existing pattern).
- Parent directories auto-created; existing files silently overwritten; file mode `644`. If you need executable mode, add a follow-up `run: chmod +x ...`.
- `from:` paths are resolved relative to the directory containing `agent.yaml`; a path-safety check rejects `from: ../../etc/passwd`.
- `as:` follows the phase default (`install.configure` → `root`; `workspace.setup` → `user` i.e. the non-root `bunsen` user when one exists). In `workspace.setup`, dropping a file via `writeFile` lands `bunsen`-owned so the agent can modify it. Set `as: root` to escalate explicitly.

> **Shell state does not persist across a `writeFile` boundary.** Consecutive `run:` steps with the same `as:` are batched into one shell invocation (so `export FOO=bar` in step 1 is visible to step 3). A `writeFile:` step — or a switch to a different `as:` — ends the batch. So this **does not** work:
>
> ```yaml
> - run: export FOO=bar          # exported in one shell
> - writeFile: /tmp/x            # batch break
>   content: ...
> - run: echo "$FOO"             # new shell — $FOO is empty here
> ```
>
> If you need an env var across a writeFile, put the export inside the run step that uses it (or use a real env var via `defaults.env` so the container env carries it).

> **Root-mode caveat for `$VAR` in `defaults.env` values.** A `$BUNSEN_AGENT_HOME` (or any `$VAR`)
> inside a `defaults.env` *value* is expanded by the non-root container entrypoint's shell. Under
> root-mode execution there is no such shell — the agent is invoked with the env value passed literally,
> so the `$BUNSEN_AGENT_HOME/...` string arrives unexpanded. For root experiments, hardcode the path
> (e.g. `/root/prompts/cautious.md`) or set it from a `run:` step. The `writeFile:` *target path* is
> unaffected — it expands regardless of execution user. See
> [Running as Root (environment.user)](./ENVIRONMENT_USER.md).

### Variant `mergeMode`

A variant's `install.configure` accepts either the raw step array (which replaces the base list) or the wrapped form:

```yaml
install:
  configure:
    mergeMode: append | replace        # defaults to 'replace' when omitted
    items:
      - <step>
      - <step>
```

`mergeMode: append` concatenates the variant's `items:` onto the base configure list. `replace` (and the raw-array shorthand) replaces wholesale.

## Worked examples for every shipped agent

The pattern works for any agent — the only difference is the target path the agent reads at startup. Here's the wiring for each agent that ships in this repo.

### `claude-code` (CLI)

Claude Code reads `~/.claude/CLAUDE.md` at startup. With Bunsen's `BUNSEN_AGENT_HOME` reserved env (set to `/home/bunsen` for non-root, `/root` for root), the same wiring works regardless of execution user.

```yaml
variants:
  cautious:
    install:
      configure:
        mergeMode: append
        items:
          - writeFile: $BUNSEN_AGENT_HOME/.claude/CLAUDE.md
            from: prompts/cautious.md
```

This is shipped in this repo. Try:

```sh
bn run <any-experiment> --agent claude-code:cautious
```

#### Alternative: `--append-system-prompt` wrapper (Pattern B)

If you specifically need flag-based injection (e.g. the prompt source isn't a file the agent can read, or you want CLI-visible provenance), build a wrapper script during `install.build` and point `entrypoint` at it:

```yaml
install:
  build:
    image: ubuntu:22.04
    cacheSalt: claude-code-wrapped-v1
    run:
      - |
        # ... fetch the claude binary as usual into /output/bin/claude ...
        cat > /output/bin/claude-wrapped <<'EOF'
        #!/bin/sh
        set -e
        if [ -n "$AGENT_SYSTEM_PROMPT_FILE" ] && [ -f "$AGENT_SYSTEM_PROMPT_FILE" ]; then
          exec claude --append-system-prompt "$(cat "$AGENT_SYSTEM_PROMPT_FILE")" "$@"
        fi
        exec claude "$@"
        EOF
        chmod +x /output/bin/claude-wrapped

entrypoint:
  command: claude-wrapped
  args:
    - --dangerously-skip-permissions

variants:
  cautious:
    install:
      configure:
        mergeMode: append
        items:
          - writeFile: $BUNSEN_AGENT_HOME/.prompts/cautious.md
            from: prompts/cautious.md
    defaults:
      env:
        AGENT_SYSTEM_PROMPT_FILE: $BUNSEN_AGENT_HOME/.prompts/cautious.md
```

When to reach for this over Pattern A: the wrapper makes the prompt visible in `ps`/process trees and survives if the agent ignores `~/.claude/CLAUDE.md` for any reason. Costs more — every variant change means rebuilding the artifact via `install.build` (whereas Pattern A only re-runs `install.configure`, which is cheap). **Default to Pattern A unless you have a specific reason.**

> **Root-mode:** the `AGENT_SYSTEM_PROMPT_FILE: $BUNSEN_AGENT_HOME/.prompts/cautious.md` env value uses
> `$VAR` expansion — under root-mode execution, hardcode `/root/.prompts/cautious.md` instead. See the
> [root-mode caveat for `$VAR` in `defaults.env` values](#writefile-step-shape) above.

### `claude-sdk-agent` (TypeScript)

The SDK agent reads its system prompt from the SDK `options.systemPrompt` field, not from a file. That field's type is `string | { type: 'preset'; preset: 'claude_code'; append?: string }`, and the agent's default prompt is already a preset object (`{ type: 'preset', preset: 'claude_code', append: '...' }`) — so the cleanest wiring keeps the Claude Code preset and appends your file's contents via the `append` sub-field rather than replacing the prompt wholesale. Patch the agent to read an env var and build the `systemPrompt` it passes to the SDK options:

```ts
import { readFileSync, existsSync } from 'node:fs';

const promptFile = process.env.AGENT_SYSTEM_PROMPT_FILE;
const systemPrompt: AgentConfig['systemPrompt'] = promptFile && existsSync(promptFile)
  ? { type: 'preset', preset: 'claude_code', append: readFileSync(promptFile, 'utf-8') }
  : DEFAULT_SYSTEM_PROMPT;

// ... pass `systemPrompt` to the SDK options.
```

Then in `agent.yaml`:

```yaml
variants:
  cautious:
    defaults:
      env:
        AGENT_SYSTEM_PROMPT_FILE: $BUNSEN_AGENT_HOME/prompts/cautious.md
    install:
      configure:
        mergeMode: append
        items:
          - writeFile: $BUNSEN_AGENT_HOME/prompts/cautious.md
            from: prompts/cautious.md
```

> **Root-mode:** the `AGENT_SYSTEM_PROMPT_FILE: $BUNSEN_AGENT_HOME/prompts/cautious.md` env value uses
> `$VAR` expansion — under root-mode execution, hardcode `/root/prompts/cautious.md` instead. See the
> [root-mode caveat for `$VAR` in `defaults.env` values](#writefile-step-shape) above.

### `codex-cli` (OpenAI's CLI)

Codex reads `~/.codex/AGENTS.md` at startup.

```yaml
variants:
  cautious:
    install:
      configure:
        mergeMode: append
        items:
          - writeFile: $BUNSEN_AGENT_HOME/.codex/AGENTS.md
            from: prompts/cautious.md
```

The base `install.configure` already creates `$BUNSEN_AGENT_HOME/.codex/` (when writing `config.toml`), so the append step just adds the file. If you ever need the prompt drop without the base directory being created, write a `mkdir -p` `run:` step first.

### `gemini-cli` (Google's CLI)

Gemini reads `~/.gemini/GEMINI.md` and also accepts a `systemInstruction` field in `~/.gemini/settings.json`. The file-drop is the simpler of the two:

```yaml
variants:
  cautious:
    install:
      configure:
        mergeMode: append
        items:
          - writeFile: $BUNSEN_AGENT_HOME/.gemini/GEMINI.md
            from: prompts/cautious.md
```

### `basic-coding-agent` (Python, hand-rolled)

This agent hardcodes its system prompt in its Python source. To make it configurable, replace the hardcoded string with an env-var lookup that falls back to the embedded default:

```python
import os
DEFAULT_SYSTEM = """You are a skilled coding agent. ..."""
system = os.environ.get("AGENT_SYSTEM_PROMPT", DEFAULT_SYSTEM)
```

Then in `agent.yaml`:

```yaml
variants:
  cautious:
    defaults:
      env:
        AGENT_SYSTEM_PROMPT_FILE: $BUNSEN_AGENT_HOME/prompts/cautious.md
    install:
      configure:
        mergeMode: append
        items:
          - writeFile: $BUNSEN_AGENT_HOME/prompts/cautious.md
            from: prompts/cautious.md
```

> **Root-mode:** the `AGENT_SYSTEM_PROMPT_FILE: $BUNSEN_AGENT_HOME/prompts/cautious.md` env value uses
> `$VAR` expansion — under root-mode execution, hardcode `/root/prompts/cautious.md` instead. See the
> [root-mode caveat for `$VAR` in `defaults.env` values](#writefile-step-shape) above. The inline
> `AGENT_SYSTEM_PROMPT` form below has no `$VAR` to expand and is safe either way.

Or use `content:` inline if the prompt is short:

```yaml
variants:
  cautious:
    defaults:
      env:
        AGENT_SYSTEM_PROMPT: |
          Be cautious. Confirm before any destructive action.
```

(The `content:` writeFile form is also fine; `defaults.env` works when the prompt is short.)

## Why no `systemPrompt` field on `agent.yaml`?

Adding it would force Bunsen to know one wiring per agent — `--append-system-prompt`, `CLAUDE.md`,
`AGENTS.md`, `GEMINI.md`, SDK options. Bunsen keeps the platform thin and lets each agent wire its own
prompt, so the platform never has to shape itself around any one agent's contract.

## Experiment-side steering

If you want to steer the agent with task-specific context (not agent-wide), put it in
`experiment.task.prompt`. Reaching across the experiment-agent boundary to write into agent-internal paths
is a coupling smell.

That said, `writeFile:` is also available in `workspace.setup` (it shares the same step shape). Use it to drop test fixtures, sample data, or seed files into the workspace — not to write into agent-internal paths.

## Verifying the prompt took effect

To confirm the file actually landed, inspect the container during a run (`bn runs open <run-id>` opens
the local web viewer at `localhost:3456`) or check the agent's startup behavior in the captured traces.
Each run's manifest also records the resolved variant and configure steps — see
[Run Manifest & Events](./RUN_MANIFEST.md).

## See also

- [The Environment Model](./ENVIRONMENT.md) — asymmetric composition and the sealed-closure agent model.
- [agent.yaml Reference](./AGENT_YAML.md) — the full `writeFile`/`run` step schema and variant rules.
- [Running as Root (environment.user)](./ENVIRONMENT_USER.md) — root vs non-root execution and the `$VAR` caveat.
- [Agent Skills](./SKILLS.md) — cross-agent `SKILL.md` authoring, another way to shape agent behavior.
