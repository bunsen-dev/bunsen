# @bunsen-dev/agents

Platform agents (orchestrator, scorer, supervisor) that run **inside Docker containers** alongside the agent-under-test.

## Build Process

These agents are bundled into self-contained `.cjs` files using esbuild so they can run inside containers without `node_modules`.

```bash
# Build all bundles + download Node.js runtime binaries
pnpm build:bundles

# Build a single bundle
pnpm build:bundles:scorer
pnpm build:bundles:orchestrator
```

> The package's own `build` script (`tsc && build-bundles bundles`) **also emits
> the `.cjs` bundles** (the `bundles` arg skips the heavy Node-runtime download).
> This is what lets `pnpm -r build` produce the bundles topologically before
> `@bunsen-dev/cli`'s build copies them into `dist/assets/` — so a clean
> `pnpm install && pnpm build` works without a separate `build:bundles` step.
> Run `build:bundles` only when you also need the per-platform Node runtimes.

### What `build:bundles` does

1. **esbuild** bundles each `src/<name>/standalone.ts` → `dist/<name>.cjs` (CJS, Node 20 target, `--bundle` flag inlines all imports)
2. **Node.js binaries** are downloaded for linux-x64 and linux-arm64 into `runtime/` for containers that don't have Node.js installed

The esbuild step injects an `import.meta.url` shim (`--define`) because esbuild's CJS output leaves `import.meta.url` empty; the scorer resolves Playwright at runtime via `createRequire(import.meta.url)`, which needs a real file URL.

### Output

```
dist/
  orchestrator.cjs      # ~1.4 MB
  scorer.cjs            # ~1.3 MB
  supervisor.cjs        # ~1.1 MB
  gitignore-filter.cjs  # ~20 KB
  proxy-bootstrap.cjs   # ~0.95 MB (mounted at /bunsen/runtime/proxy-bootstrap.cjs when trace capture is enabled)
runtime/
  node-linux-x64     # Node.js binary for x64 containers
  node-linux-arm64   # Node.js binary for arm64 containers
```

## Import Constraints (Tree-Shaking)

**The bundles cannot import from `@bunsen-dev/runtime` directly.** The `@bunsen-dev/runtime` package has transitive dependencies on Docker/SSH libraries (`ssh2`, `cpu-features`) that contain native `.node` files, which esbuild cannot bundle.

Instead, when scorer/orchestrator code needs a small pure utility:

- **Import it from a tiny dependency-free shared package** rather than from `@bunsen-dev/runtime`:
  ```typescript
  // Good: safe to bundle because this package has no Docker/SSH/native dependency chain
  import { filterLockfilesFromDiff } from '@bunsen-dev/diff-filter';

  // Bad: pulls in ALL of @bunsen-dev/runtime including Docker/SSH native deps
  import { filterLockfilesFromDiff } from '@bunsen-dev/runtime';

  // Also bad: causes packages/agents tsc to compile files under packages/runtime/src
  import { filterLockfilesFromDiff } from '../../../runtime/src/diff-filter.js';
  ```
- The standalone files already inline several utilities (see `loadDiff()`, `loadLogs()`, etc. in `src/scorer/standalone.ts`) for this reason.
- Only import from `@bunsen-dev/types` or similarly small dependency-free shared packages. Do not import `@bunsen-dev/runtime` or cross-package source files into bundle entrypoints.
- When a type from `@bunsen-dev/types` is the right shape, import it — do **not** duplicate the runtime's adapter/transform inline just to keep the bundle self-contained. This repo has no backwards-compat requirements (see the root [`CLAUDE.md`](../../CLAUDE.md)); the solution to a shape change is to update the bundle's reader, not to maintain a parallel legacy shape inside the bundle.

### External packages

- **Playwright** is marked `--external` for the scorer bundle (visual scorer needs it at runtime in the container, not bundled)
- Everything else is inlined by esbuild

## Architecture

- `src/common/` — shared agent framework (`createAgent`, `tool()`, Anthropic client)
- `src/orchestrator/` — decides how to invoke the agent-under-test
- `src/scorer/` — evaluates agent output (LLM-judge, agentic, visual, code, aggregate, report scorers)
- `src/supervisor/` — monitors agent execution and can intervene
- `src/gitignore-filter/` — lists non-ignored files for diff generation

## Orchestrator Policy

When changing `src/orchestrator/`, keep the runtime behavior boundaries clear:

- Keep orchestrator prompt policy in [`src/orchestrator/standalone.ts`](./src/orchestrator/standalone.ts). If the runtime orchestrator needs to understand a rule, the rule must be injected from code that `standalone.ts` runs; documentation files alone do not affect the live orchestrator.
- Treat agent variants as **executor-side configuration**, not as underlying agent CLI syntax. The orchestrator should never invent or forward `--variant` or `:<variant>` when constructing the final invocation.
- Prefer passing the orchestrator the **resolved effects** of executor configuration, not the raw variant definition. In practice, that means it may need auto-appended args and env var names, but not the variant label itself.
- Do not expose executor-applied env var values in orchestrator prompts or traces. If env context matters, pass only the variable names.
- Keep helper modules data-oriented. Helpers can sanitize or reshape config before the orchestrator sees it, but prompt/guidance text should stay centralized in `standalone.ts`.
- Prefer a narrow orchestration surface. The default is to determine orchestration from the selected experiment config and agent config alone, not from filesystem exploration.
- Only add filesystem inspection tools back if concrete orchestration cases require them.

### Current variant handling

- The executor passes the orchestrator:
  - CLI args provided by the user
  - guaranteed args that will be auto-appended after orchestration
  - variant env var **names** only
- The orchestrator prompt is derived from the parsed selected experiment config and agent config only.

### Verification

For orchestrator changes, run at least:

```bash
pnpm --filter @bunsen-dev/agents test
pnpm --filter @bunsen-dev/agents build
```
