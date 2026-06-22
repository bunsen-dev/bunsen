# Project Configuration (bunsen.config.yaml)

`bunsen.config.yaml` sits at the root of a Bunsen project and tells `bn` where to
find experiments and agents, which suites to consume, and the default behavior
for every run. Create one with `bn init` (add `--example` to also scaffold a
starter experiment and agent).

For the field-level contract, the JSON Schema at
[`schemas.bunsen.dev/project.v1.json`](https://schemas.bunsen.dev/project.v1.json)
is authoritative; this page is the narrative companion. Set `$schema` at the top
for editor autocomplete.

```yaml
$schema: https://schemas.bunsen.dev/project.v1.json
version: v1
name: my-lab

paths:
  experiments:
    - experiments
  agents:
    - agents
  precedence: local

suites:
  - source:
      type: git
      url: https://github.com/bunsen-dev/terminal-bench.git
      ref: v2.1.0
    as: terminal-bench

defaults:
  run:
    timeout: 15m
    platform: auto
    capture:
      traces: true
      recording: false
  envFiles:
    - .env
  passEnv:
    - ANTHROPIC_API_KEY
```

## Top-level keys

| Key          | Required | Type     | Purpose                                                            |
| ------------ | -------- | -------- | ----------------------------------------------------------------- |
| `version`    | yes      | `'v1'`   | Schema version. Always `v1`.                                      |
| `name`       | no       | string   | A label for the project.                                         |
| `paths`      | no       | object   | Where `bn` discovers experiments and agents, and how local vs suite resources are prioritized. |
| `suites`     | no       | array    | Benchmark suites to consume. Usually managed via `bn suites add`. |
| `storage`    | no       | object   | Where run outputs are written.                                   |
| `defaults`   | no       | object   | Default run settings and environment for every `bn run`.        |
| `registries` | no       | object   | Override image registries for the base images.                  |

## `paths`

Where `bn experiments list` / `bn agents list` and `bn run` look for resources.

| Field         | Type                  | Description                                                                  |
| ------------- | --------------------- | --------------------------------------------------------------------------- |
| `experiments` | `string[]`            | Directories scanned for experiments (each holding `experiment.yaml` files). |
| `agents`      | `string[]`            | Directories scanned for agents.                                            |
| `precedence`  | `'local'` \| `'suites'` | Which source wins when an unqualified name matches both. Defaults to `local`. |

`precedence` controls only the *default* resolution of an unqualified
[experiment ref](./SUITES.md#resolve-experiment-refs); a fully qualified ref is
always unambiguous.

## `suites`

The benchmark [suites](./SUITES.md) consumed by this project. Each entry is a git
source plus an optional local alias. You normally edit this through
`bn suites add` / `bn suites remove` rather than by hand.

| Field            | Required | Type   | Description                                                       |
| ---------------- | -------- | ------ | --------------------------------------------------------------- |
| `source.type`    | yes      | `'git'`| Suite source type.                                             |
| `source.url`     | yes      | string | Clone URL (HTTPS or SSH).                                      |
| `source.ref`     | no       | string | Pin to a branch, tag, or commit SHA (recommended for reproducibility). |
| `as`             | no       | string | Local alias for `bn run <alias>/<experiment>`.                |
| `cacheDir`       | no       | string | Override the cache directory for this suite.                   |

## `defaults`

Defaults applied to every run; CLI flags on `bn run` override them.

| Field           | Type                          | Description                                                       |
| --------------- | ----------------------------- | --------------------------------------------------------------- |
| `run.timeout`   | duration string               | Default agent timeout (`15m`, `900s`, …).                       |
| `run.platform`  | `'auto'` \| `'linux/amd64'` \| `'linux/arm64'` | Default execution platform. `auto` resolves per host. See [Platforms & Architecture](./PLATFORMS.md). |
| `run.capture.traces`    | boolean               | Capture AI traces by default.                                  |
| `run.capture.recording` | boolean               | Record the terminal session by default.                       |
| `env`           | `Record<string,string>`       | Environment variables injected into every run.                |
| `passEnv`       | `string[]`                    | Host env var names allowed to pass through from your shell.    |
| `envFiles`      | `string[]`                    | Files loaded into the environment on startup (`.env` is loaded by default). Values already set in your shell take precedence. |

`env` and `passEnv` here are the project-wide layer of the env precedence order —
see [The Environment Model](./ENVIRONMENT.md) for how they merge with
experiment- and agent-level values, and [CLI Reference](./CLI.md) for the
matching `--env` / `--pass-env` / `--env-file` flags.

## `storage`

| Field  | Type   | Description                                                       |
| ------ | ------ | --------------------------------------------------------------- |
| `root` | string | Directory where run outputs are written. See [Run Manifest & Events](./RUN_MANIFEST.md) for the run-directory layout. |

## `registries`

Override where the base images are pulled from (for mirrors or private
registries).

| Field             | Type   | Description                          |
| ----------------- | ------ | ------------------------------------ |
| `images.headless` | string | Registry/repo for the headless base. |
| `images.browser`  | string | Registry/repo for the browser base.  |

## JSON Schema

The authoritative field-level contract is published at:

```
https://schemas.bunsen.dev/project.v1.json
```

The companion schemas cover the other Bunsen resources: `experiment.v1.json`,
`agent.v1.json`, and `suite.v1.json`. See [Packages & Schemas](./PACKAGES.md).
