# Environment Internals

The mechanics behind [The Environment Model](./ENVIRONMENT.md). That doc is the
**authoring guide** — what the `experiment.yaml` / `agent.yaml` fields mean and how
to compose them. This is the **internals reference**: how composition actually
works inside the run container — the PATH precedence, the ABI/linkage contract, the
per-phase execution contexts, and the caches. Read this when you need to settle a
"but *why* does it behave that way" question precisely.

If you only remember one thing: **composition is asymmetric and un-negotiated.**
Three independent parties each contribute pieces to one container, and none of them
asks the others for anything. Everything below is a consequence of that.

## The three ownership domains

Every file, mount, binary, and process in a run belongs to exactly one of three
domains. Keeping them straight is the key to everything else.

| Domain | Owned by | Contributes | Declared in |
|--------|----------|-------------|-------------|
| **Substrate** | the experiment | base image, `requires.runtimes`/`packages`, services, the seeded workspace | `experiment.yaml` |
| **Closure** | the agent | a sealed toolkit it ships itself (`install.deps`, `install.build`, `install.configure`) | `agent.yaml` |
| **Platform** | Bunsen | the orchestrator/supervisor/scorer bundles, the proxy, and the Node runtime its own tools run on | the runtime, injected |

- The **substrate** is "what the task needs to exist" — the compiler the code-under-test imports, the apt packages, the language runtime the *image* ships. It does **not** negotiate with the agent.
- The **closure** is "what the agent brings, pinned to versions it controls." It's sealed: if the agent needs Node, it *ships* Node; it never assumes the substrate has it. That's what makes any-agent × any-experiment compose.
- The **platform** is Bunsen's own machinery. It also follows the closure rule for itself — for a custom image that lacks Node, the platform mounts *its own* Node (see [The two Node runtimes](#the-two-node-runtimes)). Platform agents are summarized [at the end](#platform-agents-the-short-version); their depth lives in [Platform Tools](./PLATFORM_TOOLS.md), [Supervised Mode](./SUPERVISOR.md), and [Scorers & Evaluation](./SCORERS.md).

The rest of this doc is the seams between these three.

## Container layout (orientation)

You need a rough map of the filesystem to follow the PATH and execution sections;
the authoritative per-mount table (target, RO/RW, when present) lives in
[Platform Tools → Container Paths](./PLATFORM_TOOLS.md#container-paths) and
[The Environment Model](./ENVIRONMENT.md). The short version, grouped by domain:

```
/workspace                      substrate→agent   RW   the agent's working tree (materialized from source)
/workspace-source               substrate         RO   immutable snapshot of the seeded inputs

/bunsen/deps/<name>/            closure           RO   one mount per install.deps entry
/bunsen/artifacts/             closure           RO   install.build output (/output → here)

/bunsen/lib/*.cjs              platform          RO   orchestrator / scorer / supervisor / gitignore-filter bundles
/bunsen/runtime/node           platform          RO   the mounted platform Node (custom images only)
/bunsen/runtime/proxy-bootstrap.cjs  platform    RO   undici proxy shim (when trace capture is on)

/bunsen/run/                   platform          RW   run context (logs, completion markers, agent-script.sh)
/bunsen/output/                platform          RW   agent-authored artifacts ($BUNSEN_OUTPUT_DIR)
/bunsen/verifiers/             substrate         RO   the experiment's verifiers/ (when present)
/bunsen/task/                  platform          RO   the exact task prompt
```

Two facts to carry forward: closure and platform binaries live in **separate**
mount trees (`/bunsen/deps`, `/bunsen/artifacts` vs `/bunsen/lib`, `/bunsen/runtime`),
and everything Bunsen mounts is **read-only** — a hostile agent can't tamper with
the platform's tools or runtime.

## PATH semantics

This is where asymmetric composition becomes concrete, and it's the most common
source of "wait, which binary runs?" confusion.

### The agent PATH

For the agent's own execution (and the phases that wire it up), Bunsen composes:

```
/bunsen/artifacts/bin : /bunsen/artifacts : /bunsen/deps/<dep1>/bin : … : [$HOME/.local/bin] : $PATH
```

Built by `buildDepsPathPrefix()` and injected as a literal `export PATH=…` line
prepended to the relevant **scripts** (not set on the container globally). The
precedence is deliberate and total:

1. the agent's own `install.build` artifacts (`/bunsen/artifacts/bin`, then `/bunsen/artifacts`)
2. its `install.deps`, in **declared order**
3. (`$HOME/.local/bin` for non-root runs)
4. the substrate (`/usr/local/bin`, `/usr/bin`, …) via the inherited `$PATH`

So a tool the agent ships **always** shadows a substrate binary of the same name.
That's the point: the agent gets a deterministic toolchain regardless of what the
image happens to contain.

### Which execution contexts get the agent PATH — and which don't

This is the crux. The agent PATH is **scoped to agent-facing scripts**, not the
container. It applies to:

- `install.build` (so the build can use any dep's binary)
- `install.configure`
- `workspace.setup`
- the **agent's** own execution

It does **not** apply to the platform tools — the orchestrator, supervisor, and **scorers**:

- the **orchestrator** and **supervisor** run as their own `docker exec` whose env carries **no PATH key at all** — so they inherit the *image's baseline* PATH, never `/bunsen/deps`.
- **scorers** don't get the deps PATH either, and it's worth being precise about why. The scorer *engine* (`scorer.cjs`) is a platform tool launched on the platform node (`nodeCmd`). The *commands* it dispatches — a `script` criterion's `run:`, an agentic scorer's `run_command` — exec through `buildScorerExecOptions`, which sets the scorer's user and a few `BUNSEN_*` helper vars but **no** deps PATH, so they get the container's **baseline** PATH.

The mechanism is just "separate `docker exec`, separate env." "Agent's tool is
first on PATH" is true only *inside the agent's own process tree*.

For scorers, the **dedicated vs. agent-container** choice is about *what's reachable*,
not PATH. A **dedicated** scorer container (the default) is a fresh container from the
experiment image and doesn't mount `/bunsen/deps` or `/bunsen/artifacts` at all.
**Agent-container** scoring (`evaluation.container: agent`) runs the scorer inside the
agent's own container, so it sees the agent's final `/workspace`, its running
services, and anything it installed to standard locations (`/usr/bin`, site-packages —
already on the baseline PATH). What's preserved is the agent's filesystem/process
**state**, not its closure-dep PATH prefix: `/bunsen/deps/<name>/bin` is mounted but
not auto-added to the scorer's PATH.

### How the platform finds *its* Node despite the agent's PATH

The platform tools are launched with an explicit node command:

```
nodeCmd = needsNodeRuntime ? '/bunsen/runtime/node' : 'node'
```

- On a **custom / non-bunsen image** (`needsNodeRuntime`), that's an **absolute path** — PATH is irrelevant; it always runs the platform's mounted Node.
- On a **Bunsen base image**, it's bare `node`, resolved against the image's baseline PATH (the controlled Node 20 the image ships) — and because the orchestrator's exec has no agent PATH, the agent's Node can't shadow it.

### The cross-boundary binary shadow diagnostic

There *is* one place shadowing is surfaced rather than silent: when an agent
`install.deps` binary has the same name as a binary a **substrate apt package**
installs. Bunsen records a `cross-boundary-binary-shadow` entry in the run manifest
(record-and-proceed; the agent's PATH precedence is the deterministic resolver).
Note the scope: this is **closure vs substrate, within the agent's own PATH**. The
platform's Node is *not* part of this contest, because the platform never resolves
through the agent PATH.

## ABI & linkage

The agent ships binaries built somewhere else and expects them to run inside an
arbitrary experiment image. What makes that safe is an explicit **ABI contract**,
declared per dep via `linkage` (+ `abi`). If those two words aren't already second
nature, here's the mental model (skip to the table if they are).

A compiled binary usually isn't self-contained. At startup it asks the OS to load
the **shared libraries** it depends on — `.so` files — the most universal being the
**C library (libc)**, which nearly every program calls for basics like memory, file
I/O, and threads; a small **dynamic loader** wires those up when the process starts.
**Linkage** is *how* a binary resolves them: **static** linking bakes every library
(libc included) *into* the binary, so it runs anywhere with the right CPU and OS;
**dynamic** linking leaves them out and resolves them from the target system at
runtime — smaller, but only if the target actually provides compatible versions.

That word *compatible* is what the **ABI (Application Binary Interface)** governs.
The ABI is the low-level contract between a binary and what it links against:
calling conventions, struct layouts, symbol versions, the path to the loader. Two
systems can compile the same source yet expose incompatible ABIs, so a binary built
against one refuses to load on the other. A `version 'GLIBC_2.34' not found` error,
or a binary that "doesn't exist" even though the file is right there (the loader it
names is missing) — those are ABI mismatches.

In Bunsen this is load-bearing because of asymmetric composition: a dep is **built
in one image but runs in a different one**. Two things vary across that gap. **CPU
architecture** is pinned — each dep declares per-`target` builds (`linux/amd64`,
`linux/arm64`), so the right binary is produced for the run platform. The **libc
ABI** is the remaining variable, and it's exactly what `abi.libc` makes explicit:
Bunsen runs into two libc implementations — **glibc** (Debian, Ubuntu, most images,
including every Bunsen base image) and **musl** (Alpine) — and they are *not*
interchangeable. A binary dynamically linked against glibc won't run on a musl-only
image. Declaring `linkage`/`abi` is the author stating which ABI a binary expects,
so "any agent × any experiment" stays honest instead of "works on the image I built
against" — and so the contract can fold into the cache key.

The three linkage classes:

| `linkage` | Self-contained? | `abi` | Examples |
|-----------|-----------------|-------|----------|
| `static` | everything, incl. libc | forbidden | musl `ripgrep`, `jq`, pure-Go binaries |
| `closure` | everything **except** libc | `abi.libc` required (`glibc`/`musl`) | official Node Linux tarballs, `python-build-standalone`, Bun-compiled binaries |
| `dynamic` | depends on substrate libs beyond libc | must declare `requires.libraries` | rare; reach for `closure` first |

`closure` is the dominant case for language-runtime agents. The one thing it isn't
free of is **libc**: a glibc closure runs on every Bunsen base image and the common
custom bases (debian/ubuntu/CUDA/distroless-glibc), but **not** on musl/Alpine —
that requires `abi.libc: musl` and a musl-targeted build.

### Build image ≠ experiment image

A dep's `image` is the container its **install commands run in** to *produce* the
binary — **not** the container the binary runs in at experiment time (that's the
experiment's image). Only the artifacts under `/output` cross the boundary. So the
question when picking `image` is *"does this image have the tools to produce the
right shape of binary?"*, not *"does it match the experiment image?"* — compatibility
runs through the **binary's ABI** (the `linkage`/`abi` you declared), not through
the build image. This is also why `linkage`/`abi` are part of the dep cache key
(see [Caching](#caching--cache-keys)).

## The two Node runtimes

Because both the platform and many agents use Node, it's worth being explicit that
there are **two independent Node binaries** in a custom-image run, and they never
collide:

| | Agent's Node | Platform's Node |
|---|---|---|
| Who uses it | the agent-under-test | Bunsen's orchestrator / supervisor / scorers |
| Path | `/bunsen/deps/node/bin/node` (a `closure` dep) | `/bunsen/runtime/node` |
| Version | whatever the agent declared | one Bunsen-pinned version (`node-runtime-manifest.json`) |
| On the agent PATH? | yes | no |
| How it's obtained | the agent's `install.deps` `run:` commands | a layered resolver (override → bundled asset → from-source → host cache → sha256-verified download) |

The four reasons they don't interfere: (1) different read-only mount paths; (2) the
platform invokes its Node by absolute path on custom images / baseline-PATH `node`
on bunsen images; (3) the agent PATH is script-scoped, so platform execs never see
`/bunsen/deps`; (4) platform tools and the agent are separate `docker exec` calls.
The platform runtime's acquisition (and why it's a single pinned version, unlike
agent runtimes which are unbounded and author-declared) is detailed in
[Platform Tools](./PLATFORM_TOOLS.md).

## Execution-context matrix

Putting PATH, user, and mounts together for every phase of a run. "Agent PATH" means
the prefix from [PATH semantics](#path-semantics); "baseline" means the image's
default PATH with no agent closure on it. Phases run in declared order; non-applicable
ones are skipped.

| Phase | Container | Runs as | PATH | cwd | Notes |
|-------|-----------|---------|------|-----|-------|
| `install.deps` build | ephemeral, the **dep's** `image` | root | build image baseline | — | each dep builds in isolation; output → `/output` → `/bunsen/deps/<name>/` |
| `install.build` | ephemeral, `build.image` | root | **agent PATH** (deps mounted + on PATH) | — | sees `install.deps`; output → `/output` → `/bunsen/artifacts/` |
| workspace-source assembly | run container | root | baseline | — | builds `/workspace-source` from `workspace.sources[]` |
| user creation + handoff | run container | root | baseline | — | creates `bunsen` (skipped if `environment.user: root`); chowns while `/workspace` is empty |
| workspace materialization | run container | execution user | baseline | — | copies `/workspace-source` → `/workspace`, correctly owned |
| `install.configure` | run container | root (per-step `as:`) | **agent PATH** | — | fast runtime config; before `workspace.setup` |
| `workspace.setup` | run container | execution user (per-step `as: root`) | **agent PATH** | `/workspace` | per-run prep (`npm install`, …) |
| **orchestrator** | run container | root-ish exec | **baseline** (no agent PATH) | — | `nodeCmd /bunsen/lib/orchestrator.cjs`; env = platform key + `BUNSEN_*_PATH` + proxy; 1 LLM call → invocation |
| **agent execution** | run container | execution user (`su bunsen`) or root | **agent PATH** | `/workspace` | the agent-under-test; full merged env + reserved `BUNSEN_*` |
| **supervisor** | run container | exec | **baseline** | — | `nodeCmd /bunsen/lib/supervisor.cjs`, drives tmux; only in `supervised` mode |
| scorer — **dedicated** (default) | separate scorer container, experiment image | execution user or root | **baseline** (no `/bunsen/deps`/`artifacts` mounted) | — | engine on `nodeCmd`; mounts `/workspace` (RW copy) + `/workspace-source` (RO) |
| scorer — **agent container** (`evaluation.container: agent`) | the agent's container, via `docker exec` | the agent's execution user | **baseline** | — | engine on `nodeCmd`; sees the agent's final `/workspace`, services, and standard-location installs; deps mounted but not on PATH |

The ordering exists for a reason: assembling `/workspace-source` and creating the
`bunsen` user *before* `/workspace` is materialized means the chown is trivial and a
gigabyte seed never forces a recursive `chown -R`.

## Caching & cache keys

Four caches, each content-addressed by a different key. Edit any keyed input → the
entry misses and rebuilds; there is no "force" knob for deps (change the inputs).

| Cache | Location | Scope | Key (sha256 of) |
|-------|----------|-------|-----------------|
| `install.deps` | `.bunsen/deps-cache/<name>-<key>` | **project** | `schemaVersion`, `name`, `version`, `target`, `arch`, `image`, `network`, `timeout`, `run`, `provides`, `linkage`, `abi`, `requires` |
| `install.build` | `.bunsen/build-cache/<key>` | **project** | `image`, `platform`, `arch`, `timeout`, `network`, `cacheSalt`, `contextHash`, **`depKeys[]`** |
| platform Node runtime | host cache (`BUNSEN_CACHE_DIR` / OS default) | **host** (per-user) | not hashed — version-namespaced `node-runtimes/v<version>/node-<arch>`, sha256-pinned at fetch |
| suite | `.bunsen/suites/<host>__<org>__<repo>` | project | git clone at the pinned ref |

Two things worth internalizing:

- **`linkage`/`abi` are in the dep key** (they joined at `schemaVersion: 2`). Re-declaring a dep from `dynamic` to `closure`, or `glibc` to `musl`, is a different artifact and correctly forces a rebuild.
- **A changed dep invalidates `install.build`**, because every dep's `cacheKey` is folded into the build key (`depKeys[]`). The agent's build environment includes its deps, so they have to.

The platform runtime cache is the one deliberate **host-level** cache (everything
else is project-local `.bunsen/`): the runtime is a single Bunsen-pinned, project-
invariant binary, so a per-user shelf avoids re-downloading it per checkout and is
the writable location a read-only standalone binary needs.

## Environment variables that come into play

### Reserved `BUNSEN_*` — injected, immutable

The runtime injects these into the run; user config (`env`/`passEnv`) that tries to
set a `BUNSEN_*` key is rejected. They're how the agent and platform tools find
things without hard-coding paths:

`BUNSEN_RUN_ID`, `BUNSEN_EXPERIMENT`, `BUNSEN_AGENT`, `BUNSEN_EXPERIMENT_VARIANT` /
`BUNSEN_AGENT_VARIANT` (when set), `BUNSEN_WORKSPACE_DIR` (`/workspace`),
`BUNSEN_WORKSPACE_SOURCE_DIR`, `BUNSEN_OUTPUT_DIR`, `BUNSEN_TASK_FILE` / `BUNSEN_TASK_DIR`,
`BUNSEN_RUN_DIR`, `BUNSEN_AGENT_HOME`, `BUNSEN_PLATFORM`, `BUNSEN_SUITE_ID` /
`BUNSEN_SUITE_VERSION`.

Host-side resolver knobs (read on the host, not injected into the container):
`BUNSEN_ASSET_DIR` (where shipped assets live), `BUNSEN_CACHE_DIR` (host cache root),
`BUNSEN_NODE_RUNTIME_DIR` (runtime override), `BUNSEN_NODE_OFFLINE` (forbid the
runtime fetch).

### The platform API key is separate

`BUNSEN_ANTHROPIC_API_KEY` (platform — orchestrator/supervisor/scorers) is kept
distinct from the agent's `ANTHROPIC_API_KEY`. It's passed **directly to the platform
execs**, not set on the container's base environment — so the agent-under-test never
sees the platform's key (except in `evaluation.container: agent`, where the scorer
shares the agent container). If `BUNSEN_ANTHROPIC_API_KEY` is unset, the platform
falls back to `ANTHROPIC_API_KEY`.

### Precedence (the agent's own env)

The agent's environment is merged, **later wins**: project `defaults.env` → agent
`defaults.env` → experiment `env` → selected agent-variant env → selected
experiment-variant env → `--env-file`(s) → `-e/--env` (and `--model`, which rides
this tier) → platform-reserved `BUNSEN_*` (always win, immutable). Full detail in
[The Environment Model → Environment Variables](./ENVIRONMENT.md#environment-variables).

## Platform agents (the short version)

Only enough to read the sections above; full treatment is each tool's own doc.

- **Orchestrator** — runs once before the agent; reads the experiment + agent config and emits the concrete `setupCommands` + `invocation`. One forced LLM tool-call.
- **Supervisor** — `supervised` mode only; watches the agent in tmux and answers interactive prompts via the LLM. See [Supervised Mode](./SUPERVISOR.md).
- **Scorer** — evaluates the finished run (`script`/`judge`/`agent`/`browser-agent`/`aggregate` + the `report` step), in a dedicated container or the agent's own. See [Scorers & Evaluation](./SCORERS.md).
- **Proxy** — a mitmproxy sidecar that captures **only the agent-under-test's** model traffic (platform agents bypass it), for traces + cost. See [Platform Tools](./PLATFORM_TOOLS.md) and [Cost Accounting](./COST.md).

All four are JS bundles (`/bunsen/lib/*.cjs`) that run on the platform Node — the
image's Node 20 on Bunsen base images, the mounted `/bunsen/runtime/node` on custom
images. They are *platform* domain: they never appear on the agent's PATH and the
agent never sees their key.

## See also

- [The Environment Model](./ENVIRONMENT.md) — the authoring-level companion to this doc.
- [Agent Dependencies Cookbook](./AGENT_DEPS_COOKBOOK.md) — copy-pasteable `install.deps` (incl. shipping a runtime).
- [Platform Tools](./PLATFORM_TOOLS.md) — the platform-agent bundles, container paths, and the Node-runtime resolver.
- [Running as Root](./ENVIRONMENT_USER.md), [Scoring in the Agent Container](./AGENT_CONTAINER_SCORING.md), [Platforms & Architecture](./PLATFORMS.md).
