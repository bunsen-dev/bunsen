# Bunsen

Bunsen is a general-purpose experiment runner for agentic systems. Give an agent an environment, run it reproducibly, capture artifacts and traces, then evaluate the result. Environment-first, agent-agnostic.

**North Star**: Make experiments easy to create, agents easy to plug in, and insights automatic—building a communal lab that accelerates agentic AI research.

## Documentation

- [README.md](./README.md) - Product overview, quick start, CLI reference, and package map
- [docs/ENVIRONMENT.md](./docs/ENVIRONMENT.md) - Experiment environment, workspace, and agent composition model
- [docs/SCORERS.md](./docs/SCORERS.md) - Evaluation criteria and scorer behavior
- [docs/SUITES.md](./docs/SUITES.md) - Consuming and authoring benchmark suites
- [docs/SKILLS.md](./docs/SKILLS.md) - Cross-agent `SKILL.md` authoring skills and `bn skills install`
- [docs/TRUST_MODEL.md](./docs/TRUST_MODEL.md) - Security boundary and safe-sharing guidance

## Task Tracking

Public issues and PRs are the durable coordination surface. Some development checkouts may also include
private planning folders such as `tasks/` or `working-docs/`; do not assume those folders exist in the
public repository.

## Incidental Issues

When you encounter a bug or issue outside the scope of your current task:

- **Fix it inline** if it's small (~5 min or less), low-risk, and in code you're already touching. Mention what you fixed but don't create a task file.
- **Otherwise, record it as an issue or PR note** with enough context that someone can pick it up without re-discovering the problem.
- **If it's blocking your current task**, flag it with the context and the concrete reproduction steps.

When in doubt, err toward creating a task — staying focused on the current objective is more valuable than fixing something opportunistically.

## How to Work

- Please add tests as you work
- Whenever you complete any work that adds or changes functionality, update README.md and any other relevant docs (see above)
- **Don't accumulate compatibility cruft.** Bunsen is pre-1.0 and still moves fast. Inside the repo, do not keep old APIs "just in case," do not add compatibility shims, do not maintain adapters from an old shape to a new shape, do not re-export deleted names, do not leave `Legacy*` aliases around for callers to migrate at their leisure. When a surface changes, update every call site in the same commit and delete the old version. Dual-shape / dual-path code is the specific failure mode to avoid.
- **Break the public surface deliberately, not silently.** The source is public now. The public packages are `@bunsen-dev/cli`, `@bunsen-dev/sdk`, and `@bunsen-dev/types`, plus the user-facing schemas (`bunsen.config.yaml`, `experiment.yaml`, suite and `SKILL.md` formats) and the artifact/trace formats people parse. Breaking changes there are still fine — we're pre-1.0 — but they must be **deliberate, called out in release notes, and flagged to me first**, never silent or accidental. Internal packages (`@bunsen-dev/runtime`, `@bunsen-dev/agents`, anything marked `private: true`) carry no API-stability obligation and stay free to change.
- Anytime you need to add a library or new piece of architecture or make a major decision on anything, please think through options, offer your guidance and recommendations, and then ask me what I'd like to do

## Running `bn` Locally

- **Use the locally-built `bn`, not whatever is on PATH by default.** A globally-installed `bn` (e.g. a pnpm-global shim under `~/Library/pnpm/bn`) can be a **separate stale install pointing at another repo** — it will silently ignore changes built here (symptoms: a Dockerfile experiment falls back to the base image, a new `run.*` field is rejected as "unknown field", your runtime fix has no effect). To get the **real standalone-binary UX** wired to this repo, run **`scripts/rebuild-bn.sh`** — it does `pnpm -r build`, builds the standalone binary, clears the version-keyed asset cache, and symlinks `~/.local/bin/bn` (which precedes `~/Library/pnpm` on PATH) to it. **Re-run it after any runtime/CLI change.** (For a quick inner loop without rebuilding the binary, `pnpm bn <cmd>` runs `bun packages/cli/dist/bin.js` directly off `dist/` — but the binary is the closest to real UX.)
- The `bn` CLI loads env files declared in `defaults.envFiles` of `bunsen.config.yaml` at startup (`loadProjectEnv()` in `packages/runtime/src/env.ts`, called from `packages/cli/src/index.ts`). The project's own config lists `.env`, so `ANTHROPIC_API_KEY` and other secrets placed there are exposed to `process.env` before any command runs — **you do not need to `export` them in your shell**. `process.env` values already set take precedence (the `.env` never clobbers an explicit shell value).
- Docker Desktop on this machine ships its binaries under `/Applications/Docker.app/Contents/Resources/bin/` and is not on the default PATH in non-interactive shells. For `bn run` / `bn agents build` / anything that shells out to `docker`, prepend that directory: `export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"`.

## Benchmark Porting Policy

When porting external experiment suites such as Terminal Bench into Bunsen, use exactly two approaches:

- Prefer light, suite-wide transformations that apply broadly across the benchmark
- If a specific experiment does not translate cleanly, maintain it as a native Bunsen implementation instead of adding experiment-specific converter hacks
- For native forks and Dockerfile-backed tasks, prebuild immutable expensive artifacts and seed them with `workspace.sources` whenever the verifier does not require the agent to produce them

Do not keep accumulating brittle per-experiment translation logic in conversion scripts. If a task needs semantics-aware special handling, treat that as a signal to fork it into a native Bunsen experiment and preserve that folder during regeneration.
For Terminal Bench, the converter, validator, overrides, and native-fork list all live in the [`bunsen-dev/terminal-bench`](https://github.com/bunsen-dev/terminal-bench) suite repo (`scripts/`). Record native forks in that repo's `scripts/tb-native-tasks.yaml` with notes explaining why they were forked.
