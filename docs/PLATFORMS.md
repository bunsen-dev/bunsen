# Platforms & Architecture

How Bunsen chooses the execution platform for Docker-backed runs and agent artifact builds.

## Overview

Bunsen treats **platform** as a first-class property. A platform is a `linux/<arch>` value, where `<arch>` is the bare CPU architecture:

- `linux/amd64` (arch `amd64`)
- `linux/arm64` (arch `arm64`)

Throughout the CLI and config you select a full **platform** (for example `linux/amd64`); the bare **arch** appears only as a derived field in cache metadata.

For any given `bn run` or `bn agents build`, Bunsen resolves one authoritative platform up front and then uses that same value consistently for:

1. Experiment image build or pull
2. Mounted platform runtime selection (for example the Node runtime used in custom images)
3. `install.build` artifact builds
4. `install.build` cache keys and metadata
5. Helper containers such as scorer containers

This avoids mixed-architecture failures where the experiment image, mounted runtime, and cached agent artifact were built for different platforms.

## CLI

Use `--platform` on Docker-backed commands:

```bash
bn run password-recovery claude-code:headless --platform linux/amd64
bn agents build claude-code --platform linux/arm64 --format json
```

If `--platform` is omitted, Bunsen consults `run.platform` in `experiment.yaml`, then `defaults.run.platform` from the project config, then the experiment's sole declared platform when available, and finally the Docker daemon architecture.

Experiments can narrow the valid run targets via `environment.platforms` in `experiment.yaml`:

```yaml
environment:
  platforms: [linux/amd64]
```

A single experiment can also pin its preferred run platform without restricting the membership list:

```yaml
run:
  platform: linux/amd64
```

And projects can set a default for every run in `bunsen.config.yaml`:

```yaml
defaults:
  run:
    platform: linux/amd64
```

`auto` is allowed for `run.platform` and `defaults.run.platform` and means "do not pin — fall through to the next source." `environment.platforms` accepts only concrete platforms, since it defines the membership list rather than a preference.

## Resolution Rules

Precedence:

1. Explicit `--platform` on the command line
2. `run.platform` in `experiment.yaml` (if not `auto`)
3. `defaults.run.platform` from `bunsen.config.yaml` (if not `auto`)
4. `environment.platforms` when exactly one platform is declared
5. Docker daemon architecture

There is no separate environment-variable override for platform selection.

If an experiment declares `environment.platforms`, the resolved platform must be a member regardless of which source picked it. If `--platform` is omitted and the experiment declares a single supported platform with no other override in play, Bunsen selects it automatically.

## What Uses the Resolved Platform

### `bn run`

The resolved run platform is threaded through the full run lifecycle:

- Experiment image preparation
- Mounted Node runtime path selection
- `install.build` artifact preparation
- Agent container startup
- Helper/scorer container startup

The resolved value is also recorded in the run manifest and shown by `bn runs show`.

### `bn agents build`

`bn agents build --platform ...` uses the same platform model, but only for the agent artifact build path:

- Build container platform
- Cache key selection
- Cache metadata

This is useful for pre-building artifacts for a non-default target platform before a run.

## Visibility

Inspect the resolved platform in a completed run:

```bash
bn runs show <run-id>
```

Inspect cached `install.build` artifacts and their target platforms:

```bash
bn cache list
```

Each cache entry records both:

- `platform`, for example `linux/amd64`
- `arch`, for example `amd64`

Cached artifacts are keyed by platform, so the same agent can keep separate builds for `linux/amd64` and `linux/arm64` side by side. Use `bn cache rm <key>` to drop a single entry or `bn cache prune` to clear all build and deps caches and force a rebuild on the next run.

## Examples

Build agent artifacts for both supported platforms:

```bash
bn agents build claude-code --platform linux/amd64 --format json
bn agents build claude-code --platform linux/arm64 --format json
bn cache list
```

Run the same experiment on a forced target platform:

```bash
bn run password-recovery claude-code:headless --platform linux/amd64
```

When the target platform cannot be supported by the image, runtime, or agent build configuration, Bunsen fails early with a platform-specific compatibility error instead of a later `exec` failure.

## Apple Silicon

On Apple Silicon (arm64) Macs, the Docker daemon reports `arm64`, so an unpinned run defaults to `linux/arm64`. If an experiment or agent was built for `linux/amd64`, force that platform explicitly so Docker runs it under emulation rather than failing on an arch mismatch:

```bash
bn run <experiment> <agent> --platform linux/amd64
```

Emulated `linux/amd64` runs work but are slower than native `linux/arm64`. Check your Docker daemon's architecture with `docker version --format '{{.Server.Arch}}'` to confirm which platform you'll get by default. To make the choice sticky for a project, set `defaults.run.platform` in `bunsen.config.yaml`.

## Failure Modes

### Agent supports only one architecture

The resolved per-run platform is the single authoritative choice (see [Resolution Rules](#resolution-rules) above). If an agent's [`install.build`](./AGENT_YAML.md) produces artifacts that only work on one architecture, that surfaces as a build failure inside the build container.

### Experiment supports only certain platforms

If an experiment declares `environment.platforms` and the requested or inferred run platform is outside that list, Bunsen fails before image prep:

- Example: `environment.platforms: [linux/amd64]`
- Requested platform: `linux/arm64`

### Local image exists for the wrong platform

If Docker already has a local image for one platform and the run requests another, Bunsen surfaces that mismatch explicitly and tells you to rerun with a matching `--platform` or build/pull a compatible image.

### Cross-arch installer failures inside `install.build`

If the platform selection is correct but the installer inside [`install.build`](./AGENT_YAML.md) fails, the fix belongs in the agent build configuration rather than in platform selection.

Typical examples:

- Download script instability
- Installer not publishing binaries for the requested platform
- Emulation slowness or network flakiness during the build step

In those cases, the next fix belongs in the agent build script or artifact packaging strategy.

## See also

- [agent.yaml Reference](./AGENT_YAML.md) — `install.build` and how agent artifacts are built
- [The Environment Model](./ENVIRONMENT.md) — `environment.platforms` in context
- [Run Manifest & Events](./RUN_MANIFEST.md) — where the resolved platform is recorded
- [CLI Reference](./CLI.md) — `bn run`, `bn agents build`, and `bn cache`
