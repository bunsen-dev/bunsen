# Introduction

Bunsen is a general-purpose experiment runner for agentic systems. You give an
agent an environment, run it reproducibly, capture everything it did, and
evaluate the result.

**Environment-first, agent-agnostic.** You describe the *environment and task* —
not how a particular agent works — and Bunsen figures out how to invoke whatever
agent you point at it. The same experiment can be run against Claude Code, a
custom Python agent, an npm-published CLI, or a downloaded binary, and scored the
same way.

## What a run produces

Every `bn run` executes in its own Docker container and captures, automatically:

- **Artifacts** — the final workspace, a diff of everything that changed, and an
  optional exportable tarball.
- **AI traces** — the full request/response history of the agent's model calls,
  organized into conversation threads.
- **Cost** — token usage and dollar cost, derived from the captured traces.
- **Scores** — the result of your evaluation criteria, normalized to `[0, 1]`,
  plus an optional narrative report.
- **Logs and a terminal recording** (when enabled) for replay.

You inspect all of it with `bn runs …` or in the local web viewer
(`bn runs open`). See [Run Manifest & Events](./RUN_MANIFEST.md) for the full
output layout.

## The two-file model

A Bunsen experiment is two declarative files:

- **[`experiment.yaml`](./EXPERIMENT_YAML.md)** defines the *environment*: the
  task prompt, the container substrate (image, runtimes, packages), the workspace
  inputs, and the evaluation criteria.
- **[`agent.yaml`](./AGENT_YAML.md)** defines a *pluggable agent*: where to get
  it, how to install it, how to invoke it, and which model env var it reads.

Keeping them separate is the whole point: one experiment runs against many
agents, and one agent runs against many experiments. The agent ships its own
toolkit as a [sealed closure](./GLOSSARY.md#environment); the experiment owns the
[substrate](./GLOSSARY.md#environment). They compose in one container without a
merge contract — see [How Bunsen Works](./HOW_IT_WORKS.md).

## Who it's for

Bunsen is for researchers and engineers who want to:

- **Benchmark agents** against published suites like
  [Terminal Bench](./RUN_TERMINAL_BENCH.md) — or against each other.
- **Wrap their own task** as a reproducible, scored experiment and iterate on it.
- **Inspect agent behavior** deeply — traces, diffs, cost — to turn a run into
  evidence rather than a vibe.

## Where to go next

1. **[Getting Started](./GETTING_STARTED.md)** — install the CLI and run your
   first experiment end to end.
2. Then pick a path:
   - **[Run a Terminal Bench Task](./RUN_TERMINAL_BENCH.md)** — point Bunsen at
     an existing benchmark and score a real agent, with zero authoring.
   - **[Bring Your Own Task](./BRING_YOUR_OWN_TASK.md)** — wrap your own task as
     an experiment with your own pass/fail check.

New to the vocabulary? The [Glossary](./GLOSSARY.md) defines every overloaded
term in one place.
