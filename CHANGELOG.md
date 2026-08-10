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

- **`bn agents infer-invoke <agent>`** — infers an agent's `entrypoint.invoke` template with a model
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

- **`experiment.yaml`: `threshold` aggregate function** — `aggregate: { function: threshold, at: 0.95 }`
  scores 1.0 when every `needs` dependency scored `>= at`, else 0.0 (`all` is the `at: 1.0` special
  case; comparison is `>=`). Lets suites derive headline metrics like "almost solved (>= 95% of
  tests)" from scores Bunsen already recorded instead of round-tripping state between criteria
  through files in the scorer container — which a hostile submission sharing that container could
  forge. `at` is validated (required for `threshold`, a number in [0, 1], rejected on other
  functions) and reflected in the `experiment.v1.json` schema.

### Changed

- **`bn new` is gone — creation is now noun-first.** `bn new experiment <name>` → **`bn experiments new <name>`** and `bn new agent <name>` → **`bn agents new <name>`**, so every resource verb reads noun-first (`bn agents new / add / infer-invoke / build / …`). The top-level `bn new` command was removed outright with no alias (pre-1.0, no users yet). `-t/--template` is unchanged.
- **Agent invocation is now composed deterministically.** The in-container LLM "orchestrator"
  (a model call that decided each agent's argv on every `bn run`) has been **retired**. The
  invocation is now a pure function of committed config — the agent's `entrypoint`
  (`command` + `invoke` + `args`) and the experiment's `task.prompt` — so runs are reproducible
  and comparable across agents and experiments, with no model in the invocation path. The
  composed invocation is still recorded on the run manifest's `orchestration` field and as the
  `orchestration/result.json` artifact.
- **`agent.yaml`: `examples` is no longer load-bearing at run time.** It is now documentation for
  human readers (and the primary input for `bn agents infer-invoke`). Previously the LLM orchestrator
  could infer a non-standard invocation from `examples`; an agent that relied on that must now
  declare `entrypoint.invoke` explicitly, otherwise it falls back to a bare positional
  `{prompt}` and may be mis-invoked. This is a runtime-semantics change JSON Schema cannot encode
  — hence this note. (In-repo, only `codex-cli` and `gemini-cli` needed the migration; both were
  updated.)

### Removed

- **The `orchestrator.cjs` platform bundle no longer ships.** With the runtime orchestrator retired
  and its authoring-time replacement (`bn agents infer-invoke`) running host-side, the ~1.4 MB
  `orchestrator.cjs` is no longer built by `@bunsen-dev/agents` or embedded into the `bn` binary
  (internal packaging change — no effect on the `bunsen.config.yaml` / `experiment.yaml` /
  `agent.yaml` schemas or the artifact/trace formats).
- **Starting an agent no longer requires an API key.** With the LLM orchestrator gone, `bn run`
  no longer needs `ANTHROPIC_API_KEY` to launch an agent, so a no-AI agent (e.g. `echo-agent`)
  with a script/aggregate-only rubric now runs **fully offline**. An API key is still required
  for LLM-based evaluation (judge/agent/browser-agent/report scorers) and for Claude-powered
  agents under test.

### Fixed

- **The `bn init --example` hello-world scorer now actually sees the agent's output.** The
  scaffolded criterion grepped `/workspace-source/.bunsen/agent-output.log`, a path agent stdout
  never lands at, so the canonical first run scored 0.00 even when the agent printed the right
  text. It now greps `/bunsen/run/logs.txt` — the run context mounted read-only into the scorer
  container — and the whole `bn init --example` → `bn run hello-world echo-agent` flow reliably
  scores 1.0. Contract-level tests now pin the example's agent invocation and scorer path to the
  runtime's real constants so the scaffold can't silently drift again.
- **`bn runs show` accepts an omitted run-id, defaulting to the most recent run** — matching
  `bn runs open` and the README's first-run flow (`bn run … && bn runs show`).
