# Agent Skills

Bunsen ships a set of **Agent Skills** — portable `SKILL.md` instruction packs that help a
coding agent *use* Bunsen from a user's own repo: scaffold experiments, author scorers, debug
runs, and plug in agents. They carry **guidance** (procedures, gotchas, the field reference);
the `bn` CLI carries the **actions**.

## Why `SKILL.md` (cross-agent by construction)

`SKILL.md` is an [open standard](https://agentskills.io): a directory with a `SKILL.md` whose
YAML frontmatter is `name` + `description` (the `description` is the auto-invocation trigger),
optionally accompanied by `reference/*.md` and other resources. It is discovered natively by
**Claude Code, Codex, Cursor, Gemini CLI, and Copilot**. Writing one set of skills therefore
reaches every major coding agent — there is no Claude-only plugin or marketplace to maintain.

Discovery directories differ per client, so `bn skills install` writes to each:

| Client | User scope | Project scope (`--project`) |
| --- | --- | --- |
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |
| Codex | `~/.agents/skills/` | `.agents/skills/` |

Claude Code and Codex have documented skill directories that `bn skills install` writes to
directly. Cursor, Gemini CLI, and Copilot read the same `SKILL.md` standard; install with
`--project` to drop the skills into the current repo where those clients can discover them.

## The skills

Four skills ship today — the **create → evaluate → diagnose → plug-in** loop. Each authoring
skill ends by running `bn … validate` and iterating until green, so the validator that ships
in the user's own CLI is always the final word.

| Skill | Fires when the user wants to… | Ends on |
| --- | --- | --- |
| `bunsen-new-experiment` | create/scaffold a new `experiment.yaml` (task, environment, workspace, a starter evaluation) | `bn experiments validate` |
| `bunsen-author-scorer` | design or refine the evaluation block (criterion types, gates, weights, evidence, scorer model, verifiers) | `bn experiments validate` |
| `bunsen-debug-run` | diagnose a finished run (crash, low score, high cost, empty diff, no traces, flaky) | routes the fix to an authoring skill |
| `bunsen-new-agent` | plug an agent into Bunsen (`agent.yaml`: install source, deps/build/configure, entrypoint, interaction) | `bn agents validate` + `bn agents build` |

The triggers are written to be **non-overlapping**: authoring an experiment, deepening its
scorers, diagnosing a run, and wrapping an agent each belong to exactly one skill, and the
diagnostic skill hands off to the matching authoring skill once it has named the cause.

Each skill fronts the authoring docs for the surface it edits — see
[experiment.yaml Reference](./EXPERIMENT_YAML.md), [Scorers & Evaluation](./SCORERS.md), and
[System Prompts & Agent Config Files](./AGENT_YAML.md) for the underlying concepts. Each
authoring skill bundles generated `reference/*.md` field tables (rendered from the
[@bunsen-dev/types](./PACKAGES.md) JSON Schemas the validator enforces), so the field names a skill
cites always match what `bn … validate` accepts.

## Installing

```bash
bn skills install              # auto-detect installed clients (falls back to all)
bn skills install --claude     # just Claude Code
bn skills install --codex      # just Codex
bn skills install --all        # every supported client
bn skills install --project    # into the current repo instead of $HOME
bn skills update               # alias of install — refresh after upgrading the CLI
bn skills list                 # what's installed per client, with version-drift warnings
bn skills uninstall --all      # remove Bunsen skills (leaves any non-Bunsen skills untouched)
```

Installs are **idempotent** and **namespaced** (`bunsen-*` directories), so re-installing
replaces only Bunsen's skills and never touches a user's own. Each install drops a
`.bunsen-skills.json` stamp recording the CLI version. All three subcommands accept
`--format text|json|yaml`.

### Updating after a CLI upgrade

The skills are bundled in the `bn` CLI, so a CLI upgrade ships new skill versions but does not
touch already-installed copies. **To refresh, re-run `bn skills install`** (or its alias
`bn skills update`) with the same scope/clients — it overwrites in place and re-stamps the
version, reporting the transition (`✓ Updated Claude Code: v0.1.0 → v0.2.0`). `bn skills list`
compares the stamp to the running CLI and warns when an install is stale, so you find out
without remembering to check. There is no auto-refresh on CLI upgrade, so re-run install
whenever you bump the CLI.

### Discovery nudge (optional)

Skills auto-invoke from their `description`, but a one-line pointer in the project's
`CLAUDE.md` (Claude Code) or `AGENTS.md` (Codex/Cursor — the cross-tool standard) makes the
agent reach for them more reliably:

```markdown
This repo uses Bunsen. Use the `bunsen-*` skills (installed via `bn skills install`) to author
experiments, write scorers, debug runs, and plug in agents — they end on `bn … validate`.
```

## Troubleshooting

- **A skill isn't auto-invoking.** Skills fire from their `description`, which can be
  ambiguous when a prompt is terse. Name the skill explicitly (e.g. "use the
  `bunsen-new-experiment` skill"), or add the [discovery nudge](#discovery-nudge-optional) to
  your `CLAUDE.md`/`AGENTS.md` so the agent reaches for them more reliably.
- **`bn skills install` didn't write for my client.** Auto-detect only writes to clients it
  finds installed. Pass the explicit flag (`--claude`, `--codex`) or `--all`, and use
  `--project` so Cursor, Gemini CLI, and Copilot can discover the skills from the repo.
- **A skill's advice disagrees with the CLI.** Trust the CLI. Every authoring skill ends by
  running `bn … validate` and iterating until green — the validator in your installed CLI is
  always the final word. If an install is stale, `bn skills list` flags it; re-run
  `bn skills install` to refresh.

## See also

- [experiment.yaml Reference](./EXPERIMENT_YAML.md) and [Scorers & Evaluation](./SCORERS.md) —
  the authoring surfaces the skills front
- [System Prompts & Agent Config Files](./AGENT_YAML.md) — wrapping an agent under test
- [CLI](./CLI.md) — the full `bn skills` command reference
