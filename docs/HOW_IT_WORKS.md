# How Bunsen Works

This page explains what happens when you run an experiment: the lifecycle of a run, the containers
involved, and the platform agents that drive it. For a conceptual overview start with
[INTRODUCTION.md](./INTRODUCTION.md); for hands-on usage see [GETTING_STARTED.md](./GETTING_STARTED.md).

## The Big Picture

A Bunsen run takes an **experiment** (defined by `experiment.yaml`) and an **agent under test**
(defined by `agent.yaml`), runs the agent reproducibly inside Docker, captures everything it does, and
then evaluates the result. A few ideas shape how that works:

- **The platform adapts to your agent.** An *orchestrator* (a platform agent, see below) figures out how
  to invoke any agent naturally from its `agent.yaml`. Your agent doesn't implement any Bunsen-specific
  interface.
- **Experiments define tasks, not interfaces.** An experiment describes its task in natural language;
  the orchestrator translates that into the agent's actual invocation.
- **Agent and environment coexist without a merge contract.** The experiment declares task substrate
  (runtimes, packages, services); the agent ships its own toolkit via `install.deps` / `install.build`,
  including any language runtimes it pins. Both live in one container, and the agent's PATH precedence
  wins for tools it ships. See [ENVIRONMENT.md#asymmetric-composition](./ENVIRONMENT.md#asymmetric-composition).
- **Everything is captured automatically.** AI traces, logs, and artifacts are recorded without any
  agent instrumentation.
- **Evaluation is agentic.** Beyond simple shell checks, an experiment can score results with a full
  agent (reasoning and using tools), not just a single LLM call.
- **Variants let you compare configurations** of the same agent without duplicating code — see
  [EXPERIMENT_YAML.md](./EXPERIMENT_YAML.md) and [AGENT_YAML.md](./AGENT_YAML.md).

Two terms to keep straight, both spelled "agent": the **agent under test** is the thing you're running
and measuring; the `agent` **criterion type** is a scorer that runs a full agent loop to evaluate the
result. The [Glossary](./GLOSSARY.md) defines both, plus "platform agents" (orchestrator, supervisor,
scorer).

## What Bunsen Is Built On

| Component | Choice | Why it matters to you |
|-----------|--------|-----------------------|
| Configuration | YAML files (`experiment.yaml`, `agent.yaml`) | Declarative, version-controllable, easy to read |
| Storage | Local filesystem | Runs land on disk so you can inspect them directly |
| Container runtime | Docker | Each run is isolated and reproducible |
| Base images | Headless (default), Visual, Desktop | Headless for CLI work, Visual for screenshot scoring, Desktop for GUI agents |
| Network tracing | mitmproxy sidecar | Captures HTTP(S) traffic with full request/response bodies |
| Platform agents | Claude API | The orchestrator, scorer, and supervisor are LLM-powered |

You run experiments from the `bn` CLI and inspect results either on disk or in the local web viewer
(`bn runs open`, served at `localhost:3456`). See [CLI.md](./CLI.md).

## Container Architecture

Each run uses a container with mitmproxy sidecar for trace capture:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Docker Network (bridge)                                             │
│                                                                      │
│  ┌────────────────────────────────────────────┐                      │
│  │  Experiment Container                       │                      │
│  │                                             │                      │
│  │  Mounts:                                    │                      │
│  │  • declared local workspace sources (read-only mounts)           │
│  │  • /agent  (agent code, read-only)         │                      │
│  │  • /output (platform artifacts, internal)   │                      │
│  │  • /bunsen/lib/orchestrator.cjs  (platform agents, invoked via docker exec) │
│  │  • /bunsen/lib/supervisor.cjs  (when interaction.mode: supervised)         │
│  │  • /bunsen/lib/scorer.cjs  (when evaluation.container: agent)              │
│  │  Container-local (not mounted):            │                      │
│  │  • /workspace-source (assembled immutable source, root-owned)   │
│  │  • /workspace (materialized from source as the execution user)  │
│  │                                             │                      │
│  │  ┌─────────────────────────────────────┐   │                      │
│  │  │  Agent Process                       │   │                      │
│  │  │  (invoked by orchestrator.cjs via    │   │                      │
│  │  │   docker exec, same container)       │   │                      │
│  │  └──────────────┬──────────────────────┘   │                      │
│  │                 │ HTTP(S)                   │                      │
│  └───────────────────────────────┬─────────────┘                      │
│                                  │                                    │
│  ┌───────────────────────────────▼─────────────┐                      │
│  │  Proxy Container (mitmproxy)                 │──────────────────────┼──▶ Internet
│  │  • Captures all HTTP(S) traffic              │                      │
│  │  • Detects AI provider endpoints             │                      │
│  │  • Extracts full request/response bodies     │                      │
│  └──────────────────────────────────────────────┘                      │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘

Outputs captured:
├── /output/*        → platform artifacts (diff → workspace/diff.patch, tar → workspace/export.tar.gz)
├── stdout/stderr    → logs.txt
├── HTTP traffic     → traces/agent.jsonl + traces/platform.jsonl (via mitmproxy)
└── artifacts/recording.cast   → terminal recording (if --record)
```

Everything captured lands in the run directory on disk. Terminal recording (`artifacts/recording.cast`)
is produced when you pass `--record`. For the full layout of a run's outputs and how to inspect them, see
[RUN_MANIFEST.md](./RUN_MANIFEST.md) and [CLI.md](./CLI.md); to open a run in the local web viewer, run
`bn runs open`.

Dedicated scorer containers mount:

- `/workspace` — extracted final mutable workspace
- `/workspace-source` — an immutable snapshot of the initial seeded inputs
- `/bunsen/run` — run context (logs, traces, manifest)
- `/bunsen/verifiers` — experiment's `verifiers/` directory (when present)
- `/bunsen/scorer-output` — sink for `result.json`, score, summary

By default (`evaluation.container: dedicated`) scoring runs in a fresh, dedicated container. With
`evaluation.container: agent`, scorers reuse the agent's own container instead, preserving the agent's
full filesystem and execution-user context under the same workspace contract. Because Docker can't add
mounts to a running container, the scorer-related mounts (workspace, verifiers, scorer bundle, output
sink) are attached when the container is **created**, before the agent runs. See
[AGENT_CONTAINER_SCORING.md](./AGENT_CONTAINER_SCORING.md).

## Platform Agents

> **All three platform agents (orchestrator, scorer, supervisor) execute *inside* the agent container.** Their bundles are mounted at `/bunsen/lib/*.cjs` when the container starts and invoked via `docker exec` — they are not host processes. Each runs on its own isolated Node runtime, separate from the agent under test and from anything the experiment installs.

### Orchestrator

Runs **before** the agent under test. Figures out how to invoke it cleanly.

**Inputs:**
- experiment.yaml (task, environment)
- agent.yaml (description, entrypoint.command, entrypoint.args, examples, entrypoint.help)
- Workspace directory listing

**Outputs:**
```json
{
  "setupCommands": ["cd /workspace"],
  "invocation": {
    "command": "python",
    "args": ["/agent/src/main.py", "Fix the TypeError on line 42"]
  }
}
```

The orchestrator emits structured argv (no shell-string composition), so dynamic task text reaches the agent verbatim — no escaping, no re-interpretation. The orchestrator ensures agents receive clean, focused prompts without platform boilerplate.

### Scorer

Runs **after** the agent under test. Scores results using one of five criterion types, plus an optional narrative report.

| `type:`         | Description                                          |
| --------------- | ---------------------------------------------------- |
| `script`        | Shell command in the scorer container ($0)           |
| `judge`         | Single LLM call with attached evidence (no tools)    |
| `agent`         | Full agent loop with tools                           |
| `browser-agent` | Agent loop with screenshot / Playwright              |
| `aggregate`     | Mathematical combination (no LLM)                    |

The narrative report is **not** a criterion type — it lives at `evaluation.report`, runs once after every criterion regardless of gate state, and produces a markdown artifact (no numeric score). See [SCORERS.md](./SCORERS.md) for full details.

Criteria are evaluated in `needs:`-dependency order, and all scores are normalized to [0, 1]. Scoring runs in a dedicated container by default, or in the agent's own container when `evaluation.container: agent` (see [Container Architecture](#container-architecture) above).

### Supervisor

Runs **alongside** the agent under test in supervised interaction mode (`interaction.mode: supervised`). Monitors the tmux session for stalls (`stallTimeout` / `maxCheckInterval`), detects blocked prompts, and intervenes to keep the agent making forward progress. See [SUPERVISOR.md](./SUPERVISOR.md) for configuration and behavior details.

## Thread-Based Trace Filtering

AI traces are organized into conversation **threads** so scorers (and you) can read them. This handles multi-agent scenarios where multiple concurrent conversations may be interleaved.

**Thread detection** uses message continuity: if request N's messages are a prefix of request N+1's messages, they belong to the same thread.

**Traces are normalized across providers**, so a thread reads the same regardless of which model API produced it.

The filtered format shows:
- One system prompt per thread (not repeated)
- Only NEW messages per turn (not accumulated history)
- Timeline showing interleaving across threads
- Truncated large tool outputs

Raw and filtered traces are written under the run's `traces/` directory; see [RUN_MANIFEST.md](./RUN_MANIFEST.md) for the full run layout.

## See Also

- [ENVIRONMENT.md](./ENVIRONMENT.md) — how the experiment environment and workspace are composed
- [SCORERS.md](./SCORERS.md) — criterion types and evaluation in depth
- [TRUST_MODEL.md](./TRUST_MODEL.md) — the container isolation boundary and safe-sharing guidance
- [COST.md](./COST.md) — how token usage and cost are accounted from captured traces
