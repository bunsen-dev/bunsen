# OpenTTD bot — your task

You are running a transport company in **OpenTTD** by writing a bot against the game's native
**NoAI Squirrel API**. Your deliverable is the AI package in **`ai/StarterAI/`** — edit
`ai/StarterAI/main.nut` (and add helper `.nut` files beside it) to build a profitable transport
network: connect towns and industries, run vehicles, deliver cargo, and grow.

The `openttd-bot` skill (already available to you) teaches the API and the build loop in depth.
Read it first — the NoAI API is large and has sharp edges that will silently kill a bot.

## How you are scored

After you finish, the scorer **re-runs your bot from a fixed map seed** for a fixed number of
in-game years, headless, and reads metrics straight from authoritative game state — you cannot
report your own numbers. The scoring:

- **Gate — not bankrupt**: your company must still exist at the horizon. A bot that crashes, fails
  to compile, or goes bankrupt scores zero overall.
- **Performance rating** (OpenTTD's own 0–1000 score) — **this is the score.** It already folds in
  company value, cargo delivered, cargo variety, busy stations, profitable vehicles, and a low loan,
  so "build junk that moves nothing" does not help. Company value and cargo delivered are also
  printed (by the playtest and in the report) for insight, but the rating is what's graded.

The unmodified starter founds a company and stays solvent but builds nothing, so it passes the gate
and scores near zero on everything else. Your job is to make it actually move cargo.

## The build loop (do this constantly)

Iterate fast with the **same simulation the scorer uses**:

```sh
openttd-playtest          # runs your ai/StarterAI/ headless for the scored horizon
```

It prints whether your bot compiled and registered, the final rating / value / cargo, and writes
artifacts (including `final.sav`, which you can ignore) under `./openttd-out/`. If your `.nut` does
not compile or the company never founds, it tells you — fix and re-run. A short loop is cheaper than
a full horizon: `OPENTTD_HORIZON_YEARS=2 openttd-playtest` while iterating, then a full run
before you finish.

## Hard rules (breaking these silently kills your bot)

1. **`Start()` must never return.** Keep an infinite loop with `this.Sleep(n)`; returning ends the bot.
2. **Call `this.Sleep(n)` regularly.** Without it you hit OpenTTD's opcode limit and the bot is killed.
3. **Don't rename the package.** `ai/StarterAI/info.nut`'s `GetName()`/`CreateInstance()` must stay
   `"StarterAI"` and `GetShortName()` must stay 4 characters — the harness launches your bot by that
   name. Put your logic in `main.nut`, not `info.nut`.
4. **Cost-check before you build.** Use `AITestMode` to test feasibility, then `AIExecMode` to commit.

See the `openttd-bot` skill for the full API tour and a worked first-route example.
