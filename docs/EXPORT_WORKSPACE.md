# Exporting a Run Workspace

The diff in a run directory shows what the agent under test *changed*, but sometimes you
want the agent's full workspace as it stood at the end of the run — to run a dev server,
explore the codebase the agent produced, debug an unexpected score, or build a dataset of
agent-generated code.

Exporting is two distinct steps:

1. **Capture** the workspace into the run directory with `bn run --export-workspace`.
2. **Extract** it onto your machine with `bn runs export <run-id>`.

## Step 1: Capture the workspace at run time

Pass `--export-workspace` when you launch a run to snapshot the final workspace into the
run directory as `workspace/export.tar.gz`:

```bash
bn run my-experiment my-agent --export-workspace
```

Without the flag, the run directory still contains `workspace/diff.patch` (the change set),
but not the full tarball.

The tarball respects `.gitignore`: patterns from the container's workspace are honored
(including agent modifications to `.gitignore` and nested `.gitignore` files), so generated
junk like `node_modules`, `dist`, and `__pycache__` is excluded. When no `.gitignore`
exists, a sensible fallback exclusion list is used.

> **Note:** Both the export tarball and the diff are only produced when the experiment
> declares `workspace.sources`. With no sources there is nothing to snapshot, so
> `--export-workspace` silently produces no `export.tar.gz`. See
> [The Environment Model](./ENVIRONMENT.md) for how `workspace.sources` seeds the
> `/workspace-source` — an immutable snapshot of the initial seeded inputs — and `/workspace`.

For where `export.tar.gz` and `diff.patch` live in the run directory, see
[Run Manifest & Events](./RUN_MANIFEST.md).

## Step 2: Extract the workspace onto your machine

`bn runs export <run-id>` reconstructs the workspace into a directory you can inspect:

```bash
# Extract to a temp directory (path is printed at the end)
bn runs export <run-id>

# Extract to a specific directory
bn runs export <run-id> -o ./my-output

# Extract and then run the project's package install (npm/pnpm/yarn/bun or pip/poetry/uv/…)
bn runs export <run-id> --install
```

| Flag              | Description                                                     |
| ----------------- | --------------------------------------------------------------- |
| `-o, --output`    | Output directory. Defaults to a temp directory.                 |
| `--install`       | Detect the package manager and run install after extraction.    |

If the run was captured with `--export-workspace`, `bn runs export` simply extracts
`workspace/export.tar.gz`. Otherwise it falls back to reconstructing the workspace from
`workspace/diff.patch`: it copies the experiment's seeded workspace and applies the patch.
Capturing the tarball up front is the most faithful option, since the diff-based fallback
only reproduces files that were sourced or changed.

The output directory is cleaned before each export, so re-running `bn runs export` to the
same `-o` path gives you a fresh copy.

## A note on trust

A captured workspace is agent-produced data, and `bn runs export` writes files (and, in the
diff fallback, applies a patch) on your host. Bunsen validates the archive so a crafted
tarball cannot write outside the requested output directory, but you should still treat an
exported workspace — and any install step it runs — as untrusted input. See the
[Trust Model](./TRUST_MODEL.md) for the full boundary.

## See also

- [Run Manifest & Events](./RUN_MANIFEST.md) — the run-directory layout.
- [The Environment Model](./ENVIRONMENT.md) — `workspace.sources`, `/workspace`, and `/workspace-source`.
- [Trust Model](./TRUST_MODEL.md) — what is and isn't safe to run on the host.
