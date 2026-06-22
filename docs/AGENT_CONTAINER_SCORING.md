# Scoring in the Agent Container

## Overview

By default (`evaluation.container: dedicated`), Bunsen evaluates experiment results in a **dedicated scorer container** — a fresh instance of the same Docker image with the agent's final `/workspace` extracted from the agent container and `/workspace-source` — an immutable snapshot of the initial seeded inputs — mounted alongside it. This provides isolation but loses system-level changes: installed packages, files outside `/workspace`, and system configuration.

`evaluation.container: agent` opts into running scorers **inside the agent's container** after the agent finishes. The agent's filesystem state is fully preserved: packages, system files, configuration changes.

Important caveat: any experiment that declares a `verifiers/` directory has it mounted (read-only) into the agent container before the agent runs — Docker cannot add mounts to a running container, so the mount must exist up front. This is **not** specific to agent-container scoring: in either evaluation mode the agent can read `/bunsen/verifiers` during the run, so don't put scoring secrets there.

When the agent ran as the non-root `bunsen` user, scorers in the agent container also run as `bunsen` with `HOME=/home/bunsen`. If the agent ran as root (`environment.user: root`), scorers run as root. This matters for user-scoped state like conda environments, virtualenvs, and per-user config directories.

## What It Preserves (and What It Doesn't)

`evaluation.container: agent` preserves **state** — not necessarily **processes**.

| Preserved                                          | Not guaranteed                                  |
| -------------------------------------------------- | ----------------------------------------------- |
| Installed packages (pip, apt, npm)                 | Running servers / daemons                       |
| Files outside `/workspace` (`/etc`, `/opt`, `~/.*`)| Background processes                            |
| Conda / virtualenv environments                    | Services started by the agent                   |
| Agent execution-user context (`bunsen` vs `root`)  | Anything tied to the agent's process tree       |
| System configuration changes                       |                                                 |

**Why processes may not survive:** Background processes started by the agent *can* survive into the scoring phase, but only if the agent uses proper shell backgrounding (`nohup ... &`). Some agent frameworks (e.g., Claude Code's `run_in_background` tool parameter) manage background tasks internally and kill them on exit — those processes won't survive. See [Scoring Service Tasks](./PROCESS_SURVIVAL.md) for the detailed analysis.

**For service experiments**, whether the agent properly daemonizes a service is meaningful benchmark signal, not a platform bug. An agent that can't leave a persistent service running has a real capability gap.

## When to Use

Set `evaluation.container: agent` when the experiment involves:

- **Package installation** — agent installs/upgrades packages that scorers need to verify.
- **System configuration** — agent modifies files outside `/workspace` (e.g. `/etc`, `/opt`).
- **Environment setup** — agent creates conda environments, virtualenvs, or other runtime environments.
- **Service experiments** — agent starts servers or daemons that scorers need to test — with the understanding that process survival depends on agent behavior.

## Usage

```yaml
$schema: https://schemas.bunsen.dev/experiment.v1.json
version: v1
name: my-package-task
description: Fix a package version
task:
  prompt: Upgrade pandas to support dtype_backend.
workspace:
  sources:
    - path: ./workspace
environment:
  image:
    base: bunsen/headless
evaluation:
  container: agent
  criteria:
    - id: tests-pass
      title: Tests pass
      type: script
      run: pytest /bunsen/verifiers/test_outputs.py -v
      scores: [0, 1]
```

## How It Works

### Default flow (dedicated scorer container)

```
Agent runs in Container A
  → extract /workspace
  → extract /workspace-source
  → create Container B (fresh image)
  → run scorers in B
  → destroy B
  → destroy A
```

### With `evaluation.container: agent`

```
Agent runs in Container A (with scorer mounts pre-attached)
  → agent finishes
  → run scorers in Container A (no extraction, no new container)
  → destroy A
```

What this means for you:

- **No separate container** — the workspace is already in place, so scoring saves container-creation overhead and preserves all state.
- **Same workspace contract** — scorers still see a mutable `/workspace` and `/workspace-source` — an immutable snapshot of the initial seeded inputs.
- **Same user context** — scorers run as the same user as the agent, so user-scoped environments resolve the same way during scoring.
- **Same criterion types** — `script`, `judge`, `agent`, and `browser-agent` criteria all work unchanged.
- **Verifier visibility** — `/bunsen/verifiers` is mounted up front (as for any run that declares a `verifiers/` directory), so the agent can read verifier assets before scoring begins. This is the same in both evaluation modes, so don't put scoring secrets there.

## Trade-offs

| Aspect                       | Default (dedicated container)            | `evaluation.container: agent`              |
| ---------------------------- | ---------------------------------------- | ------------------------------------------ |
| Isolation                    | Fresh container, no agent side effects   | Agent's full state preserved               |
| Packages                     | Only what's in the image                 | Agent-installed packages available         |
| System files                 | Only `/workspace`                        | Full filesystem preserved                  |
| Services                     | Lost                                     | Preserved if the agent daemonized properly |
| Crash safety                 | Scorer crash doesn't touch agent data    | Same (agent is already finished)           |
| Performance                  | Container creation + workspace copy      | Slightly faster (no extraction)            |

## Examples

Two illustrative cases for when `evaluation.container: agent` is the right fit:

- **Package/system state (reliable):** the agent upgrades pandas, and the scorer imports pandas 2.0 features that only exist after the upgrade. The agent-installed package must be present at scoring time.
- **Service/daemon (depends on agent behavior):** the agent starts a `fibonacci-server`, and the scorer issues a request against it. Scoring succeeds only if the agent daemonized the service so it survives into the scoring phase.

Scores land in the run manifest the same way regardless of evaluation mode — see [Run Manifest & Events](./RUN_MANIFEST.md).

## See also

- [Scorers & Evaluation](./SCORERS.md) — criterion types and how scoring works
- [Scoring Service Tasks](./PROCESS_SURVIVAL.md) — process survival for service/daemon experiments
- [Running as Root (environment.user)](./ENVIRONMENT_USER.md) — how the agent's execution user affects scoring
- [experiment.yaml Reference](./EXPERIMENT_YAML.md) — the full `evaluation` block
