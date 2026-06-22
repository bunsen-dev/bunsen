# Glossary

Bunsen reuses a few words a lot — *agent*, *scorer*, *platform* — in ways that
are easy to conflate. This page is the canonical definition for each term. Other
docs link here rather than redefining them.

## Core model

**Experiment** — the unit defined by an [`experiment.yaml`](./EXPERIMENT_YAML.md):
a task, the container environment it runs in, and how the result is evaluated. An
experiment is the thing you `bn run`. Do not call the whole experiment a "task" —
the task is one field inside it.

**Task** — the work the agent under test must accomplish, expressed in natural
language as `task.prompt`. One experiment has exactly one task.

**Agent under test** — the agent being evaluated: the thing you are running the
experiment *on*. Defined by an [`agent.yaml`](./AGENT_YAML.md). Bunsen is
agent-agnostic — an agent under test can be a CLI, a script, an npm package, or a
downloaded binary. In prose we always write "agent under test" (never "AUT") to
keep it distinct from the two senses below.

**Platform agents** — the three Bunsen-supplied agents that run *inside the
container* to operate the experiment: the **orchestrator** (works out how to
invoke the agent under test), the **supervisor** (keeps an interactive agent
moving in [supervised mode](./SUPERVISOR.md)), and the **scorer** (executes LLM
criteria). These are infrastructure; you do not author them. See
[How Bunsen Works](./HOW_IT_WORKS.md).

**Run** — one execution of an experiment with an agent. Each run gets its own
container, its own directory of outputs, and an entry in the
[run manifest](./RUN_MANIFEST.md).

## Environment

**Substrate** — the container baseline an experiment declares: the base image
plus any runtimes, packages, and services the *task* needs. The experiment owns
the substrate. See [The Environment Model](./ENVIRONMENT.md).

**Sealed closure** — how an agent ships its own toolkit (and any runtime it pins)
via `install`, independent of the substrate. The agent and the substrate coexist
in one container without negotiating a merge — this is the **asymmetric
composition** model. See [The Environment Model](./ENVIRONMENT.md#asymmetric-composition).

**Workspace** (`/workspace`) — the mutable directory the agent under test works
in. Materialized at run start from the immutable sources.

**workspace-source** (`/workspace-source`) — an immutable snapshot of the
initial seeded inputs. `/workspace` is materialized from it, so the original
inputs are always available for comparison and re-runs.

## Evaluation

**Criterion** — one user-authored entry under `evaluation.criteria` in an
experiment, with a `type` and a weight. Criteria are what you write to define
"did the agent succeed?" See [Scorers & Evaluation](./SCORERS.md).

**Criterion type** — one of five values a criterion can take:

| Type            | What it does                                        |
| --------------- | --------------------------------------------------- |
| `script`        | Runs a shell command; deterministic, near-zero cost |
| `judge`         | A single LLM call with attached evidence, no tools  |
| `agent`         | A full agent loop with tools                         |
| `browser-agent` | An agent loop with screenshots / Playwright         |
| `aggregate`     | A mathematical combination of other criteria        |

**Scorer** — the engine that executes a criterion. "Scorer" is the runner;
"criterion" is the rubric entry it runs. (The run manifest records a
`scorerType` field for each result — that manifest vocabulary is separate from
the authoring `type` above; see [Run Manifest & Events](./RUN_MANIFEST.md).)

**Verifier** — a helper file or asset placed in an experiment's `verifiers/`
directory, mounted read-only at `/bunsen/verifiers` during scoring. A `script`
criterion typically calls a verifier. A verifier is a *file*; a criterion is the
*rubric entry* that runs it.

**Report** — the optional narrative summary configured at `evaluation.report`. It
runs once after all criteria and produces a markdown artifact with **no numeric
score**. It is not a criterion type.

**Gate** — a criterion marked `gate: true` that short-circuits the rest of
scoring when it fails — e.g. skip expensive LLM judging when the cheap `script`
tests already failed. See [Scorers & Evaluation](./SCORERS.md).

## Configuration

**Variant** — a named overlay on an `experiment.yaml` or `agent.yaml` that tweaks
it without duplicating the whole file (a harder prompt, an extra flag). Variants
are **behavioral only**.

**Model axis** — the model is chosen separately from variants, with
`bn run … --model <id>`, against the agent's `model` block. Do not author
per-model variants; pick the model on the command line. See
[agent.yaml Reference](./AGENT_YAML.md#model).

**Suite** — a versioned group of related experiments distributed as one git
repository (e.g. Terminal Bench). See [Suites](./SUITES.md).

**Experiment ref** — how you name an experiment to `bn run`. Unqualified
(`fizzbuzz`) resolves locally first, then across suites; qualified forms
(`terminal-bench/<task>`, `github.com/org/repo/<task>`) are unambiguous. See
[Suites](./SUITES.md).

## Platforms

**Platform** — a `linux/<arch>` value: `linux/amd64` or `linux/arm64`. Use
"platform" for the full value.

**Architecture** (**arch**) — the bare `amd64` / `arm64` part. Reserve "arch"
for when you specifically mean that suffix. See
[Platforms & Architecture](./PLATFORMS.md).

## Cost

**Headline model** — the model Bunsen labels a run with: its highest-cost model.
Used so runs can be grouped and compared by the model that dominated their spend.
See [Cost Accounting](./COST.md).
