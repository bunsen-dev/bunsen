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

## Image-bundled components (built into experiment images, not vendored in-repo)

### `examples/experiments/games/battlesnake` — Battlesnake rules engine (AGPL-3.0)

- **Upstream:** [BattlesnakeOfficial/rules](https://github.com/BattlesnakeOfficial/rules), tag
  **`v1.2.3`** = immutable commit **`1940f03d40a2bf17fdd2643030e8518023c7471d`** — corresponding
  source: <https://github.com/BattlesnakeOfficial/rules/tree/1940f03d40a2bf17fdd2643030e8518023c7471d>
  (the Dockerfile builds from the tag but fails if upstream ever moves it off this commit). The
  AGPL-3.0 license text and a source-pointer notice also ship **inside the image** under
  `/opt/battlesnake/licenses/`, so they travel with the binary for anyone who only pulls the image.
- **License:** **GNU AGPL-3.0** (strong copyleft). This is the one non-permissive bundled component
  in the repo; treat it accordingly.
- **What it is:** the official Battlesnake game engine + `battlesnake play` CLI. The experiment's
  `environment.image.dockerfile` builds it **unmodified** from the pinned tag in an isolated builder
  stage and copies the resulting binary into the image. No Bunsen source is in the repo for it, and
  none links against it.
- **Why AGPL does not spread to Bunsen:** the binary is shipped **unmodified** as an independently
  built component and is invoked **only as a subprocess** (the CLI is spawned; bots talk to it over
  HTTP). This is mere aggregation — running an unmodified program at arm's length — so it does not
  make Bunsen's own code (PolyForm Shield) a derivative work. We do **not** modify the engine, link it
  into our code, or expose a modified engine as a network service (AGPL §13). Anyone redistributing a
  built image conveys an AGPL-3.0 binary and must keep this notice + the source pointer above and offer
  corresponding source (it is public at the pinned tag). The image carries the same pointer as OCI
  labels (`org.battlesnake.rules.*`).
- **What is NOT used:** the official `board` and `exporter` renderers (also AGPL-3.0) are **not**
  bundled. The experiment ships its **own** replay renderer (`runtime/lib/bsrender.py`), reference
  snakes, and engine runner — all original Bunsen code under the repo's own license. The Battlesnake
  HTTP **API** that the starter bot implements is documented under the MIT-licensed
  [BattlesnakeOfficial/docs](https://github.com/BattlesnakeOfficial/docs); implementing an API from its
  spec carries no copyleft obligation.
- **Pillow** (the renderer's only third-party dependency) is installed from PyPI into the image under
  its permissive MIT-CMU license, like other registry-installed dependencies below.

## External (not in this repository, for completeness)

- **Terminal Bench** — the 66-task port of
  [laude-institute/terminal-bench](https://github.com/laude-institute/terminal-bench) lives in the
  separate [bunsen-dev/terminal-bench](https://github.com/bunsen-dev/terminal-bench) suite repo and is
  consumed at a pinned git ref via `bn suites add`; its licensing is documented there.
- **npm dependencies** declared in `package.json` files are installed from the registry under their own
  licenses and are not bundled in this repository.
