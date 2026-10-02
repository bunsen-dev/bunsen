# @bunsen-dev/agents

Platform agents (scorer, supervisor, gitignore-filter, proxy-bootstrap) that run **inside Docker containers** alongside the agent-under-test, **plus** the host-side `entrypoint.invoke` scaffolder (`src/scaffolder/`) that powers `bn agents infer-invoke`.

The scaffolder is the one thing here that is *not* a container bundle: it is imported as a normal module by the CLI (via the package entry `src/index.ts`) and inlined into the `bn` binary. It runs a model **once per agent at authoring time** to infer that agent's `entrypoint.invoke` template. At run time the invocation is built deterministically by `@bunsen-dev/runtime` from that committed template, so runs stay reproducible and comparable.

## Build Process

The container agents are bundled into self-contained `.cjs` files using esbuild so they can run inside containers without `node_modules`. (The scaffolder is not bundled here — see above.)

```bash
# Build all bundles + download Node.js runtime binaries
pnpm build:bundles

# Build a single bundle
pnpm build:bundles:scorer
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
  scorer.cjs            # ~2.1 MB (the AI SDK + its Anthropic/OpenAI/Google providers)
  supervisor.cjs        # ~1.1 MB
  gitignore-filter.cjs  # ~20 KB
  proxy-bootstrap.cjs   # ~0.95 MB (mounted at /bunsen/runtime/proxy-bootstrap.cjs when trace capture is enabled)
  index.js              # package entry — exports the host-side scaffolder (NOT a container bundle)
runtime/
  node-linux-x64     # Node.js binary for x64 containers
  node-linux-arm64   # Node.js binary for arm64 containers
```

## Import Constraints (Tree-Shaking)

**The bundles cannot import from `@bunsen-dev/runtime` directly.** The `@bunsen-dev/runtime` package has transitive dependencies on Docker/SSH libraries (`ssh2`, `cpu-features`) that contain native `.node` files, which esbuild cannot bundle.

This constraint applies to the **container bundle entrypoints** (`src/*/standalone.ts`). The scaffolder (`src/scaffolder/`) is host code inlined into the CLI, so it is free to import third-party deps normally — but it still must not import `@bunsen-dev/runtime` (that would create a package cycle), so it re-implements the tiny bits it needs.

Instead, when scorer/supervisor bundle code needs a small pure utility:

- **Import it from a tiny dependency-free shared package** rather than from `@bunsen-dev/runtime`:
  ```typescript
  // Good: safe to bundle because this package has no Docker/SSH/native dependency chain
  import { filterLockfilesFromDiff } from '@bunsen-dev/diff-filter';

  // Bad: pulls in ALL of @bunsen-dev/runtime including Docker/SSH native deps
  import { filterLockfilesFromDiff } from '@bunsen-dev/runtime';

  // Also bad: causes packages/agents tsc to compile files under packages/runtime/src
  import { filterLockfilesFromDiff } from '../../../runtime/src/diff-filter.js';
  ```
- The scorer inlines the small readers it needs for this reason (see `loadDiff()` / `loadLogs()` in `src/scorer/evidence.ts` and the thread readers in `src/scorer/traces.ts`).
- Only import from `@bunsen-dev/types` or similarly small dependency-free shared packages. Do not import `@bunsen-dev/runtime` or cross-package source files into bundle entrypoints.
- When a type from `@bunsen-dev/types` is the right shape, import it — do **not** duplicate the runtime's adapter/transform inline just to keep the bundle self-contained. This is internal bundle code with no API-stability obligation (see the root [`CLAUDE.md`](../../CLAUDE.md)); the solution to a shape change is to update the bundle's reader, not to maintain a parallel legacy shape inside the bundle.

### External packages

- **Playwright** is marked `--external` for the scorer bundle (a `browser-agent` criterion needs it at runtime in the container, not bundled). `src/scorer/browser-tools.ts` therefore resolves it **lazily, inside `execute`** — a judge or agent scorer in an image without Playwright must never touch it.
- Everything else is inlined by esbuild

## Architecture

- `src/common/` — `model.ts`, the one provider-agnostic model layer: `createModel('<provider>/<model>', { apiKey, headers })` over the Vercel AI SDK's Anthropic, OpenAI and Google providers, plus `parseModelRef`. The key is always passed explicitly — never read from a provider SDK's own default env var; the scorer bundle reads it from the one-time key file the host delivers (`readScorerApiKey` in `scorer/config.ts`), never from an environment variable. Shared by the scorer bundle and the scaffolder.
- `src/scaffolder/` — host-side `entrypoint.invoke` inference for `bn agents infer-invoke` (exported via `src/index.ts`; not a container bundle)
- `src/scorer/` — grades one criterion (`judge`, `agent`, `browser-agent`) or writes the run's `report`:
  - `config.ts` — every limit with the reason it has that value, the container paths, and `loadScorerConfig()` (the bundle's own guard over the config the runtime wrote; it never applies a default model)
  - `evidence.ts` — the task prompt, the lockfile-filtered diff, the logs, and `truncateHeadTail()`, the one truncation helper
  - `traces.ts` — readers for the captured agent conversations (`traces/threads/`)
  - `prompts.ts` — `systemPrompt()` (policy only, replaced wholesale by `scorer.systemPrompt`) and `userPrompt()` (the invariant turn: criterion, allowed scores, where the evidence is, the evidence, dependency results, the verdict instruction)
  - `tools.ts` / `browser-tools.ts` — the exploration tools, the two browser tools, and the verdict tools (`submit_score`, `submit_report`), which record into runner state
  - `runner.ts` — `runScorer()`: one capped loop, a state-based stop condition, one verdict-only call (the submit tool is the only one offered and the user turn asks for it), then `ScorerError` rather than a synthesized score. Tool choice is never forced: current Claude models reject `tool_choice: tool` / `any`, so narrowing the tool set is the one mechanism that works on every provider
  - `standalone.ts` — the bundle entry: parse `--config`, build the model, run, print one JSON line
  - Unit-tested with vitest and no API key (a `MockLanguageModelV4` stands in for the provider): `npx vitest run src/scorer`
- `src/supervisor/` — monitors agent execution and can intervene. It keeps its **own** `@anthropic-ai/sdk` client under `src/supervisor/` and does not use `common/model.ts`; moving it onto the shared model layer is deliberately separate work (it is Anthropic-only and never grades anything, so provider choice does not affect scores)
- `src/gitignore-filter/` — lists non-ignored files for diff generation

## Scaffolder Policy

When changing `src/scaffolder/`, keep these boundaries clear:

- The suggestion is a **pure function of the agent** — `command`, `examples`, `entrypoint.help`, `description`. It must **not** be conditioned on any experiment, task prompt, or rubric: how you invoke `codex` cannot depend on which bug it is fixing. (Conditioning invocation on the task would couple how an agent is called to what it is doing, and defeat cross-run comparability.)
- It emits an `entrypoint.invoke` **template** with `{prompt}` / `{promptFile}` placeholders, not a concrete argv. Keep `validateInvokeTemplate` in lockstep with the canonical `parseInvoke` in `@bunsen-dev/runtime`'s `agent-loader.ts` — the CLI re-parses the written file through the real loader, so a template this validator accepts must be one the loader accepts.
- It is a **suggestion tool**: the committed template is the contract, not the model. Any nondeterminism is absorbed by the human reviewing the `bn agents infer-invoke` diff before commit.
- It never invents or forwards `--variant` / `:<variant>`. Persistent `entrypoint.args` are passed for context but must not be repeated in the inferred template (the executor appends them).
- Running the agent's real `--help` is a legitimate authoring-time affordance: the CLI captures it host-side and folds it into the prompt. It is safe precisely because it happens once at authoring time, not on the run path — so it lets the model see the agent's real interface without touching run-time determinism.

### Verification

For scaffolder changes, run at least:

```bash
pnpm --filter @bunsen-dev/agents test
pnpm --filter @bunsen-dev/agents build
```
