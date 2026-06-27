# experiment.yaml Reference

The single authoritative spec for `experiment.yaml` — the resource that defines a Bunsen experiment: the task an agent under test is given, the container substrate it runs in, how its output is evaluated, and any named overlays (variants) that tweak all of the above.

This page covers every top-level block. Two blocks have their own deep-dive docs and are only summarized here:

- The `environment`, `workspace`, and `run` blocks — full coverage in [docs/ENVIRONMENT.md](./ENVIRONMENT.md).
- The `evaluation` block (criteria, scorers, reports) — full coverage in [docs/SCORERS.md](./SCORERS.md).

For the field-level contract (types, enums, required/optional, patterns), the hosted JSON Schema at [`https://schemas.bunsen.dev/experiment.v1.json`](https://schemas.bunsen.dev/experiment.v1.json) is authoritative. This document is the narrative companion to that schema.

## Block map

A complete `experiment.yaml` is a single YAML mapping with these top-level keys:

| Key           | Required | Type                                  | Purpose                                                                 |
| ------------- | -------- | ------------------------------------- | ---------------------------------------------------------------------- |
| `version`     | yes      | `'v1'`                                | Schema version. Always `v1`.                                           |
| `name`        | yes      | string (kebab-case)                   | Stable identifier; ASCII lowercase, digits, hyphens.                   |
| `description` | no       | string                                | Short human-readable summary.                                         |
| `labels`      | no       | `Record<string, string>`              | Free-form key/value labels recorded on each run, for filtering and grouping runs (see [docs/CLI.md](./CLI.md)). |
| `task`        | yes      | object                                | The instruction given to the agent under test.                       |
| `workspace`   | no       | object                                | Immutable input sources and per-run setup steps.                     |
| `environment` | yes      | object                                | The container substrate (image, runtimes, packages, platforms, user). |
| `run`         | no       | object                                | Per-experiment run settings (timeouts, platform).                    |
| `evaluation`  | yes      | object                                | How the agent's output is scored, plus an optional narrative report.  |
| `env`         | no       | `Record<string, string>`              | Env vars this experiment injects into the run.                       |
| `passEnv`     | no       | `string[]`                            | Host env var names allowed to pass through from the shell.           |
| `variants`    | no       | `Record<string, ExperimentVariant>`   | Named overlays applied on top of the base experiment.               |

`$schema` (string) may also appear at the top level to point editors at the JSON Schema for autocomplete and inline validation; it is otherwise ignored. Set it to the hosted schema URL:

```yaml
$schema: https://schemas.bunsen.dev/experiment.v1.json
```

A minimal valid experiment looks like:

```yaml
version: v1
name: fix-the-bug
task:
  prompt: Fix the failing test in src/parser.ts.
environment:
  image:
    base: bunsen/headless
evaluation:
  criteria:
    - id: tests-pass
      title: Test suite passes
      type: script
      run: pnpm test
```

## `task`

The instruction handed to the agent under test. Its only field is `task.prompt`.

| Field    | Required | Type   | Description                                       |
| -------- | -------- | ------ | ------------------------------------------------- |
| `prompt` | yes      | string | The main instruction given to the agent. Non-empty. |

```yaml
task:
  prompt: |
    The HTTP server in src/server.ts returns 500 on /health.
    Make it return 200 with body "ok".
```

## `workspace`

The immutable inputs assembled into the agent's workspace, plus ordered setup commands applied after the workspace is materialized.

| Field     | Required | Type                     | Description                                                       |
| --------- | -------- | ------------------------ | --------------------------------------------------------------- |
| `sources` | no       | `WorkspaceSourceEntry[]` | Ordered immutable inputs assembled into the workspace.          |
| `setup`   | no       | `StepConfig[]`           | Ordered per-run setup steps applied after workspace materialization. |

Each `sources` entry declares exactly one of `path` (a file or directory in the experiment repo) or `imagePath` (a file or directory already present in the built image), with an optional `target` for the destination inside the workspace. Each `setup` step is either a `run` step (a shell command) or a `writeFile` step (write a file from `from` or inline `content`).

> **Full coverage:** see [docs/ENVIRONMENT.md](./ENVIRONMENT.md) for workspace sources, source resolution, collision detection, setup-phase ordering, and the `run` / `writeFile` step shapes.

## `environment`

The container substrate the agent runs in. Required; `environment.image` must be present.

| Field       | Required | Type                                                   | Description                                                           |
| ----------- | -------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| `image`     | yes      | `{ base }` \| `{ dockerfile }`                         | Base image tag (default `bunsen/headless`) or a custom Dockerfile. Exactly one. |
| `requires`  | no       | `{ runtimes?, packages? }`                             | Substrate runtimes and packages the task needs.                     |
| `platforms` | no       | `RunPlatform[]`                                        | Declared experiment platforms. Runtime resolution picks one of them. |
| `user`      | no       | `'user'` \| `'root'`                                   | Execution user for the agent. Defaults to `user`.                   |

> **Full coverage:** see [docs/ENVIRONMENT.md](./ENVIRONMENT.md) for image selection, the asymmetric agent/experiment composition model, substrate runtime syntax, package installation, and Dockerfile handling.

## `run`

Per-experiment run settings. All fields are optional.

| Field                    | Required | Type                                     | Description                                          |
| ------------------------ | -------- | ---------------------------------------- | -------------------------------------------------- |
| `timeout`                | no       | duration string                          | Overall agent timeout.                             |
| `onTimeout`              | no       | `'score'` \| `'fail'`                    | On agent timeout: `score` captures the workspace and runs evaluation (run completes, flagged timed-out); `fail` (default) fails the run. |
| `platform`               | no       | `'auto'` \| `'linux/amd64'` \| `'linux/arm64'` | Single resolved platform for this run.      |
| `artifactCaptureTimeout` | no       | duration string                          | Post-run artifact capture timeout.                 |

Duration strings are written like `5m`, `300s`, or `1h`.

> **Full coverage:** see [docs/ENVIRONMENT.md](./ENVIRONMENT.md) for the run block's defaults and platform resolution, and [docs/PLATFORMS.md](./PLATFORMS.md) for platform selection.

## `evaluation`

How the agent's output is scored. Required; `evaluation.criteria` must be present.

| Field       | Required | Type                       | Description                                                  |
| ----------- | -------- | -------------------------- | ----------------------------------------------------------- |
| `container` | no       | `'dedicated'` \| `'agent'` | Where scorers execute. Defaults to `dedicated`.            |
| `criteria`  | yes      | `Criterion[]`              | Ordered list of scoring criteria.                          |
| `report`    | no       | object                     | Optional narrative report. Omitted = no report produced.   |

Each criterion has a `type` — `script`, `judge`, `agent`, `browser-agent`, or `aggregate` — plus common fields (`id`, `title`, `weight`, `needs`, `gate`, …). (The `agent` criterion type is a scorer that drives an evaluating agent; it is distinct from the agent under test and from the platform agents — see [docs/GLOSSARY.md](./GLOSSARY.md).)

> **Full coverage:** see [docs/SCORERS.md](./SCORERS.md) for the five criterion types, common criterion fields, scoring math, gates, dependencies, the report step, and the dedicated-vs-agent container execution model.

## `env` and `passEnv`

These two blocks control the environment variables visible inside the run.

- **`env`** is a `Record<string, string>` of variables this experiment injects into the run. They are merged with the other environment sources per the env precedence order documented in [docs/ENVIRONMENT.md](./ENVIRONMENT.md). Names starting with `BUNSEN_` are reserved by the platform and rejected.
- **`passEnv`** is a list of host environment variable names allowed to pass through from the shell that invoked `bn`. Use it to forward secrets or machine-specific values without hardcoding them. As with `env`, `BUNSEN_*` names cannot be allowlisted, and duplicate entries are rejected.

```yaml
env:
  LOG_LEVEL: debug
passEnv:
  - GITHUB_TOKEN
```

## Variants and merge semantics

`variants` is the primary mechanism for running the same experiment with small, named tweaks — a harder prompt, a different base image, an extra criterion — without duplicating the whole file.

`variants` is a `Record<string, ExperimentVariant>`: a map from variant name to an overlay. Each overlay may set any of `description`, `labels`, `task`, `workspace`, `environment`, `run`, `evaluation`, `env`, and `passEnv`. It cannot define `version`, `name`, or nested `variants`.

```yaml
variants:
  hard:
    description: Same task, stricter time budget and an extra criterion.
    run:
      timeout: 5m
    evaluation:
      criteria:
        - id: no-todos
          title: No TODO comments left behind
          type: script
          run: "! grep -rn TODO src/"
```

### Invoking a variant

Select an experiment variant by appending `:<variant>` to the experiment argument:

```bash
bn run <experiment>:<variant> [agent]
# e.g.
bn run fix-the-bug:hard claude-code
```

(The agent under test has its own independent variants, selected the same way on the agent argument: `bn run <experiment> <agent>:<variant>`. See [docs/AGENT_YAML.md](./AGENT_YAML.md) for the agent resource and its variants.)

### Merge rules

A variant overlay is applied on top of the base experiment to produce the config that actually runs:

- **Scalar and object fields shallow-merge** — the variant's value wins for any key it sets; keys it omits fall through to the base. `labels`, `env`, and a variant `environment.requires` shallow-merge key-by-key with the base.
- **Arrays replace wholesale** — a variant that sets an array field replaces the base array entirely. The one exception is `evaluation.criteria` (below). `passEnv` is the other special case: the base and variant lists are concatenated and de-duplicated rather than replaced.
- **`evaluation.criteria` merges by `id`** — entries in the variant whose `id` matches a base criterion **replace** that base entry in place; entries with a new `id` are **appended** to the end of the list.
- **Variants cannot delete criteria.** There is no removal syntax. To neutralize a base criterion in a variant, override it by `id` with `weight: 0` so it no longer contributes to the weighted score.

After a variant is applied, the criteria dependency graph is re-validated, so a variant that adds or replaces criteria must keep `needs` references valid and acyclic.

## JSON Schema

The authoritative field-level contract — every type, enum, pattern, required/optional flag, and mutual-exclusion rule — lives in the hosted JSON Schema:

```
https://schemas.bunsen.dev/experiment.v1.json
```

Companion schemas cover the other Bunsen resources: [`agent.v1.json`](https://schemas.bunsen.dev/agent.v1.json), [`project.v1.json`](https://schemas.bunsen.dev/project.v1.json), and [`suite.v1.json`](https://schemas.bunsen.dev/suite.v1.json). These types are also published in the `@bunsen-dev/types` package.

## See also

- [docs/AGENT_YAML.md](./AGENT_YAML.md) — the `agent.yaml` resource that defines the agent under test.
- [docs/ENVIRONMENT.md](./ENVIRONMENT.md) — the `environment`, `workspace`, and `run` blocks in depth.
- [docs/SCORERS.md](./SCORERS.md) — the `evaluation` block, criterion types, and scoring math.
- [docs/GLOSSARY.md](./GLOSSARY.md) — definitions for experiment, task, criterion, scorer, agent under test, and platform agents.
