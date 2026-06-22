# Scorers & Evaluation

Comprehensive documentation for Bunsen's evaluation system. A **criterion** is a user-authored entry under `evaluation.criteria` (each has a `type`); a **scorer** is the engine that runs a criterion; a **verifier** is a file you drop in `verifiers/`. (See the [Glossary](GLOSSARY.md) for these and other terms.) Scorers assess the agent under test against your criteria, producing 0-1 scores and human-readable summaries. A separate dedicated step — `evaluation.report` — produces an optional narrative artifact for the run.

## Overview

Bunsen has five criterion types:

| `type:`         | Description                              | Cost     | Best For                            |
| --------------- | ---------------------------------------- | -------- | ----------------------------------- |
| `script`        | Run a shell command in a scorer container | $0       | Tests, linting, file checks         |
| `judge`         | Single LLM call with attached evidence    | ~$0.05   | Review diff, assess quality         |
| `agent`         | Full agent loop with tools                | ~$0.10+  | Run commands, explore workspace     |
| `browser-agent` | Agent loop with screenshot/Playwright     | ~$0.15+  | UI / UX evaluation                  |
| `aggregate`     | Pure math over `needs:` scores            | $0       | Combine scores without an LLM       |

Plus the `evaluation.report` step — a dedicated synthesis pass that runs once per evaluation, after the criteria, regardless of gate state. Reports produce a markdown narrative, never a numeric score.

By default, scorers run in a **dedicated scorer container** isolated from the agent. The container has both `/workspace` (the agent's final state, copied) and `/workspace-source` (an immutable snapshot of the initial seeded inputs). Set `evaluation.container: agent` in `experiment.yaml` to run scorers in the agent's container instead, preserving filesystem state and the agent's execution-user context. Caveat: in agent-container scoring, `verifiers/` is mounted into the agent container before the agent runs (Docker can't add mounts to running containers), so verifier-only assets are not hidden from the agent.

## Quick Reference

```yaml
evaluation:
  criteria:
    # Script: shell command, exit code or explicit score
    - id: tests-pass
      title: Tests pass
      type: script
      run: pytest --tb=short
      scores: [0, 1]
      gate:
        ifBelow: 1                    # Skip remaining criteria if score < 1

    # Judge: single LLM call with attached evidence
    - id: code-quality
      title: Code quality
      type: judge
      instructions: Is the fix clean and minimal?
      evidence: [diff]                # Default: [diff]

    # Agent: full agent loop with tools
    - id: integration-works
      title: Integration works
      type: agent
      instructions: Verify the integration functions correctly.

    # Browser-agent: agent loop with screenshot/Playwright tools
    - id: ui-layout
      title: UI layout
      type: browser-agent
      instructions: Check responsive design and layout polish.

    # Aggregate: combine other scores mathematically
    - id: overall
      title: Overall
      type: aggregate
      needs: [tests-pass, code-quality]
      aggregate:
        function: weighted_average
      weight: 0

  # Dedicated narrative report (always runs; not a criterion).
  report:
    instructions: Synthesize the run as a short, evidence-cited narrative.
    needs: all
```

## Scorer Types in Detail

### Script criteria (`type: script`)

Run a shell command in the scorer container. The simplest and cheapest evaluation method.

```yaml
- id: tests-pass
  title: Tests pass
  type: script
  run: pytest --tb=short
  scores: [0, 1]
```

**Score resolution (highest precedence first):**

1. If `$BUNSEN_EVAL_RESULT` (default `/bunsen/scorer-output/result.json`) is written → parse it as a structured result (see "Structured `result.json`" below).
2. Else if `$BUNSEN_SCORE_FILE` is written → use that value (float in [0, 1]).
3. Otherwise, fall back to exit code:
   - Exit `0` → score `1.0`
   - Non-zero exit → score `0.0`

**Summary resolution:**

1. If `result.json.summary` is provided → use it.
2. Else if `$BUNSEN_SUMMARY_FILE` is written → use that content.
3. Else if a score file is present → `"Score: {value}"`.
4. Exit `0` (no files) → `"Passed"`.
5. Non-zero exit (no files) → `"Failed (exit code {code})"`.

**Structured `result.json`:**

For scorers that need to attach artifacts (coverage reports, generated diffs, screenshots, etc.) write a JSON document to `$BUNSEN_EVAL_RESULT`:

```json
{
  "score": 1,
  "summary": "Passed",
  "artifacts": [
    { "path": "coverage/report.txt", "mediaType": "text/plain" }
  ]
}
```

`artifacts[].path` is interpreted relative to `$BUNSEN_SCORER_OUTPUT`. Listed files are copied into the run directory and recorded on the criterion result, where they appear in the [run manifest](RUN_MANIFEST.md).

**The `bunsen-score` helper:**

Available on PATH in the scorer container for easy score reporting:

```bash
bunsen-score 0.85                    # Just the score
bunsen-score 0.85 "Coverage: 85%"    # Score + summary
```

**Examples:**

```yaml
# Simple pass/fail
- id: linting
  title: Linting
  type: script
  run: flake8 /workspace/src
  scores: [0, 1]

# Continuous score with bunsen-score
- id: test-coverage
  title: Test coverage
  type: script
  run: |
    pytest --cov=src --cov-report=json -q
    COV=$(python -c "import json; print(json.load(open('coverage.json'))['totals']['percent_covered']/100)")
    bunsen-score $COV "Coverage: $(python -c "print(f'{$COV*100:.0f}%')")"

# Verifier script
- id: output-valid
  title: Output valid
  type: script
  run: python /bunsen/verifiers/check_output.py
```

**Default timeout:** 60 seconds (configurable via the `timeout` field — duration string).

Use `/workspace-source` in scripts when you need the untouched seeded input, and `/workspace` when you need the agent's final outputs or post-run workspace state.

For verifier-owned scratch data, prefer `/tmp` or `/var/tmp` when the verifier creates or extracts thousands of files. In the dedicated scorer container, `/workspace` is an extracted/mounted copy of the agent workspace and can be noticeably slower for large file-heavy setup. Use `/workspace` when you are validating the agent's outputs; use `/tmp` or `/var/tmp` for temporary verifier staging.

### Judge criteria (`type: judge`)

A single LLM API call without tools. Reviews assembled evidence and produces a score.

```yaml
- id: minimal-changes
  title: Minimal changes
  type: judge
  instructions: |
    Review the diff to verify minimal changes:
    - Only the bug fix is included
    - No unrelated refactoring
    - No unnecessary whitespace changes
  evidence: [diff]
```

**Characteristics:**
- Single LLM call (no agent loop, no tool_use)
- Evidence assembled by the platform from the run's artifacts
- Cheapest LLM scorer option

The default model for every LLM-backed scorer (`judge`, `agent`, `browser-agent`, and `evaluation.report`) is `claude-sonnet-4-6`. Override it per criterion with `scorer.model`.

> **Models.** LLM-backed criteria (`judge`, `agent`, `browser-agent`) and `evaluation.report` run on Claude models, so `scorer.model` selects among Claude models. (This applies only to the platform's own scorers; traces captured from the agent under test are normalized across providers.) Scorers authenticate with the same `ANTHROPIC_API_KEY` you set up in [Getting Started](GETTING_STARTED.md); the runner forwards it into the scorer container as `$BUNSEN_ANTHROPIC_API_KEY`.

**Evidence options:**

| Value    | Description                                          |
| -------- | ---------------------------------------------------- |
| `diff`   | Workspace diff showing the agent's changes (default) |
| `logs`   | Agent stdout/stderr                                  |
| `traces` | AI conversation history (agent's own LLM calls)      |

```yaml
# Include logs for debugging-style evaluation
- id: error-handling
  title: Error handling
  type: judge
  instructions: Did the agent handle errors gracefully?
  evidence: [diff, logs]

# Include traces for reasoning-quality evaluation
- id: reasoning-quality
  title: Reasoning quality
  type: judge
  instructions: Was the agent's reasoning sound?
  evidence: [diff, traces]
```

`evidence` is a `judge`-only field. Agentic scorers (`type: agent`, `type: browser-agent`) ignore it because they fetch evidence on demand via tools.

**Default timeout:** 600 seconds (10 minutes).

### Agent criteria (`type: agent`)

Full agent loop with tools. Can explore the workspace, run commands, and gather information on demand.

```yaml
- id: server-works
  title: Server works
  type: agent
  instructions: |
    Start the server and verify it responds correctly.
    Run: curl http://localhost:3000/health
  scores: [0, 1]
  scorer:
    model: claude-sonnet-4-6        # Optional; default is claude-sonnet-4-6
```

**Characteristics:**
- Full agent loop with tool_use
- Access to workspace, run artifacts, and sub-tooling
- Can run commands, read files, explore
- More expensive but more thorough than `judge`

**Available tools:**
- `run_command` — execute shell commands in the workspace (supports `run_in_background`)
- `read_file` — read any path: workspace files, `/tmp`, `/bunsen/run/workspace/diff.patch`, `/bunsen/run/logs.txt`
- `list_files` — list directory contents
- `list_threads` — list agent conversation threads
- `read_thread_turns` — read turns from a specific thread
- `submit_score` — submit final score and summary

### Browser-agent criteria (`type: browser-agent`)

Agentic scorer with screenshot capability and Playwright tooling. For UI / UX evaluation.

```yaml
- id: visual-design
  title: Visual design
  type: browser-agent
  instructions: |
    Open the app in the browser and evaluate:
    - Layout matches the design requirements
    - Responsive behavior on different viewport sizes
    - Visual polish and consistency
  scores: [0, 0.25, 0.5, 0.75, 1]
```

**Additional tools:**
- `screenshot` — capture a browser screenshot
- `run_playwright_script` — execute a Playwright script against the browser session

**Requires:** `environment.image.base: bunsen/visual` (includes Playwright/Chromium).

### Aggregate criteria (`type: aggregate`)

Combine dependency scores mathematically without an LLM call.

```yaml
- id: overall-score
  title: Overall score
  type: aggregate
  needs: [tests-pass, code-quality, documentation]
  aggregate:
    function: weighted_average
  weight: 0
```

**Available functions:**

| Function           | Description                                          |
| ------------------ | ---------------------------------------------------- |
| `weighted_average` | Weighted average of `needs` scores                   |
| `all`              | 1.0 if every dep scores 1.0, else 0.0                |
| `any`              | 1.0 if any dep scores > 0.5, else 0.0                |
| `min`              | Minimum of `needs` scores                            |
| `max`              | Maximum of `needs` scores                            |

**Requirements:**
- Must have a `needs` field
- Pure computation — runs locally, no container
- Cost: $0
- If any of an aggregate's dependencies were skipped (gate failure), the aggregate itself is marked `skipped` rather than scored 0.

### Narrative report (`evaluation.report`)

The report is **not a criterion type** — it lives at `evaluation.report`, runs once per evaluation after every criterion, and is skipped only when `evaluation.report` is omitted entirely. Output is a markdown narrative stored at `evaluation/report.md` and surfaced in the manifest as `kind: report`.

```yaml
evaluation:
  report:
    model: claude-haiku-4-5         # Optional; default is claude-sonnet-4-6
    evidence: [diff, logs, traces]  # Optional; default is [diff]
    instructions: |
      Produce a short, evidence-cited narrative of the run.
      Reference specific lines in the diff and turn numbers in the trace.
    needs: all                      # Or list specific criterion ids
```

**Characteristics:**
- Always runs, regardless of gate skips
- Produces no numeric score (`score: null`)
- Has access to the same agent tools as `type: agent` criteria
- Omit `evaluation.report` to disable narrative generation entirely

## Common Criterion Fields

| Field         | Type                                                         | Description                                                                                       |
| ------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `id`          | string                                                       | **Required.** Stable machine id, used for `needs:` references and artifact paths.                 |
| `title`       | string                                                       | Human-readable label.                                                                             |
| `type`        | `script` \| `judge` \| `agent` \| `browser-agent` \| `aggregate` | **Required.** Explicit scorer type.                                                            |
| `weight`      | number                                                       | Weight for the rolled-up score (default: 1; set 0 to exclude).                                    |
| `scores`      | `number[]` \| `Record<number,string>`                        | Allowed discrete score values (or labeled values).                                                |
| `timeout`     | duration string                                              | Per-criterion timeout (e.g. `60s`, `5m`).                                                         |
| `gate`        | `{ ifBelow: number }`                                        | Skip remaining criteria when the resolved score is below this threshold.                          |
| `needs`       | `string[]` \| `'all'`                                        | Required for `aggregate`; available on any criterion to control execution order.                  |
| `instructions`| string                                                       | LLM prompt for `judge`, `agent`, `browser-agent`, and `evaluation.report`.                        |
| `run`         | string                                                       | Shell command for `type: script` only.                                                            |
| `evidence`    | `('diff' \| 'logs' \| 'traces')[]`                           | `judge`-only. Default: `[diff]`.                                                                  |
| `scorer`      | `judge`: `{ model? }` · `agent`/`browser-agent`: `{ model?, tools? }` | Optional per-criterion model selection; the `tools` allowlist applies to `agent`/`browser-agent` only. |
| `aggregate`   | `{ function: AggregateFunction }`                            | Required for `type: aggregate`.                                                                   |

The accepted set of fields per type is enforced by schema validation — `bn experiments validate` rejects, for example, `evidence` on a `script` criterion.

### `id` derivation

`id` is required, but `bn experiments validate --fix` will rewrite YAML in-place to derive missing ids from `title` via deterministic kebab-case slugification. This is an authoring convenience, not a runtime fallback — the parser hard-errors on a missing `id` at run time.

## Scoring System

### Score values

All scores are normalized to **[0, 1]**:
- `0.0` — complete failure
- `0.5` — partial success
- `1.0` — perfect

### Discrete scores

Use `scores` to constrain allowed values:

```yaml
# Binary pass/fail
- id: tests-pass
  title: Tests pass
  type: script
  run: pytest
  scores: [0, 1]

# 5-point scale
- id: code-quality
  title: Code quality
  type: judge
  instructions: Rate the code quality.
  scores: [0, 0.25, 0.5, 0.75, 1]

# Labeled scores (rendered in `bn eval show` and the web viewer)
- id: severity
  title: Severity
  type: judge
  instructions: Assess the severity of issues.
  scores:
    0: none
    0.33: minor
    0.66: moderate
    1: severe
```

### Weighted score

The final weighted score is:

```
weightedScore = sum(score[i] * weight[i]) / sum(weight[i])
```

Where:
- `weight[i] > 0` (criteria with `weight: 0` are excluded)
- `score[i] !== null` (`evaluation.report` and skipped criteria are excluded)

## Gate Semantics

`gate.ifBelow: <threshold>` short-circuits the rest of the criteria list when the criterion's resolved score is below the threshold:

```yaml
evaluation:
  criteria:
    # Cheap script runs first ($0)
    - id: tests-pass
      title: Tests pass
      type: script
      run: pytest
      scores: [0, 1]
      gate:
        ifBelow: 1                  # Must score 1.0

    # LLM scorer only runs if tests pass (~$0.05)
    - id: code-quality
      title: Code quality
      type: judge
      instructions: Is the fix clean?
  report:
    instructions: Synthesize a short narrative of the run.
    needs: all
```

**Behavior:**
- Skipped criteria are recorded with `status: 'skipped'` and `score: null` (not zero).
- `aggregate` criteria whose dependencies were skipped are themselves marked `skipped`, not scored 0 — otherwise "agent bombed early" and "agent got things wrong" would be indistinguishable.
- `evaluation.report` always runs to explain the failure.
- The overall `weightedScore` reflects only completed, non-zero-weight criteria.

Gating only skips the remaining criteria; it does not kill the run or mark it failed.

**Cost-savings example:**

If 80% of experimental runs fail the test gate:
```
Without gate: $0.00 (test) + $0.05 (judge) = $0.05/run
With gate:    0.2 × $0.05 + 0.8 × $0.00    = $0.01/run
Savings: 80%
```

## Dependencies (`needs`)

Any criterion can declare `needs: [<id>, ...]` to control execution order. `aggregate` criteria require `needs`. `evaluation.report` accepts `needs: all` (default) or a specific list.

```yaml
- id: code-quality
  title: Code quality
  type: judge
  instructions: Is the code clean?

- id: test-coverage
  title: Test coverage
  type: script
  run: python /bunsen/verifiers/coverage.py

- id: overall-quality
  title: Overall quality
  type: aggregate
  needs: [code-quality, test-coverage]
  aggregate:
    function: weighted_average
  weight: 0
```

**Properties:**
- Controls execution order (dependencies run first)
- Dependent agentic scorers can read upstream `{score, summary}` via tools
- `needs: all` depends on all other criteria
- Cycle detection in `bn experiments validate` rejects invalid configurations

## Execution Environment

### Dedicated scorer container (default)

By default, scorers run in a separate Docker container from the agent:

```
┌─────────────────────────────────────┐
│  Scorer container                   │
│                                     │
│  /workspace              (rw)       │  ← Agent's final workspace (copy)
│  /workspace-source       (ro)       │  ← Initial immutable snapshot
│  /bunsen/run/            (ro)       │  ← Run context (diff, logs, traces)
│  /bunsen/verifiers/      (ro)       │  ← Experiment's verifiers/ dir
│  /bunsen/scorer-output/  (rw)       │  ← Score + summary + result.json
│  /bunsen/bin/bunsen-score           │  ← Helper script (on PATH)
│                                     │
│  Working dir: /workspace            │
│                                     │
│  Environment:                       │
│    $BUNSEN_SCORE_FILE               │
│    $BUNSEN_SUMMARY_FILE             │
│    $BUNSEN_SCORER_OUTPUT            │
│    $BUNSEN_EVAL_RESULT              │
│    $BUNSEN_WORKSPACE_DIR            │
│    $BUNSEN_WORKSPACE_SOURCE_DIR     │
│    $BUNSEN_ANTHROPIC_API_KEY        │
└─────────────────────────────────────┘
```

**Why a separate container?**
- **Force-kill support** — Docker's exec API can't force-kill; full containers can.
- **Workspace isolation** — `/workspace` is an extracted copy, immune to agent damage.
- **Crash isolation** — a scorer crash doesn't affect other scorers.
- **Shared state** — all scorers share the container, so a server started by one criterion can be tested by another.

### Agent-container scoring (`evaluation.container: agent`)

Set `evaluation.container: agent` to run scorers in the agent's container instead of a dedicated one.

```yaml
evaluation:
  container: agent
  criteria: ...
```

**Properties:**
- Full filesystem state preserved (`/opt`, `/etc`, user home directories, installed packages)
- Scorers reuse the agent's execution-user context (`bunsen` when the agent ran non-root, root otherwise)
- No workspace extraction
- All scorers share the agent's container
- `/bunsen/verifiers` is mounted before the agent runs, so verifier assets are visible to the agent

Use this mode for tasks that depend on system-level or user-scoped state — conda environments, virtualenvs, installed packages, or daemons left running by the agent.

See [Agent Container Scoring](AGENT_CONTAINER_SCORING.md) and [Process Survival](PROCESS_SURVIVAL.md) for details.

### Verifiers directory

Experiments can include a `verifiers/` directory beside `experiment.yaml`:

```
experiments/my-experiment/
├── experiment.yaml
├── workspace/           # Seed (referenced via workspace.sources)
└── verifiers/           # Scorer scripts
    ├── expected.txt
    ├── check_output.py
    └── validate.sh
```

**Properties:**
- Auto-detected; no need to declare in `experiment.yaml`
- Read-only; mounted at `/bunsen/verifiers`
- Any files, any language

With `evaluation.container: agent`, this directory is mounted into the agent container before the agent runs. **Do not store secret benchmark fixtures here if you need them hidden from the agent.**

**Verifier dependencies:**

Install verifier dependencies via `environment.requires.packages`:

```yaml
environment:
  image:
    base: bunsen/headless
  requires:
    packages:
      pip: [coverage, pylint]
      npm: [ajv]

evaluation:
  criteria:
    - id: coverage
      title: Coverage
      type: script
      run: python /bunsen/verifiers/check_coverage.py
```

## Examples

### Code-only evaluation (high-throughput)

Purely deterministic, near-zero cost — Terminal Bench pattern.

```yaml
$schema: https://schemas.bunsen.dev/experiment.v1.json
version: v1
name: fizzbuzz
task:
  prompt: Implement FizzBuzz in /workspace/fizzbuzz.py
workspace:
  sources:
    - path: ./workspace
environment:
  image:
    base: bunsen/headless
evaluation:
  criteria:
    - id: correct-output
      title: Correct output
      type: script
      run: diff <(python /workspace/fizzbuzz.py) /bunsen/verifiers/expected.txt
      scores: [0, 1]
      gate:
        ifBelow: 1

    - id: no-hardcoding
      title: No hardcoding
      type: script
      run: |
        LINES=$(wc -l < /workspace/fizzbuzz.py)
        [ "$LINES" -lt 20 ]
      scores: [0, 1]
```

Cost per run: **$0** for evaluation.

### Gate pattern (cost-optimized)

Combine cheap script criteria with expensive LLM scorers.

```yaml
evaluation:
  criteria:
    # $0 — runs first
    - id: tests-pass
      title: Tests pass
      type: script
      run: pytest --tb=short
      scores: [0, 1]
      gate:
        ifBelow: 1

    # ~$0.05 — only if tests pass
    - id: code-quality
      title: Code quality
      type: judge
      instructions: Is the fix clean and minimal?

    # ~$0.05 — only if tests pass
    - id: documentation
      title: Documentation
      type: judge
      instructions: Are changes documented?

  report:
    instructions: Synthesize the run as a short, evidence-cited narrative.
    needs: all
```

### Shared state (server + tests)

Agent criterion starts a server, script criterion tests it. Both share the scorer container, so the server process persists.

```yaml
evaluation:
  criteria:
    - id: server-starts
      title: Server starts
      type: agent
      instructions: |
        Find and start the server on port 3000.
        Verify it responds: curl http://localhost:3000/health
      scores: [0, 1]
      gate:
        ifBelow: 1
      timeout: 30s

    - id: tests-pass
      title: Tests pass
      type: script
      run: pytest /bunsen/verifiers/test_api.py -v
      scores: [0, 1]
```

### Full evaluation rubric

Comprehensive evaluation with all criterion types plus a narrative report.

```yaml
evaluation:
  criteria:
    # Script gate
    - id: tests-pass
      title: Tests pass
      type: script
      run: cd /workspace && pytest --tb=short
      scores: [0, 1]
      gate:
        ifBelow: 1

    # Judge
    - id: minimal-changes
      title: Minimal changes
      type: judge
      instructions: Only the necessary changes — no unrelated edits.
      evidence: [diff]

    # Agent
    - id: error-handling
      title: Error handling
      type: agent
      instructions: Test edge cases and error scenarios.
      weight: 0.5

    # Browser-agent
    - id: ui-quality
      title: UI quality
      type: browser-agent
      instructions: Check visual design and responsiveness.
      weight: 0.5

    # Aggregate
    - id: overall-quality
      title: Overall quality
      type: aggregate
      needs: [minimal-changes, error-handling, ui-quality]
      aggregate:
        function: weighted_average
      weight: 0

  report:
    instructions: Produce a research-quality narrative referencing diff and trace evidence.
    needs: all
```

## Verifier Script Examples

### Shell (check_quality.sh)

```bash
#!/bin/bash
WARNINGS=$(pylint /workspace/src --score=no 2>&1 | grep -c "warning")
SCORE=$(python3 -c "print(max(0, 1 - $WARNINGS / 20))")
bunsen-score $SCORE "Found $WARNINGS warnings"
```

### Python (check_coverage.py)

```python
import json
import os
import subprocess

subprocess.run(["pytest", "--cov=src", "--cov-report=json", "-q"], cwd="/workspace")

with open("/workspace/coverage.json") as f:
    data = json.load(f)
    pct = data["totals"]["percent_covered"]

score = pct / 100
with open(os.environ["BUNSEN_SCORE_FILE"], "w") as f:
    f.write(str(score))
with open(os.environ["BUNSEN_SUMMARY_FILE"], "w") as f:
    f.write(f"Coverage: {pct:.1f}%")
```

### Node.js (validate_schema.js)

```javascript
const fs = require('fs');
const Ajv = require('ajv');

const schema = JSON.parse(fs.readFileSync('/bunsen/verifiers/schema.json'));
const data = JSON.parse(fs.readFileSync('/workspace/output.json'));

const ajv = new Ajv();
const valid = ajv.validate(schema, data);

fs.writeFileSync(process.env.BUNSEN_SCORE_FILE, valid ? '1' : '0');
fs.writeFileSync(
  process.env.BUNSEN_SUMMARY_FILE,
  valid ? 'Schema valid' : `Schema invalid: ${ajv.errorsText()}`
);
```

## Results Structure

Evaluation results are written to the run directory: per-criterion results and summaries land in `evaluation/result.json`, the optional narrative in `evaluation/report.md`, and human scores from `bn eval human` in `evaluation/human.json`. The result shape below is also reflected in the [run manifest](RUN_MANIFEST.md).

### CriterionResult

```typescript
interface CriterionResult {
  id: string;
  title?: string;
  scorerType: 'script' | 'judge' | 'agent' | 'browser-agent' | 'aggregate';
  weight: number;
  score: number | null;             // null for skipped criteria
  summary: string;
  allowedScores?: number[] | Record<number, string>;
  status: 'completed' | 'skipped' | 'not_run';
  screenshots?: string[];           // Browser-agent
  logPath?: string;                 // Script criterion logs
  artifacts?: ScriptResultArtifact[];
}
```

### EvaluationResult

```typescript
interface EvaluationResult {
  criteria: CriterionResult[];
  weightedScore: number;            // 0-1
  report?: string;                  // Markdown narrative produced by evaluation.report
}
```

## Choosing the Right Criterion Type

### Judge vs agent for code review

**Use `type: judge`** when:
- The diff is small and focused (e.g. fix-bugs experiments with targeted changes)
- You're evaluating the diff itself (minimality, style, correctness)
- Cost matters and the criterion doesn't need file exploration

**Use `type: agent`** when:
- The experiment produces large diffs (zero-to-one, scaffold-based projects)
- The criterion needs to review architecture or implementation details
- The workspace includes lockfiles or generated code that would dominate the diff
- The scorer needs to run commands (build, test, start servers)

`type: judge` receives the workspace diff as a single prompt. For large diffs (common in zero-to-one experiments), the diff gets truncated and source code may not be visible — leading to artificial 0.0 scores on criteria that need to see the code. `type: agent` reads specific files on demand.

**Rule of thumb:** if the criterion involves reviewing code that the agent *wrote* (not just *changed*), use `type: agent`.

### Browser-agent

`type: browser-agent` evaluates screenshots captured from the agent's workspace. Works well for functional checks ("does the UI render?", "is there a button?"); less reliable for subjective aesthetic judgment. Expect more scoring variance here than from any other criterion type, and expect the largest errors on broad, taste-driven criteria (e.g. "color harmony" or "visual quality").

**Tips for better browser-agent scoring:**

- **Decompose subjective criteria.** Instead of "Visual Quality" (pure taste), use narrower criteria: "consistent spacing between elements", "readable text contrast", "coherent color palette", "no overlapping elements". Specific criteria produce more consistent scores.
- **Use script proxies where possible.** Color contrast ratios (WCAG compliance), Lighthouse accessibility/performance scores, and responsive breakpoint checks are deterministic and free.
- **Accept higher variance on aesthetic criteria.** Subjective visual judgment is hard for any automated system, so purely aesthetic criteria score less consistently than functional ones.
- **Weight aesthetic criteria lower** if precise scoring matters. Functional visual checks ("does the page render?", "is the layout responsive?") are much more reliable than aesthetic ones.

### Lockfile exclusion

Lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`, etc.) are preserved in `workspace/diff.patch` on disk for full reproducibility and `bn runs export` workspace reconstruction, but are filtered out at consumption time — in scorers, `bn runs diff`, and `bn runs open`. This keeps LLM context windows free of auto-generated dependency noise while keeping the stored record complete.

Use `bn runs diff --include-lockfiles <run-id>` to see the full diff including lockfile changes.

## Best Practices

1. **Gate early.** Put cheap `type: script` criteria first with `gate.ifBelow: 1` to skip expensive LLM evaluation on failures.
2. **Use `script` for determinism.** Tests, linting, and file validation belong in `type: script` for reproducibility.
3. **`type: agent` for code review.** Use it for criteria that review source code quality — especially on zero-to-one experiments where diffs are large. `type: judge` works well for small, focused diffs (fix-bugs experiments).
4. **`type: judge` for diff review.** Use it when evaluating the diff itself — minimality, style, whether changes are targeted.
5. **`weight: 0`** for aggregate criteria. (`evaluation.report` is implicitly weight: 0 — it's not a criterion at all.)
6. **Use descriptive `title` text.** Write clear criterion titles — they appear in score reports and calibration output. Use YAML comments for internal notes; per-criterion `description` is not a supported field.
7. **Verifiers for reuse.** Put complex validation logic in `verifiers/` scripts.
8. **Timeout appropriately.** Script criteria default to 60s, LLM-backed criteria to 600s; tune as needed.

## CLI Commands

```bash
bn eval show <run-id>           # View evaluation scores
bn eval report <run-id>         # View evaluation.report narrative
bn eval human <run-id>          # Score a run with human judgment
bn eval calibrate [run-ids...]  # Compare human scores to LLM scores
bn runs open <run-id>           # Open in web viewer with all details
```

## Related Documentation

- [The Environment Model](ENVIRONMENT.md) — runtime + workspace setup
- [Scoring in the Agent Container](AGENT_CONTAINER_SCORING.md) — when and how to use `evaluation.container: agent`
- [Scoring Service Tasks](PROCESS_SURVIVAL.md) — scoring agents that leave a server or daemon running
- [experiment.yaml Reference](EXPERIMENT_YAML.md) — the full `evaluation` block in context
- [Run Manifest & Events](RUN_MANIFEST.md) — where scores, summaries, and artifacts are recorded
- [Cost Accounting](COST.md) — how scorer spend is tracked
- [Glossary](GLOSSARY.md) — criterion vs. scorer vs. verifier, and other terms
