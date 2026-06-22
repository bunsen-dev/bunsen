# Bunsen

Bunsen is a general-purpose experiment runner for agentic systems. Give an agent
an environment, run it reproducibly, capture artifacts and traces, then evaluate
the result. **Environment-first, agent-agnostic.**

🌐 Live at **[bunsen.dev](https://bunsen.dev)** — with full **[docs](https://bunsen.dev/docs)**.

**Idea to insight, fast.** Run agents in reproducible environments, inspect
traces and artifacts deeply, and turn behavior into evidence-backed insight
humans and AI can build on.

> **Familiar shape:** if you've used [devcontainer features](https://containers.dev/features),
> Bunsen's environment model will feel similar — declarative units that compose
> into a shared container, multi-source (inline / file / registry), a schema
> centered on *what does this install* rather than *what's the full environment
> shape*. Bunsen applies the same pattern to a slightly different runtime model
> (artifacts mounted at agent invocation rather than baked into images per
> agent). See [The Environment Model](./docs/ENVIRONMENT.md#conceptual-precedent-devcontainer-features)
> for the full lineage.

## Features

- **Reproducible runs** — each run executes in its own Docker container with
  workspace snapshotting for idempotent runs (a reproducibility boundary, not a
  security sandbox — see [Trust & Safety](#trust--safety)).
- **Agent and experiment variants** — first-class variants on both, with clear
  merge semantics. Model is a separate axis — pick it with `bn run --model <id>`
  instead of a per-model variant.
- **Multiple agent sources** — load agents from local dirs, git repos, npm
  packages, or binaries.
- **Suites** — consume external benchmark suites at a pinned git ref (e.g.
  Terminal Bench).
- **Automatic capture** — logs, artifacts, workspace diffs, AI traces, and cost,
  captured automatically. Optional terminal recording for visual replay.
- **Five criterion types** — `script`, `judge`, `agent`, `browser-agent`,
  `aggregate` — plus a dedicated `evaluation.report` synthesis step.
- **Gate pattern** — short-circuit expensive LLM scoring when cheap script tests
  fail.
- **CLI-first** — a noun-grouped command tree (`bn run`, `bn experiments`,
  `bn agents`, `bn runs`, `bn suites`, `bn eval`, …) with stable exit codes and
  machine-readable output.

## Quick Start

**Prerequisites:** Docker, Node.js ≥ 22, and an `ANTHROPIC_API_KEY` (Bunsen's
orchestrator and LLM evaluation run on Claude).

```bash
npm i -g @bunsen-dev/cli
bn doctor                  # verify Docker + environment

mkdir my-lab && cd my-lab
bn init --example          # scaffold a project + a hello-world experiment + echo-agent
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

bn run hello-world echo-agent
bn runs show               # score, cost, status
bn runs open               # open the run in the local web viewer
```

That's the whole loop. Next: **[Getting Started](./docs/GETTING_STARTED.md)**
walks it in detail and forks into two paths —
[Run a Terminal Bench Task](./docs/RUN_TERMINAL_BENCH.md) or
[Bring Your Own Task](./docs/BRING_YOUR_OWN_TASK.md).

> **Distribution.** The CLI currently ships as an npm package that runs on your
> Node. It will move to a signed, self-contained standalone binary
> (`curl | sh`, no Node required). `@bunsen-dev/types` stays on npm permanently. For
> a one-shot try without a global install: `npx @bunsen-dev/cli …` (slower — prefer
> `npm i -g` for real use). Experiments on Bunsen base images run end-to-end from
> the npm install; experiments using a **custom Dockerfile or non-bunsen base
> image** currently need the from-source checkout below.

### From a source checkout (for contributing)

```bash
pnpm install
pnpm build
# then invoke the CLI through pnpm by prefixing each command: `pnpm bn …`
```

A checkout ships example agents and experiments under `examples/`, so you can run
`bn run fix-the-bug claude-code` or `bn run fizzbuzz basic-coding-agent` directly.

## Documentation

Full documentation lives at **[bunsen.dev/docs](https://bunsen.dev/docs)** (sources
under [`docs/`](./docs)):

**Start here**
- [Introduction](./docs/INTRODUCTION.md) · [Getting Started](./docs/GETTING_STARTED.md) · [Run a Terminal Bench Task](./docs/RUN_TERMINAL_BENCH.md) · [Bring Your Own Task](./docs/BRING_YOUR_OWN_TASK.md)

**Concepts**
- [How Bunsen Works](./docs/HOW_IT_WORKS.md) · [The Environment Model](./docs/ENVIRONMENT.md) · [Trust Model](./docs/TRUST_MODEL.md)

**Authoring**
- [experiment.yaml Reference](./docs/EXPERIMENT_YAML.md) · [agent.yaml Reference](./docs/AGENT_YAML.md) · [Agent Dependencies Cookbook](./docs/AGENT_DEPS_COOKBOOK.md) · [System Prompts](./docs/SYSTEM_PROMPTS.md) · [Running as Root](./docs/ENVIRONMENT_USER.md) · [Supervised Mode](./docs/SUPERVISOR.md) · [Agent Skills](./docs/SKILLS.md)

**Evaluation**
- [Scorers & Evaluation](./docs/SCORERS.md) · [Scoring in the Agent Container](./docs/AGENT_CONTAINER_SCORING.md) · [Scoring Service Tasks](./docs/PROCESS_SURVIVAL.md)

**Suites & Reference**
- [Suites](./docs/SUITES.md) · [CLI Reference](./docs/CLI.md) · [Project Configuration](./docs/PROJECT_CONFIG.md) · [Run Manifest & Events](./docs/RUN_MANIFEST.md) · [Exporting a Run Workspace](./docs/EXPORT_WORKSPACE.md) · [Cost Accounting](./docs/COST.md) · [Platforms & Architecture](./docs/PLATFORMS.md) · [Packages & Schemas](./docs/PACKAGES.md) · [Glossary](./docs/GLOSSARY.md)

## Examples

A source checkout includes sample agents and experiments under `examples/`:

| Agent                | Description                                                          |
| -------------------- | ------------------------------------------------------------------- |
| `echo-agent`         | Minimal test agent (no LLM) — echoes the task, for smoke tests.     |
| `basic-coding-agent` | Full coding agent with file/bash tools (ships its own Python).      |
| `claude-code`        | Claude Code — Anthropic's agentic CLI; supervised mode, non-root.   |
| `claude-sdk-agent`   | Claude Agent SDK wrapper; programmatic tool allowlist, runs as root.|
| `codex-cli`          | OpenAI Codex CLI.                                                   |
| `gemini-cli`         | Google Gemini CLI (Gemini Direct API).                             |

Any agent can be steered with a system prompt without changing the platform — see
[System Prompts](./docs/SYSTEM_PROMPTS.md). To scaffold your own, use
`bn new experiment <name>` / `bn new agent <name>` (see the
[CLI Reference](./docs/CLI.md)).

## Base images

| Image             | Description                                          |
| ----------------- | -------------------------------------------------- |
| `bunsen/headless` | Default — Python + Node for CLI agents.            |
| `bunsen/visual`   | Headless + Playwright/Chromium for visual scoring. |
| `bunsen/desktop`  | Full desktop environment for GUI agents.           |

Most experiments use a Bunsen image (the default); you can also point at any
Docker image or a `Dockerfile` in the experiment directory. See
[The Environment Model](./docs/ENVIRONMENT.md) for image selection, runtimes,
packages, and custom Dockerfiles.

## Development

```bash
pnpm build      # build all packages
pnpm test       # run tests
pnpm typecheck  # type check
pnpm lint       # lint
```

## Trust & Safety

**Running an experiment, agent, or suite means running its author's code on your machine.** That's the
nature of the tool — Bunsen exists to execute agents against environments and capture what happens. Runs
execute in a Docker container, but the container is a **reproducibility and accident boundary, not a
security sandbox**: it uses Docker's default capabilities and seccomp, sets no resource limits, has open
network egress, and has your real provider API keys inside it. There's no known container-escape vector and
the agent runs non-root by default — but a deliberately hostile agent can still exfiltrate keys and data
over the network. Saved run directories and AI traces can also contain secrets and full prompt/workspace
content, and there is no automatic redaction yet, so scrub before sharing.

Treat it like `git clone && make` on an unfamiliar repo: run what you trust, or run untrusted code on a
disposable host with throwaway, scoped API keys. See **[Trust Model](./docs/TRUST_MODEL.md)** for the
full trust model — where code executes (host vs container), the exact container posture, how to share runs
safely, and the trace body-vs-headers nuance.

## License

Bunsen is **source-available** under the [PolyForm Shield License 1.0.0](./LICENSE) — it is **not** an OSI
"open source" license. In plain English:

- **Yes, you can use it at work.** Internal commercial use is allowed.
- **Yes, you can run it anywhere** — your laptop, your servers, your cloud — for your own use.
- **Yes, you can read, modify, fork, and redistribute** the source.
- **Yes, you can build, test, and evaluate your own products** with it.
- **No, you cannot offer a competing Bunsen-like product or service** without a separate commercial
  license. That applies whether the competing product is hosted, local, embedded, forked, or free.

Bunsen has been source-available since day one; there was no prior OSI open-source release.

See [LICENSING.md](./LICENSING.md) for the full terms, the licenses of bundled third-party components, and
the rationale. Want to do something the license doesn't allow (e.g. offer a competing or hosted commercial
service)? A commercial license is available — contact `licensing@bunsen.dev`.

## Contact

General questions, feedback, and collaboration: `hello@bunsen.dev`.
