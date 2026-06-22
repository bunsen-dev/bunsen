# Cost Accounting

How Bunsen prices a run's API traffic, attributes it, and shows it to you. This
is the canonical reference: "what did this run cost, how was it priced, and where
do I see it" — all in one place.

The short version:

- Every captured API call is **priced** from a vendored LiteLLM snapshot
  (offline, reproducible) — see [How a call is priced](#how-a-call-is-priced).
- Each call is **attributed** two independent ways — by *who* made it (agent vs
  platform) and by *which model* ran it — see
  [How cost is attributed](#how-cost-is-attributed).
- **`bn runs cost <run-id>`** is the one command that shows the whole picture for
  a run; the headline numbers also appear in `show`, `list`, and `compare` — see
  [Reading `bn runs cost`](#reading-bn-runs-cost) and
  [Where else cost shows up](#where-else-cost-shows-up).

Cost is only as good as the traces it's computed from. If the proxy captured no
traffic, there is nothing to price — see [Can you trust the
numbers?](#can-you-trust-the-numbers).

## How a call is priced

### The pricing snapshot

Every captured call is priced from a **vendored, reproducible pricing dataset**,
not a hand-maintained table. The dataset is a filtered, checked-in slice of
[LiteLLM's](https://github.com/BerriAI/litellm) community pricing dataset (MIT).
It covers every native Anthropic / OpenAI / Google token-priced model LiteLLM
tracks; because the proxy only ever intercepts those three hosts, that set is
exactly "any model a run can capture," whatever model your agent uses.

Pricing a single call:

1. **Read offline.** The proxy loads the snapshot at startup and never fetches at
   runtime, so a run's cost is reproducible from repo state.
2. **Per-token → per-1M.** LiteLLM stores native per-token rates; the loader
   converts them to per-1M at load.
3. **Match the model id** — exact match first, then the **longest snapshot key
   that is a substring** of the captured id ("most-specific wins": `gpt-5.5-pro`
   beats `gpt-5.5`). Provider routing prefixes (`gemini/`, `vertex_ai/`, …) and
   trailing date stamps (`-20260205`, `@20251001`) are normalized off first.
4. **Multiply** each token bucket (fresh input, output, cache-read,
   cache-creation) by its rate and sum.

A model the snapshot doesn't know about doesn't go silently mispriced — it falls
to a coarse default that is surfaced everywhere (see [Unpriced
models](#unpriced-models-fall-back-to-a-coarse-default)).

All dollar amounts are in **USD**, shown to four decimal places. Cost accounting
is automatic whenever trace capture is on; there is nothing to enable beyond
running normally (it is suppressed only by `--skip-traces`).

### Cache tokens dominate the bill

On agent loops the prompt is mostly **cache**: a single Claude Code run can show
~3.4K fresh input tokens against ~1.1M cache-read (≈332×). Pricing therefore
splits input into **three disjoint buckets** — they never overlap, and the total
prompt size is their sum:

| Bucket | What it is | How it's priced |
| --- | --- | --- |
| **Fresh input** | New, non-cached input tokens | Full input rate |
| **Cache-read** | Input served from cache | Discounted cache-read rate |
| **Cache-creation** | Input written into the cache | Cache-write premium |

Token usage is normalized across providers, so the `in` count Bunsen displays is
**fresh-only** and comparable across vendors — it's exactly the input billed at
the full rate.

Cache rates are **data-driven**: the pricing dataset gives each model its own
cache-read and cache-creation prices. For models that don't publish explicit
cache prices, Bunsen falls back to a multiplier of the input rate (0.1× for
cache-read, 1.25× for cache-creation).

Because cache usually dwarfs fresh input, it's the line that explains the bill.
`bn runs cost` prints a `cache  <read> read · <created> created` line under each
source plus a run-wide `Cache:` rollup; `bn runs show` prints a `Cache:` line in
its AI Usage block. The fields are carried per source and run-wide on the
manifest (`usage.by_source[*].cache_read_input_tokens`,
`usage.total_cache_read_input_tokens`).

### Unpriced models fall back to a coarse default

When a captured model matches nothing in the snapshot (one LiteLLM has dropped,
or a brand-new one not yet refreshed) and the coarse per-provider default
produces a non-zero cost, the proxy stamps `pricingFallback: true` on that trace.
That signal is threaded through every cost surface so a **guessed** cost is never
presented as accurate:

- The manifest carries `usage.pricing_fallback_calls` + `usage.unpriced_models`.
- **`bn runs cost`** and **`bn runs show`** print a `⚠` caveat naming the
  model(s); **`bn runs compare`** marks the affected run's cost cell with `*`
  (yellow) + a footnote so guessed and data-driven costs aren't compared as
  equals; **`bn runs list --format json`** carries the count. All `--format json`
  outputs carry the fields.

`$0` calls (e.g. `count_tokens`) are never flagged.

## How cost is attributed

Every priced call is attributed two **independent** ways. The two axes are
orthogonal: one source can drive several models, and one model can be driven by
several sources.

- **By source** — *who* made the call: the agent under test, or a platform agent
  (orchestrator / supervisor / scorer).
- **By model** — *which model* did the work, within the agent under test.

"Source" here means the **caller** of an API call — it is unrelated to
`workspace.sources` (the seed inputs that populate the environment).

### By source: agent vs platform

Platform agent cost (orchestrator, supervisor, scorers) is tracked **separately**
from the agent under test so it never inflates the agent's number. A run's
**headline cost is the agent under test's cost alone** — `usage.estimated_cost_usd`
is the agent's cost, not the run total. When platform calls exist, the split is
also recorded as `usage.agent_cost_usd` / `usage.platform_cost_usd`, and the
run-wide total (agent + platform) is what `bn runs cost` prints as `Total:`.

The full per-source breakdown lives in `usage.by_source`, keyed by source:

| Source key | Who |
| --- | --- |
| `agent` | The agent under test |
| `platform` | All platform traffic, aggregated |
| `orchestrator` | The orchestrator agent |
| `supervisor` | The supervisor agent (supervised mode) |
| `scorer` | A scorer with no per-criterion attribution |
| `scorer:<criterion>` | A model-using scorer (a `judge`, `agent`, or `browser-agent` [criterion](./SCORERS.md)), attributed to its criterion |

Each entry carries `calls`, fresh `input_tokens`, `output_tokens`, the two cache
buckets, and `cost_usd`.

### By model: the per-model breakdown (`agent.models`)

`agent.models` is the agent under test's API usage sliced by model. Each entry
carries that model's share of the agent's calls, tokens, and cost:

```ts
interface AgentModelUsage {
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}
```

It is **observed-only** — computed from the agent's captured traces, never from
declared config. Consequences:

- A run that captured no agent traces has **no** breakdown (absent, not a
  guess). There is no fallback to the configured `ANTHROPIC_MODEL`.
- **Errored (non-2xx) calls are excluded.** A model alias that only ever 404s
  ran no inference and never appears — let alone headlines.
- **Platform models are excluded.** Orchestrator / supervisor / scorer traffic
  lives in `usage.by_source`, not here.
- Because errored and platform calls are filtered out, the per-model call counts
  do **not** sum to `usage.total_ai_calls`.

### The headline model is the highest-cost model

`agent.models` is sorted **highest cost first**, so `models[0]` is the run's
**headline model** (the highest-cost model) — the one Bunsen labels the run with.

Cost — not call count — decides the headline. Total cost already folds in
`tokens × per-model rate`, so it is the best single proxy for *which model
carried the run's compute*.

**Why this matters (the Claude Code shape).** Claude Code fires many cheap
**background** calls on a small model (titles, summaries, classifications) plus
fewer **reasoning** calls on its main model. Ranked by call count the background
model wins — so a run where Opus did, say, $0.26 of a $0.28 bill would be
mislabelled "haiku" purely because Haiku made more calls. Ranking by cost puts
the reasoning model first, where it belongs.

Ordering is fully deterministic. Ties break in this order:

1. `cost_usd` (descending) — the primary key
2. `output_tokens` (descending)
3. `calls` (descending)
4. `model` id (lexical, ascending)

So the breakdown is stable regardless of the order models first appeared in the
trace stream.

`bn runs show` renders the breakdown highest-cost first, with each model's call
count, call-share, and cost:

```
Models:
  claude-opus-4-7              4 calls   80%  $0.1254
  claude-haiku-4-5-20251001     1 call   20%  $0.0007
```

Opus headlines on cost ($0.1254 vs $0.0007). The call-share column is
informational; it does **not** drive the ordering. (Here Opus also leads on
calls; when a cheap background model out-*calls* the reasoning model, cost still
puts the reasoning model first.)

## Can you trust the numbers?

Cost is computed from captured traces, so a run's manifest carries a
`usage.accounting_status` flag that distinguishes a trustworthy zero from missing
data:

| Status | Meaning |
| --- | --- |
| `captured` | Proxy intercepted ≥1 inference call. Numbers reflect actual API traffic, within the limits of the in-proxy parser. |
| `missing` | Proxy was active but recorded no traces. The agent made no LLM calls *or* used an HTTP client we couldn't intercept (e.g. Node native fetch / undici, which doesn't honor `HTTPS_PROXY`). Treat the totals as a **lower bound**. |
| `skipped` | `--skip-traces` was passed; tracing was deliberately disabled. |

`bn runs show` and `bn runs cost` print a warning when status is `missing` so an
unexpectedly empty cost report doesn't go unnoticed. The status may be absent on
runs that errored before the trace-finalization step.

> **Why `missing` happens, and the fix.** Node's built-in `fetch` (used by
> `@anthropic-ai/sdk` and Claude Code) ignores `HTTPS_PROXY`. Bunsen ships a
> bootstrap module that registers an undici `ProxyAgent` into agent and
> platform-agent containers via `NODE_OPTIONS`, which is what makes Claude Code
> traces show up. See [README → AI Trace
> Capture](../README.md#ai-trace-capture) for the capture mechanics.

## Reading `bn runs cost`

`bn runs cost <run-id>` is the full per-run cost view: every source, its fresh
and cached token split, and the run-wide total. An annotated example of a
supervised Claude Code run scored by two LLM criteria:

```
Cost Breakdown: 01JABCDEF0123456789ABCDEFG
══════════════════════════════════════════════════

Agent:     $0.2601                                  ← headline cost (agent only)
  19 calls  3,447 in / 6,210 out                    ← `in` is fresh-only
  cache  1,143,571 read · 48,800 created            ← the line that explains the bill

Platform:  $0.0137                                  ← tracked separately from the agent
  cache  78,000 read · 0 created                    ← platform cache, aggregated
  Orchestrator
    2 calls  1,200 in / 340 out  $0.0021
    cache  12,000 read · 0 created
  Supervisor
    4 calls  900 in / 210 out  $0.0014
    cache  16,000 read · 0 created
  Scorers (2) ($0.0102)                             ← per-criterion sub-breakdown
    correctness: 3 calls  5,400 in / 220 out  $0.0064
      cache  31,000 read · 0 created
    completeness: 2 calls  3,100 in / 90 out  $0.0038
      cache  19,000 read · 0 created

──────────────────────────────────────────────────
Total:     $0.2738                                  ← agent + platform
Run cache: 1,221,571 read · 48,800 created          ← run-wide cache rollup
           run-wide; fresh input billed at full rate: 14,047
```

Reading it:

- **Agent** is the headline cost (`usage.estimated_cost_usd`). Its `in` is
  fresh-only; the `cache` line below it is usually far larger and is where the
  money actually goes.
- **Platform** is the sum of orchestrator + supervisor + scorers, never folded
  into the agent number. Sub-sources only print when they made calls; LLM
  scorers are broken out per criterion under `Scorers (N)`.
- **Total** is agent + platform. **Run cache** is the run-wide cache rollup, with
  the fresh-input total spelled out as a reminder that only fresh input is billed
  at the full rate.
- If any call used fallback pricing, a `⚠` caveat naming the model(s) prints
  below the total (see [Unpriced
  models](#unpriced-models-fall-back-to-a-coarse-default)).
- A `missing` / `skipped` run prints a short explanation instead of the
  breakdown.

`bn runs cost <run-id> --format json` emits `{ runId, usage, summary }` — the
manifest `usage` (snake_case, incl. `by_source` and cache totals) plus the live
trace `summary` (camelCase `bySource`, `pricingFallbackCalls`, …).

## Where else cost shows up

| Surface | What it shows |
| --- | --- |
| `bn runs cost` | The full per-source / cache / total breakdown above. |
| `bn runs show` | An **AI Usage** block: calls, fresh input/output, a `Cache:` line, the agent **Est. Cost** (+ a `+ Platform` line), any `⚠` fallback caveat, and the per-model **Models:** breakdown. |
| `bn runs list` | A **Model** column = the headline model, with a `+N` suffix when the agent drove `N` additional models. `--format json` adds `agentModel`, `agentModelCount`, `pricingFallbackCalls`. |
| `bn runs compare` | **Cost** and **Model** rows per run; `*` + footnote flags fallback-priced costs, `—` marks runs with no captured cost. |
| Run manifest | `usage.*` (totals, `by_source`, cache, `accounting_status`, fallback) and `agent.models[]` (sorted; `[0]` is the headline). |
| Run index | `runs.agent_model` / `agent_model_count`; `run_cost_breakdown` (per source); `run_agent_models` (per model, `rank` 0 = highest-cost). |

## See also

- [README → AI Trace Capture](../README.md#ai-trace-capture) — how traces are
  captured in the first place (the proxy sidecar, supported providers,
  native-fetch capture).
- [Scorers & Evaluation](./SCORERS.md) — the `judge`, `agent`, and `browser-agent`
  criterion types whose model calls show up under `scorer:<criterion>`.
- [Run Manifest & Events](./RUN_MANIFEST.md) — field-level manifest reference for
  `usage.*` and `agent.models`.
