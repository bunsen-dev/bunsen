# Changelog

All notable, user-facing changes to Bunsen are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
public packages (`@bunsen-dev/cli`, `@bunsen-dev/sdk`, `@bunsen-dev/types`) follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Bunsen is **pre-1.0**: breaking
changes to the public surface (the packages above plus the user-facing `bunsen.config.yaml`,
`experiment.yaml`, `agent.yaml`, suite, and `SKILL.md` schemas and the artifact/trace formats)
may land in minor releases, and are always called out here under **Changed** / **Removed**.

Unreleased changes accumulate below; when a release is cut, this section is renamed to the
version and date and a fresh `[Unreleased]` is started.

## [Unreleased]

### Added

- **`bn agents scaffold <agent>`** — infers an agent's `entrypoint.invoke` template with a model
  at **authoring time** (once per agent, host-side) and writes it into `agent.yaml` as a
  reviewable diff. It reads the agent's `examples`/`description` and runs the CLI's `--help` on
  the host when available (`--skip-help` to disable, `--help-text <file>` to supply it), shows the
  composed sample invocation, refuses to overwrite an existing `invoke` without `--force`, and
  supports `--dry-run` / `--model <id>`. Requires `ANTHROPIC_API_KEY`. This is the good half of
  the retired runtime orchestrator — onboarding a brand-new CLI — relocated out of the run loop, so
  the thing that *runs* stays deterministic and only the thing that *helps you write config* is a
  model.
- **`agent.yaml`: `entrypoint.invoke`** — an ordered argv template (the tokens from the first
  argument through the prompt slot) with per-token `{prompt}` / `{promptFile}` substring
  placeholders. It lets an agent declare an order-sensitive prefix — a subcommand
  (`invoke: [exec, "{prompt}"]` → `codex exec <prompt>`) or a prompt flag
  (`invoke: ["-p", "{prompt}"]` → `gemini -p <prompt>`) — while order-insensitive persistent
  flags stay in `entrypoint.args`. At most one placeholder kind per template. Omitting `invoke`
  defaults to `["{prompt}"]` (a bare positional prompt), so existing agents are unaffected.
  Reflected in the `agent.v1.json` schema.

### Changed

- **Agent invocation is now composed deterministically.** The in-container LLM "orchestrator"
  (a model call that decided each agent's argv on every `bn run`) has been **retired**. The
  invocation is now a pure function of committed config — the agent's `entrypoint`
  (`command` + `invoke` + `args`) and the experiment's `task.prompt` — so runs are reproducible
  and comparable across agents and experiments, with no model in the invocation path. The
  composed invocation is still recorded on the run manifest's `orchestration` field and as the
  `orchestration/result.json` artifact.
- **`agent.yaml`: `examples` is no longer load-bearing at run time.** It is now documentation for
  human readers (and the primary input for `bn agents scaffold`). Previously the LLM orchestrator
  could infer a non-standard invocation from `examples`; an agent that relied on that must now
  declare `entrypoint.invoke` explicitly, otherwise it falls back to a bare positional
  `{prompt}` and may be mis-invoked. This is a runtime-semantics change JSON Schema cannot encode
  — hence this note. (In-repo, only `codex-cli` and `gemini-cli` needed the migration; both were
  updated.)

### Removed

- **The `orchestrator.cjs` platform bundle no longer ships.** With the runtime orchestrator retired
  and its authoring-time replacement (`bn agents scaffold`) running host-side, the ~1.4 MB
  `orchestrator.cjs` is no longer built by `@bunsen-dev/agents` or embedded into the `bn` binary
  (internal packaging change — no effect on the `bunsen.config.yaml` / `experiment.yaml` /
  `agent.yaml` schemas or the artifact/trace formats).
- **Starting an agent no longer requires an API key.** With the LLM orchestrator gone, `bn run`
  no longer needs `ANTHROPIC_API_KEY` to launch an agent, so a no-AI agent (e.g. `echo-agent`)
  with a script/aggregate-only rubric now runs **fully offline**. An API key is still required
  for LLM-based evaluation (judge/agent/browser-agent/report scorers) and for Claude-powered
  agents under test.
