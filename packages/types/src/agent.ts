// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Public v1 shape for `agent.yaml`.
 *
 * The matching JSON Schema lives at `@bunsen-dev/types/schemas/agent.v1.json`.
 *
 * Agents are sealed closures, not negotiated combinations: an agent ships
 * everything it pins to specific versions via `install.deps` and
 * `install.build`. The experiment provides task substrate; the two coexist
 * in one container without a merge contract. See `docs/ENVIRONMENT.md` for
 * the asymmetric-composition model.
 */

import type { StepConfig } from './common.js';

// ---------------------------------------------------------------------------
// Top-level agent
// ---------------------------------------------------------------------------

export interface AgentConfig {
  $schema?: string;
  version: 'v1';
  name: string;
  description?: string;

  install: InstallConfig;
  entrypoint: Entrypoint;
  interaction: InteractionConfig;

  /**
   * Declares how the model is selected for this harness. Naming the env var
   * the harness reads its model id from is what lets `bn run --model <id>`
   * (and a declared `default`) target the right variable without the user
   * authoring a per-model variant. Omit for agents that expose no model knob
   * (e.g. a no-AI test agent or a harness that routes models server-side);
   * `--model` is then rejected with a clear error.
   */
  model?: ModelConfig;

  /** Default env added by this agent (before variants, before CLI overrides). */
  defaults?: AgentDefaults;
  examples?: AgentExample[];

  /** Named overlays applied on top of the base agent. */
  variants?: Record<string, AgentVariant>;
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export interface InstallConfig {
  source: InstallSource;
  /**
   * Declarative tool dependencies. Each dep is built and cached independently
   * and mounted read-only at `/bunsen/deps/<name>/` before `install.build`
   * runs. File references are resolved at load time, so this is always a list
   * of inline specs in the in-memory shape. See `docs/ENVIRONMENT.md`.
   */
  deps?: AgentDepSpec[];
  /** Cached build phase producing artifacts mounted at runtime. */
  build?: BuildConfig;
  /** Fast per-run setup commands. */
  configure?: ConfigureStep[];
}

// ---------------------------------------------------------------------------
// install.deps
// ---------------------------------------------------------------------------

/**
 * A single tool the agent needs. Built once per (name, version, target,
 * install-step-hash, linkage, abi); artifacts mount read-only at
 * `/bunsen/deps/<name>/`.
 */
export interface AgentDepSpec {
  /** Stable identifier; used as the mount path under `/bunsen/deps/`. */
  name: string;
  /** Recommended; included in the cache key and recorded in the manifest. */
  version?: string;
  /** Optional human description. */
  description?: string;
  /**
   * Default build image for every entry in `install`. A per-target entry may
   * override it via `install[].image`.
   */
  image?: string;
  /**
   * How the produced artifact is linked. Drives portability and the
   * declarations required for honest cross-image expectations:
   * - `static` — the binary contains everything including its libc. No
   *   `abi` block needed.
   * - `closure` — self-contained except for libc. Author declares
   *   `abi.libc` (the dominant case for language-runtime-based agents).
   * - `dynamic` — depends on substrate libraries beyond libc. Author must
   *   declare expected libraries via `requires.libraries`. Should be rare
   *   and explicit.
   *
   * Defaults to `closure` because that is the realistic dominant case for
   * language-runtime closures (Node, Python, Ruby).
   */
  linkage?: AgentDepLinkage;
  /**
   * Required for `closure` or `dynamic` linkage; ignored for `static`.
   * Declares the substrate libc the artifact targets.
   */
  abi?: AgentDepAbi;
  /**
   * Declared substrate libraries the dep relies on (only meaningful for
   * `linkage: dynamic`). Recorded in the manifest; not enforced at build
   * time in v1.
   */
  requires?: AgentDepRequires;
  /** What the dep contributes to the run environment. */
  provides?: AgentDepProvides;
  /** Per-target build recipes. Exactly one target must match the run platform. */
  install: AgentDepInstall[];
}

export type AgentDepLinkage = 'static' | 'closure' | 'dynamic';

export interface AgentDepAbi {
  /** libc family the artifact targets. */
  libc: 'glibc' | 'musl';
  /** Optional version range, e.g. `">=2.31"`. Recorded; not enforced in v1. */
  libc_version?: string;
}

export interface AgentDepRequires {
  /** Substrate libraries beyond libc the dep depends on. */
  libraries?: AgentDepLibraryRequirement[];
}

export interface AgentDepLibraryRequirement {
  /** Library name as the dynamic linker sees it (e.g. `libpq`). */
  name: string;
  /** Optional version range. */
  version?: string;
}

export interface AgentDepProvides {
  /**
   * Executable names expected under the dep's `/bunsen/deps/<name>/bin/`.
   * Verified after build; used for conflict detection across deps.
   */
  binaries?: string[];
}

/** Per-target build steps for a dep. */
export interface AgentDepInstall {
  /** Run platform this recipe applies to (e.g. `linux/amd64`, `linux/arm64`). */
  target: string;
  /** Commands executed in the build image; write artifacts to `/output/`. */
  run: string[];
  /** Optional override; defaults to the dep's parent `install.image`. */
  image?: string;
  /** Build network mode. Defaults to `default`. */
  network?: 'default' | 'none';
  /** Per-target timeout override. */
  timeout?: string;
}

/** Discriminated union of install sources. */
export type InstallSource =
  | InstallSourceLocal
  | InstallSourceGit
  | InstallSourceNpm
  | InstallSourceBinary;

export interface InstallSourceLocal {
  type: 'local';
}

export interface InstallSourceGit {
  type: 'git';
  repo: string;
  /** Branch, tag, or SHA. */
  ref?: string;
}

/**
 * An npm-published agent. Resolved on the host with `--ignore-scripts`, so the
 * package's lifecycle scripts (preinstall/install/postinstall) do not run — an
 * agent distributed via npm must ship prebuilt rather than relying on a
 * postinstall build step.
 */
export interface InstallSourceNpm {
  type: 'npm';
  package: string;
  /** NPM semver specifier. */
  version?: string;
}

export interface InstallSourceBinary {
  type: 'binary';
  url: string;
  /** Recommended integrity hash; `bn agents validate` warns when missing. */
  sha256?: string;
}

/** Cached build configuration — produces artifacts mounted read-only at runtime. */
export interface BuildConfig {
  /** Docker image used to run the build script. */
  image: string;
  /** Network mode for the build container. */
  network?: 'default' | 'none';
  /** Build timeout. Duration string. */
  timeout?: string;
  /** Build commands. */
  run: string[];
  /** Optional cache salt for manual cache busting. */
  cacheSalt?: string;
}

/**
 * Step applied at agent-startup time (fast per-run). Shares the step shape
 * with `workspace.setup`.
 */
export type ConfigureStep = StepConfig;

// ---------------------------------------------------------------------------
// Entrypoint and interaction
// ---------------------------------------------------------------------------

export interface Entrypoint {
  command: string;
  args?: string[];
  /** Shell command that prints the agent's help. Used by the orchestrator. */
  help?: string;
}

export type InteractionMode = 'direct' | 'supervised';

export interface InteractionConfig {
  mode: InteractionMode;
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

/**
 * How an agent's model is set. The model is delivered as an environment
 * variable — the portable mechanism across harnesses (most coding agents read
 * the model from an env var or a config file the agent's `install.configure`
 * step generates from one). `bn run --model <id>` sets `env` at CLI precedence,
 * overriding any model baked into a variant; with no flag, `default` (if any)
 * seeds it at the agent-defaults tier.
 */
export interface ModelConfig {
  /** Env var the harness reads the model id from (e.g. `ANTHROPIC_MODEL`). */
  env: string;
  /** Model id used when `--model` is not passed. */
  default?: string;
}

// ---------------------------------------------------------------------------
// Defaults and examples
// ---------------------------------------------------------------------------

export interface AgentDefaults {
  env?: Record<string, string>;
  /** Host env vars allowed to pass through from the shell. */
  passEnv?: string[];
}

export interface AgentExample {
  prompt: string;
  invocation: string;
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

/**
 * Partial override for `install.source` on a variant. Either a full source
 * block (which replaces the base) or a patch `{ ref }` / `{ version }`
 * applied to the base source's corresponding field.
 */
export type VariantInstallSource = InstallSource | { ref?: string; version?: string };

/**
 * Wrapper that annotates an array field with its merge mode against the base.
 *
 * Used for variant array fields that need an `append` option alongside the
 * default `replace`. The discriminator lives co-located with the data. Today
 * this applies to `install.configure`; the same shape is reserved for
 * `entrypoint.args` / `install.deps` if those pains surface.
 *
 * The raw-array form is shorthand for `{ mergeMode: 'replace', items: [...] }`.
 */
export interface MergeableArray<T> {
  /** How to merge against the base array. Defaults to `replace`. */
  mergeMode: 'append' | 'replace';
  items: T[];
}

/** Variant `install.configure` accepts either the raw array or the wrapped form. */
export type VariantConfigureSteps = ConfigureStep[] | MergeableArray<ConfigureStep>;

/**
 * Per-variant install overrides.
 * - `source` supports partial patching (see {@link VariantInstallSource}).
 * - `configure` accepts either a raw array (replace, the default) or a
 *   {@link MergeableArray} wrapper to append to the base configure list.
 * - `deps` / `build` replace wholesale.
 */
export interface VariantInstallConfig {
  source?: VariantInstallSource;
  deps?: AgentDepSpec[];
  build?: BuildConfig;
  configure?: VariantConfigureSteps;
}

/**
 * Overlay applied on top of the base agent.
 *
 * Merge semantics:
 * - Scalar/object fields shallow-merge.
 * - Arrays replace wholesale by default — including `entrypoint.args`.
 * - `install.configure` accepts an opt-in append form via the
 *   {@link MergeableArray} wrapper (`mergeMode: append`).
 * - Variants may override `install.source` in full or partially (e.g. just
 *   `source.ref`).
 */
export interface AgentVariant {
  description?: string;
  install?: VariantInstallConfig;
  entrypoint?: Partial<Entrypoint>;
  interaction?: Partial<InteractionConfig>;
  defaults?: Partial<AgentDefaults>;
}
