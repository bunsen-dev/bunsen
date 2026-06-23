# Platform Tools Architecture

This document describes how Bunsen's platform tools (orchestrator, scorer, supervisor, gitignore-filter, and proxy-bootstrap) are built and distributed to experiment containers.

## Overview

Bunsen's platform tools are TypeScript/Node.js applications that run inside experiment containers. They are distributed as JS bundles that run on Node.js.

## Build Process

The build script (`packages/agents/scripts/build-bundles.mjs`) performs:

1. **Bundle TypeScript** - Uses esbuild to create single CJS files
2. **Download Node.js** - Downloads Node.js binaries for linux-x64 and linux-arm64 (for custom images)

### Build Outputs

```
packages/agents/dist/
  orchestrator.cjs      (~1.4MB)
  scorer.cjs            (~1.3MB)
  supervisor.cjs        (~1.1MB)
  proxy-bootstrap.cjs   (~1.0MB)
  gitignore-filter.cjs  (~20KB)

packages/agents/runtime/
  node-linux-x64        (~96MB)
  node-linux-arm64      (~95MB)
```

### Build Commands

```bash
pnpm build:bundles                    # Build all five bundles + download Node.js
pnpm build:bundles:orchestrator       # Build just orchestrator
pnpm build:bundles:scorer             # Build just scorer
pnpm build:bundles:gitignore-filter   # Build just gitignore-filter
pnpm build:bundles:runtime            # Just download Node.js binaries
```

`pnpm build:bundles` (`build-bundles.mjs all`) builds all five bundles —
orchestrator, scorer, supervisor, gitignore-filter, and proxy-bootstrap — and
then downloads the Node.js binaries. There are no dedicated npm scripts for
supervisor or proxy-bootstrap; build them individually with:

```bash
node scripts/build-bundles.mjs supervisor
node scripts/build-bundles.mjs proxy-bootstrap
```

## Runtime Behavior

The executor detects the image type and adjusts how it runs platform tools:

### Bunsen Images (bunsen/headless, bunsen/visual)

`bunsen/headless` and `bunsen/visual` have Node.js 20 pre-installed:

```
Agent container mounts (conditional — see below):
  /bunsen/lib/orchestrator.cjs            when orchestration is enabled
  /bunsen/lib/gitignore-filter.cjs        when the experiment seeds an initial workspace
  /bunsen/lib/supervisor.cjs              when the supervisor is enabled
  /bunsen/runtime/proxy-bootstrap.cjs     when trace capture is enabled
  /bunsen/lib/scorer.cjs                  only when evaluation.container: agent

Execution:
  node /bunsen/lib/orchestrator.cjs
```

By default `scorer.cjs` is not mounted in the agent container at all — it is
mounted into a separate dedicated scorer container (see below). The agent
container's bundles are mounted conditionally:

- `orchestrator.cjs` — mounted only when orchestration is not skipped.
- `gitignore-filter.cjs` — mounted only when the experiment seeds an initial
  workspace source (used for workspace diff/export).
- `supervisor.cjs` — mounted at `/bunsen/lib/supervisor.cjs` when the supervisor
  is enabled (supervised interaction mode).
- `proxy-bootstrap.cjs` — mounted at `/bunsen/runtime/proxy-bootstrap.cjs` when
  trace capture is enabled.
- `scorer.cjs` — mounted into the agent container only when
  `evaluation.container: agent` is set; otherwise it goes to the dedicated
  scorer container.

### Scorer Container

By default, scorers run in a separate dedicated scorer container, where the
scorer bundle is mounted at `/bunsen/lib/scorer.cjs`. Setting
`evaluation.container: agent` instead runs scorers inside the agent's own
container via `docker exec`, in which case `scorer.cjs` is mounted into the
agent container at creation time.

### Custom Images

For custom base images that may not ship Node.js, Bunsen mounts its **own** Node
runtime at `/bunsen/runtime/node` — the platform honoring the same "ship your own
runtime" anti-contract the [environment model](./ENVIRONMENT.md#the-anti-contract)
imposes on agents. The same conditional bundle mounts as the Bunsen-image case
apply; only the Node.js binary is added:

```
Agent container mounts (conditional — see above):
  /bunsen/lib/orchestrator.cjs            when orchestration is enabled
  /bunsen/lib/gitignore-filter.cjs        when the experiment seeds an initial workspace
  /bunsen/lib/supervisor.cjs              when the supervisor is enabled
  /bunsen/runtime/proxy-bootstrap.cjs     when trace capture is enabled
  /bunsen/lib/scorer.cjs                  only when evaluation.container: agent
  /bunsen/runtime/node                    (Node.js binary)

Execution:
  /bunsen/runtime/node /bunsen/lib/orchestrator.cjs
```

**How that binary is obtained.** The host path mounted at `/bunsen/runtime/node`
is resolved by `resolveContainerNodeRuntime(platform)` through layers, first hit
wins: (a) `BUNSEN_NODE_RUNTIME_DIR` override → (b) a bundled asset shipped with the
distribution → (c) `packages/agents/runtime/` in a source checkout → (d) a shared
per-user host cache → (e) a **sha256-verified download** from nodejs.org. The
pinned version and per-target hashes are the single source of truth in
[`node-runtime-manifest.json`](../packages/runtime/src/node-runtime-manifest.json),
shared with `build-bundles.mjs`. So the ~95 MB binary is in no distribution
artifact (small npm package / standalone binary) yet custom-image experiments
"just work" — the runtime is fetched once per host, verified, and cached. Set
`BUNSEN_NODE_OFFLINE=1` to forbid the fetch (reproducible CI / air-gapped) and get
an actionable error instead; `pnpm --filter @bunsen-dev/agents build:bundles:runtime`
pre-fetches it for a source checkout. The runtime is **glibc** — it runs on every
Bunsen base image and the common custom bases (debian/ubuntu/CUDA/distroless-glibc);
**musl/Alpine** bases are not yet supported.

## Version Isolation

Our tools are isolated from the experiment's Node.js version:

| Image Type | Our Tools Run On | Experiment Can Use |
|------------|------------------|-------------------|
| Bunsen images | Container's Node.js 20 (we control it) | Node.js 20 (same) |
| Custom images | Our mounted Node.js binary | Any version or none |

This means experiments can use any Node.js version (or none) without affecting platform tool execution.

## Key Functions

In `packages/runtime/src/container.ts`:

- `getPlatformBundlePath(bundleName)` - Get path to a JS bundle
- `getNodeRuntimePath(dockerArch)` - Get path to Node.js binary for custom images
- `isBunsenImage(imageName)` - Check if image is a Bunsen-controlled image

## Container Paths

| Path | Contents |
|------|----------|
| `/bunsen/lib/*.cjs` | Platform tool JS bundles |
| `/bunsen/runtime/node` | Node.js binary (custom images only) |
| `/bunsen/run/` | Run context for evaluation |
