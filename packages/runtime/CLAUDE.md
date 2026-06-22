# @bunsen-dev/runtime

Internal execution engine for Bunsen. Handles configuration loading, Docker container management, experiment execution, and evaluation coordination.

**Not public API.** This package is marked `private: true`. The public surface is `@bunsen-dev/sdk`, `@bunsen-dev/types`, and `@bunsen-dev/cli`. See `docs/PACKAGES.md` for the boundary.

**No backwards compatibility.** See the root [`CLAUDE.md`](../../CLAUDE.md) — Bunsen has no external consumers yet, so every shape in this package is free to change. Do not keep legacy fields around, do not add adapters from an old shape to a new one, do not maintain dual-shape code paths. When a type, field, or function changes, update every call site in the same commit and delete the old version.

## Module Overview

| File | Purpose |
|------|---------|
| `container.ts` | Docker container lifecycle: build/pull images, create persistent containers, exec commands, proxy management, tmux/asciinema recording, cleanup |
| `executor.ts` | Orchestrates a full experiment run: image prep, container setup, agent execution (direct or tmux mode), artifact capture, evaluation |
| `scorer-container.ts` | Manages evaluation execution contexts. Runs code-based and LLM-based scorers in the default scorer container or the agent container when agent-container scoring is enabled |
| `evaluation-coordinator.ts` | Rubric resolution, dependency ordering, scorer config building, weighted score calculation |
| `config.ts` | Loads and validates `experiment.yaml` and `agent.yaml` files |
| `environment.ts` | Resolves substrate-only environment from the experiment (default + declared runtimes/packages); generates package install commands. The agent does NOT contribute — see `docs/ENVIRONMENT.md#asymmetric-composition` |
| `storage.ts` | Run lifecycle: create runs, save/load metadata, logs, traces, scores, diffs, artifacts |
| `calibration.ts` | Compares human vs LLM scores (MAE, bias, per-criterion stats) |
| `trace-filter.ts` | Thread-based AI trace filtering for scorer context |
| `diff-filter.ts` | Filters lockfiles from workspace diffs |
| `resolve.ts` | Project root discovery, experiment/agent resolution from search paths |
| `sources.ts` | Resolves agent sources (git, npm, binary) with caching |
| `env.ts` | `.env` file parsing and environment variable loading |
| `gitignore.ts` | Gitignore pattern matching for workspace diff/export filtering |

## Container Execution Model

Three functions for running things inside containers, each for a different use case:

- **`execInContainer(container, command[])`** — Runs a command array via `docker exec`. Use when you have a simple command with arguments (no shell interpretation needed). Example: `[nodeCmd, '/bunsen/lib/orchestrator.cjs']`

- **`execShellInContainer(container, script)`** — Wraps script in `['/bin/bash', '-c', script]`. Use for shell constructs (pipes, `&&`, variable expansion). Example: `'mkdir -p /workspace && cp -a /src/. /workspace/'`

- **`writeFileInContainer(container, path, content)`** — Writes file content using base64 encoding. The content is encoded in Node.js and decoded inside the container, so shell special characters (`$`, backticks, quotes, heredoc delimiters) are never interpreted. **Always use this instead of heredocs** (`cat > file << 'EOF'`) to write files into containers.

### Why base64 instead of heredocs

Heredoc patterns like `cat > file << 'EOF'\n${content}\nEOF` break when `content` contains:
- Backticks (`` ` ``) — trigger command substitution even in single-quoted heredocs if the delimiter itself isn't quoted correctly in all contexts
- The heredoc delimiter (e.g., `EOF`) on its own line — prematurely ends the heredoc
- NUL bytes or other binary content

Base64 encoding eliminates all these concerns. The encoded output only contains `[A-Za-z0-9+/=]`, which are safe in any shell context.

## Key Conventions

- **Environment variables** are passed to containers at creation time (via `createPersistentContainer`) or per-exec (via the `env` option on exec functions). Env vars set at creation time are available to all exec calls; per-exec env vars are scoped to that execution.

- **Platform API key** (`BUNSEN_ANTHROPIC_API_KEY`) is kept separate from the agent's API key. It's passed directly to platform agent exec calls, not set in the container's base environment (except when `evaluation.container: agent`).

- **Non-root execution**: By default, a `bunsen` user is created and the agent runs as that user. Scripts are written to files (via `writeFileInContainer`) then executed with `su bunsen -c /path/to/script.sh`.

- **Scorer container vs agent container scoring**: By default, scorers run in a separate container with both `/workspace` (final mutable state) and `/workspace-source` (immutable initial snapshot) extracted/mounted from the agent run. With `evaluation.container: agent`, scorers run in the agent's own container via `docker exec`, preserving installed packages, running services, the same `/workspace` + `/workspace-source` contract, and the agent's execution user context. Because Docker cannot add mounts later, `/bunsen/verifiers` is mounted into the agent container before the agent runs for any experiment that declares a `verifiers/` directory — independent of `evaluation.container` — so verifier assets are visible to the agent during the run in either mode.

## Model pricing snapshot

> **User-facing docs:** [`docs/COST.md`](../../docs/COST.md) is the canonical cost reference — how a call is priced, cache buckets, source/model attribution, accounting status, and the `bn runs cost` output. This section is the **implementation home** for the pricing snapshot itself (the vendored dataset, the loader, matching, and the refresh script).

The proxy cost estimator (`src/proxy/ai_capture.py`) prices every captured AI call from a **vendored, refreshable dataset**, not a hand-maintained dict.

- **Snapshot:** `src/proxy/model_prices.json` is a filtered slice of [LiteLLM's](https://github.com/BerriAI/litellm) `model_prices_and_context_window.json` (MIT) — the de-facto-standard community pricing dataset. It is checked in, stays in LiteLLM's **native per-token units and field names** (so it diffs cleanly against upstream), and vendors **every native Anthropic / OpenAI / Google token-priced model** LiteLLM tracks (~218). Scope rationale: Bunsen is general-purpose — a user's agent can reference any model — and the proxy only ever intercepts three hosts (`api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`), so that set is exactly "any model we can capture." Cloud-routed variants (Bedrock / Azure / Vertex-Anthropic) are excluded: different hosts, possibly different prices, and their ids never appear in a captured trace. For Google we prefer LiteLLM's `gemini` provider (the AI-Studio API we actually capture) over Vertex. The build copies the snapshot into `dist/assets/proxy/` (resolved at runtime via `getAssetDir()`; the published `@bunsen-dev/cli` carries the same layout), and `startProxyContainer` bind-mounts it beside the addon at `/addon/model_prices.json` (see `getPricingDataPath`). **The proxy never fetches at runtime** — a run's cost is reproducible from repo state.
- **Loading:** `ai_capture.py:_load_pricing()` reads the snapshot, maps `litellm_provider` → Bunsen's provider tag, and converts per-token → per-1M at load (so `_estimate_cost`'s `/1e6` math is unchanged). LiteLLM's `cache_read_input_token_cost` / `cache_creation_input_token_cost` make cached-read and cache-write prices **data-driven**; the legacy 0.1× / 1.25×-of-input multipliers survive only as a fallback for models lacking explicit cache prices. If the snapshot is missing/unreadable the loader degrades to coarse per-provider defaults rather than crashing, so trace capture never goes dark.
- **Matching:** exact match on the captured model id, then the **longest snapshot key that is a substring** of it (preserving "most-specific wins": `gpt-5.5-pro` beats `gpt-5.5`). Provider routing prefixes (`gemini/`, `vertex_ai/`, …) and trailing date stamps (`-20260205`, `@20251001`) are normalized first. A model LiteLLM no longer tracks (deprecated and pruned upstream) falls to the coarse default — the unavoidable limit of any vendored snapshot.
- **Unpriced models are surfaced, not silent.** When a captured model matches nothing in the snapshot and the coarse default produced a non-zero cost, the proxy stamps `pricingFallback: true` on that trace (and warns once per model in its own log; `$0` calls like `count_tokens` are not flagged). The signal is threaded from the trace through to every cost surface:
  - `streamProcessTraces` → `TracesSummary.pricingFallbackCalls` / `unpricedModels` (the trace summary).
  - `storage.ts` projects it onto the manifest (`RunManifestUsage.pricing_fallback_calls` / `unpriced_models`), and the run-index carries the count onto `RunSummary.pricingFallbackCalls` (one nullable column).
  - How it's then shown across `bn runs cost` / `show` / `compare` / `list` is documented in [`docs/COST.md`](../../docs/COST.md#unpriced-models-fall-back-to-a-coarse-default).
- **Refresh (deliberate, optionally CI-scheduled):**
  ```bash
  python3 scripts/refresh_model_prices.py            # re-fetch upstream + rewrite the snapshot
  python3 scripts/refresh_model_prices.py --check     # exit non-zero if stale (for CI)
  python3 scripts/refresh_model_prices.py --ref v1.80.0 --source /path/litellm.json
  ```
  The script filters by `NATIVE_PROVIDERS` (no per-model list to maintain), and **aborts if any provider yields fewer than 5 models** — a guard against LiteLLM renaming a provider tag and silently emptying a provider. `ai_capture_test.py` asserts per-provider floor counts plus that example-agent models and common non-example models (gpt-4o, o3, claude-3-opus, gemini-2.0-flash, …) all resolve from data. Run it when prices move or new models ship.
