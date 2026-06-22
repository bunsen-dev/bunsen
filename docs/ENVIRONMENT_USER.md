# Running as Root (environment.user)

`environment.user` lives in the `environment` block of `experiment.yaml` (see the [experiment.yaml Reference](./EXPERIMENT_YAML.md) for the surrounding `environment.image` and `workspace` blocks, and [The Environment Model](./ENVIRONMENT.md) for how the container is composed). The `install.build` / `install.configure` blocks referenced below are agent-config (`agent.yaml`) concepts.

By default, Bunsen creates a non-root user named `bunsen` and runs both `workspace.setup` and the agent as that user. This default is written as `environment.user: user` (the literal value `user` means "create the standard non-root user"; the resulting account is always named `bunsen`). Set `environment.user: root` to skip non-root user creation entirely, running `workspace.setup` and the agent as root.

> **Note:** The non-root `bunsen` user cannot `sudo` or otherwise escalate to root — Bunsen sets `no-new-privileges` on the container, which blocks setuid-based privilege escalation (see [Trust Model](./TRUST_MODEL.md#the-real-container-posture)). If a step needs root, set `environment.user: root` (or `as: root` on that specific setup step); don't rely on `sudo` from the non-root user.

## Usage

```yaml
$schema: https://schemas.bunsen.dev/experiment.v1.json
version: v1
name: cron-broken-network
description: Repair a broken system curl setup
task:
  prompt: Figure out why /usr/bin/curl example.com fails and fix it.
workspace:
  sources:
    - path: ./workspace
environment:
  image:
    base: bunsen/headless
  user: root
evaluation:
  criteria:
    - id: tests-pass
      title: Tests pass
      type: script
      run: pytest /bunsen/verifiers/test_outputs.py -v
      scores: [0, 1]
```

## When to use `environment.user: root`

- **`workspace.setup` needs root** — e.g. `apt-get install`, writing to `/etc`, or modifying system-wide packages (pip/npm global installs).
- **The agent needs root** — e.g. modifying protected directories, fixing system-level configs, managing services with `systemctl`.
- **File-permission experiments** — testing how an agent handles protected files or ownership issues.

If only one or two `workspace.setup` steps need root, prefer setting `as: root` on those individual steps instead of escalating the whole experiment:

```yaml
workspace:
  setup:
    - run: pip install -r requirements.txt   # runs as the execution user
    - run: apt-get install -y libpq-dev      # needs root
      as: root
```

The same per-step `as: root` field is available on `install.configure` steps.

## When NOT to use it

- **Agent dependencies** — install agent tools via `install.build` (or Dockerfile) and use `install.configure` for fast runtime config (`install.configure` already runs as root).
- **Workspace dependencies** — `npm install` or `pip install -r requirements.txt` in the workspace don't need root; they run fine as the `bunsen` user.
- **Most experiments** — the default non-root behavior is preferred because it enables flags like `--dangerously-skip-permissions` on agents like Claude Code, which reject running as root. If you set `environment.user: root` with an agent that refuses to run as root, the agent will either error out or require an interactive confirmation it cannot give in a headless container, so only escalate when the task genuinely needs it.

## How it works

Bunsen's container initialization runs in this order:

| Step                                                      | Runs as                | `environment.user: user` (default)                                | `environment.user: root`                |
| --------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------- | --------------------------------------- |
| 1. Assemble `/workspace-source` from `workspace.sources[]`| root                   | Always runs                                                       | Always runs                             |
| 2. User creation + ownership handoff                      | root                   | Creates `bunsen`, chowns `/workspace` (still empty) and `/bunsen` | **Skipped**                             |
| 3. Materialize `/workspace` from `/workspace-source`      | execution user         | Runs as `bunsen` — files land bunsen-owned, no recursive chown    | Runs as root                            |
| 4. `install.configure`                                    | root (per-step `as:` allowed) | Fast runtime config                                          | Fast runtime config                     |
| 5. `workspace.setup`                                      | execution user (per-step `as:` allowed) | Runs as `bunsen` — deps are bunsen-owned from the start | Runs as root                            |
| 6. Agent execution                                        | execution user         | Runs as `bunsen`                                                  | Runs as root                            |

### Performance note

User creation happens *before* workspace materialization so the recursive `chown` only covers an empty `/workspace`, not a large immutable seed. Materialization then runs as the non-root user and produces correctly-owned files directly, avoiding another recursive ownership pass. When `environment.user: root` is set, non-root setup is skipped entirely.

## Non-root user creation details

When `environment.user` is left at the default (`user`), Bunsen:

1. Tries `useradd` (standard Linux), then `adduser -D` (Alpine/BusyBox) to create the `bunsen` user.
2. Transfers ownership of `/workspace` (still empty), `/bunsen`, and `/home/bunsen` to the new user. `/workspace-source` is left root-owned but world-readable so `bunsen` can materialize `/workspace` from it.
3. `install.configure` writes agent config directly into `$BUNSEN_AGENT_HOME` (= `/home/bunsen` for non-root runs, `/root` when `environment.user: root`). After `install.configure` completes, `/home/bunsen` is recursively chowned back to the `bunsen` user so the agent can read its config and exec anything in `~/.local/bin`.

If user creation fails (e.g. minimal images without `useradd` or `adduser`), Bunsen falls back to running as root — same behavior as `environment.user: root`, but without the explicit opt-in.

## Interaction with other features

### Supervisor

`interaction.mode: supervised` (declared in `agent.yaml`) is independent of `environment.user`. The supervisor handles interactive prompts via LLM and is useful when agents run as root and encounter permission dialogs. It is **not** automatically enabled as a fallback — agents opt in via their config.

### Recording

Terminal recording (`--record`) works in both root and non-root modes. Non-root is preferred because agents like Claude Code can use `--dangerously-skip-permissions`, eliminating interactive prompts that would otherwise clutter the recording.

### `evaluation.container: agent`

`evaluation.container: agent` (the default is `dedicated`) is often paired with `environment.user: root` for experiments where the agent installs system packages or starts services that scorers need to verify. The two settings are independent but complementary. See [Scoring in the Agent Container](./AGENT_CONTAINER_SCORING.md) for full coverage of this setting.

When `evaluation.container: agent` is set, scorers reuse the agent container's execution context:

- If the agent ran as non-root `bunsen`, scorers also run as `bunsen` with `HOME=/home/bunsen`.
- If the agent ran as root (because `environment.user: root` was set, or non-root setup failed), scorers run as root.
- The experiment's `verifiers/` directory is mounted before the agent runs, so verifier-only assets are not hidden in this mode.

`evaluation.container: agent` solves tasks that depend on user-scoped state (conda environments, per-user config directories), while `environment.user: root` only controls whether the agent and setup phases themselves need privilege.

## Examples

Experiments using `environment.user: root` in the Terminal Bench suite:

- **`cron-broken-network`** — agent must repair system-level sabotage of `/usr/bin/curl` and related startup mechanisms.
- **`blind-maze-explorer-5x5`** / **`blind-maze-explorer-algorithm`** — agent needs unrestricted system access for maze exploration.
