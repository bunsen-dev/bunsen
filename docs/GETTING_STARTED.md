# Getting Started

This page takes you from nothing to a scored run in a few minutes, then points
you at the path that fits what you're doing.

## Prerequisites

- **Docker** — every run executes in a container. Docker Desktop or Engine, running.
- **Node.js ≥ 22** — the CLI ships as an npm package.
- **An Anthropic API key** — Bunsen's orchestrator and LLM evaluation run on
  Claude. Set `ANTHROPIC_API_KEY` in your environment (or a `.env` file in your
  project — Bunsen loads it automatically).

## Install the CLI

```bash
npm i -g @bunsen-dev/cli
bn doctor   # verify Docker, git, and your environment
```

This puts `bn` (and the `bunsen` alias) on your PATH. `bn doctor` tells you if
anything is missing before you run.

## Run your first experiment

Scaffold a project with a tiny bundled example, then run it:

```bash
mkdir my-lab && cd my-lab
bn init --example          # writes bunsen.config.yaml + a hello-world experiment + echo-agent
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

bn run hello-world echo-agent
```

What just happened: Bunsen built a container from the experiment's base image,
the **orchestrator** worked out how to invoke `echo-agent`, ran it against the
task, captured everything, and scored the result with a deterministic `script`
criterion. `echo-agent` makes no model calls itself — but the orchestrator and
evaluation do, which is why the API key is needed even here.

## View the result

```bash
bn runs show              # summary of the most recent run: score, cost, status
bn runs open              # open the run in the local web viewer
```

`bn runs show` prints the score and a per-criterion breakdown. `bn runs open`
serves an interactive viewer (traces, diff, artifacts) at `http://localhost:3456`.
For everything a run captures and where it lives on disk, see
[Run Manifest & Events](./RUN_MANIFEST.md).

## Where to next

You've seen the full loop. Now pick the path that matches your goal — each is
self-contained:

- **[Run a Terminal Bench Task →](./RUN_TERMINAL_BENCH.md)**
  Point Bunsen at an existing benchmark suite and score a real coding agent, with
  zero authoring. Best if you want to **evaluate agents**.

- **[Bring Your Own Task →](./BRING_YOUR_OWN_TASK.md)**
  Wrap your own task or codebase as a reproducible experiment with your own
  pass/fail check. Best if you want to **measure agents on your work**.

Along the way you'll want the two reference specs —
[`experiment.yaml`](./EXPERIMENT_YAML.md) and [`agent.yaml`](./AGENT_YAML.md) —
and the [Glossary](./GLOSSARY.md) for any unfamiliar term.
