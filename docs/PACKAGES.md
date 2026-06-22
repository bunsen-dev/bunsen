# Packages & Schemas

Bunsen ships as a small set of npm packages. They split into a **public** surface (a stable contract you may depend on) and an **internal** surface (implementation detail that may change without notice).

## Public

| Package         | Purpose                                                          |
| --------------- | --------------------------------------------------------------- |
| `@bunsen-dev/cli`   | The `bn` command-line interface.                                |
| `@bunsen-dev/types` | Shared resource and run types. Zero runtime dependencies.       |

The public contract also includes:

- The configuration schemas: `bunsen.config.yaml`, `experiment.yaml`, `agent.yaml`, `bunsen-suite.yaml` — see [Schema reference](#schema-reference) below.
- The runtime contract inside the agent container (reserved `BUNSEN_*` env vars, `/workspace-source`, `/bunsen/...` paths) — documented in [The Environment Model](./ENVIRONMENT.md).
- `RunManifestV1` and the run-event vocabulary, exported from `@bunsen-dev/types` — see [Run Manifest & Events](./RUN_MANIFEST.md).
- CLI exit codes and the `--format` contract — see [CLI Reference](./CLI.md).

Everything else may change without notice.

### Installing the CLI

The `bn` command is the main entry point. Install it globally (or run it with `npx`):

```bash
npm install -g @bunsen-dev/cli
bn --help
```

### Consuming the types

`@bunsen-dev/types` lets you read run manifests and other Bunsen resources in a type-safe way without pulling in the runtime:

```bash
npm install @bunsen-dev/types
```

```ts
import type { RunManifestV1 } from "@bunsen-dev/types";

const manifest: RunManifestV1 = JSON.parse(
  await readFile("runs/<run-id>/manifest.json", "utf8"),
);
```

## Schema reference

Each configuration file has a narrative home and a published JSON Schema. The JSON Schema is the authoritative field-level contract; the narrative docs provide usage guidance.

| Config               | Narrative home                                                                                                                                                                                                  | JSON Schema                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `bunsen.config.yaml` | [Project Configuration](./PROJECT_CONFIG.md)                                                                                                                                                                    | https://schemas.bunsen.dev/project.v1.json       |
| `experiment.yaml`    | [experiment.yaml Reference](./EXPERIMENT_YAML.md) (full spec), with deep dives in [The Environment Model](./ENVIRONMENT.md) (env/workspace/run blocks) and [Scorers & Evaluation](./SCORERS.md) (evaluation block) | https://schemas.bunsen.dev/experiment.v1.json    |
| `agent.yaml`         | [agent.yaml Reference](./AGENT_YAML.md)                                                                                                                                                                         | https://schemas.bunsen.dev/agent.v1.json         |
| `bunsen-suite.yaml`  | [Suites](./SUITES.md)                                                                                                                                                                                           | https://schemas.bunsen.dev/suite.v1.json         |

Point your editor's YAML language server at these URLs (via a `# yaml-language-server: $schema=...` comment or your editor's schema mapping) to get completion and validation as you author. The same schemas are exported from `@bunsen-dev/types` for programmatic validation.

## Internal

| Package               | Purpose                                                                          |
| --------------------- | ------------------------------------------------------------------------------- |
| `@bunsen-dev/runtime`     | Execution engine: container orchestration, storage, env merging.                |
| `@bunsen-dev/agents`      | Platform agents (orchestrator, scorer, supervisor) bundled for in-container use. |
| `@bunsen-dev/diff-filter` | Lockfile-aware diff filtering used by scorers.                                   |

Internal packages are implementation detail. External consumers must not depend on them directly.

## See also

- [How Bunsen Works](./HOW_IT_WORKS.md) — how these packages fit together at run time.
- [Glossary](./GLOSSARY.md) — definitions of every term used across the docs.
