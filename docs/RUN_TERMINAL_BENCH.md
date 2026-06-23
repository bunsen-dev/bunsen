# Run a Terminal Bench Task

This path points Bunsen at [Terminal Bench](https://www.terminal-bench.org/) — a
well-known CLI-agent benchmark — and scores a real agent on one of its tasks,
with **zero authoring**. It's the fastest way to see suite consumption and
code-based scoring in action.

If you haven't run anything yet, do [Getting Started](./GETTING_STARTED.md)
first — you'll need the CLI installed, Docker running, and `ANTHROPIC_API_KEY`
set.

## 1. Add the suite

A [suite](./SUITES.md) is a versioned group of experiments distributed as one git
repo. Add Terminal Bench and give it a short local alias:

```bash
bn suites add https://github.com/bunsen-dev/terminal-bench.git --as terminal-bench
```

This clones the suite into `.bunsen/suites/`, registers it in
`bunsen.config.yaml`, and makes its tasks available to `bn run`. Pin a specific
version with `--ref <tag|sha>` for reproducible benchmarking (recommended) — an
unpinned suite tracks the default branch and can change under you.

## 2. See what's available

```bash
bn experiments list                 # local + suite experiments
bn suites info terminal-bench       # suite metadata and task count
```

Suite tasks show up as `terminal-bench/<task>` (the alias form) or by their fully
qualified `github.com/bunsen-dev/terminal-bench/<task>` id.

## 3. Run a task

Pick a task and run it with a bundled agent:

```bash
bn run terminal-bench/fix-permissions claude-code
```

A few things worth knowing:

- **Choose the model** with `--model`, independent of the agent's variants:
  `bn run terminal-bench/fix-permissions claude-code --model claude-opus-4-8`.
  See the [model axis](./AGENT_YAML.md#model).
- **Apple Silicon:** many ported tasks are built for `linux/amd64`. If a task
  was authored for amd64, force it with `--platform linux/amd64` (it runs under
  emulation). See [Platforms & Architecture](./PLATFORMS.md).
- Terminal Bench tasks score with deterministic `script` criteria, so the
  **scoring itself needs no API key** — only the agent and orchestrator do.

## 4. Read the score

```bash
bn runs show              # score + per-criterion pass/fail for the latest run
bn runs open              # full run in the web viewer (traces, diff, artifacts)
```

A `script` criterion reports a clean pass/fail; the overall score is the
weighted combination. See [Scorers & Evaluation](./SCORERS.md) for how the math
works.

## 5. Compare agents

The point of a benchmark is comparison. Run the same task with a different agent,
then put the runs side by side:

```bash
bn run terminal-bench/fix-permissions basic-coding-agent
bn runs compare          # newest run per agent, side by side
```

Use `bn runs compare --matrix` to render an experiments × agents score grid once
you've run several.

## Next steps

- **[Suites](./SUITES.md)** — the full consume workflow: pinning, updating,
  inspecting, and authoring your own suite.
- **[Scorers & Evaluation](./SCORERS.md)** — how scoring works under the hood.
- **[Bring Your Own Task](./BRING_YOUR_OWN_TASK.md)** — wrap your *own* task the
  same way these benchmark tasks are defined.
