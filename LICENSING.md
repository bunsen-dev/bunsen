# Licensing

## Bunsen's own code — Apache-2.0

Bunsen is open source under the **Apache License, Version 2.0**. See
[`LICENSE`](./LICENSE) for the full terms and [`NOTICE`](./NOTICE) for attribution.

For guidance on running code safely and managing provider costs, see the
[Trust Model](./docs/TRUST_MODEL.md) and [Cost Accounting](./docs/COST.md).

## Third-party components

Bundled third-party components retain their own licenses:

| Path | Component | License |
|------|-----------|---------|
| `packages/runtime/src/proxy/model_prices.json` | LiteLLM pricing data slice | MIT — Copyright (c) 2023 Berri AI |
| `examples/experiments/fix-bugs/vercel-ai-xai-errors/workspace/` | Vercel AI SDK (fork) | Apache-2.0 — Copyright 2023 Vercel, Inc. |
| `examples/experiments/fix-bugs/anthropic-stream-errors/workspace/` | Anthropic SDK (fork) | MIT — Copyright 2023 Anthropic, PBC. |
| `examples/experiments/fix-bugs/fastify-json-escape/workspace/` | Fastify (fork) | MIT — Copyright (c) 2016-present The Fastify Team |
| `examples/experiments/fix-bugs/click-context-sentinel/workspace/`, `.../click-flag-options/workspace/` | Pallets/click (fork) | BSD-3-Clause — Copyright 2014 Pallets |

Each third-party directory keeps its own `LICENSE`/`LICENSE.txt` file; consult it for the authoritative
terms. See [`THIRD_PARTY.md`](./THIRD_PARTY.md) for the full provenance catalog (upstream repos, snapshot
points, and any modifications).

### Image-bundled engine — AGPL-3.0 (not vendored in this repository)

One third-party component is **not** stored in this repository but is built into an experiment image from
pinned upstream source: the official Battlesnake rules engine
([`BattlesnakeOfficial/rules`](https://github.com/BattlesnakeOfficial/rules)), bundled under the **GNU
AGPL-3.0** by `examples/experiments/games/battlesnake/Dockerfile`. It is shipped **unmodified** and invoked
only as a subprocess (mere aggregation), so it does **not** make Bunsen's own code a derivative work or
subject it to the AGPL. The AGPL-3.0 license text and a corresponding-source pointer (upstream repo +
immutable commit) travel **inside the image** under `/opt/battlesnake/licenses/`. See
[`THIRD_PARTY.md`](./THIRD_PARTY.md) for the full provenance and the AGPL compliance posture.

## For tooling (SPDX / SCA)

- Bunsen's own source headers use the standard `SPDX-License-Identifier: Apache-2.0`.
- Public package metadata uses `"license": "Apache-2.0"`.
- Third-party files retain their own headers and SPDX identifiers (`MIT`, `Apache-2.0`, `BSD-3-Clause`).

**Publishing note:** the npm packages (`@bunsen-dev/sdk` and `@bunsen-dev/types`) include
`LICENSE`, `NOTICE`, `LICENSING.md`, and `THIRD_PARTY.md` in their tarballs. The CLI is
distributed as a standalone binary rather than an npm package.

License history: v0.1.0–v0.3.1 were distributed under PolyForm Shield 1.0.0; from v0.4.0 Bunsen is Apache-2.0.
