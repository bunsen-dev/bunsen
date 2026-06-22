# Run Manifest & Events

Every Bunsen run records two public artifacts in its run directory:

- **`manifest.json`** — the canonical, on-disk end-state summary of the run. Its
  shape is `RunManifestV1` (exported from `@bunsen-dev/types`).
- **`events.jsonl`** — the ordered, append-only execution timeline. One JSON
  object per line, each a `RunEvent` (also from `@bunsen-dev/types`).

Both are stable public contract. The manifest is the "what is the final state"
record; the event log is the "what happened, in order" record. They live side by
side in the run directory, which defaults to `.bunsen/runs/<run-id>/`:

```
.bunsen/runs/<run-id>/
  manifest.json
  events.jsonl
  ...
```

Open a run's full directory (including a local web viewer at
`http://localhost:3456`) with `bn runs open [run-id]`; see [CLI.md](./CLI.md) for
the rest of the `bn runs` commands.

> **Naming convention:** manifest JSON keys are **snake_case** (the on-disk
> contract), while event `data` payload keys are **camelCase**. This is
> intentional — match each file's convention when you parse it.

## `RunManifestV1`

A populated manifest looks like this (trimmed for length):

```jsonc
{
  "schema_version": 1,
  "run_id": "2026-06-21T17-04-12_a1b2c3",
  "manifest_revision": 3,
  "run_source": "local",
  "created_at": "2026-06-21T17:04:12.001Z",
  "updated_at": "2026-06-21T17:09:48.512Z",
  "started_at": "2026-06-21T17:04:12.118Z",
  "completed_at": "2026-06-21T17:09:48.500Z",
  "duration_ms": 336382,
  "status": "succeeded",
  "exit_code": 0,
  "platform": "linux/arm64",
  "experiment": { "id": "fibonacci-server", "path": "experiments/fibonacci-server" },
  "agent": {
    "id": "claude-code",
    "args": [],
    "model": "claude-opus-4-8",
    "models": [
      { "model": "claude-opus-4-8", "calls": 14, "input_tokens": 38211,
        "output_tokens": 9044, "cost_usd": 1.2243 }
    ]
  },
  "usage": {
    "total_ai_calls": 17,
    "total_input_tokens": 41902,
    "total_output_tokens": 9711,
    "estimated_cost_usd": 1.31,
    "accounting_status": "captured"
  },
  "evaluation": {
    "weighted_score": 0.83,
    "criteria": [
      { "id": "server-responds", "weight": 1, "score": 1, "summary": "200 OK on /fib/10",
        "scorer_type": "script", "status": "completed" }
    ]
  },
  "provenance": { "verification_tier": "self_reported", "replayable": true },
  "artifacts": [
    { "key": "diff", "kind": "diff", "rel_path": "artifacts/workspace.diff",
      "content_type": "text/x-diff", "bytes": 2841, "created_at": "2026-06-21T17:09:48.300Z" }
  ]
}
```

### Top-level fields

| Field | Type | Notes |
|---|---|---|
| `schema_version` | `1` | Always `1`. The manifest schema discriminator. |
| `run_id` | `string` | Unique id for the run. |
| `manifest_revision` | `number` | Starts at `1`; incremented on each manifest-changing update. |
| `run_source` | `RunSource` | Where the run originated. |
| `created_at` | `string` | ISO8601. When the run record was created. |
| `updated_at` | `string` | ISO8601. Last manifest write. |
| `started_at` | `string` | ISO8601. When execution began. |
| `completed_at` | `string?` | ISO8601. When execution finished; absent until terminal. |
| `duration_ms` | `number` | Run duration in milliseconds. |
| `status` | `RunStatus` | See [RunStatus values](#runstatus-values). |
| `exit_code` | `number?` | Agent process exit code, when known. |
| `platform` | `RunPlatform?` | Resolved platform for the run. |
| `experiment` | `RunManifestExperiment` | The experiment that ran. See [Experiment](#experiment). |
| `agent` | `RunManifestAgent` | The agent under test. See [Agent](#agent). |
| `orchestration` | `RunManifestOrchestration?` | Setup commands and the structured invocation. |
| `usage` | `RunManifestUsage` | API call / token / cost accounting. See [Usage](#usage). |
| `evaluation` | `RunManifestEvaluation?` | Scores and report; absent on unevaluated runs. |
| `human_scoring` | `RunManifestHumanScoring?` | Human calibration scores, when recorded. |
| `provenance` | `RunManifestProvenance` | Verification tier, replayability, attestation. |
| `artifacts` | `RunManifestArtifact[]` | Captured artifacts (diffs, logs, screenshots, exports). |
| `diagnostics` | `RunManifestDiagnostic[]?` | Non-blocking signals; see [Diagnostics](#diagnostics). |

### RunStatus values

`status` is a `RunStatus`, one of:

`'pending' | 'running' | 'succeeded' | 'failed' | 'canceled'`

### RunSource and RunPlatform values

- `run_source` (`RunSource`) records where the run executed: `'local'` or `'remote'`.
- `platform` (`RunPlatform`) is a `linux/<arch>` value: `'linux/amd64'` or
  `'linux/arm64'`. See [PLATFORMS.md](./PLATFORMS.md).

### Experiment

`experiment: RunManifestExperiment`:

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Experiment id. |
| `path` | `string?` | On-disk path, when run from disk. |
| `variant` | `string?` | Experiment variant, when selected. |
| `suite_id` | `string?` | Canonical suite id (`<host>/<org>/<repo>` for git-cloned suites, `local/<dirname>` for on-disk suites). Only present for suite runs; not the local alias from `bunsen.config.yaml#suites[].as`. |
| `suite_version` | `string?` | Commit sha of the cloned suite ref. Suite runs only. |
| `suite_source_url` | `string?` | Git URL the suite was cloned from. Git-cloned suite runs only. |
| `config_hash` | `string?` | SHA-256 over the normalized experiment config. |

### Agent

`agent: RunManifestAgent`:

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Agent id. |
| `path` | `string?` | On-disk path, when run from disk. |
| `variant` | `string?` | Agent variant, when selected. |
| `args` | `string[]` | Invocation args. |
| `model` | `string?` | The model the agent was *configured* with — the merged value of its declared `model.env` var (`--model`, a variant pin, or the declared default). Launch-time intent; absent when the agent declares no model. Contrast with `models` (observed). |
| `models` | `AgentModelUsage[]?` | Models the agent under test drove. See below. |
| `config_hash` | `string?` | SHA-256 over the normalized agent config. |
| `deps` | `RunManifestAgentDep[]?` | Resolved `install.deps` (version + cache key, in declared order). |

`agent.models` is observed from captured traces and **sorted highest-cost
first**, so `models[0]` is the run's headline/primary model — the one that
carried the run's compute, not necessarily the one with the most calls. It is
**absent when no agent traces were captured**: there is no declared/placeholder
fallback, so it is always a record of what actually ran. It counts only
successful (2xx) inference — errored calls (e.g. a 404 for an unavailable model)
are excluded — and excludes platform-model calls (orchestrator, supervisor,
scorer), which live in `usage.by_source`. Because errored and platform calls are
filtered out, the per-model `calls` here do not sum to `usage.total_ai_calls`.

`AgentModelUsage` (one model's slice of the run's API usage):

| Field | Type |
|---|---|
| `model` | `string` |
| `calls` | `number` |
| `input_tokens` | `number` |
| `output_tokens` | `number` |
| `cost_usd` | `number` |

`RunManifestAgentDep`:

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | Dep name. |
| `version` | `string?` | Resolved version, when known. |
| `cache_key` | `string` | `install.deps` build-cache key. |
| `binaries` | `string[]` | Binary names declared in `provides.binaries`. |

### Orchestration

`orchestration: RunManifestOrchestration`:

| Field | Type | Notes |
|---|---|---|
| `setup_commands` | `string[]` | Setup commands run before the agent. |
| `invocation` | `{ command: string; args: string[] }` | Structured invocation. |

### Usage

`usage: RunManifestUsage` — the run's API accounting. See
[docs/COST.md](./COST.md) for how these numbers are priced and attributed.

| Field | Type | Notes |
|---|---|---|
| `total_ai_calls` | `number` | All captured inference calls (agent + platform). |
| `total_input_tokens` | `number` | Fresh (non-cached) input tokens. |
| `total_output_tokens` | `number` | Output tokens. |
| `total_cache_read_input_tokens` | `number?` | Run-wide cache-read input tokens, summed across sources. Disjoint from `total_input_tokens`. Absent on runs with no captured traces. |
| `total_cache_creation_input_tokens` | `number?` | Run-wide cache-creation input tokens. Same disjointness; absent on runs with no captured traces. |
| `estimated_cost_usd` | `number` | Total estimated cost. |
| `agent_cost_usd` | `number?` | Cost attributable to the agent under test. |
| `platform_cost_usd` | `number?` | Cost attributable to platform agents. |
| `pricing_fallback_calls` | `number?` | Calls whose model was absent from the vendored pricing snapshot and priced with a coarse per-provider default — that much of the cost is a rough estimate. Present only when > 0. |
| `unpriced_models` | `string[]?` | Distinct unrecognized model ids behind `pricing_fallback_calls`, sorted. |
| `by_source` | `Record<string, RunManifestUsageSource>?` | Per-source breakdown (agent vs orchestrator/supervisor/scorer). |
| `accounting_status` | `'captured' \| 'missing' \| 'skipped'` (optional) | Whether the numbers reflect actual captured traffic. See below. |

`RunManifestUsageSource`:

| Field | Type | Notes |
|---|---|---|
| `calls` | `number` | Calls from this source. |
| `input_tokens` | `number` | Fresh (non-cached) input tokens. |
| `output_tokens` | `number` | Output tokens. |
| `cache_read_input_tokens` | `number?` | Cache-read input tokens for this source, disjoint from `input_tokens`. |
| `cache_creation_input_tokens` | `number?` | Cache-creation input tokens for this source. |
| `cost_usd` | `number` | Cost for this source. |

#### `usage.accounting_status` semantics

This field distinguishes a "trustworthy zero" from "no proxy data — we don't
know":

- **`'captured'`** — the proxy intercepted at least one inference call. The
  numbers are accurate within the limits of the in-proxy parser.
- **`'missing'`** — the proxy was active but recorded no traces. Could mean a
  deterministic agent that made no LLM calls, or an agent whose HTTP client
  bypassed the proxy (e.g. Node native fetch / undici, which does not honor
  `HTTPS_PROXY`). Treat the totals as a lower bound.
- **`'skipped'`** — tracing was deliberately disabled (`--skip-traces`).
- **`undefined`** — a run that errored before the trace-finalization step.

### Evaluation

`evaluation: RunManifestEvaluation`:

| Field | Type | Notes |
|---|---|---|
| `weighted_score` | `number` | Overall weighted score. |
| `criteria` | `RunManifestCriterion[]` | Per-criterion results. |
| `report` | `string?` | Narrative evaluation report, when generated. |

`RunManifestCriterion`:

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Criterion id (matches `Criterion.id` from the experiment). |
| `title` | `string?` | Human-readable title. |
| `weight` | `number` | Criterion weight in the aggregate. |
| `score` | `number \| null` | Resolved score; `null` when not scored. |
| `summary` | `string` | Scorer summary. |
| `status` | `'completed' \| 'skipped' \| 'not_run'` (optional) | Lifecycle status. |
| `scorer_type` | `RunManifestScorerType?` | The criterion type that produced the score: `'script' \| 'judge' \| 'agent' \| 'browser-agent' \| 'aggregate'`. See [SCORERS.md](./SCORERS.md). |
| `allowed_scores` | `AllowedScores?` | Allowed score set or range for the criterion (e.g. a discrete set or a min/max range). |
| `screenshots` | `string[]?` | Artifact keys for screenshots the scorer produced. |
| `log_path` | `string?` | Artifact key for the scorer's log output. |

### Human scoring

`human_scoring: RunManifestHumanScoring`:

| Field | Type | Notes |
|---|---|---|
| `scored_by` | `string` | Who recorded the human scores. |
| `scored_at` | `string` | ISO8601. |
| `criteria` | `RunManifestHumanCriterion[]` | Per-criterion human scores. |

`RunManifestHumanCriterion`:

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Criterion id. |
| `human_score` | `number` | The human-assigned score. |
| `llm_score` | `number \| null` | The LLM score being calibrated against. |
| `notes` | `string?` | Reviewer notes. |
| `allowed_scores` | `AllowedScores?` | Allowed score set/range. |

### Provenance

`provenance: RunManifestProvenance`:

| Field | Type | Notes |
|---|---|---|
| `verification_tier` | `VerificationTier` | How strongly the run's reproducibility is guaranteed: `'self_reported' \| 'reproducible' \| 'attested'`. |
| `replayable` | `boolean` | Whether the run is reproducible. |
| `image_digest` | `string?` | Pinned image digest. |
| `suite_version_locked` | `boolean?` | Whether the suite version is pinned. |
| `attestation_id` | `string?` | Attestation id, when present. |

### Diagnostics

`diagnostics: RunManifestDiagnostic[]` are non-blocking signals Bunsen surfaces
about the run. The type is a discriminated union; the `cross-boundary-binary-shadow`
variant is emitted by the cross-boundary binary-shadow detector (see
[ENVIRONMENT.md#asymmetric-composition](./ENVIRONMENT.md#asymmetric-composition)).
Absent on runs that recorded no diagnostics.

`RunManifestCrossBoundaryShadow`:

| Field | Type | Notes |
|---|---|---|
| `diagnostic` | `'cross-boundary-binary-shadow'` | Discriminator. |
| `binary` | `string` | Binary name (e.g. `rg`); matches `provides.binaries[]` on the agent dep. |
| `winner` | `{ source: 'agent-dep'; name: string; version?: string }` | Resolved winner on the run's PATH. |
| `shadowed` | `{ source: 'substrate-apt' \| 'substrate-npm' \| 'substrate-pip'; name: string; version?: string }` | The substrate-side package that also declared this binary and lost the precedence contest. |
| `resolution` | `string` | Human-readable reason explaining how the conflict resolved. |

### Artifacts

`artifacts: RunManifestArtifact[]`:

| Field | Type | Notes |
|---|---|---|
| `key` | `string` | Stable artifact key. |
| `kind` | `ArtifactKind` | What the artifact is: `'diff' \| 'log' \| 'screenshot' \| 'export' \| 'trace' \| 'other'`. |
| `rel_path` | `string?` | Path relative to the run dir, for local artifacts. |
| `object_url` | `string?` | Remote object URL, for uploaded artifacts. |
| `content_type` | `string?` | MIME type. |
| `bytes` | `number?` | Size in bytes. |
| `sha256` | `string?` | Content hash. |
| `redaction_state` | `'unknown' \| 'clean' \| 'redacted' \| 'blocked'` (optional) | Outcome of secret scanning before the artifact is surfaced. See below. |
| `created_at` | `string` | ISO8601. |
| `title` | `string?` | Human-readable title surfaced in UIs. |

`redaction_state` values:

- **`'clean'`** — scanned, no secrets found; safe to surface as-is.
- **`'redacted'`** — secrets were found and masked; the artifact is safe to share.
- **`'blocked'`** — secrets were found that could not be safely masked, so the
  artifact is withheld.
- **`'unknown'`** — not scanned.

See [TRUST_MODEL.md](./TRUST_MODEL.md) for what triggers redaction and how
safe-sharing works.

## Run events (`events.jsonl`)

`events.jsonl` is the canonical, ordered, append-only execution record for a run
— the timeline complement to `manifest.json` (the end-state summary). Each line
is one JSON object: a `RunEvent` from the discriminated union below. Every event
carries an `event` name (the discriminator), a `ts: string` ISO8601 timestamp,
and a `data` payload (whose keys are camelCase).

A few lines from a real `events.jsonl`:

```jsonl
{"event":"run.started","ts":"2026-06-21T17:04:12.118Z","data":{"id":"2026-06-21T17-04-12_a1b2c3"}}
{"event":"agent.started","ts":"2026-06-21T17:04:18.940Z","data":{"id":"claude-code"}}
{"event":"agent.completed","ts":"2026-06-21T17:08:51.002Z","data":{"exitCode":0,"durationMs":272062}}
{"event":"criterion.completed","ts":"2026-06-21T17:09:40.221Z","data":{"id":"server-responds","score":1,"durationMs":1840,"status":"completed"}}
{"event":"run.completed","ts":"2026-06-21T17:09:48.500Z","data":{"id":"2026-06-21T17-04-12_a1b2c3","durationMs":336382}}
```

The full set of 19 event variants:

| Event name | `data` payload |
|---|---|
| `install.build.started` | `{ agent: string; variant?: string }` |
| `install.build.completed` | `{ cacheHit: boolean; durationMs: number }` |
| `workspace.sources.started` | `{}` |
| `workspace.sources.completed` | `{ sourceCount: number; durationMs: number }` |
| `install.configure.started` | `{}` |
| `install.configure.completed` | `{ stepCount: number; durationMs: number }` |
| `workspace.setup.started` | `{}` |
| `workspace.setup.completed` | `{ stepCount: number; durationMs: number }` |
| `run.started` | `{ id: string }` |
| `agent.started` | `{ id: string }` |
| `agent.completed` | `{ exitCode: number; durationMs: number }` |
| `evaluation.started` | `{ criterionCount: number }` |
| `criterion.started` | `{ id: string }` |
| `criterion.completed` | `{ id: string; score: number \| null; durationMs: number; status?: 'completed' \| 'skipped' }` |
| `evaluation.report.started` | `{}` |
| `evaluation.report.completed` | `{ durationMs: number }` |
| `run.completed` | `{ id: string; durationMs: number }` |
| `run.failed` | `{ phase: string; reason: string }` |
| `run.canceled` | `{ reason?: string }` |

### Durability

`events.jsonl` is written append-only. Each emit opens the file with `O_APPEND`,
writes one JSON object plus a trailing newline, fsyncs the descriptor, and
closes. Lines arrive whole to disk on normal termination, even across
`process.exit` from a signal handler. A `kill -9` is allowed to lose the trailing
partial line; no preceding event is lost.

## See also

- [SCORERS.md](./SCORERS.md) — how criteria are evaluated and what `scorer_type` means.
- [COST.md](./COST.md) — how the `usage` numbers are priced and attributed.
- [CLI.md](./CLI.md) — the `bn runs` commands for inspecting runs.
