---
name: bunsen-new-experiment
description: >-
  Create or scaffold a new Bunsen experiment (experiment.yaml) — the task prompt, the
  container environment (a base image or Dockerfile, plus runtimes/packages), optional
  workspace seeding, run options, and a starter evaluation block. Use when the user wants to
  set up a new experiment for an agent to run against. For designing or deepening
  scorers/rubrics use bunsen-author-scorer; for authoring the agent-under-test use
  bunsen-new-agent; for diagnosing a finished run use bunsen-debug-run.
---

# Author a Bunsen experiment

An experiment is a directory with an `experiment.yaml` that declares **what the agent is
asked to do** (`task`), **the environment it runs in** (`environment`), **the files it
starts from** (`workspace`), and **how the result is scored** (`evaluation`). You build it,
then `bn run <experiment> <agent>` executes it reproducibly in Docker.

This skill gets a valid experiment.yaml in place and green under `bn experiments validate`.
Keep the evaluation block minimal here and hand scorer depth to **bunsen-author-scorer**.

> Field truth lives in [`reference/experiment-schema.md`](reference/experiment-schema.md) —
> the complete field list generated from the schema your `bn` ships. Don't guess field
> names; consult it, and let `bn experiments validate` be the final word.

## Steps

1. **Confirm you're in a Bunsen project.** Experiments live under `experiments/<name>/`
   inside a project rooted by `bunsen.config.yaml`. If there's no config yet, scaffold one:
   ```bash
   bn init            # writes bunsen.config.yaml (add --example for a runnable hello-world)
   bn doctor          # confirm Docker + environment are healthy
   ```

2. **Scaffold the experiment.** Names are kebab-case (`^[a-z0-9][a-z0-9-]*$`) and must match
   the directory and the top-level `name:`.
   ```bash
   bn new experiment <name>           # creates experiments/<name>/experiment.yaml + workspace/
   bn new experiment <name> -t coding-task   # template with a script + judge starter
   ```

3. **Write the task prompt.** `task.prompt` is the *only* instruction the agent-under-test
   receives — make it concrete. Name the exact paths it should touch (the agent works in
   `/workspace`), state what success looks like, and tell it how to self-check. Use a YAML
   block scalar (`|-`). `task` accepts no other fields.

4. **Choose the environment image.** `environment.image` is **exactly one of** `base` (an
   image tag) or `dockerfile` (a path next to experiment.yaml).
   - Default to a Bunsen base image: **`bunsen/headless`** (Ubuntu + Python + Node + tmux),
     **`bunsen/visual`** (adds Playwright/Chromium — required for `browser-agent` scorers),
     or **`bunsen/desktop`**.
   - Add substrate the *task* needs under `environment.requires.packages` (`apt` / `npm` /
     `pip` arrays) so it caches into the image layer.
   - ⚠️ The npm-installed `bn` can only run experiments on the **bunsen base images**. A
     custom `dockerfile` or a non-bunsen `base` needs the per-platform runtimes that the npm
     package doesn't ship — those require the from-source checkout for now. The `bn new`
     scaffolder emits `base: python:3.11-slim`; **change it to `bunsen/headless`** unless the
     user is on a source checkout.

5. **Seed the workspace (optional).** If the task needs starter files, put them under
   `experiments/<name>/workspace/` and **declare them explicitly** — nothing is
   auto-included:
   ```yaml
   workspace:
     sources:
       - path: ./workspace        # exactly one of: path | imagePath, plus optional target
   ```
   Use `workspace.setup` for ordered per-run steps (`run:` commands or `writeFile:` steps).
   Sources assemble into `/workspace-source` (the immutable seed); the agent edits
   `/workspace`.

6. **Set run options (optional).** All optional, all overridable by `bn run` flags and
   `bunsen.config.yaml` `defaults.run`:
   ```yaml
   run:
     timeout: 10m       # duration: ^\d+(ms|s|m|h)$  — bare numbers fail
     platform: auto     # auto | linux/amd64 | linux/arm64
   ```

7. **Add a starter evaluation.** `evaluation.criteria` is required. Begin with one cheap,
   deterministic `script` criterion that mechanically checks the deliverable; add a
   `gate.ifBelow` so a broken solution scores 0 and skips the rest. Then hand off to
   **bunsen-author-scorer** for judges, weights, aggregates, and the report.

8. **Validate until green — the oracle.** `bn experiments validate` runs the full
   schema + cross-resource + criteria-graph check (exit 3 on failure, with a precise
   message). Edit → validate → repeat until you see `✓ <name> — valid`.
   ```bash
   bn experiments validate <name>          # the oracle
   bn experiments validate <name> --fix    # derive missing criterion ids from titles
   bn experiments show <name>              # inspect the resolved config
   bn run <name> <agent> --dry-run         # preview the run plan without executing
   ```

## Gotchas

- **Inject secrets at run time, not in the file.** Pass env into a run with
  `bn run … -e KEY=VAL` / `--env-file` / `--pass-env`, or set `defaults.env` in
  `bunsen.config.yaml` — don't hard-code secrets into `experiment.yaml`.
- **`image` is exactly one of `base` or `dockerfile`** — setting both, or neither, fails.
- **Dockerfile images skip `environment.requires.packages`** — install those inside the
  Dockerfile itself. `requires.runtimes` versions are logged only (not enforced) in v1, and
  `packages.cargo` is parsed but not installed.
- **Workspace files aren't auto-included** — an undeclared `./workspace` only warns. Declare
  `workspace.sources: [{ path: ./workspace }]`.
- **Criteria need a kebab-case `id`** (`^[a-z0-9][a-z0-9-]*$`). `--fix` can derive them from
  titles; the runtime hard-errors on a missing id.
- **Variants merge by replacing arrays wholesale**, except `evaluation.criteria`, which
  merges by `id`. Select one with `bn run <exp>:<variant> <agent>`.

## Complete example

```yaml
$schema: https://schemas.bunsen.dev/experiment.v1.json
version: v1
name: fix-the-bug
description: Fix a simple bug in a Python CLI tool.

task:
  prompt: |-
    The code in /workspace has a bug: running `python main.py` raises a
    TypeError. Fix it with a minimal change, then verify by running `pytest`.

workspace:
  sources:
    - path: ./workspace

environment:
  image:
    base: bunsen/headless
  requires:
    packages:
      pip: [pytest]

run:
  timeout: 10m

evaluation:
  container: dedicated
  criteria:
    - id: tests-pass
      title: Tests pass
      type: script
      scores: [0, 1]
      gate:
        ifBelow: 1            # below this, skip everything after it
      run: cd /workspace && pytest --tb=short

    - id: minimal-changes
      title: Minimal changes
      type: judge
      weight: 0.3
      evidence: [diff]
      instructions: |
        Review the diff: only the bug fix should be present, with no unrelated
        refactoring, formatting churn, or added comments.
```

**Done when** `bn experiments validate <name>` prints `✓ <name> — valid`. Then deepen the
evaluation with **bunsen-author-scorer**, or run it: `bn run <name> <agent>`.
