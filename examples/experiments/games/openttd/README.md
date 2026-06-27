# OpenTTD — the flagship game-bot experiment

The agent-under-test runs a transport company in **OpenTTD** by **authoring a bot** against the game's
native **NoAI Squirrel API** — the most natural surface for a coding agent (write code in `/workspace`,
run headless, score the artifact). It is graded by **deterministic, hard-to-cheese scorers** read from
authoritative game state, and produces a **watchable savegame replay**.

This is a *native Bunsen experiment*: a custom Dockerfile, a starter bot, a reporter, a run harness,
and a cross-agent `SKILL.md` — no new platform API. See
[`../GAME_SELECTION_BRIEF`](../../../tasks/game-bot-flagship/GAME_SELECTION_BRIEF.md) (dev checkout) for
why OpenTTD.

## How it works

```
agent edits  /workspace/ai/StarterAI/{info,main}.nut   (the bot — its only deliverable)
                          │
        scorer re-runs the bot from a FIXED seed, headless, for a fixed in-game horizon
                          │
  openttd -v null:ticks=N -g    ← single-player null-video driver: N game-ticks back-to-back,
                          │        no real-time throttle (a 12-year horizon runs in seconds),
                          │        then writes a savegame on exit. A tiny engine patch starts
                          │        the bot via `start_ai` once the game is live (see engine/).
                          │
   BunsenReporter (a separate, verifier-owned company) reads the agent company's quarterly
   performance rating / value / cargo straight from game state and prints them to stderr
                          │
        harness → metrics.json → script scorers → solvency gate + performance rating (the score)
```

**Why it can't be cheesed:** the agent only ever controls *source*. The scored savegame is generated
by the scorer re-running that source from the pinned seed in an isolated container; the metrics are
read by a separate company (the reporter), not reported by the agent. OpenTTD's lockstep sim is
integer-deterministic, so the same image + seed + bot yields byte-identical results (verified).

| Piece | What it is |
|---|---|
| [`Dockerfile`](./Dockerfile) | Builds headless OpenTTD 15.3 from pinned source + bakes OpenGFX 8.0 (native amd64 **and** arm64). |
| [`engine/`](./engine/) | The one small engine patch (+ why) that lets the null driver launch a named bot. |
| [`config/openttd.cfg.tmpl`](./config/openttd.cfg.tmpl) | Pinned, cheats-off, determinism-fixed config (env-driven seed/map/climate). |
| [`reporter/`](./reporter/) | The verifier-owned AI that reads the agent company's authoritative metrics. |
| [`harness/run_openttd.py`](./harness/run_openttd.py) | Runs one deterministic sim → `metrics.json` + `final.sav`. Used by the agent (`openttd-playtest`) and the scorer alike. |
| [`workspace/ai/StarterAI/`](./workspace/ai/StarterAI/) | The starter bot the agent edits (compiles, registers, stays solvent, builds nothing). |
| [`skill/openttd-bot/`](./skill/openttd-bot/) | Cross-agent `SKILL.md` teaching the NoAI API + the build loop. |
| [`verifiers/`](./verifiers/) | `type:script` scorers reading authoritative metrics from the savegame run. |

## Run it

```sh
bn experiments validate openttd
bn run openttd claude-code          # or codex-cli, gemini-cli, basic-coding-agent
bn run openttd echo-agent           # no-LLM smoke test: scores the unmodified baseline (~0.02)
bn runs open                        # scores, the report, and the captured final.sav
```

The unmodified starter passes the **not-bankrupt gate** but scores ~0 on the **performance rating** —
exactly the baseline an agent must beat by actually moving cargo.

### Config knobs (env-driven, for a later calibration sweep)

`OPENTTD_SEED`, `OPENTTD_HORIZON_YEARS` (default 12), `OPENTTD_MAP_SIZE` (default 9 → 512²),
`OPENTTD_CLIMATE` (default 0, temperate). Set in `experiment.yaml`'s `env:`; they match the harness
defaults baked into the image, so the agent's `openttd-playtest` sees exactly the scored configuration.

## Watching a run

The scored run captures **`final.sav`** — the exact end-state of the game — attached to the
`not-bankrupt` criterion and listed in the run manifest. Our scoring image is headless (null/dedicated
video drivers only), so you watch it in the **free official OpenTTD client**; the savegame is portable
across builds and platforms, so it just loads.

1. **Install the OpenTTD client** — `brew install --cask openttd` (macOS), or grab **15.x or newer**
   from [openttd.org](https://www.openttd.org/) (the save is 15.3, and newer clients always load older
   saves). On first launch, accept the **OpenGFX** download prompt — that's the free baseset the
   experiment uses, so it matches exactly; the save has no custom NewGRFs, so there's nothing else to
   install.
2. **Drop the savegame where the client looks for saves** so it appears in *Load Game*:

   ```sh
   ls .bunsen/runs/*/evaluation/criteria/not-bankrupt/artifacts/final.sav   # runs that have one
   mkdir -p ~/Documents/OpenTTD/save                                        # macOS personal data dir
   cp ".bunsen/runs/<RUN>/evaluation/criteria/not-bankrupt/artifacts/final.sav" \
      ~/Documents/OpenTTD/save/agent-replay.sav
   ```

   (`bn runs open <run>` also surfaces the artifact.)
3. **Load Game → `agent-replay.sav`.** It warns that the `StarterAI` / `BunsenReporter` scripts aren't
   installed — click through; the company's vehicles are baked into the save and run regardless. It
   opens **paused** at the end state; un-pause and **the game keeps playing from the end state**:
   vehicles run their routes, cargo flows, the calendar advances. You load in as a spectator, so open
   the **companies** toolbar to jump to the agent's network, the **minimap** for the whole web, click a
   vehicle to follow it, and **Tab** to fast-forward.
4. *(Optional, advanced)* To have the **bot itself resume building** — not just run the fleet it already
   built — reconstruct it from the run's `workspace/diff.patch` onto a copy of [`workspace/`](./workspace/),
   then drop `ai/StarterAI/` + [`reporter/`](./reporter/) into the client's `ai/` dir before loading.
   The bot has no save/load handler, so it restarts mid-game; not needed for the qualitative check.

### The in-game graphs *are* the scorers

You don't have to take the score on faith — OpenTTD's own UI plots exactly what the scorer reads.
Open the **Graphs** menu and the **Performance Detail** window:

- **Performance History** → the 0–1000 rating over time — **this is the score.**
- **Performance Detail** → the rating broken into its components (profitable vehicles, stations,
  delivered cargo, cargo variety, income, low loan…), so you can see *why* it scored what it did.
- **Company Value** and **Delivered Cargo** → shown for context — the rating already folds them in, so
  they're reported (and in `metrics.json`) but not scored separately.

The Performance History line is exactly `metrics.json`'s `rating`, so a glance is the qualitative
"yep, that score makes sense" check.

> How much there is to watch depends on what the bot built. The unmodified starter builds *nothing*,
> so its replay is an empty company — the living network, vehicles, and interesting graphs only appear
> once an agent actually constructs a transport system.

### Cross-agent comparison demo

Run two agents on the **same seed**, then compare scores and replays:

```sh
bn run openttd claude-code --model claude-opus-4-8
bn run openttd codex-cli   --model gpt-5.5
bn runs compare <run-a> <run-b>     # solvency gate + performance rating, side by side
```

Open each run's `final.sav` in the client. The deterministic scores tell you *who won*; the two
networks — and the graphs, which **overlay all companies on one chart** — show you *why*: "Claude's
rating pulls ahead in 1958 when its rail trunk came online; Codex's bus sprawl never connected the
refinery." Same map, same horizon, two strategies, one scoreboard.

> A `-d desync` command log can be captured as a forensic record of *what the bot did* (it replays
> gamestate, not reasoning), but it needs a special replay build to play back — the `.sav` is the
> canonical, watchable artifact and needs no custom tooling.

## Licensing

OpenTTD (GPL-2.0-only) + OpenGFX (GPL-2.0), both freely redistributable; the proprietary TTD assets are
never bundled. See [`NOTICE.md`](./NOTICE.md).
