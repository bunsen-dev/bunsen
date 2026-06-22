# CLAUDE.md Template for Bunsen Experiments

Copy this file to your experiment repository as `CLAUDE.md` to enable effective analysis with Claude Code.

---

# Bunsen Experiments

This repository uses Bunsen for running and evaluating agent experiments.

## Quick Reference

### Running Experiments

```bash
# Run an experiment with an agent
bn run <experiment> <agent>

# Run with terminal recording
bn run <experiment> <agent> --record

# Pick a model (sets the agent's declared model env var)
bn run <experiment> <agent> --model claude-opus-4-7

# Run with a specific agent variant (behavioral)
bn run <experiment> <agent>:headless

# Skip evaluation for faster testing
bn run <experiment> <agent> --skip-eval

# Skip AI trace capture
bn run <experiment> <agent> --skip-traces

# Set environment variables
bn run <experiment> <agent> -e API_KEY=secret -e DEBUG=true
bn run <experiment> <agent> --env-file config.env

# Pass a host env var through to the run
bn run <experiment> <agent> --pass-env ANTHROPIC_API_KEY

# Export workspace after run
bn run <experiment> <agent> --export-workspace

# Custom timeout (duration string)
bn run <experiment> <agent> --timeout 20m

# Verbose output
bn run <experiment> <agent> -v

# Dry run: print the resolved run plan and exit
bn run <experiment> <agent> --dry-run --format json
```

### Viewing Results

```bash
# List recent runs
bn runs list
bn runs list -e <experiment>      # Filter by experiment
bn runs list -a <agent>           # Filter by agent
bn runs list -n 10                # Last N runs

# Show run summary
bn runs show <run-id>

# Inspect specific artifacts
bn runs logs <run-id>             # Agent stdout/stderr
bn eval show <run-id>             # Evaluation scores per criterion
bn eval report <run-id>           # Evaluation report (markdown)
bn eval report <run-id> --save    # Save report to report.md in run dir
bn runs traces <run-id>           # AI API trace summary with cost breakdown
bn runs traces <run-id> --full    # Full request/response bodies
bn runs diff <run-id>             # Workspace changes
bn runs cost <run-id>             # Detailed cost breakdown (agent vs platform)
```

### Comparing Runs

```bash
# Compare specific runs
bn runs compare <run-id-1> <run-id-2>

# Compare last N runs for an experiment
bn runs compare -e <experiment> -n 5

# Machine-readable output for analysis
bn runs list --format json
bn runs list --ids-only           # Space-separated run IDs for scripting
bn runs compare <run-id-1> <run-id-2> --format json
```

### Other Commands

```bash
# Inspect resources
bn experiments list
bn experiments show <name>
bn experiments validate --all
bn agents list
bn agents show <name>
bn agents validate --all

# Manage external suites
bn suites list
bn suites add <git-url> --as <alias>
bn suites update --all
bn suites info <suite-id>

# Calibration
bn eval human <run-id>            # Score a run with human judgment
bn eval calibrate -e <experiment> # Compare human vs LLM scores

# Project / cache / housekeeping
bn config show
bn config validate
bn cache list
bn cache prune --force
bn doctor
bn init
bn new experiment <name>
bn new agent <name>
bn clean --dry-run
```

## Run Artifacts

Runs are stored in `.bunsen/runs/<run-id>/` with this structure:

| File                              | Description                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`                   | Canonical RunManifestV1 — sole on-disk source of truth (experiment, agent, status, timing, cost, evaluation, artifacts list) |
| `events.jsonl`                    | Append-only run-event stream                                                                                         |
| `logs.txt`                        | Agent stdout/stderr                                                                                                  |
| `task/prompt.md`                  | Exact task prompt the agent received                                                                                 |
| `orchestration/result.json`       | Orchestrator output (`setupCommands` + `invocation`)                                                                  |
| `workspace/diff.patch`            | Changes made to the workspace                                                                                        |
| `workspace/export.tar.gz`         | Full workspace export (if `--export-workspace` was used)                                                              |
| `traces/agent.jsonl`              | Agent-under-test AI API traces (JSONL streaming format)                                                              |
| `traces/platform.jsonl`           | Platform agent traces (orchestrator/scorer/supervisor)                                                               |
| `traces/threads/index.json`       | Per-thread index + run summary (small — fits in any prompt)                                                          |
| `traces/threads/<thread-id>.jsonl`| Per-thread turn bodies (one turn per line; only the new-message delta from the previous turn)                        |
| `traces/summary.json`             | Aggregate stats (calls, tokens, cost)                                                                                |
| `evaluation/result.json`          | Evaluation scores + report metadata                                                                                  |
| `evaluation/report.md`            | Narrative report (from `evaluation.report`)                                                                          |
| `evaluation/human.json`           | Human scores (from `bn eval human`)                                                                                  |
| `evaluation/criteria/<id>.json`   | Per-criterion result projection                                                                                      |
| `evaluation/criteria/<id>.log`    | `type: script` criterion log (stdout + stderr)                                                                       |
| `artifacts/output/`               | Agent-authored artifacts (from `/bunsen/output/`)                                                                    |
| `artifacts/screenshots/`          | Browser-agent screenshots                                                                                            |
| `artifacts/recording.cast`        | Terminal recording (if `--record` was used)                                                                          |
| `supervisor.json`                 | Supervisor agent interactions (if `interaction.mode: supervised`)                                                    |

## Analysis Patterns

### Understanding a Run

1. Check the summary: `bn runs show <run-id>`
2. View the evaluation report: `bn eval report <run-id>`
3. Check cost breakdown: `bn runs cost <run-id>`
4. If evaluation failed, check logs: `bn runs logs <run-id>`
5. Review code changes: `bn runs diff <run-id>`

### Debugging Failures

1. Check run status: `bn runs show <run-id>` (look for status, duration)
2. Read logs for errors: `bn runs logs <run-id>`
3. Review traces to see agent reasoning: `bn runs traces <run-id>`
4. Compare with successful runs: `bn runs compare <successful-id> <failed-id>`

### Improving Agent Performance

1. Run baseline: `bn run <experiment> <agent>`
2. Run variant: `bn run <experiment> <agent>:variant`
3. Compare results: `bn runs compare -e <experiment> -n 2`
4. Review diffs to see what each approach did differently
5. Check traces to understand reasoning differences

## Project Configuration

Bunsen projects are configured via YAML files. The project structure is flexible — you decide where experiments and agents live, then tell Bunsen where to find them.

### `bunsen.config.yaml`

Located at the project root. Tells Bunsen where to search for experiments and agents and what defaults to apply per run:

```yaml
$schema: https://schemas.bunsen.dev/project.v1.json
version: v1
name: my-project

paths:
  experiments:
    - experiments          # ./experiments/<name>/experiment.yaml
    - shared/experiments   # Any path relative to project root
  agents:
    - agents               # ./agents/<name>/agent.yaml
    - shared/agents

# Optional: external benchmark suites
# suites:
#   - source:
#       type: git
#       url: https://github.com/bunsen-dev/terminal-bench.git
#       ref: v2.1.0
#     as: terminal-bench

defaults:
  run:
    timeout: 15m
    platform: auto
  envFiles:
    - .env
  passEnv:
    - ANTHROPIC_API_KEY
    - OPENAI_API_KEY
```

If no `bunsen.config.yaml` exists, Bunsen defaults to looking in `./experiments/` and `./agents/`.

### `experiment.yaml`

Defines a task and how to evaluate it. Located inside each experiment directory.

```yaml
$schema: https://schemas.bunsen.dev/experiment.v1.json
version: v1
name: fix-the-bug
description: Fix a bug in a Python CLI tool

task:
  prompt: |
    Fix the bug in /workspace and verify with pytest.

workspace:
  sources:
    - path: ./workspace
  setup:
    - run: pip install -e .
      timeout: 5m

environment:
  image:
    base: bunsen/headless          # Or `dockerfile: ./Dockerfile`
  requires:
    runtimes:
      python: "3.11"
    packages:
      pip: [pytest]
      apt: [git]
  # platforms: [linux/amd64]       # Optional; restricts run platforms
  # user: root                     # Optional; default 'user'

run:
  timeout: 15m
  # artifactCaptureTimeout: 2m

evaluation:
  # container: agent              # Optional; default 'dedicated'
  criteria:
    - id: tests-pass
      title: Tests pass
      type: script
      run: pytest --tb=short
      scores: [0, 1]
      gate:
        ifBelow: 1                # Skip remaining criteria if score < 1

    - id: code-quality
      title: Code quality
      type: judge
      instructions: Is the fix clean and minimal?
      evidence: [diff]            # Default: [diff]

    - id: error-handling
      title: Error handling
      type: agent
      instructions: Does the code handle edge cases properly?

  # Optional dedicated narrative report.
  report:
    instructions: |
      Produce a short, evidence-cited narrative of the run.
    needs: all
```

Key concepts:

- **Five criterion types**: `script` (shell command), `judge` (single LLM call with evidence), `agent` (full agent loop with tools), `browser-agent` (agent + Playwright), `aggregate` (math over `needs:` scores).
- **Narrative report**: lives at `evaluation.report`, runs once per evaluation regardless of gate state. Omit to disable.
- **Gates**: `gate.ifBelow: 1` skips remaining criteria when this one falls below the threshold (saves tokens). Skipped criteria record `status: 'skipped'`, `score: null`.
- **Evidence**: `evidence: [diff]` (default), `[diff, logs]`, or `[diff, logs, traces]` — `judge`-only.
- **Aggregates**: `type: aggregate` with `aggregate.function: weighted_average|all|any|min|max` plus a `needs:` list — combines dependent criterion scores without an LLM call.

### `agent.yaml`

Defines how to invoke an agent and what it needs to run. Located inside each agent directory.

```yaml
$schema: https://schemas.bunsen.dev/agent.v1.json
version: v1
name: my-agent
description: An AI coding agent

install:
  source:
    type: local
  # Optional cached artifact build:
  # build:
  #   image: ubuntu:22.04
  #   run:
  #     - mkdir -p /output/bin
  #     - cp /agent/bin/my-agent /output/bin/my-agent
  # Optional fast per-run config:
  # configure:
  #   - run: echo "Agent ready"
  #     as: root

runtime:
  requires:
    runtimes:
      python: ">=3.10"
    packages:
      pip: [anthropic]

entrypoint:
  command: python
  args:
    - src/main.py

interaction:
  mode: direct                    # 'direct' or 'supervised' (tmux + supervisor)

model:                            # enables `bn run <exp> <agent> --model <id>`
  env: ANTHROPIC_MODEL            # the env var your harness reads its model from
  default: claude-sonnet-4-6      # used when --model is not passed

defaults:
  env:
    LOG_LEVEL: info

examples:
  - prompt: Fix the bug in main.py
    invocation: python src/main.py "Fix the bug in main.py"

variants:
  fast:
    description: Quick mode (behavioral overlay; pick the model with --model)
    entrypoint:
      args:
        - src/main.py
        - --fast
    defaults:
      env:
        CACHE_ENABLED: "false"
```

Key concepts:

- **Asymmetric composition**: the experiment provides task substrate (`environment.requires.*`); the agent is a sealed closure that ships its own toolkit via `install.deps` / `install.build`. There is no merge between them — see [`docs/ENVIRONMENT.md#asymmetric-composition`](../docs/ENVIRONMENT.md#asymmetric-composition).
- **Variants**: test different *behavioral* configs of the same agent (e.g. `bn run task my-agent:fast`). Variant overrides shallow-merge with the base; arrays (including `entrypoint.args`) replace wholesale. Pick the **model** with `bn run task my-agent --model <id>` (an orthogonal axis), not a per-model variant.
- **Sources**: agents can be loaded from `local`, `git`, `npm`, or `binary` sources via `install.source`. Variants can override `install.source` (e.g. swap a git ref).
