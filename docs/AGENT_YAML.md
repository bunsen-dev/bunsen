# agent.yaml Reference

The single authoritative spec for `agent.yaml` — the resource that defines a
**pluggable agent under test**: where to get it, how to install it into the
container, how to invoke it, which model it uses, and any named overlays
(variants) that tweak its behavior.

An agent is a [sealed closure](./GLOSSARY.md#environment): it ships its own
toolkit (and any runtime it pins) and coexists with the experiment's
[substrate](./ENVIRONMENT.md) in one container without a merge contract. The same
agent runs against many experiments; the same experiment runs against many
agents. For the conceptual picture, see [How Bunsen Works](./HOW_IT_WORKS.md);
for the field-level contract (types, enums, patterns), the JSON Schema at
[`schemas.bunsen.dev/agent.v1.json`](https://schemas.bunsen.dev/agent.v1.json) is
authoritative. This document is the narrative companion.

## Block map

A complete `agent.yaml` is a single YAML mapping with these top-level keys:

| Key           | Required | Type                              | Purpose                                                            |
| ------------- | -------- | --------------------------------- | ----------------------------------------------------------------- |
| `version`     | yes      | `'v1'`                            | Schema version. Always `v1`.                                      |
| `name`        | yes      | string (kebab-case)               | Stable identifier; ASCII lowercase, digits, hyphens.             |
| `description` | no       | string                            | Human-readable summary.                                         |
| `install`     | yes      | object                            | Where the agent comes from and how it is installed.             |
| `entrypoint`  | yes      | object                            | How the agent is invoked (`command` + `invoke` template + `args`). |
| `interaction` | yes      | object                            | `direct` exec or `supervised` mode.                            |
| `model`       | no       | object                            | The env var the agent reads its model from, plus a default.    |
| `defaults`    | no       | object                            | Default `env` and `passEnv` for runs of this agent.            |
| `examples`    | no       | `AgentExample[]`                  | Sample prompt/invocation pairs (documentation / scaffolder input). |
| `variants`    | no       | `Record<string, AgentVariant>`    | Named behavioral overlays applied on top of the base agent.    |

`$schema` may also appear at the top level to point editors at the JSON Schema;
it is otherwise ignored. Set it for autocomplete:

```yaml
$schema: https://schemas.bunsen.dev/agent.v1.json
```

A minimal valid agent looks like:

```yaml
version: v1
name: my-agent
install:
  source:
    type: local
entrypoint:
  command: python src/main.py
interaction:
  mode: direct
```

## `install`

How the agent is obtained and assembled in the container. `install.source` is
required; `deps`, `build`, and `configure` are optional.

| Field       | Required | Type             | Description                                                          |
| ----------- | -------- | ---------------- | ------------------------------------------------------------------- |
| `source`    | yes      | object           | Where the agent code comes from (local / git / npm / binary).      |
| `deps`      | no       | `AgentDep[]`     | Portable toolchain the agent ships (e.g. its own pinned runtime).  |
| `build`     | no       | object           | A one-time build step whose output is cached as an artifact.       |
| `configure` | no       | `Step[]`         | Per-run setup steps applied after the agent is installed.          |

### `install.source`

Exactly one source type:

| Type     | Required fields | Optional   | Description                                                    |
| -------- | --------------- | ---------- | ------------------------------------------------------------- |
| `local`  | `type`          | —          | The agent directory itself is the source (the default).      |
| `git`    | `type`, `repo`  | `ref`      | Clone a git repository; `ref` pins a branch, tag, or SHA.    |
| `npm`    | `type`, `package` | `version` | Install a published npm package.                            |
| `binary` | `type`, `url`   | `sha256`   | Download a binary; `sha256` is strongly recommended.         |

```yaml
# Local (default): files next to agent.yaml are the source.
install:
  source:
    type: local

# Git, pinned to a tag.
install:
  source:
    type: git
    repo: https://github.com/acme/my-agent.git
    ref: v1.4.0

# npm package at a fixed version.
install:
  source:
    type: npm
    package: "@acme/agent-cli"
    version: 2.3.1

# Downloaded binary, integrity-checked.
install:
  source:
    type: binary
    url: https://example.com/agent-linux-amd64
    sha256: <64-hex-digest>
```

`bn agents validate` warns when a `binary` source omits `sha256`.

### `install.deps`

`deps` is how an agent ships its **own** runtime and tools so it works against
any substrate — even an image with, say, no Python at all. A dep is either a file
reference (`{ file: ./deps/python.yaml }`) or an inline spec. Building portable
deps (closures, ABI, per-platform install steps) is involved enough to have its
own page: see the **[Agent Dependencies Cookbook](./AGENT_DEPS_COOKBOOK.md)**.

### `install.build`

A one-time build whose output (under `/output`) is captured and cached as an
immutable artifact, keyed so repeated runs reuse it. Use it to compile or
download a heavy binary once.

| Field       | Required | Type                       | Description                                                       |
| ----------- | -------- | -------------------------- | --------------------------------------------------------------- |
| `image`     | yes      | string                     | Image the build runs in.                                       |
| `run`       | yes      | `string[]`                 | Build commands (at least one).                                 |
| `network`   | no       | `'default'` \| `'none'`    | Network access during build. Defaults to `default`.            |
| `timeout`   | no       | duration string            | Build timeout (`5m`, `300s`, …).                               |
| `cacheSalt` | no       | string                     | Bump to invalidate the build-artifact cache (e.g. on a version bump). |

```yaml
install:
  source:
    type: local
  build:
    image: ubuntu:22.04
    cacheSalt: my-agent-v3
    run:
      - curl -fsSL https://example.com/install.sh | bash
      - mkdir -p /output/bin && cp "$(command -v my-agent)" /output/bin/
```

Rebuild on demand with `bn run … --rebuild-agent`, or prebuild for a platform
with `bn agents build <agent> --platform linux/amd64`.

### `install.configure`

Ordered per-run setup steps applied after the agent is installed — typically
writing a config file so the agent skips interactive setup. Each step is either a
`run` step (a shell command) or a `writeFile` step:

| Step type   | Fields                                              |
| ----------- | -------------------------------------------------- |
| `run`       | `run` (command), optional `as` (`user`/`root`), `timeout` |
| `writeFile` | `writeFile` (path), one of `from` (a file) or `content` (inline), optional `as`, `timeout` |

Write to `$BUNSEN_AGENT_HOME` — the runtime sets it to the agent's home directory
regardless of execution user, and chowns it to the execution user afterward.

```yaml
install:
  source:
    type: local
  configure:
    - run: |
        if [ -n "$ANTHROPIC_API_KEY" ]; then
          mkdir -p "$BUNSEN_AGENT_HOME/.config/my-agent"
          printf 'key=%s\n' "$ANTHROPIC_API_KEY" > "$BUNSEN_AGENT_HOME/.config/my-agent/auth"
        fi
```

For dropping a system prompt into the location an agent reads at startup, see
[System Prompts & Agent Config Files](./SYSTEM_PROMPTS.md).

## `entrypoint`

How the agent is invoked. The invocation is composed **deterministically** from
these fields plus the experiment's task prompt — no model in the invocation
path, so it is reproducible and comparable across runs:

```
<command> [interpreter/script split] <expanded invoke…> <cli passthrough> <args>
```

| Field     | Required | Type       | Description                                                       |
| --------- | -------- | ---------- | --------------------------------------------------------------- |
| `command` | yes      | string     | The executable. A bare name resolves via `PATH`; `python <script>` / `node <script>` split into interpreter + script (a relative script is rewritten under `/agent`). |
| `invoke`  | no       | `string[]` | Ordered argv template from the first argument through the prompt slot. Default `["{prompt}"]`. |
| `args`    | no       | `string[]` | Guaranteed args appended to **every** invocation (order-insensitive persistent flags). |
| `help`    | no       | string     | A `--help` command (documentation / scaffolder input).         |

### `invoke` — where the prompt sits in argv

`invoke` is an ordered argv template. Order-sensitive prefixes — a subcommand or
a prompt flag — live here; order-insensitive persistent flags stay in `args`
(always appended last). Each token is a literal argv element (no shell, no
escaping), with per-token **substring** placeholder expansion:

| Placeholder    | Expands to                                              |
| -------------- | ------------------------------------------------------- |
| `{prompt}`     | the experiment's `task.prompt`, verbatim, as one token  |
| `{promptFile}` | `/bunsen/task/prompt.md` (the injected `BUNSEN_TASK_FILE`) |

Rules: only these two placeholders are allowed, and **at most one kind** may
appear (the prompt is delivered through a single channel). Omitting `invoke`
defaults to `["{prompt}"]` — a bare positional prompt. An explicit empty array
delivers no prompt token (for a wrapper `command` that reads `$BUNSEN_TASK_FILE`
itself). Because expansion is per-token substring, both `["{prompt}"]` and
`["--task={prompt}"]` work.

Since the prompt is a discrete argv token (structured argv, not a shell string),
prompt text reaches the agent verbatim — backticks, `$`, quotes, and newlines
are never re-interpreted.

```yaml
# Bare positional prompt (default — invoke omitted):  claude <prompt> …
entrypoint:
  command: claude
  args:
    - --dangerously-skip-permissions

# After a subcommand:  codex exec <prompt> …
entrypoint:
  command: codex
  invoke: [exec, "{prompt}"]
  args: [--sandbox, danger-full-access]

# After a flag:  gemini -p <prompt> …
entrypoint:
  command: gemini
  invoke: ["-p", "{prompt}"]
  args: [--yolo]
```

### Scaffolding `invoke`

Onboarding a brand-new CLI? Instead of hand-writing `invoke`, let a model infer
it:

```bash
bn agents scaffold <agent>
```

It reads the agent's `command`, `examples`, and `description`, runs the CLI's
`--help` on the host when the command is available (best-effort; `--skip-help`
to disable, `--help-text <file>` to supply it explicitly), and writes an
inferred `entrypoint.invoke` into `agent.yaml` as a reviewable diff (with a
sample composed invocation to eyeball). It **runs once per agent at authoring
time**, not per run — the committed template is the contract; the model is only
a drafting aid. It refuses to overwrite an existing `invoke` without `--force`,
and `--dry-run` prints the suggestion without writing. Requires an Anthropic API
key (`ANTHROPIC_API_KEY`).

## `interaction`

How the agent is driven.

| Field  | Required | Type                          | Description                                                  |
| ------ | -------- | ----------------------------- | ---------------------------------------------------------- |
| `mode` | yes      | `'direct'` \| `'supervised'`  | Raw exec, or a tmux session driven by the supervisor.     |

- **`direct`** — the agent is exec'd once and runs to completion. Best for
  non-interactive agents and print/headless modes.
- **`supervised`** — the agent runs in a tmux session and the
  [supervisor](./SUPERVISOR.md) keeps it moving (answering prompts, detecting
  stalls). Use for interactive CLIs. Requires tmux in the image.

## `model`

The model is a separate axis from variants. Declare the **env var your agent
reads its model from**, plus a default; pick the actual model at run time with
`bn run … --model <id>`.

| Field     | Required | Type   | Description                                                       |
| --------- | -------- | ------ | --------------------------------------------------------------- |
| `env`     | yes      | string | The environment variable the agent reads its model id from.    |
| `default` | no       | string | Model id used when `--model` is not passed.                    |

```yaml
model:
  env: ANTHROPIC_MODEL
  default: claude-sonnet-4-6
```

`bn run <exp> <agent> --model claude-opus-4-8` sets that env var at CLI
precedence, overriding any value a variant set. **Do not author per-model
variants** — that's what this axis is for. See the
[Glossary](./GLOSSARY.md#configuration).

## `defaults`

Default environment for runs of this agent.

| Field     | Required | Type                     | Description                                                       |
| --------- | -------- | ------------------------ | --------------------------------------------------------------- |
| `env`     | no       | `Record<string,string>`  | Variables merged into the container for this agent.            |
| `passEnv` | no       | `string[]`               | Host env var names allowed to pass through from the shell.     |

Names starting with `BUNSEN_` are reserved by the platform and rejected. These
merge with experiment-level `env`/`passEnv` and are overridden by CLI flags; see
the env precedence order in [The Environment Model](./ENVIRONMENT.md).

## `examples`

Optional sample prompt/invocation pairs. They document how the agent expects to
be called and are the primary input for [`bn agents scaffold`](#scaffolding-invoke),
which infers an `entrypoint.invoke` template for a brand-new CLI. They are
**not** consulted at run time — the invocation is composed deterministically
from `entrypoint`.

| Field        | Required | Type   | Description                          |
| ------------ | -------- | ------ | ------------------------------------ |
| `prompt`     | yes      | string | An example task prompt.              |
| `invocation` | yes      | string | The command line that task maps to.  |

```yaml
examples:
  - prompt: Fix the bug in the authentication module
    invocation: claude "Fix the bug in the authentication module"
```

## `variants` and merge semantics

`variants` is a `Record<string, AgentVariant>`: named overlays for running the
same agent with small behavioral tweaks (an extra flag, a different mode) without
duplicating the file. Variants are **behavioral only** — pick the model with
`--model`, not a variant.

Each overlay may set `description`, `install` (`source`/`deps`/`build`/`configure`),
`entrypoint`, `interaction`, and `defaults`. It cannot set `version`, `name`, or
nested `variants`.

### Merge rules

- **Scalar and object fields shallow-merge** — the variant's value wins per key;
  omitted keys fall through to the base. `defaults.env` shallow-merges key-by-key.
- **Arrays replace wholesale** — notably `entrypoint.args`: a variant that sets
  `args` replaces the base list entirely.
- **`install.configure` replaces by default**, but supports an explicit merge:
  set `mergeMode: append` to add steps on top of the base list instead of
  replacing it.
- **`install.source` in a variant** may either be a full source or just override
  the `ref`/`version` of the base source.

```yaml
variants:
  headed:
    description: Interactive supervised mode; runs in a supervisor-driven tmux session.
    interaction:
      mode: supervised
    entrypoint:
      args: [--dangerously-skip-permissions]

  cautious:
    description: Drop a system prompt in via a writeFile step appended to configure.
    install:
      configure:
        mergeMode: append
        items:
          - writeFile: $BUNSEN_AGENT_HOME/.claude/CLAUDE.md
            from: prompts/cautious.md
```

### Selecting a variant

Append `:<variant>` to the agent argument:

```bash
bn run <experiment> <agent>:<variant>
# e.g.
bn run fix-the-bug claude-code:headed --model claude-opus-4-8
```

(Experiments have their own independent variants, selected the same way on the
experiment argument — see [`experiment.yaml`](./EXPERIMENT_YAML.md#variants-and-merge-semantics).)

## A worked pair

An `experiment.yaml` and an `agent.yaml` that run together with
`bn run fizzbuzz my-agent`:

```yaml
# experiments/fizzbuzz/experiment.yaml
version: v1
name: fizzbuzz
task:
  prompt: Write fizzbuzz.py that prints FizzBuzz for 1..100.
environment:
  image:
    base: python:3.11-slim
evaluation:
  criteria:
    - id: runs-correctly
      title: Output is correct
      type: script
      run: python fizzbuzz.py | head -15 | grep -q FizzBuzz
```

```yaml
# agents/my-agent/agent.yaml
version: v1
name: my-agent
install:
  source:
    type: local
entrypoint:
  command: python src/main.py
interaction:
  mode: direct
model:
  env: AGENT_MODEL
  default: claude-sonnet-4-6
```

## JSON Schema

The authoritative field-level contract — every type, enum, pattern,
required/optional flag, and mutual-exclusion rule — is the bundled JSON Schema,
published at:

```
https://schemas.bunsen.dev/agent.v1.json
```

The companion schemas cover the other Bunsen resources: `experiment.v1.json`,
`project.v1.json`, and `suite.v1.json`. See [Packages & Schemas](./PACKAGES.md).
