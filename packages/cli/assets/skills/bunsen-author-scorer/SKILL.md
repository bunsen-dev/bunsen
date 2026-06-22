---
name: bunsen-author-scorer
description: >-
  Design or refine the evaluation block of a Bunsen experiment — choosing among criterion
  types (script, judge, agent, browser-agent, aggregate) and the evaluation.report step,
  wiring gates/weights/needs, scoping evidence for cost, picking a scorer model, choosing the
  dedicated-vs-agent scorer container, and writing verifier scripts. Use for intents like
  "score this", "add a rubric/criterion", "gate the expensive judge", "make my scorer
  cheaper", or "write a verifier". For creating the whole experiment use bunsen-new-experiment;
  for authoring the agent use bunsen-new-agent; for diagnosing a finished run's scores use
  bunsen-debug-run.
---

# Author Bunsen scorers (the evaluation block)

Everything here lives under the experiment's `evaluation:` key, which has exactly three
children: `container` (optional), `criteria` (required array), and `report` (optional). This
skill edits an *existing* experiment's evaluation; it does not create experiments
(bunsen-new-experiment) or read finished-run scores (bunsen-debug-run).

> Field truth lives in [`reference/criteria-schema.md`](reference/criteria-schema.md) — every
> criterion type's required/optional fields, the gate/needs/scores defs, the report block,
> and the script runtime contract, generated from the schema your `bn` ships. Consult it; let
> `bn experiments validate` be the oracle.

## The five criterion types (cheapest first)

| Type | Cost | Use for | Required field |
|------|------|---------|----------------|
| `script` | $0 | deterministic tests / lint / file checks | `run` (shell) |
| `judge` | ~$0.05 | one LLM call over assembled evidence — small, focused **diffs** | `instructions` |
| `agent` | ~$0.10+ | a tool loop that reads files/runs commands — large diffs or code the agent **wrote** | `instructions` |
| `browser-agent` | ~$0.15+ | screenshot/Playwright UI checks (needs `bunsen/visual`) | `instructions` |
| `aggregate` | $0 | pure math over other criteria | `aggregate.function` + `needs` |

Rule of thumb: reviewing the **diff** (minimality, style) → `judge`; reviewing code the agent
**authored** (architecture, needs to explore files) → `agent` (a `judge` truncates large
diffs and can return a false `0.0`).

## Steps

1. **Read the current evaluation.** `bn experiments show <name> --format yaml` dumps the
   parsed config so you see what's already there.

2. **Write each criterion's required fields.** Every criterion needs `id` (kebab-case),
   `title`, and `type`, then its type-specific field above. `additionalProperties: false` is
   enforced **per type** — a field valid on one type is rejected on another. There is **no
   `code` field** (that's the old shape); the shell field is `run`.

3. **Gate to short-circuit expensive scoring.** Put cheap `script` criteria **first** with
   `gate: { ifBelow: <threshold> }`. If that criterion's score is below the threshold, every
   criterion **after it in the array** is skipped (`status: skipped`, `score: null` — never
   0). Gating is **positional**, not dependency-based. This is the canonical cost pattern:
   gate a `$0` test run before any judge fires.

4. **Scope evidence on judges for cost.** `judge` only: `evidence: [diff|logs|traces]`
   (default `[diff]`). Keep it to `[diff]` unless the criterion truly needs `logs` (agent
   stdout/stderr) or `traces` (the agent's own LLM conversation) — each source inflates input
   tokens. `evidence` is **judge-only**: `agent`/`browser-agent` fetch evidence on demand via
   tools; `script` rejects it (validate error). Lockfiles are auto-filtered from the diff.

5. **Select the scorer model where it matters.** Default for every LLM-backed scorer is
   `claude-sonnet-4-6`. Override per criterion: `judge` takes `scorer: { model }` (model
   only — `tools` is rejected on a judge); `agent`/`browser-agent` take
   `scorer: { model, tools }`. The report uses a **flat** `report.model`. Use a cheaper model
   (e.g. `claude-haiku-4-5`) for simple binary judgments. (All LLM scorers run on Claude
   models today.)

6. **Combine with `aggregate` + `needs`; set weights.** The weighted score is
   `sum(score·weight) / sum(weight)` over completed criteria with `weight > 0`. Give
   `aggregate` criteria `weight: 0` so they don't double-count. `aggregate` requires **both**
   `needs: [ids]` and `aggregate.function` (`weighted_average|all|any|min|max`). Any
   criterion may carry `needs` to force order; only `aggregate` requires it. If an aggregate's
   deps were gate-skipped, the aggregate is skipped (not 0).

7. **Add the narrative report (optional).** `evaluation.report` is a sibling object, **not**
   a criterion — it runs once after all criteria, **always** (even after a gate skip), and
   writes a markdown narrative to `evaluation/report.md` with no numeric score. Required:
   `instructions`. Optional: `model` (flat), `evidence` (default `[diff]`), `needs`,
   `timeout`. It has the tool access of a `type: agent` criterion. Omit the block to disable.

8. **Choose the scorer container.** Default `container: dedicated` runs scorers in a fresh
   container with `/workspace` (the agent's final state, read-write copy) and
   `/workspace-source` (the immutable initial snapshot). `container: agent` runs scorers
   **inside the agent's finished container** — use it when scoring depends on packages,
   services, or venvs the agent created. ⚠️ With `agent` mode, `verifiers/` is mounted
   **before** the agent runs, so don't hide grading secrets there.

9. **Wire the script-criterion runtime contract.** A `verifiers/` dir next to experiment.yaml
   is auto-mounted read-only at `/bunsen/verifiers` — reference it as
   `python /bunsen/verifiers/check.py`. In a `run:` script, report the score (highest
   precedence first): write JSON to `$BUNSEN_EVAL_RESULT` → write a float to
   `$BUNSEN_SCORE_FILE` → else the exit code (`0` → 1.0, non-zero → 0.0). The
   **`bunsen-score <score> [summary]`** helper on PATH is the easy path. Default timeouts:
   script `60s`, LLM scorers `600s` — override with a per-criterion `timeout`.

10. **Constrain scores and validate — the oracle.** Use `scores: [0, 1]` for pass/fail, a
    discrete scale `[0, 0.25, 0.5, 0.75, 1]`, or a labeled map `{0: none, 1: severe}`. Then:
    ```bash
    bn experiments validate <name>          # the oracle (exit 3 on schema/cycle errors)
    bn experiments validate <name> --fix    # derive missing criterion ids from titles
    bn experiments validate --all           # if you touched shared rubrics
    ```
    Iterate on the reported `evaluation.criteria[N]: …` error until exit 0.

## Gotchas

- `run` not `code`; `evidence` is **judge/report-only** (script/agent/browser-agent/aggregate
  reject it); `judge.scorer` takes **only** `model` (no `tools`).
- A criterion's model is nested at `scorer.model`; the **report's** is the flat `report.model`.
  `model` directly on a criterion fails validation.
- `aggregate` needs **both** `needs` and `aggregate.function`; give it `weight: 0`.
- Gate skipping is **positional** — order cheap script gates first; skipped ≠ scored 0.
- `browser-agent` needs `environment.image.base: bunsen/visual`.
- There is **no per-criterion `description` field** — use `title` plus YAML comments. (Only
  the top-level experiment and variants have `description`.)
- A `judge` truncates large diffs → false `0.0`; switch to `agent` for code the agent wrote.

## Complete example

```yaml
$schema: https://schemas.bunsen.dev/experiment.v1.json
version: v1
name: example-scored
task:
  prompt: Fix the failing test in /workspace.
workspace:
  sources:
    - path: ./workspace
environment:
  image:
    base: bunsen/headless
evaluation:
  container: dedicated
  criteria:
    - id: tests-pass
      title: Tests pass
      type: script
      run: cd /workspace && pytest --tb=short
      scores: [0, 1]
      gate:
        ifBelow: 1                    # broken solution → skip the judges below
    - id: minimal-changes
      title: Minimal changes
      type: judge
      instructions: Review the diff. Is the fix clean, minimal, and free of unrelated edits?
      evidence: [diff]
      scorer:
        model: claude-sonnet-4-6
    - id: overall
      title: Overall
      type: aggregate
      needs: [tests-pass, minimal-changes]
      aggregate:
        function: weighted_average
      weight: 0                       # observation only — don't double-count
  report:
    instructions: Synthesize the run as a short, evidence-cited narrative.
    needs: all
```

**Done when** `bn experiments validate <name>` is green. To see how these scorers behaved on
a real run, that's **bunsen-debug-run** (`bn eval show <run-id>`).
