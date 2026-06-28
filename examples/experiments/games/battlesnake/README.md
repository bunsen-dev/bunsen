# Battlesnake experiment

The agent authors a **Battlesnake bot** (an HTTP server implementing the
4-endpoint Battlesnake API) in `/workspace`. It is scored by **win-rate against a
hidden, held-out ladder** of bundled algorithmic reference snakes, and the run
emits an **auto-rendered replay GIF** of a representative game.

This is a *code-first, single-agent* experiment: there is exactly one agent under
test. The opponents are fixed reference snakes baked into the scorer environment,
and the official engine runs the multi-bot game internally — Bunsen still
evaluates one agent.

## Layout

```
battlesnake/
├── experiment.yaml                  task, image, scoring
├── Dockerfile                       multi-stage: build engine + bake runtime
├── SKILL.md                         the Battlesnake API + strategy (seeded into /workspace)
├── workspace/                       the agent's starter bot (legal moves out of the box)
│   ├── main.py  start.sh
├── runtime/                         baked into the image (VISIBLE to the agent)
│   ├── lib/        bssafety, bsserver, bsengine (engine runner), bsrender (GIF)
│   ├── sparring/   randomish, hungry, spacer   ← the DEV/visible practice bots
│   └── bin/        battlesnake-selftest         ← the self-test tool (on PATH)
└── verifiers/                       mounted ONLY in the dedicated scorer (HIDDEN)
    ├── gate.py            validity gate
    ├── score_winrate.py   primary win-rate scorer + renders the replay GIF
    ├── diagnostics.py     survival / per-opponent / food (weight 0)
    ├── _ladder.py         the held-out opponents + held-out scored seeds
    └── ladder/            areacontrol, hunter, minimax, trapper  ← the SCORED/hidden bots
```

The held-out panel is a difficulty spread: `areacontrol` (1-ply Voronoi) and
`hunter` (aggressive 1-ply) are medium; `minimax` and `trapper` are **depth-2
alpha-beta maximin** bots (pinned to a fixed depth so scored games are fast and
deterministic) with different evals. The two strong bots cap even a frontier-model
bot near ~50% each, so win-rate does not saturate at 100% for top models (a
strong reference bot itself only scores ~50% against the panel) while weaker bots
score in the single digits — add a stronger snake to re-open headroom as models
improve.

## The dev/scored split (anti-leakage)

The agent practices against the **visible sparring set** (`runtime/sparring/`,
baked into the image so the agent can read and play them via `battlesnake-selftest`)
but is **scored against a different, hidden held-out ladder** (`verifiers/ladder/`)
over **held-out seeds** (`verifiers/_ladder.py`). Because scoring uses the default
**dedicated** scorer container, `verifiers/` is never mounted into the agent's
container — the agent cannot read the bots or seeds it is graded on. The held-out
ladder also includes an **aggressive head-to-head** style the sparring set lacks,
so a bot that over-fits the practice bots generalizes poorly. The agent is **told**
all of this (in `task.prompt` and `SKILL.md`).

> Keep `evaluation.container: dedicated` (the default). Setting `container: agent`
> would mount `verifiers/` — and thus the hidden ladder and seeds — into the
> agent's container, defeating the split.

## Scoring

| Criterion | Weight | What it measures |
| --- | --- | --- |
| `valid-bot` (gate) | 0 | Responds to `GET /` and `POST /move`, and survives a baseline solo game. Gates the rest. |
| `win-rate` | 1 | **Headline.** Aggregate win-rate across all held-out opponents × held-out seeds. Renders the replay GIF. |
| `diagnostics` | 0 | Mean survival, per-opponent win-rate, food efficiency, death causes. |

The score is read from the **engine's own result line** — never from anything the
agent printed. The metric is **relative and unbounded**: add a stronger reference
snake to re-open headroom.

## Determinism

Games are run with `battlesnake play --seed N --sequential`, and the reference
bots are deterministic given the board state. Note the official CLI assigns snake
**start positions** nondeterministically (it permutes them across a Go map keyed
by random UUIDs), so individual games are not bit-reproducible; the board and food
are symmetric, so this adds variance to single games but does **not bias** the
aggregate win-rate, which is stable to a few percent over the held-out seed set.

## Licensing

The game engine (`BattlesnakeOfficial/rules`, pinned `v1.2.3`) is **AGPL-3.0**. It
is built unmodified in an isolated Docker stage and invoked only as a subprocess
(mere aggregation), so it does not make Bunsen's code AGPL. The replay renderer,
reference snakes, and engine runner are original code; the official AGPL
`board`/`exporter` renderers are **not** used. See the repo-root
[`THIRD_PARTY.md`](../../../../THIRD_PARTY.md).

## Run it

```bash
bn experiments validate battlesnake
bn run battlesnake claude-code
```

The image builds the engine from source (multi-stage, `amd64` + `arm64`), so no
binaries are vendored in the repo and there are no per-run downloads.
