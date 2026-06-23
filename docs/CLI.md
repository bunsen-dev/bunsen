# CLI Reference

`bn` (alias `bunsen`) is the command-line interface. It's a **noun-grouped**
tree: the resource is the group (`experiments`, `agents`, `runs`, `suites`,
`eval`, …) and `run` stays as the primary verb. Every command supports stable
exit codes and, where it prints data, a `--format` flag for machine-readable
output.

```bash
bn --help            # top-level command list
bn <group> --help    # commands within a group
bn doctor            # diagnose Docker, git, and project config
```

## `bn run`

Run an experiment with an agent. The one command you'll use most.

```bash
bn run <experiment>[:variant] [agent][:variant] [options]
```

| Option                   | Description                                                            |
| ------------------------ | --------------------------------------------------------------------- |
| `--model <id>`           | Model id for the agent (sets its declared model env var, overriding any variant). |
| `--agent-variant <name>` | Override the agent variant.                                           |
| `--experiment-variant <name>` | Override the experiment variant.                                |
| `-e, --env <VAR=value>`  | Set an environment variable (repeatable).                            |
| `--env-file <path>`      | Load environment from a file (repeatable).                          |
| `--pass-env <VAR>`       | Pass a host env var through to the run (repeatable).                |
| `--platform <platform>`  | Execution platform (`linux/amd64` or `linux/arm64`).               |
| `--timeout <duration>`   | Execution timeout (e.g. `15m`, `900000ms`).                        |
| `--skip-eval`            | Skip the evaluation phase (orchestration still runs).             |
| `--skip-traces`          | Skip AI API trace capture.                                        |
| `--record`               | Record the terminal session (tmux + asciinema).                  |
| `--rebuild-agent`        | Rebuild `install.build` artifacts, bypassing the cache.          |
| `--export-workspace`     | Export the workspace as a tarball after the run.                 |
| `--dry-run`              | Print the resolved run plan and exit (pair with `--format`).     |
| `--debug-keep-container` | Keep the container running after completion for debugging.       |
| `-v, --verbose`          | Verbose output.                                                  |

```bash
bn run fix-the-bug claude-code
bn run fix-the-bug claude-code --model claude-opus-4-7
bn run fix-the-bug:hard claude-code:headless
bn run terminal-bench/fix-permissions basic-coding-agent --platform linux/amd64
```

## `bn experiments`

Inspect and validate experiments.

| Command                              | Description                                              |
| ------------------------------------ | ------------------------------------------------------- |
| `bn experiments list`                | List available experiments (local + suites).           |
| `bn experiments show <name>`         | Show details about an experiment.                      |
| `bn experiments validate [name]`     | Validate `experiment.yaml` (schema + cross-resource). `--all` for every experiment; `--fix` to derive missing criterion ids from titles. |

## `bn agents`

Inspect, validate, and prebuild agents.

| Command                          | Description                                                       |
| -------------------------------- | --------------------------------------------------------------- |
| `bn agents list`                 | List available agents.                                          |
| `bn agents show <name>`          | Show details about an agent.                                    |
| `bn agents validate [name]`      | Validate `agent.yaml`. `--all` for every agent.                |
| `bn agents build <agent>`        | Build and cache `install.build` artifacts. `--platform`, `--rebuild`. |
| `bn agents add [names…]`         | Copy bundled starter agents (`claude-code`, `codex-cli`, `gemini-cli`) into the project's agents dir. No names adds all; `--list` shows them; `--force` overwrites an existing dir. |

## `bn suites`

Manage git-cloned [benchmark suites](./SUITES.md).

| Command                          | Description                                                            |
| -------------------------------- | --------------------------------------------------------------------- |
| `bn suites add <git-url>`        | Clone a suite and register it. `--ref <tag\|sha>`, `--as <alias>`.    |
| `bn suites list`                 | List configured suites and cache status.                             |
| `bn suites update [suite-id]`    | Refresh a suite to its configured ref. `--all` for every suite.      |
| `bn suites info <suite-id>`      | Show details about a configured suite.                               |
| `bn suites remove <suite-id>`    | Unregister a suite and delete its cache. `-f, --force`.              |

## `bn runs`

Inspect and manage [runs](./RUN_MANIFEST.md).

| Command                          | Description                                                            |
| -------------------------------- | --------------------------------------------------------------------- |
| `bn runs list`                   | List runs. Filter with `-e/--experiment`, `-a/--agent`, `-n/--last`.  |
| `bn runs show <run-id>`          | Run summary: score, cost, status.                                    |
| `bn runs open [run-id]`          | Open a run in the local web viewer (defaults to most recent). `-p, --port`. |
| `bn runs logs <run-id>`          | Show logs for a run.                                                 |
| `bn runs diff <run-id>`          | Show workspace changes. `--include-lockfiles`.                       |
| `bn runs traces <run-id>`        | Show AI traces. `--full` for complete bodies.                        |
| `bn runs cost <run-id>`          | Show the [cost breakdown](./COST.md).                                |
| `bn runs compare [run-ids...]`   | Compare runs side by side; `--matrix` for an experiments × agents grid. |
| `bn runs export <run-id>`        | Extract the workspace from a completed run. `-o/--output`, `--install`. See [Exporting a Run's Workspace](./EXPORT_WORKSPACE.md). |
| `bn runs cancel <run-id>`        | Stop a run's containers and mark the manifest canceled.             |

## `bn eval`

Inspect, augment, and calibrate [evaluation](./SCORERS.md) results.

| Command                          | Description                                                            |
| -------------------------------- | --------------------------------------------------------------------- |
| `bn eval show <run-id>`          | Show evaluator scores for a run.                                     |
| `bn eval report <run-id>`        | Show the evaluation report. `--save` to write `evaluation/report.md`, `--open` to view. |
| `bn eval human <run-id>`         | Interactively score a run with human judgment. `--only <criterion>`, `--reset`. |
| `bn eval calibrate [run-ids...]` | Compare human scores to LLM scores (MAE, bias, per-type breakdown).  |

## Project & system

| Command                          | Description                                                            |
| -------------------------------- | --------------------------------------------------------------------- |
| `bn init`                        | Scaffold `bunsen.config.yaml`. `--example` also writes a starter experiment + echo-agent; `--starter-agents` copies the starter agents (`claude-code`, `codex-cli`, `gemini-cli`) into `agents/` (existing agent dirs are skipped unless `--force`); `-f/--force` overwrites. |
| `bn new <type> <name>`           | Create a new `experiment` or `agent`. `-t/--template`.                |
| `bn doctor`                      | Environment diagnostics (Docker, git, project config).              |
| `bn config show`                 | Print the resolved `bunsen.config.yaml`.                            |
| `bn config validate`             | Validate `bunsen.config.yaml`.                                      |
| `bn skills install`              | Install the bundled [authoring skills](./SKILLS.md) for Claude Code / Codex. Also `list`, `uninstall`. |
| `bn index rebuild` / `status`    | Manage the local SQLite run index.                                 |
| `bn cache list` / `prune` / `rm` | Manage local build and deps caches.                                |
| `bn clean`                       | Remove orphaned Bunsen containers and networks. `--dry-run`, `-f/--force`. |

## Exit codes

`bn` uses a stable exit-code contract so CI scripts and agents can branch on
outcomes. A low score is **not** a failure — only an error is.

| Code | Meaning                                                            |
| ---- | ----------------------------------------------------------------- |
| `0`  | Success.                                                          |
| `1`  | Generic failure (uncategorized).                                  |
| `2`  | Usage error: bad flags, missing args, unknown command.           |
| `3`  | Validation failure: invalid YAML, schema violation, cross-resource error. |
| `4`  | Runtime failure during a run (agent crashed, container died).    |
| `5`  | Evaluation failure (a scorer crashed — distinct from a low score). |

## Machine-readable output

Every command that prints data accepts `--format <text|json|yaml>` (default
`text`). Use `json` to pipe into other tools:

```bash
bn runs list --format json
bn runs compare --matrix --format json
bn experiments list --format json
```

`bn runs list --ids-only` prints just the run IDs (space-separated) for shell
loops.

## Environment files

On startup `bn` discovers the project root and loads the env files declared in
`defaults.envFiles` of `bunsen.config.yaml` (`.env` by default). Values already
set in your shell take precedence — an env file never clobbers an explicit shell
value. This is how `ANTHROPIC_API_KEY` and similar secrets reach the
orchestrator, evaluation, and (via `passEnv`) the agent. For the full env
precedence order, see [The Environment Model](./ENVIRONMENT.md).
