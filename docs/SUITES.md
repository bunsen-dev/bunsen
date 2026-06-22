# Suites

A **suite** is a versioned group of related experiments distributed as a unit. Suites are how benchmarks (Terminal Bench, future community suites) move between repos without being copy-pasted.

For the authoritative schema, see [suite.v1.json](https://schemas.bunsen.dev/suite.v1.json). This page covers the day-to-day workflow.

## Two Sides

- **Consuming a suite** — pull a published suite into your project at a pinned ref and run experiments against it.
- **Authoring a suite** — write a `bunsen-suite.yaml` so your experiments can be consumed by others.

## Consuming a Suite

### Add it to your project

```bash
bn suites add https://github.com/bunsen-dev/terminal-bench.git --as terminal-bench
```

That registers the suite in `bunsen.config.yaml` under `suites:`, clones it into `.bunsen/suites/<id>/` (where slashes in the canonical id are replaced with `__` — e.g. `.bunsen/suites/github.com__bunsen-dev__terminal-bench`), and makes its experiments available to `bn run` and `bn experiments list`.

The `--as <alias>` flag is optional — it gives the suite a short local name (`terminal-bench/<task>` instead of the canonical `github.com/bunsen-dev/terminal-bench/<task>`).

**Private repos.** `bn suites add` clones with your local `git` configuration, so any credentials `git` already has work transparently — an `ssh://`/`git@host:org/repo.git` URL uses your SSH keys, and an `https://` URL uses your configured credential helper (or a token embedded in the URL). If a non-interactive `git clone` succeeds in your shell, `bn suites add` succeeds too — `bn` never prompts interactively for credentials.

```yaml
# bunsen.config.yaml after `bn suites add`
suites:
  - source:
      type: git
      url: https://github.com/bunsen-dev/terminal-bench.git
      ref: v2.1.0     # Optional pin; otherwise tracks the default branch
    as: terminal-bench
```

### Identity

A suite's canonical id is **derived from where it was pulled from**, never declared by the suite author:

- Git-cloned suites → `<host>/<org>/<repo>` (trailing `.git` stripped, all-lowercase). E.g. `github.com/bunsen-dev/terminal-bench`, `gitlab.example.com/internal/eval-suite`.
- Local on-disk suites (no clone URL) → `local/<dirname>`. The `local/` prefix is reserved.

Run manifests record the canonical id (`suite_id`), the commit sha actually cloned (`suite_version`), and the source URL — so cross-run analysis stays unambiguous even when forks coexist.

### Resolve experiment refs

Three forms work everywhere `bn run` accepts an experiment ref:

| Form         | Example                                                            |
| ------------ | ------------------------------------------------------------------ |
| Canonical    | `bn run github.com/bunsen-dev/terminal-bench/fix-permissions ...`   |
| Short github | `bn run bunsen-dev/terminal-bench/fix-permissions ...`              |
| Local alias  | `bn run terminal-bench/fix-permissions ...`                        |

Unqualified refs (`bn run fix-permissions ...`) resolve in order: local experiments first, then registered suites in `bn suites list` order. Unqualified refs that match experiments in more than one source throw a hard **"Ambiguous experiment name"** error listing every matching qualified id. Use a qualified form to resolve the ambiguity.

### End-to-end: add and run

A full add → list → run → inspect loop against a published suite:

```bash
# 1. Register the suite (pinned to a tag for reproducibility)
bn suites add https://github.com/bunsen-dev/terminal-bench.git --as terminal-bench --ref v2.1.0

# 2. See what experiments it brought in
bn experiments list

# 3. Run one experiment from it with your agent under test
bn run terminal-bench/fix-permissions claude-code

# 4. Open the run in the local web viewer
bn runs open
```

Each experiment runs individually — give `bn run` one experiment ref at a time. There is no single command to run an entire suite or a track in one shot; to run a batch, invoke `bn run` per experiment (for example, by scripting a loop over the refs in `bn experiments list`).

### Update / refresh

```bash
bn suites update terminal-bench       # Refresh one suite to its configured ref
bn suites update --all                # Refresh every registered suite
```

`update` runs `git fetch` then checks out the configured ref as a detached HEAD — whether that ref is a tag, sha, or branch tip. A full re-clone only happens if the local cache directory is missing (no `.git` present).

### Inspect

```bash
bn suites list                              # All registered suites + cache status
bn suites info github.com/bunsen-dev/terminal-bench   # Detailed metadata
bn suites info terminal-bench --format json          # Same, machine-readable
```

### Remove

```bash
bn suites remove terminal-bench --force
```

Unregisters the suite from `bunsen.config.yaml` and deletes the cache under `.bunsen/suites/`.

## Authoring a Suite

A suite is a git repository with a `bunsen-suite.yaml` at the root and one or more `experiment.yaml` files under directories named in its `experiments:` list. (`bunsen-suite.yaml` lives in the *suite's* repo and describes the suite; the consuming side's `bunsen.config.yaml` is a different file that records which suites a *project* has registered.)

> **Informational fields.** `tags`, `tracks`, and `aggregation` are documented and stored, but **not yet selectable** — there is no `--track` flag, glob include/exclude arrays are not applied, and no suite-level aggregation runs at evaluation time. Author them so your suite is ready when selection lands, but don't rely on them to scope a run today. To run a subset now, pass explicit experiment refs (see [End-to-end: add and run](#end-to-end-add-and-run)).

```yaml
$schema: https://schemas.bunsen.dev/suite.v1.json
version: v1
name: Terminal Bench
description: CLI agent benchmark ported from terminal-bench.org
version_tag: 2.1.0    # Suite content version; semver recommended
license: MIT

compatibility:
  # Schema-feature gate. Names the minimum `bn` runtime that understands
  # all fields used in this manifest. Per-experiment image / runtime / package
  # needs go in each experiment.yaml — never duplicate here.
  min_bunsen_version: "0.3.0"

experiments:
  - tasks                # Directories containing experiment.yaml files
  - tasks-extra

tags:
  domains: [cli, sysadmin, coding]

tracks:
  default:
    description: Full suite
    include: ["**/*"]
  quick:
    description: Fast subset for smoke tests
    include: ["tasks/cli-basics/**", "tasks/simple-fs/**"]

aggregation:
  default: weighted_average
  weights:
    by_tag:
      hard: 2.0
```

### What goes in `bunsen-suite.yaml`

| Field             | Purpose                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------- |
| `name`            | Display name (free-form).                                                                |
| `description`     | Short human-readable summary.                                                            |
| `version_tag`     | Semver-recommended content version.                                                      |
| `license`         | SPDX-style license identifier.                                                           |
| `compatibility.min_bunsen_version` | Minimum `bn` version that understands the manifest's features.              |
| `experiments`     | Directories (relative to repo root) walked for nested `experiment.yaml` files.           |
| `tags`            | Free-form tag metadata. Informational today (see callout above).                        |
| `tracks`          | Named subsets of the suite via include/exclude globs; surfaced by `bn suites info`. Informational today. |
| `aggregation`     | Suite-level scoring policy. Informational today.                                         |

The manifest deliberately does **not** include an `id:` field. Identity comes from the clone URL — author-declared ids would invite collisions.

It also does **not** restate per-experiment image / runtime / package needs. Each `experiment.yaml` declares those itself; duplicating them at the suite level just creates a place where the manifest can lie about its contents.

### Verifier helpers

Suite-level helper scripts can live in a `verifiers/` directory at the repo root, mounted read-only at `/bunsen/suite-verifiers/` during experiment execution. Put scripts here that multiple experiments in the suite share, so each `experiment.yaml` can reference them without copying.

### Compatibility and stability

- Treat changes that move existing experiments out of an `experiments:` root, rename directories, or change criterion `id`s as **breaking** for downstream consumers — bump `version_tag` accordingly.
- New experiments and new tracks are additive — safe to ship under a minor bump.
- If you change `compatibility.min_bunsen_version`, document the reason in your suite's release notes. It is surfaced by `bn suites info` but is **advisory** — `bn` will not refuse to run a suite whose `min_bunsen_version` exceeds the installed version, so treat it as documentation for consumers rather than a hard gate.

## Best Practices

1. **Pin a `ref`.** Floating `ref` references (branch tips) make benchmarks irreproducible. Most consumers should pin a tag or sha.
2. **One suite per repo.** Suites are identified by URL, so don't try to ship two distinct suites from one repo.
3. **Keep manifests light.** Suites reference experiments; they do not embed them. `experiment.yaml` remains the atomic unit.
4. **Document forks.** When you fork a community suite, change the URL — that's what makes it a different suite. Don't try to masquerade as upstream.

## See also

- [experiment.yaml Reference](./EXPERIMENT_YAML.md) — the atomic unit a suite bundles.
- [Run Terminal Bench](./RUN_TERMINAL_BENCH.md) — a complete walkthrough of consuming a published suite.
- [Run Manifest & Events](./RUN_MANIFEST.md) — how `suite_id`/`suite_version` are recorded for cross-run analysis.
