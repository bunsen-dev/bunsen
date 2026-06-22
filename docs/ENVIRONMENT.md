# The Environment Model

How Bunsen composes the run container for an agent against an experiment. Covers the `environment`, `workspace`, and `run` blocks in `experiment.yaml`; the `install` block in `agent.yaml`; and the asymmetric way they coexist.

For the authoritative schema reference, see the hosted JSON schemas: [`experiment.v1.json`](https://schemas.bunsen.dev/experiment.v1.json), [`agent.v1.json`](https://schemas.bunsen.dev/agent.v1.json), [`project.v1.json`](https://schemas.bunsen.dev/project.v1.json), and [`suite.v1.json`](https://schemas.bunsen.dev/suite.v1.json). These ship in the `@bunsen-dev/types` package (see [Packages & Schemas](./PACKAGES.md)).

## Overview

> **The experiment provides task substrate. The agent provides a sealed toolkit. They coexist in the same container without a merge contract.** Bunsen does not negotiate a combined environment from agent + experiment requirements; the agent ships everything it pins to specific versions (via `install.deps` and `install.build`), and the experiment provides the substrate the *task* needs (compilers, language runtimes the codebase under test depends on, services, apt packages). The two run side by side; the agent's PATH precedence wins for tools it ships.

This split keeps each unit addressable on its own (any-agent × any-experiment composes), and it removes the hidden environment variance that a merge surface inevitably introduces. The agent is a sealed closure that walks into whatever experiment image is supplied; experiments declare task substrate without negotiating with the agent.

1. **Experiment** declares task substrate (`environment.image`, `environment.requires.*`, `workspace.*`).
2. **Agent** declares its sealed toolkit (`install.deps`, `install.build`, `install.configure`). It does **not** declare runtime version requirements — if it needs Node, it ships Node.
3. **Bunsen** builds/mounts the agent's deps + build artifacts, prepares the substrate image, runs setup phases, and records any cross-boundary binary shadows in the run manifest.

## Asymmetric composition

The "any agent × any experiment" promise is honest because the agent isn't asking the experiment for anything. The agent walks in self-contained:

- If the substrate is `bunsen/headless` (Ubuntu 22.04 + Python 3.11 + Node 20), the agent's shipped runtimes shadow substrate ones for tools the agent invokes.
- If the substrate is a custom `Dockerfile` pointing at `debian:bookworm-slim` or a CUDA-heavy ML image, the agent's tools still run — same closure, different substrate.
- If the substrate is minimal Alpine, the agent works only if its closures are musl-targeted. Bunsen base images are glibc; agents that need Alpine portability must declare `abi.libc: musl` on the relevant deps.

The only cross-boundary signal is the structured **cross-boundary-binary-shadow** diagnostic recorded in the run manifest when an agent dep ships a binary that the substrate's apt layer also installs under the same name. That diagnostic is a record-and-proceed warning, not a build blocker — the agent's PATH precedence is the deterministic resolver.

### The anti-contract

Bunsen base images happen to ship Node 20 and Python 3.11 because those are useful for `install.configure` shell scripts, the orchestrator, and the supervisor. **Agents do not depend on this.** An agent that needs a runtime ships its own via `install.deps`. That's what makes the same agent run against any experiment image — including custom Dockerfiles, Alpine, distroless images — without modification.

If you find yourself wanting to declare "this agent requires Node 20", the migration is "this agent ships Node 20 as a closure dep". See [Shipping a language runtime](./AGENT_DEPS_COOKBOOK.md#shipping-a-language-runtime) in the cookbook.

### Setup phase ordering

Bunsen's setup ordering is what makes large-seed experiments fast and predictable. Steps run after platform resolution; non-applicable steps are skipped.

1. **`install.deps`** — cached, platform-keyed dep builds (each declared tool produces a tree at `/bunsen/deps/<name>/`).
2. **`install.build`** — cached, platform-keyed agent artifact build. Sees `install.deps` mounted at `/bunsen/deps/<name>/` and on `PATH`.
3. **Mount build artifacts, dep artifacts, and image-backed inputs** into the run container.
4. **`workspace.sources` assembled into `/workspace-source`** (read-only after assembly, world-readable, root-owned).
5. **Execution-user creation and ownership handoff** — `bunsen` is created (skipped when `environment.user: root`); `/workspace`, `/bunsen`, `/home/bunsen` are chown'd while `/workspace` is still empty, so the chown is trivial.
6. **`/workspace` materialized from `/workspace-source`** as the execution user, so files land owned by that user without any recursive `chown -R` over a populated tree.
7. **`install.configure`** — fast per-run runtime config from the agent.
8. **`workspace.setup`** — fast per-run workspace prep from the experiment.
9. **Agent execution.**
10. **Evaluation** against final `/workspace` plus immutable `/workspace-source`.

The ordering matters for large-seed experiments: large immutable seeds (gigabyte models, prebuilt build trees) never force a recursive `chown -R` over the materialized workspace, because materialization runs as the execution user and produces correctly-owned files in `/workspace` directly.

## Conceptual precedent: devcontainer features

Bunsen's environment model — agents and experiments contributing pieces that compose into a shared run container — has its closest mainstream analog in [devcontainer features](https://containers.dev/features). A devcontainer feature is a small YAML/JSON unit that adds a tool or capability: declared inline in `devcontainer.json` or pulled from a file or an OCI registry, composable with other features, multi-platform-aware.

**What devcontainer features get right and Bunsen adopts:**

- Declarative
- Composable
- Multi-source (inline, file, registry)
- Schema centered on *what does this install* rather than *what's the full environment shape*

**What's different in Bunsen, and why it doesn't reuse them directly:**

- Devcontainer features run at image-bake time; Bunsen mounts built artifacts at agent invocation time, so the same dep can compose against whichever experiment image the agent runs in.
- Devcontainer features are coupled to the VS Code / devcontainer ecosystem.
- Different consuming surface (`devcontainer.json` vs `agent.yaml`).
- Bunsen's runtime model is intentionally lighter — no image baking per agent.

**Adjacent tools** (asdf, mise, nix, pkgx, homebrew) solve pieces of this but are too opinionated about runtime or platform to slot in cleanly. Devcontainer features remains the cleanest conceptual precedent.

## A worked pair: experiment.yaml + agent.yaml

A single `bn run <experiment> <agent>` pairs one of each. Here they are side by side for a small "fix the failing test" experiment run with Claude Code.

`experiment.yaml` (the task substrate):

```yaml
$schema: https://schemas.bunsen.dev/experiment.v1.json
version: v1
name: fix-the-bug
task:
  prompt: |
    The test suite in /workspace is failing. Find and fix the bug.

workspace:
  sources:
    - path: ./workspace            # seeded repo, copied from the experiment dir
  setup:
    - run: cd /workspace && npm install
      timeout: 5m

environment:
  image:
    base: bunsen/headless
  requires:
    runtimes:
      node: ">=18"                 # substrate the codebase-under-test needs
    packages:
      apt: [git]
  user: user                       # 'user' (default) or 'root'

run:
  timeout: 15m
```

`agent.yaml` (the sealed toolkit):

```yaml
$schema: https://schemas.bunsen.dev/agent.v1.json
version: v1
name: claude-code

install:
  source:
    type: local
  build:
    image: ubuntu:22.04
    run:
      - |
        if ! command -v curl >/dev/null 2>&1; then
          apt-get update && apt-get install -y curl
        fi
        curl -fsSL https://claude.ai/install.sh | bash
        mkdir -p /output/bin
        cp "$HOME/.local/bin/claude" /output/bin/claude
        chmod +x /output/bin/claude
    timeout: 10m
  configure:
    - run: |
        if [ -n "$ANTHROPIC_API_KEY" ]; then
          MODEL="${ANTHROPIC_MODEL:-claude-sonnet-4-6}"
          printf '{"primaryApiKey":"%s","model":"%s"}\n' "$ANTHROPIC_API_KEY" "$MODEL" > ~/.claude.json
        fi
      as: root
      timeout: 2m

entrypoint:
  command: claude
  args:
    - --dangerously-skip-permissions
  help: claude --help

interaction:
  mode: supervised

model:
  env: ANTHROPIC_MODEL
  default: claude-sonnet-4-6
```

The experiment knows nothing about Claude Code; the agent knows nothing about the test fixture. Bunsen prepares the substrate from the experiment, mounts the agent's closure on top, and runs them together.

## Experiment Environment (`experiment.yaml`)

```yaml
$schema: https://schemas.bunsen.dev/experiment.v1.json
version: v1
name: my-experiment
task:
  prompt: ...

workspace:
  sources:
    - path: ./workspace
    - imagePath: /app/reference.png
      target: reference.png
  setup:
    - run: cd /workspace && npm install
      timeout: 5m

environment:
  image:
    base: bunsen/headless
    # or:
    # dockerfile: ./Dockerfile
  requires:
    runtimes:
      python: "3.11"
      node: ">=18"
    packages:
      apt: [git, gcc, make]
      npm: [typescript]
      pip: [pytest, coverage]
  platforms: [linux/amd64]
  user: user                # 'user' (default) or 'root'

run:
  timeout: 15m
  platform: auto             # 'auto', 'linux/amd64', or 'linux/arm64'
  artifactCaptureTimeout: 5m
```

The `environment.requires` block declares **substrate** — the runtimes and packages the task depends on (e.g. the Python the codebase-under-test imports, the apt build deps for the project's native extensions). It is not a contract negotiated with the agent. The agent operates on top of this without merging into it.

See the full field-level reference in [experiment.yaml Reference](./EXPERIMENT_YAML.md).

### Workspace sources

Initial immutable workspace inputs are declared under `workspace.sources` and assembled into `/workspace-source` before the agent runs. `/workspace` is then materialized from this snapshot.

```yaml
workspace:
  sources:
    - path: ./workspace
    - imagePath: /app/reference.png
      target: reference.png
```

**Rules:**

- Each entry declares exactly one of `path` or `imagePath`.
- `path` refers to a file or directory in the experiment repo (resolved relative to `experiment.yaml`).
- `imagePath` refers to a file or directory already present in the built image.
- `target` is an optional relative destination inside the workspace. Defaults: basename for files; directory contents merge into the workspace root.
- Sources are applied in declared order; path collisions fail validation.
- `/workspace-source` is always created — empty when no sources are declared — so scorers can rely on its presence.
- `/workspace-source` is part of the public scorer contract (see [Scorers & Evaluation](./SCORERS.md)).
- A `workspace:` block with no `sources` is valid. There is no implicit auto-include; any directory used as a workspace source must be declared explicitly.

### Workspace setup

`workspace.setup` is an ordered list of per-run shell commands run after `/workspace` has been materialized. Each step uses the shared step shape:

```yaml
workspace:
  setup:
    - run: npm install
      as: user            # 'user' (default) or 'root'
      timeout: 5m         # Duration string; default 5m per step
```

If a step needs root, set `as: root` on that step or set `environment.user: root` for the whole experiment (see [Running as Root (environment.user)](./ENVIRONMENT_USER.md)).

#### Step variants: run and writeFile

`workspace.setup` (and `install.configure`) steps share the same shape: each step is one of two variants — a `run` step or a `writeFile` step.

- **`run`** — `{run, as?, timeout?}`. Executes a shell command.
- **`writeFile`** — `{writeFile, from?|content?, as?, timeout?}`. Drops a file at a path inside the container (parent directories are auto-created; existing files are overwritten; mode `644`). Set exactly one of `from` (a path relative to the directory holding `experiment.yaml` / `agent.yaml`, copied from the host) or `content` (inline UTF-8, no env interpolation). The `writeFile` target path supports shell variable expansion (e.g. `$BUNSEN_WORKSPACE_DIR/config.json`). `writeFile` steps default to a 30 s timeout.

### Environment

| Field                      | Type                                          | Default              | Description                                                                                              |
| -------------------------- | --------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| `image.base`               | string                                        | `bunsen/headless`    | Bunsen base image to start from. Mutually exclusive with `image.dockerfile`.                             |
| `image.dockerfile`         | string                                        | —                    | Path to a custom Dockerfile (relative to `experiment.yaml`). Mutually exclusive with `image.base`.        |
| `requires.runtimes`        | `Record<RuntimeName, VersionSpec>`            | —                    | **Substrate** runtime names the task needs. Parsed, validated, and logged to the run log; the base image supplies the actual runtime (see "Substrate runtime syntax"). |
| `requires.packages`        | `PackageSpecs` (`apt`, `npm`, `pip`, `cargo`) | —                    | **Substrate** packages installed during image preparation (skipped for Dockerfile experiments). `apt`/`npm`/`pip` are installed; declare cargo dependencies via `install.build` instead (see "Packages and Dockerfiles"). |
| `platforms`                | `RunPlatform[]`                               | —                    | Restricts the supported execution platforms. If exactly one entry, Bunsen auto-selects it.                |
| `user`                     | `'user'` \| `'root'`                          | `'user'`             | Execution user inside the agent container. The default `'user'` runs as a non-root `bunsen` user; `'root'` skips non-root user creation entirely (see [Running as Root](./ENVIRONMENT_USER.md)). |

### Run

| Field                    | Type            | Default | Description                                                                                  |
| ------------------------ | --------------- | ------- | -------------------------------------------------------------------------------------------- |
| `timeout`                | duration string | `15m`   | Overall agent timeout.                                                                       |
| `platform`               | `auto` \| `linux/amd64` \| `linux/arm64` | `auto` | Per-experiment platform preference (see [Platforms & Architecture](./PLATFORMS.md)).               |
| `artifactCaptureTimeout` | duration string | `2m`    | Post-run artifact capture (diff, tar export, log retrieval).                                 |

### Substrate runtime syntax

`requires.runtimes` values are parsed, validated, and logged to the run log; the base image supplies whatever runtime it ships (Node 20, Python 3.11). Version constraints do not change the container image, and Bunsen does not switch runtimes (nvm, pyenv, rustup, etc.). If your task needs a specific runtime version that the base image does not ship, supply it via a custom Dockerfile, or have the agent ship it as a dep.

### Packages and Dockerfiles

`requires.packages` installs `apt`, `npm`, and `pip` during image preparation. Declare cargo dependencies via `install.build` steps instead.

For experiments with a custom `Dockerfile`, `requires.packages` is ignored during image preparation. Install dependencies in the Dockerfile itself; `install.configure` is for fast runtime-only config, not for installing tooling.

## Agent (`agent.yaml`)

Agents are sealed closures. `agent.yaml` declares the agent's source, its dep tree (`install.deps`), an optional cached build phase (`install.build`), and fast per-run wiring (`install.configure`). There is no runtime requirements block — the agent ships any runtime it pins to a specific version as a dep.

See the hosted [`agent.v1.json`](https://schemas.bunsen.dev/agent.v1.json) schema and [agent.yaml Reference](./AGENT_YAML.md) for the canonical schema.

```yaml
$schema: https://schemas.bunsen.dev/agent.v1.json
version: v1
name: claude-code

install:
  source:
    type: local

  build:
    image: ubuntu:22.04
    run:
      - |
        if ! command -v curl >/dev/null 2>&1; then
          apt-get update && apt-get install -y curl
        fi
        curl -fsSL https://claude.ai/install.sh | bash
        mkdir -p /output/bin
        cp "$HOME/.local/bin/claude" /output/bin/claude
        chmod +x /output/bin/claude
    timeout: 10m
    network: default
    cacheSalt: claude-code-build

  configure:
    - run: |
        if [ -n "$ANTHROPIC_API_KEY" ]; then
          MODEL="${ANTHROPIC_MODEL:-claude-sonnet-4-6}"
          printf '{"primaryApiKey":"%s","model":"%s"}\n' "$ANTHROPIC_API_KEY" "$MODEL" > ~/.claude.json
        fi
      as: root
      timeout: 2m

entrypoint:
  command: claude
  args:
    - --dangerously-skip-permissions
  help: claude --help

interaction:
  mode: supervised

# Declares the env var the harness reads its model from, so `bn run --model
# <id>` (and the `default` below) can target it without a per-model variant.
model:
  env: ANTHROPIC_MODEL
  default: claude-sonnet-4-6
```

### Fields

| Field                              | Type                                              | Default      | Description                                                                                                |
| ---------------------------------- | ------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| `install.source`                   | `InstallSource` (`local`/`git`/`npm`/`binary`)    | required (no default) | Where the agent code comes from.                                                                          |
| `install.deps`                     | `AgentDepSpec[]`                                  | —            | Declarative tool dependencies. Each entry produces a read-only mount at `/bunsen/deps/<name>/`. See "Install Deps".  |
| `install.build`                    | `BuildConfig`                                     | —            | Cached artifact build phase (produces read-only `/bunsen/artifacts` mount). Runs after `install.deps`.   |
| `install.build.image`              | string                                            | —            | Docker image used to run the build.                                                                        |
| `install.build.run`                | `string[]`                                        | —            | Ordered build commands.                                                                                    |
| `install.build.timeout`            | duration string                                   | `10m`        | Build timeout.                                                                                             |
| `install.build.network`            | `"default"` \| `"none"`                           | `default`    | Build network mode.                                                                                        |
| `install.build.cacheSalt`          | string                                            | —            | Manual cache-bust knob.                                                                                    |
| `install.configure`                | `StepConfig[]`                                    | —            | Fast per-run runtime configuration steps. Each step is either a `run` step (`{run, as?, timeout?}`) or a `writeFile` step (`{writeFile, from?\|content?, as?, timeout?}`, 30 s default timeout) — see ["Step variants: run and writeFile"](#step-variants-run-and-writefile). |
| `entrypoint.command`               | string                                            | —            | Executable invoked at run start.                                                                           |
| `entrypoint.args`                  | `string[]`                                        | —            | Guaranteed argv tokens appended to every invocation.                                                       |
| `entrypoint.help`                  | string                                            | —            | Help command consulted by the orchestrator.                                                                |
| `interaction.mode`                 | `"direct"` \| `"supervised"`                      | required (no default) | Run-loop mode (see [Supervised Mode](./SUPERVISOR.md)).                                                         |
| `model.env`                        | string                                            | —            | Env var the harness reads its model id from (e.g. `ANTHROPIC_MODEL`). Declaring it enables `bn run --model <id>`. See ["Model selection"](#model-selection). |
| `model.default`                    | string                                            | —            | Model id used when `--model` is not passed. Seeds `model.env` at the agent-defaults tier.                  |
| `defaults.env`                     | `Record<string, string>`                          | —            | Default env merged into the container before variant defaults and CLI overrides.                          |
| `defaults.passEnv`                 | `string[]`                                         | —            | Host env var names this agent allows through (host passthrough allowlist).                                 |

### Model selection

The model is an orthogonal axis from the variant. An agent declares the env var
its harness reads the model from in the top-level `model` block; the model id
itself is chosen at the command line:

```bash
bn run fix-the-bug claude-code --model claude-opus-4-7
bn run fix-the-bug gemini-cli --model gemini-2.5-flash
bn run fix-the-bug claude-code:headless --model claude-opus-4-7   # model ⟂ variant
```

`--model <id>` sets the agent's declared `model.env` variable. It rides the CLI
`--env` tier (precedence 7 below), so it overrides a model baked into a selected
variant; with no flag, `model.default` seeds the same variable at the
agent-defaults tier (precedence 2). The value the agent was configured with is
recorded on the run manifest (`agent.model`), distinct from `agent.models`, which
is what actually ran (observed from captured traces).

The model env var name is harness-specific — `ANTHROPIC_MODEL`, `CODEX_MODEL`,
`GEMINI_MODEL`, and so on — which is exactly why each agent declares it. The
harness consumes that variable directly, or via the config file the agent's
`install.configure` step generates from it. An agent that exposes no model knob
(a no-AI test agent, or a harness that routes models server-side) simply omits
the `model` block; `--model` is then rejected with a clear error.

Because model is its own axis, **variants are behavioral overlays** (run mode,
output format, turn caps, system prompts) rather than per-model duplicates — see
[agent.yaml Reference](./AGENT_YAML.md) for variant authoring. A variant should
pin a model only when its behavior genuinely requires one — e.g. claude-code's
`auto` variant, whose permission-mode auto classifier is only supported on a
specific model. When `--model` is passed alongside such a variant, the CLI wins
and prints a notice that the variant's model was overridden.

### Build artifacts and PATH

- Build outputs are written to `/output` in the build container.
- Preferred convention: executables in `/output/bin`.
- `install.build` outputs are mounted read-only at `/bunsen/artifacts` in run containers.
- Each `install.deps` entry is mounted read-only at `/bunsen/deps/<name>/`.
- Bunsen builds `PATH` as `/bunsen/artifacts/bin : /bunsen/artifacts : /bunsen/deps/<dep1>/bin : /bunsen/deps/<dep2>/bin : … : $PATH` (the agent's own build artifacts win, then deps in declared order, then substrate). The same PATH applies for:
  - `install.configure`
  - `workspace.setup`
  - agent execution
  - scorer commands (only when `evaluation.container: agent` — dedicated scorer containers do not mount `/bunsen/deps` or `/bunsen/artifacts`; see [Scoring in the Agent Container](./AGENT_CONTAINER_SCORING.md))
  - `install.build` itself (so the agent's build script can use any binary a dep provides)

This precedence is what makes asymmetric composition deterministic: tools the agent ships always shadow substrate-installed binaries with the same name. The cross-boundary shadow detector records each shadowing in the run manifest (see [Run Manifest & Events](./RUN_MANIFEST.md)).

## Install Deps (`install.deps`)

`install.deps` lets agent authors declare the CLIs, language runtimes, and tools their agent needs without burying the agent's identity under packaging boilerplate. Each entry produces an artifact tree mounted at `/bunsen/deps/<name>/` and is built once per `(name, version, target, image, network, timeout, run, provides, linkage, abi, requires)`.

For copy-pasteable recipes (GitHub release binaries, archives, bundled Node/Python, shipping a runtime, Alpine/musl), see the [Agent Dependencies Cookbook](./AGENT_DEPS_COOKBOOK.md).

### Linkage taxonomy

Every dep falls into one of three categories. Marking them explicitly with `linkage` makes cross-image expectations honest and informs the build cache key.

- **`static`** — the binary contains everything including its libc. Drop it anywhere with the right CPU arch. Examples: `ripgrep` musl build, `jq`, pure Go binaries. No `abi` block.
- **`closure`** — self-contained except for libc. The dominant case for language-runtime agents (Node, Python, Ruby). Examples: Bun-compiled native binaries, Astral's `python-build-standalone`, the official Node Linux tarballs. Requires `abi.libc` (`glibc` or `musl`) and optionally a version range.
- **`dynamic`** — depends on substrate libraries beyond libc. The author must declare expected libraries via `requires.libraries`. Reach for `closure` when possible; `dynamic` should be rare and explicit.

When `linkage` is omitted, it is recorded as `null` in the cache key (portability unknown). New deps should declare `linkage` explicitly.

### Authoring shape

```yaml
install:
  source:
    type: local
  deps:
    - name: ripgrep
      version: "14.1.1"
      image: debian:bookworm-slim
      linkage: static
      provides:
        binaries: [rg]
      install:
        - target: linux/amd64
          run:
            - apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates
            - curl -fsSL https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz | tar xz -C /tmp
            - cp /tmp/ripgrep-14.1.1-x86_64-unknown-linux-musl/rg /output/bin/rg
            - chmod +x /output/bin/rg
        - target: linux/arm64
          run: [...]

    - name: node
      version: "20.18.1"
      image: debian:bookworm-slim
      linkage: closure
      abi:
        libc: glibc
        libc_version: ">=2.28"
      provides:
        binaries: [node, npm, npx]
      install: [...]
```

| Field                | Required | Description                                                                                                                       |
| -------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | yes      | Kebab-case identifier. Used as the mount path under `/bunsen/deps/`.                                                              |
| `version`            | no       | Recorded in the run manifest and included in the cache key. Recommended for reproducibility.                                       |
| `description`        | no       | Human-readable docs.                                                                                                              |
| `image`              | dep- or per-target | Docker image used to **run the install commands**. Not the image the binary runs in at experiment time — see "Build image vs. experiment image" below. Either declared on the dep (default for every target) or on each `install[]` entry. |
| `linkage`            | recommended | `static`, `closure`, or `dynamic`. Drives portability expectations and is included in the cache key.                            |
| `abi.libc`           | for closure/dynamic | `glibc` or `musl`. The substrate libc the artifact targets. Forbidden on `static`.                                      |
| `abi.libc_version`   | no       | Optional version range. Recorded; not enforced.                                                                            |
| `requires.libraries` | for dynamic | List of `{name, version?}` substrate libraries the dep depends on. Forbidden on `static`.                                     |
| `provides.binaries`  | no       | Bare names of executables expected under `/output/bin/`. Verified at build time; used for conflict detection across deps and for cross-boundary shadow diagnostics. |
| `install[].target`   | yes      | One of `linux/amd64`, `linux/arm64`. Each target appears at most once.                                                            |
| `install[].run`      | yes      | Ordered shell commands. The build container starts with `/output/bin` precreated; write artifacts to `/output/...`.               |
| `install[].image`    | no       | Overrides the dep-level `image` for this specific target.                                                                         |
| `install[].network`  | no       | `default` (online) or `none`. Defaults to `default`.                                                                              |
| `install[].timeout`  | no       | Duration string (e.g. `10m`). Defaults to 10 minutes.                                                                             |

### File reference (lightweight reuse)

When the same dep is used by several agents in the same project, pull its spec into its own file and reference it:

```yaml
install:
  deps:
    - file: ./shared-deps/ripgrep-14.yaml
    - name: my-other-tool
      install: [...]
```

**Resolution rule:** the `file` path is resolved relative to the referring `agent.yaml`. No project-root search, no magic. Inline and file-referenced deps may be mixed freely.

The referenced file contains exactly the same `name`/`version`/`linkage`/`abi`/`install` shape as the inline form. Nested file references are rejected.

### Runtime contract

- Each dep's artifacts mount read-only at `/bunsen/deps/<name>/`.
- `/bunsen/deps/<name>/bin` is appended to `PATH` after `/bunsen/artifacts/bin` (in declared dep order). The agent's own `install.build` artifacts win on collisions.
- `install.deps` resolve and build/mount **before** `install.build` runs. The agent's build script can shell out to any binary a dep provides.
- The `provides.binaries` list is verified at build time — missing binaries fail the build loudly, preventing silent install regressions.
- The run manifest records each resolved dep's `(name, version, cache_key, binaries)` for reproducibility.

### Cross-boundary binary shadow diagnostic

When an agent dep ships a binary whose name matches a substrate apt package the experiment installs, Bunsen records a structured diagnostic in the run manifest:

```json
{
  "diagnostic": "cross-boundary-binary-shadow",
  "binary": "rg",
  "winner": { "source": "agent-dep", "name": "ripgrep", "version": "14.1.1" },
  "shadowed": { "source": "substrate-apt", "name": "rg" },
  "resolution": "agent dep wins on PATH (deterministic precedence: /bunsen/artifacts/bin → /bunsen/deps/<name>/bin → substrate)."
}
```

This is **record-and-proceed**, not a build blocker. The agent's PATH precedence is the resolver; the diagnostic is recorded in the run manifest so the shadowing is captured for inspection instead of silently corrupting cross-run comparisons. Detection is by name: an apt package whose installed binary has a different name than the package itself won't be caught.

### Cache invalidation

Each dep is keyed by `(name, version, target, image, network, timeout, run, provides, linkage, abi, requires)`. Editing any of those — including the `install[].run` command list — automatically changes the cache key and forces a rebuild on the next `bn run` / `bn agents build`. There is no manual cache-bust knob to flip and no `cacheSalt` field on deps: change the inputs, get a fresh build.

Note that an inline dep's `version` is *only* metadata for the cache key and run manifest — it does not pin the version that gets downloaded. If you bump `version` but leave the URL in `install[].run` unchanged, the cache rebuilds with the same binary. Either change both (when bumping the upstream version) or leave both alone (when iterating on shell-only details that don't affect the artifact).

A changed dep also invalidates the dependent `install.build` cache, because the dep's cache key is part of `install.build`'s key.

### Build image vs. experiment image

The dep's `image` is the container in which **the install commands execute**. It is not the container the dep's binary runs in at experiment time — that's the experiment's image (`environment.image.base` or the experiment's Dockerfile). The artifacts that the install commands write to `/output/` get mounted into the experiment container at run time; only the binaries cross the boundary, not the build image.

What this means for the author: compatibility runs through **the binary's ABI**, not the build image. The `linkage` field above is the contract.

A good model is a ripgrep dep that publishes per-target builds:

- `linux/amd64` target → downloads the `x86_64-unknown-linux-musl` build (`linkage: static` — runs anywhere).
- `linux/arm64` target → downloads the `aarch64-unknown-linux-gnu` build (glibc-static on every glibc base Bunsen runs on).

So the question to ask when picking `image` is: "does this image have the tools I need to *produce* the right shape of binary?" Not "does this image match the experiment image."

### Conflict detection

When two declared deps claim the same `provides.binaries` entry, Bunsen fails fast before any build runs. The error names every contributor and its version:

```
install.deps conflict detected:
  - binary "rg" is provided by multiple deps: ripgrep@14.1.1, ripgrep-mirror@13.0.0
```

Each binary may be provided by at most one dep — drop or rename the duplicate. (Substrate apt packages are *not* errors; they generate the diagnostic above.)

## Configure vs Workspace Setup

| Phase                  | Field                | Runs as                                | Default timeout                              | Purpose                                                       |
| ---------------------- | -------------------- | -------------------------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| Agent artifact build   | `install.build`      | root (build container)                 | `10m` (`install.build.timeout`)              | Build/download agent artifacts once and cache.                |
| Agent runtime configure| `install.configure`  | root by default; per-step `as:` allowed | `2m` per step                                | Fast runtime config (env-based files, links).                 |
| Workspace setup        | `workspace.setup`    | execution user by default; per-step `as:` allowed | `5m` per step                       | Per-run workspace prep (`npm install`, `pip install -e .`).   |

Rules for `install.configure`:

- Keep it fast and deterministic.
- Use it for env-dependent config files, symlinks, permissions.
- Do not install / download dependencies (use `install.deps` or `install.build`, or the experiment's Dockerfile).

## Build Cache Operations

Use these commands to manage `install.build` artifacts:

```bash
# Build artifacts ahead of time
bn agents build claude-code
bn agents build claude-code --platform linux/amd64

# Force rebuild and bypass the cache
bn agents build claude-code --rebuild
bn run fix-the-bug claude-code --rebuild-agent

# Inspect and clean the cache
bn cache list
bn cache rm <cache-key>
bn cache prune --force
```

See [Platforms & Architecture](./PLATFORMS.md) for how Bunsen chooses a single platform for image prep, platform runtimes, helper containers, and artifact cache keys.

## Resolution Logic

When `bn run <experiment> <agent>` executes:

1. Resolve **substrate** from the experiment alone: default runtimes (`node: "20"`, `python: "3.11"`) overlaid with `environment.requires.runtimes`, and substrate `environment.requires.packages`.
2. Prepare the substrate image (base image + apt/npm/pip installs).
3. Build (or fetch from cache) every `install.deps` entry in declared order.
4. Build (or fetch from cache) the agent's `install.build` artifacts. The dep tree is mounted and on PATH before this step runs.
5. Detect any cross-boundary binary shadows (agent dep binary names that match substrate apt package names) and record them as diagnostics in the run manifest. Non-blocking.
6. Mount the agent dep trees and build artifacts read-only into the run container.
7. Run `install.configure` (agent-side per-run wiring).
8. Run `workspace.setup` (experiment-side per-run wiring).
9. Execute the agent.

There is no agent/experiment runtime negotiation, no version intersection, no package merge. The agent walks in self-contained; the substrate provides whatever it provides.

## Docker Images

### Bunsen base images

| Image             | Contents                                                |
| ----------------- | ------------------------------------------------------- |
| `bunsen/headless` | Ubuntu 22.04, Python 3.11, Node.js 20, tmux, asciinema  |
| `bunsen/visual`   | Headless + Playwright/Chromium                          |
| `bunsen/desktop`  | Full desktop environment                                |

Bunsen base images happen to ship Node 20 and Python 3.11; those exist for the orchestrator, the supervisor, and `install.configure` shell scripts. **Agents do not depend on this.** An agent that needs a runtime ships its own via `install.deps`.

### Custom Dockerfiles

If an experiment provides a Dockerfile (`environment.image.dockerfile`), it takes precedence over `image.base`.

- Dockerfile experiments skip package-layer installs from `requires.packages`.
- Dockerfile experiments can provide immutable starter files via explicit `workspace.sources[]` `imagePath` entries (for example `imagePath: /workspace/reference.png` with `target: reference.png`).
- `install.configure` and `workspace.setup` still run at container start.
- `install.build` still works (artifacts are mounted at runtime, not baked into image layers).

For benchmark design, use that split intentionally:

- Prebuild expensive immutable artifacts in the Docker image when the verifier does not require the agent to produce them.
- Seed those artifacts into `/workspace` with `workspace.sources[]`.
- Leave expensive work in-run only when that expensive work is the thing being benchmarked.

## Scoring Contract

Scorer containers (dedicated or agent-shared) receive both:

- `/workspace` — a mutable copy (or live tree, in agent-container mode) of the agent's final workspace.
- `/workspace-source` — an immutable snapshot of the initial seeded inputs.

Use `/workspace-source` in verifiers when checking original fixtures or seeded inputs, and `/workspace` when checking agent-authored outputs or final workspace state. See [Scorers & Evaluation](./SCORERS.md) and [Scoring in the Agent Container](./AGENT_CONTAINER_SCORING.md).

`evaluation.container: agent` runs scorers inside the agent's own container (default is `dedicated`, a separate scorer container). The narrative report is configured at `evaluation.report` and is not a criterion. Both are documented in [Scorers & Evaluation](./SCORERS.md).

## Environment Variables

Environment variables are merged from several sources, **later wins**:

1. `bunsen.config.yaml` → `defaults.env`
2. `agent.yaml` → `defaults.env`
3. `experiment.yaml` → `env`
4. Selected agent variant's `defaults.env`
5. Selected experiment variant's `env`
6. CLI `--env-file` files (in order)
7. CLI `-e` / `--env` flags
8. Platform-reserved `BUNSEN_*` vars — **immutable; collisions are rejected**

`bn run --model <id>` is sugar over this list: it sets the agent's declared
`model.env` variable at the CLI `--env` tier (7), while the declared
`model.default` contributes at the agent-defaults tier (2). An explicit `--env
<model.env>=...` still wins over `--model` (it lands later in the flag list). See
["Model selection"](#model-selection).

Host passthrough only happens through explicit `passEnv` (project, agent, experiment, or `--pass-env` on the CLI). The major LLM provider API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`) are allowlisted by default.

### Reserved `BUNSEN_*` names

The runtime injects these; user config cannot override them (parsers reject `BUNSEN_*` keys in `env` / `passEnv` blocks):

- `BUNSEN_RUN_ID`, `BUNSEN_EXPERIMENT`, `BUNSEN_AGENT`
- `BUNSEN_EXPERIMENT_VARIANT`, `BUNSEN_AGENT_VARIANT` (set only when selected)
- `BUNSEN_WORKSPACE_DIR` (`/workspace`)
- `BUNSEN_WORKSPACE_SOURCE_DIR` (`/workspace-source`)
- `BUNSEN_OUTPUT_DIR` (`/bunsen/output`)
- `BUNSEN_TASK_FILE` (`/bunsen/task/prompt.md`), `BUNSEN_TASK_DIR` (`/bunsen/task`)
- `BUNSEN_RUN_DIR` (`/bunsen/run`)
- `BUNSEN_AGENT_HOME` (`/home/bunsen` for non-root runs, `/root` when `environment.user: root`). Use this in `install.configure` scripts to write user-level config files (`$BUNSEN_AGENT_HOME/.codex/config.toml`, `$BUNSEN_AGENT_HOME/.claude.json`, etc.) without needing to know the execution user. The runtime chowns this directory to the execution user after `install.configure` finishes.
- `BUNSEN_PLATFORM` (resolved run platform)
- `BUNSEN_SUITE_ID`, `BUNSEN_SUITE_VERSION` (set only when running via a suite)

## See also

- [How Bunsen Works](./HOW_IT_WORKS.md) — the end-to-end run lifecycle.
- [experiment.yaml Reference](./EXPERIMENT_YAML.md) and [agent.yaml Reference](./AGENT_YAML.md) — full field-level schemas.
- [Agent Dependencies Cookbook](./AGENT_DEPS_COOKBOOK.md) — copy-pasteable `install.deps` recipes.
- [Running as Root (environment.user)](./ENVIRONMENT_USER.md) — when and how to run as root.
- [Platforms & Architecture](./PLATFORMS.md) and [Packages & Schemas](./PACKAGES.md).
- [Glossary](./GLOSSARY.md) — definitions of agent under test, platform agents, substrate, criterion, scorer, and verifier.
