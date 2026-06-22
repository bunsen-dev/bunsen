---
name: bunsen-debug-run
description: >-
  Diagnose a Bunsen run that misbehaved — the agent crashed or exited non-zero, scored lower
  than expected, cost too much, produced an unexpected or empty workspace diff, captured no AI
  traces, or behaved nondeterministically. Drives the bn runs/eval inspection commands in the
  right order, maps each symptom to the surface that explains it, and reproduces the failure.
  Use when a run already exists and the user wants to understand WHY it went wrong — not to
  author an experiment (bunsen-new-experiment), write scorers (bunsen-author-scorer), or build
  an agent (bunsen-new-agent).
---

# Diagnose a Bunsen run

This skill **reads** an existing run and explains it, then hands the fix to the right
authoring skill. It never edits `experiment.yaml` / `agent.yaml` itself.

## Always start here

1. **Resolve the run.** `bn runs list` shows the 10 most recent (ID, Experiment, Agent,
   Model, Status, Score, Duration). Filter with `-e <exp>` / `-a <agent>`, widen with
   `-n <N>`, or `--ids-only` for scripting.
2. **Read the hub.** `bn runs show <id>` is the center of everything — Status, Exit Code,
   Duration, AI Usage, per-criterion Evaluation, Artifacts, and a footer linking every
   drill-down. **Read Status + Exit Code first; they route the rest.** For programmatic
   branching, `bn runs show <id> --format json` returns the full run manifest (branch on
   `status`, `exit_code`, `usage.accounting_status`, `evaluation.weighted_score`).

> From the CLI, `bn runs show <id> --format json` gives you `status` and `exit_code` (the
> manifest has no `phase` field). The exact failing **phase** lives in the run directory's
> `events.jsonl` — the terminal `run.failed` event carries `{ phase, reason }`. There is no
> `bn runs events` command; read `bn runs logs` for the agent's own error and pair it with the
> phase below.

## Symptom → command map

**Crash / non-zero exit / `failed` status**
- `bn runs logs <id>` — the container's combined stdout/stderr; first place a stack trace or
  `command not found` shows up.
- The failing **phase** (from the `run.failed` event in the run's `events.jsonl`) localizes
  the cause: `agent` = the agent-under-test crashed (read logs); `install.build` /
  `install.configure` = the agent's install (→ **bunsen-new-agent**); `workspace.sources` /
  `workspace.setup` = experiment setup (→ **bunsen-new-experiment**); `evaluation` = a scorer
  crashed (→ **bunsen-author-scorer**). `reason: SIGTERM` = timeout / external termination.

**Low score**  — separate "agent did the wrong work" from "scorer is miscalibrated"
- `bn eval show <id>` — per-criterion breakdown: score (or N/A), `(observation only)` for
  `weight: 0`, the scorer's summary (the **why**), a `Log:` path for script criteria,
  `Screenshot:` paths for browser-agent.
- `bn eval report <id>` — the narrative report (`--save` / `--open`).
- Then decide: confirm real failure with `bn runs diff <id>` + `bn runs logs <id>`; if the
  scorer's reasoning looks wrong, read the script criterion's `.log` and hand off to
  **bunsen-author-scorer**. Sanity-check a judge with `bn eval human <id>` then
  `bn eval calibrate <id>` (MAE / bias vs the LLM).

**High cost**
- `bn runs cost <id>` — per-source: **Agent** (headline; the `cache <read>·<created>` line
  usually dominates), **Platform** (orchestrator + supervisor + scorers, broken out so they
  never inflate the agent number), **Total**, and a run-cache rollup. If **Platform** is
  large, an expensive judge/agent scorer is the cost → **bunsen-author-scorer** (switch a
  judge to a script, or narrow evidence). The `Models` block in `bn runs show` is sorted
  highest-cost-first; `models[0]` carried the run. A `⚠`/`*` means the model wasn't in the
  price table and the cost is a coarse guess.

**No traces / $0 cost / "degraded accounting"**
- Read `usage.accounting_status` (in `bn runs show <id> --format json`): `captured` = real
  (a true $0 is a free/deterministic vendor); `missing` = the proxy recorded nothing (the
  agent likely bypassed it, or made no LLM calls) — **treat totals as a lower bound**;
  `skipped` = `--skip-traces` was set. `bn runs traces <id>` lists the captured calls;
  `--full` dumps full request/response bodies.

**Unexpected / empty diff**
- `bn runs diff <id>` — the workspace diff. **Lockfiles are filtered by default**; pass
  `--include-lockfiles` before concluding "the agent did nothing." `No workspace changes
  detected.` = it edited nothing (failed silently, worked outside `/workspace`, or misread
  the task — cross-check logs and score). The diff respects the **container's** `.gitignore`,
  so an agent that gitignored its own output looks misleadingly empty.

**Flaky / nondeterministic**
- `bn runs compare -e <exp> -a <agent>` pins a single experiment×agent cell and shows every
  recent run as columns (within-cell variance), with rows for each criterion, Weighted Score,
  Status, Model, Duration, Cost. `-n <N>` caps; `--since <date>` scopes; explicit ids compare
  exactly those; `--annotate <field>` (e.g. `exit-code`, `cost-source`) surfaces what
  differs. Diverging Status with identical inputs → agent/environment nondeterminism;
  diverging score with an identical diff → a flaky (often judge) scorer →
  **bunsen-author-scorer**.

## Reproduce

These are flags on **`bn run`** (you re-run to reproduce), not on `bn runs`:
- `--debug-keep-container` — leaves the container up so you can `docker exec` in.
- `--export-workspace` — writes the full final workspace (not just the diff).
- `--record` — asciinema replay, viewable in `bn runs open`.

For a run that already finished: `bn runs export <id> [-o <dir>] [--install]` reconstructs the
final workspace; `bn runs open <id>` launches the local web viewer (Report / Screenshots /
Traces / Logs / Diff + terminal replay; `-p <port>` to change port).

## Route the fix (this skill's exit)

Name the root cause and hand off — debug-run doesn't edit YAML:

- Agent crashed in its own code / install / invocation, or `missing` traces from a
  proxy-bypassing agent → **bunsen-new-agent**.
- Workspace setup / source-seeding failed, the task prompt is wrong, or the diff shows the
  agent had nothing to work on → **bunsen-new-experiment**.
- A criterion scored implausibly, a judge is miscalibrated, a script criterion errored, or a
  scorer is too expensive → **bunsen-author-scorer**.
- Docker missing, no API key, storage issue → not a config defect; run `bn doctor`.

State the evidence (which command showed what) so the handoff is actionable. Prefer
`--format json` (on `show`, `cost`, `eval show`, `list`, `compare`) when an agent needs to
branch on the result instead of scraping text.
