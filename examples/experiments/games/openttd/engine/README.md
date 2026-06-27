# Engine patch — why we modify OpenTTD

OpenTTD 15.3 is built from source for this image (see [`../Dockerfile`](../Dockerfile)). We apply
exactly **one** small, reviewable patch:

## `null-startup-commands.patch`

**What it does:** the headless **null video driver** (`-v null:ticks=N`) runs the game for exactly
`N` ticks back-to-back with no real-time throttle, then saves a savegame — which is exactly what a
deterministic, fast benchmark wants. But that driver runs no console and has no hook to launch a
specific AI. This patch adds a few lines to `VideoDriver_Null::MainLoop`: once the freshly generated
game is live, it runs any console commands in the `OPENTTD_STARTUP_COMMANDS` environment variable
(semicolon-separated). The harness uses it to run `start_ai StarterAI; start_ai BunsenReporter`.

**Why it's needed:** there is no stock way to launch a *named* AI from a headless single-player run.
The dedicated server (`-D`) can (`start_ai` over a TTY/admin port), but it is a *network* game whose
tick rate is locked to real-time — a multi-year horizon would take hours. The null driver is
uncapped (a 20-year horizon runs in seconds) but couldn't start our bot. The competitor auto-spawn
timer doesn't fire on a headless new game either. This patch bridges that gap with the smallest
possible change, reusing the engine's own `start_ai` console command and `start_game_script` path.

**Why it's safe / determinism-preserving:** it only executes operator-supplied console commands at a
well-defined point; it changes nothing about the simulation itself. Two runs of the same image with
the same seed and tick count produce byte-identical results (verified).

**Scope:** `src/video/null_v.cpp` only. The patch is applied with `patch -p1` against the pinned
`openttd-15.3` source tree during the image build. It is GPL-2.0 (same as OpenTTD); shipping it here
as a full diff is the offer of the modified source (see [`../NOTICE.md`](../NOTICE.md)).
