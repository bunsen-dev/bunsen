# Licensing

Bunsen is **source-available**, not "open source" (it is not OSI-approved). This page explains, in plain
English, what you may and may not do, and maps the licenses of every component in this repository.

## Bunsen's own code — PolyForm Shield 1.0.0

All original code in this repository authored by the Licensor (Matthew Job Granmoe) is licensed under the
**PolyForm Shield License 1.0.0** — see [`LICENSE`](./LICENSE) for the full text.

**You may, freely and at no cost:**

- Use Bunsen for any purpose — personal, academic, or **commercial** — including inside your own company.
- Run it anywhere — your laptop, your servers, your cloud — for your own use.
- Read, modify, and fork the source.
- Redistribute it, with or without your changes.
- Use Bunsen to build, test, and evaluate **your own** products.

**You may not:**

- Provide a product or service that **competes** with Bunsen (or with a product the Licensor offers using
  Bunsen). Per the license, this is delivery-mode-agnostic: it applies whether the competing product is a
  hosted service, a local CLI, an embedded library, or a rebranded fork — **and even if you give it away
  for free**. In short: don't take Bunsen and offer a competing experiment-runner product.

If you want to do something the Shield license doesn't permit (e.g., offer a competing or hosted commercial
service built on Bunsen), a **commercial license is available** — contact the maintainer (see the README).

### Can I use Bunsen at work?

Yes. PolyForm Shield allows internal commercial use, including using Bunsen inside your company to run
experiments, compare agents, evaluate your own products, and modify the tool for your own use.

The line is productization: you need separate commercial terms if you want to provide a product or service
that competes with Bunsen, including a hosted service, local tool, embedded feature, or rebranded fork.

### Why source-available?

PolyForm Shield keeps Bunsen free for normal use, including internal commercial use, while reserving the
right to license competing products separately. This is the "fair source" model (see
[fair.io](https://fair.io)). Bunsen has been source-available from day one; there was no prior OSI
open-source release.

## Third-party components (NOT covered by the Shield license)

This repository bundles third-party code under its own, separate licenses. The Shield license above does
**not** apply to these paths; each retains the upstream license shipped alongside it:

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

## For tooling (SPDX / SCA)

PolyForm Shield 1.0.0 is **not** on the SPDX standard license list, so:

- **Source headers** for Bunsen's own files use the custom identifier:
  `// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0`
- **`package.json`** `license` fields use `"SEE LICENSE IN LICENSE"` (npm-supported; avoids asserting an
  invalid SPDX id).
- Third-party files retain their own headers and SPDX identifiers (`MIT`, `Apache-2.0`, `BSD-3-Clause`).

**Publishing note:** each public npm package (`@bunsen-dev/cli`, `@bunsen-dev/sdk`, `@bunsen-dev/types`) must include
`LICENSE`, `LICENSING.md`, and `THIRD_PARTY.md` in its published tarball so the terms and referenced
third-party license map travel with the package.
