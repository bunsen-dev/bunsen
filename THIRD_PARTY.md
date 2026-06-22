# Third-Party Code in This Repository

Bunsen's own code is licensed under PolyForm Shield 1.0.0 (see [LICENSE](./LICENSE) and
[LICENSING.md](./LICENSING.md)). This repository also **bundles third-party code**, which remains under
its own upstream license — the Shield license does **not** apply to any path listed here. Each entry
keeps its upstream `LICENSE`/`LICENSE.txt` file in place; that file is the authoritative statement of
terms for that directory.

This document is the provenance catalog: what each bundled component is, where it came from, why it's
here, and what (if anything) was changed.

## Vendored data

### `packages/runtime/src/proxy/model_prices.json` — LiteLLM pricing slice (Berri AI)

- **Upstream:** [BerriAI/litellm](https://github.com/BerriAI/litellm)
  `model_prices_and_context_window.json`
- **License:** MIT — Copyright (c) 2023 Berri AI (notice retained in the file's `_meta.copyright`)
- **What it is:** a filtered slice (native Anthropic/OpenAI/Google token-priced models) of LiteLLM's
  community pricing dataset, kept in LiteLLM's native units and field names. Regenerated deliberately
  with `packages/runtime/scripts/refresh_model_prices.py`; the proxy never fetches prices at runtime.

## Example-experiment workspace forks

The "real PR" example experiments under `examples/experiments/fix-bugs/` each contain a `workspace/`
directory holding a **verbatim snapshot of an upstream open-source repository at the commit before a
specific PR merged** — the agent-under-test gets the same starting point the original contributor had.
These snapshots are unmodified upstream code (no Bunsen changes inside `workspace/`), and each retains
the upstream license file at its root.

| Path (`examples/experiments/fix-bugs/…`) | Upstream | Snapshot point | License |
|---|---|---|---|
| `vercel-ai-xai-errors/workspace/` | [vercel/ai](https://github.com/vercel/ai) (Vercel AI SDK) | pre-[#11671](https://github.com/vercel/ai/pull/11671) | Apache-2.0 — Copyright 2023 Vercel, Inc. (upstream ships no NOTICE file; the snapshot is verbatim, so Apache-2.0 §4(b)'s "state changes" requirement is not triggered) |
| `anthropic-stream-errors/workspace/` | [anthropics/anthropic-sdk-typescript](https://github.com/anthropics/anthropic-sdk-typescript) | pre-[#856](https://github.com/anthropics/anthropic-sdk-typescript/pull/856) | MIT — Copyright 2023 Anthropic, PBC. |
| `fastify-json-escape/workspace/` | [fastify/fastify](https://github.com/fastify/fastify) | pre-[#6420](https://github.com/fastify/fastify/pull/6420) | MIT — Copyright (c) 2016-present The Fastify Team |
| `click-context-sentinel/workspace/` | [pallets/click](https://github.com/pallets/click) | pre-[#3137](https://github.com/pallets/click/pull/3137) | BSD-3-Clause — Copyright 2014 Pallets |
| `click-flag-options/workspace/` | [pallets/click](https://github.com/pallets/click) | pre-[#3152](https://github.com/pallets/click/pull/3152) | BSD-3-Clause — Copyright 2014 Pallets |

## External (not in this repository, for completeness)

- **Terminal Bench** — the 66-task port of
  [laude-institute/terminal-bench](https://github.com/laude-institute/terminal-bench) lives in the
  separate [bunsen-dev/terminal-bench](https://github.com/bunsen-dev/terminal-bench) suite repo and is
  consumed at a pinned git ref via `bn suites add`; its licensing is documented there.
- **npm dependencies** declared in `package.json` files are installed from the registry under their own
  licenses and are not bundled in this repository.
