# Bring Your Own Task

This path wraps *your* task — a bug to fix, a feature to build, a check to
pass — as a reproducible Bunsen experiment with your own pass/fail criterion.
By the end you'll have an `experiment.yaml` you can run against any agent and
iterate on.

If you haven't run anything yet, do [Getting Started](./GETTING_STARTED.md)
first.

## 1. Scaffold an experiment

From a Bunsen project (run `bn init` first if you don't have a
`bunsen.config.yaml`):

```bash
bn new experiment my-task -t coding-task
```

This creates:

```
experiments/my-task/
  experiment.yaml      # the task, environment, and evaluation
  workspace/           # files seeded into the agent's /workspace
```

The `coding-task` template gives you a runnable starting point: a Python image, a
task prompt, and a `script` criterion that runs `pytest`. Open
`experiments/my-task/experiment.yaml` and make it yours.

## 2. Write the task

Set `task.prompt` to a clear, specific instruction — what to do and what success
looks like. This is the only thing the agent is told; the
[orchestrator](./HOW_IT_WORKS.md) delivers it verbatim.

```yaml
task:
  prompt: |
    The HTTP server in src/server.ts returns 500 on /health.
    Make it return 200 with body "ok". Do not change the routing.
```

See the [`experiment.yaml` reference](./EXPERIMENT_YAML.md#task) for the full block.

## 3. Seed the workspace

Drop the files the agent should start from into `experiments/my-task/workspace/`,
or declare them explicitly with `workspace.sources` for finer control (file vs
directory, target path, image-baked inputs):

```yaml
workspace:
  sources:
    - path: ./workspace        # everything under the experiment's workspace/ dir
```

The full source model — multiple sources, collision handling, and post-seed
`setup` steps — is in [The Environment Model](./ENVIRONMENT.md).

## 4. Choose the environment

Pick the base image and any runtimes or packages the *task* needs (not the agent
— the agent brings its own toolkit). For most coding tasks the bundled
`bunsen/headless` image or a language base like `python:3.11-slim` is enough:

```yaml
environment:
  image:
    base: bunsen/headless
  requires:
    packages:
      pip: [pytest]
```

See [The Environment Model](./ENVIRONMENT.md) for image selection, runtimes, and
install steps.

## 5. Add a pass/fail check

The heart of the experiment is the evaluation. Start with a deterministic
`script` criterion — it's near-zero cost and unambiguous. Put any helper checks
in a `verifiers/` directory and call them from the criterion:

```yaml
evaluation:
  criteria:
    - id: tests-pass
      title: Test suite passes
      type: script
      run: pytest -q
```

A `script` criterion scores from its exit code (0 → pass) or from a fine-grained
score written with the `bunsen-score` helper. Files in `verifiers/` are mounted
read-only at `/bunsen/verifiers` during scoring. See
[Scorers & Evaluation](./SCORERS.md) for the full criterion model, weights, and
gates.

## 6. Run and iterate

```bash
bn run my-task claude-code
bn runs show
```

Iterate on the prompt and the criterion until the experiment measures what you
actually care about. `bn runs diff` shows exactly what the agent changed;
`bn runs traces` shows how it reasoned.

## Next steps

- **Add an LLM `judge` criterion** for qualities a script can't check (clarity,
  approach) — see [Scorers & Evaluation](./SCORERS.md).
- **Add a starter agent** — `bn agents add` drops the bundled `claude-code`,
  `codex-cli`, and `gemini-cli` into `agents/` so you can run `bn run my-task
  claude-code` immediately (set the provider key in `.env` first).
- **Try different agents and models** — `bn run my-task <agent> --model <id>` —
  and compare with `bn runs compare`.
- **Let your coding agent help author** — `bn skills install` ships authoring
  skills for Claude Code and Codex so they understand `experiment.yaml` and
  `agent.yaml`. See [Agent Skills](./SKILLS.md).
- **Bring your own agent** — wrap a CLI, script, or package as an
  [`agent.yaml`](./AGENT_YAML.md) (the `bunsen-new-agent` skill helps), or
  `bn agents add` a starter and edit it.
