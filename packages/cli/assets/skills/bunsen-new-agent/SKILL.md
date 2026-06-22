---
name: bunsen-new-agent
description: >-
  Plug a new coding agent or CLI into Bunsen by authoring or fixing an agent.yaml — the
  install.source (local/git/npm/binary), install.deps/build/configure, the entrypoint,
  interaction mode (direct/supervised), defaults.env, examples, and variants — so a tool like
  Claude Code, Codex, Gemini CLI, or a custom script can run inside a Bunsen experiment. Use
  when the user wants to "add an agent" or "make Bunsen run <some CLI>". For defining the
  task/environment use bunsen-new-experiment; for scorers use bunsen-author-scorer; for
  diagnosing a finished run use bunsen-debug-run.
---

# Plug an agent into Bunsen

An agent is a directory with an `agent.yaml` that says **where the agent code comes from**
(`install.source`), **what toolkit it ships** (`install.deps` / `build` / `configure`),
**how Bunsen invokes it** (`entrypoint`), and **how it's driven** (`interaction.mode`). Then
`bn run <experiment> <agent>` composes it into the experiment's container.

**Core mental model — the agent is a sealed closure.** It ships *everything* it needs
(its language runtime, its CLIs) and does **not** ask the experiment's environment for them.
There is no agent-side "requires Node 20" block; if the agent needs Node/Python, ship it as
an `install.deps` closure. This is what lets one agent run against any experiment image.

> Field truth lives in [`reference/agent-schema.md`](reference/agent-schema.md) — the four
> source shapes, dep/build/configure fields, entrypoint, variants, and the reserved-env
> contract, generated from the schema your `bn` ships. Consult it; let `bn agents validate`
> be the oracle.

## Steps

1. **Scaffold.** From the project root:
   ```bash
   bn new agent <name>     # creates agents/<name>/agent.yaml (+ a placeholder src/main.py)
   bn agents list          # what's already available
   ```
   Name is kebab-case (`^[a-z0-9][a-z0-9-]*$`) and matches the directory + top-level `name:`.

2. **Pick `install.source`** — exactly one of four shapes (`additionalProperties: false`, no
   stray keys):
   - `{ type: local }` — the agent's own dir, mounted read-only at `/agent`; relative
     entrypoint paths resolve there. Most first-party agents use this and do real work in
     `install.build`.
   - `{ type: git, repo, ref? }` — clone a repo at a branch/tag/SHA.
   - `{ type: npm, package, version? }` — install an npm package.
   - `{ type: binary, url, sha256? }` — download a prebuilt binary (`sha256` is 64-hex and
     strongly recommended; validate warns when missing).

3. **Ship the toolkit** (`install`, optional but usually needed):
   - `install.deps[]` — cached, platform-keyed tool builds. Each mounts read-only at
     `/bunsen/deps/<name>/` and joins PATH. Required: `name` + `install[]` (each entry a
     `target: linux/amd64|linux/arm64` plus ordered `run[]` writing to `/output/...`,
     conventionally `/output/bin`). Strongly declare `linkage` (`static|closure|dynamic`),
     `version`, and `provides.binaries`. `closure`/`dynamic` require `abi.libc`
     (`glibc|musl`); `static` forbids `abi`.
   - `install.build` — one cached artifact build: required `image` + `run[]`; optional
     `timeout` (default 10m), `network` (`default|none`), `cacheSalt`. Outputs to `/output`
     (mounted at `/bunsen/artifacts`; `/output/bin` wins PATH over deps).
   - `install.configure[]` — **fast per-run wiring only** (write config from env, symlinks,
     perms). **Do not install tools here** — that's `deps`/`build`. Steps are `run:` or
     `writeFile:` (a `writeFile` sets exactly one of `from` | `content`).

4. **Define the entrypoint.** `entrypoint.command` (required) is the executable; `args[]` are
   tokens appended to **every** invocation; `help` is an optional help command. The **task
   prompt** reaches the agent as the first argv token after the prefix, and is also at
   `$BUNSEN_TASK_FILE` (`/bunsen/task/prompt.md`). Put non-interactive/auto-approve flags here
   (e.g. `--dangerously-skip-permissions`, `--yolo`).

5. **Choose `interaction.mode`** (required):
   - `direct` — a straight exec. Use when the agent is already non-interactive (headless / `-p`
     / auto-approve flags). Cheaper, simpler, works against minimal images.
   - `supervised` — runs in tmux with a platform supervisor that answers interactive prompts.
     Use for interactive CLIs with no skip flag. ⚠️ Needs **tmux in the experiment image**
     (bunsen base images have it; minimal/custom images may not).

6. **Declare the model knob.** Put the model in the top-level `model` block, not in
   `defaults.env`: `model.env` names the env var your harness reads its model id from (e.g.
   `ANTHROPIC_MODEL`, `CODEX_MODEL`), and `model.default` is the id used when no flag is passed.
   This is what makes `bn run <exp> <agent> --model <id>` work — it sets `model.env` at CLI
   precedence so the user picks a model without authoring a per-model variant. Omit the block
   only for agents with no model knob (a no-AI agent); `--model` is then rejected. The harness
   reads `model.env` directly, or a `configure` step generates a config file from it.

7. **Wire env.** `defaults.env` is a flat `string→string` map for **non-secret behavioral knobs**
   (turn caps, TERM, feature flags) — the model lives in the `model` block above, not here.
   **Do not put API keys here** — the major provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
   `GOOGLE_API_KEY`, `GEMINI_API_KEY`) are allowlisted from the host by default, so a `configure`
   step can read `$ANTHROPIC_API_KEY` to write the agent's auth file. Write user config under
   `$BUNSEN_AGENT_HOME`. You **cannot set** any `BUNSEN_*` var — they're reserved (validate
   rejects them); you can only read them.

8. **Add `examples[]`** — each `{ prompt, invocation }` teaches the orchestrator how a task
   prompt maps to a real command line. Add at least one.

9. **Add `variants` (optional)** — a map of name → partial override that shallow-merges over
   the base. Variants are **behavioral overlays** (run mode, output format, turn caps, system
   prompts) — pick the **model** with `--model`, not a variant. Pin a model in a variant only
   when its behavior requires one. ⚠️ **Arrays replace wholesale** (a variant's `entrypoint.args`
   does not append — re-list what you want). Select at run time with `bn run <exp> <agent>:<variant>`.

10. **Validate, then build — the oracle loop.**
   ```bash
   bn agents validate <name>          # schema oracle: source oneOf, required fields, abi rules
   bn agents validate --all           # check every agent
   bn agents show <name> --format yaml
   bn agents build <name>             # prebuild + cache artifacts (Docker required)
   bn run <experiment> <name>         # a real run
   ```
   Exit 3 = validation failure; iterate until green, then `bn agents build` to confirm the
   artifacts actually build before a full run.

## Gotchas

- `source` is one of **four exact shapes** (`additionalProperties: false`) — mixing keys
  (e.g. `repo` on an `npm` source) fails. There is **no default source**.
- **No agent-side runtime-requirements block** — ship runtimes as `install.deps` closures;
  the agent never merges with `environment.requires`.
- `install.configure` is **wiring, not installation** — downloading/installing tools there is
  wrong (use `deps`/`build`). It runs as root by default (`as: user` per step to change).
- A `writeFile` step sets **exactly one** of `from` (host path) or `content` (inline). The
  target path expands `$BUNSEN_*` vars; `content` does not interpolate.
- Dep `version` is **cache-key metadata only** — it does not pin what gets downloaded; change
  the URL too when upgrading. Two deps providing the same binary name is a hard error.
- Local-source relative entrypoints resolve under `/agent`; the agent runs as a non-root
  `bunsen` user by default (which is why skip-permission flags are needed).

## Complete example

```yaml
$schema: https://schemas.bunsen.dev/agent.v1.json
version: v1
name: my-coding-agent
description: A coding agent that ships its own Python runtime and runs non-interactively.

install:
  source:
    type: local

  # Ship Python as a sealed closure dep so the agent runs on any substrate.
  deps:
    - name: python
      version: "3.11.10"
      description: Astral python-build-standalone (glibc closure)
      image: debian:bookworm-slim
      linkage: closure
      abi:
        libc: glibc
        libc_version: ">=2.31"
      provides:
        binaries: [python, python3, pip, pip3]
      install:
        - target: linux/amd64
          run:
            - apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates
            - curl -fsSL https://example.com/cpython-3.11.10-x86_64-linux.tar.gz -o /tmp/py.tar.gz
            - mkdir -p /tmp/x && tar -xzf /tmp/py.tar.gz -C /tmp/x
            - mkdir -p /output/bin /output/lib
            - cp -a /tmp/x/python/bin/. /output/bin/
            - cp -a /tmp/x/python/lib/. /output/lib/

  # Fast per-run wiring only: read the allowlisted API key from env.
  configure:
    - run: |
        if [ -n "$ANTHROPIC_API_KEY" ]; then
          mkdir -p "$BUNSEN_AGENT_HOME/.config/my-agent"
          printf 'key=%s\n' "$ANTHROPIC_API_KEY" > "$BUNSEN_AGENT_HOME/.config/my-agent/auth"
        fi
      as: root

entrypoint:
  command: python /agent/main.py

interaction:
  mode: direct

# main.py reads its model from AGENT_MODEL. Declaring it here enables
# `bn run <exp> my-coding-agent --model <id>`; with no flag, `default` is used.
model:
  env: AGENT_MODEL
  default: claude-sonnet-4-6

examples:
  - prompt: Fix the failing test in calculator.py
    invocation: python /agent/main.py "Fix the failing test in calculator.py"

# Behavioral overlay only — pick the model with `--model`, e.g.
# `bn run <exp> my-coding-agent --model claude-haiku-4-5`.
variants:
  quick:
    description: Cap the loop at 5 turns for quick smoke tests
    defaults:
      env:
        AGENT_MAX_TURNS: "5"
```

**Done when** `bn agents validate <name>` is green and `bn agents build <name>` succeeds.
Then run it against an experiment: `bn run <experiment> <name>`.
