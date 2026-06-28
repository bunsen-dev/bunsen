---
name: battlesnake-bot
description: >-
  How to write a Battlesnake bot for the Bunsen `battlesnake` experiment — the
  4-endpoint HTTP API, the board/move JSON, the coordinate system, core strategy
  (flood-fill space control, food/health management, head-to-head), and the local
  self-test loop. Use when authoring or improving a Battlesnake bot in /workspace.
---

# Writing a Battlesnake bot

You are building a **Battlesnake bot**: an HTTP server that decides, each turn,
which way your snake moves. The game engine runs the match and POSTs the board
state to your server; you reply with a direction. You win by being the last
snake alive (or, solo, by surviving). You are scored by **win-rate against a
hidden, held-out ladder** of reference snakes — see "How you are scored" at the
bottom.

## The 4-endpoint API

Your server implements four routes (the starter already does all of this):

| Method & path | When | You return |
| --- | --- | --- |
| `GET /` | Once at startup | Your snake's info: `{"apiversion":"1","author":"you","color":"#33aaff","head":"default","tail":"default"}` |
| `POST /start` | Game begins | `{}` (ignored) |
| `POST /move` | **Every turn** | `{"move":"up"\|"down"\|"left"\|"right"}` — **this is where all the logic lives** |
| `POST /end` | Game over | `{}` (ignored) |

Only `GET /` and `POST /move` matter for play. If `/move` errors, times out, or
returns anything invalid, the engine moves you **`up`** — which is often fatal,
so never rely on it.

## The board/move JSON

Every `POST /move` body (the "GameState") looks like:

```json
{
  "game": { "id": "abc-123", "ruleset": {"name": "standard"}, "map": "standard", "timeout": 500 },
  "turn": 14,
  "board": {
    "width": 11, "height": 11,
    "food": [{"x":5,"y":5}, {"x":9,"y":1}],
    "hazards": [],
    "snakes": [
      {"id":"a","name":"you","health":86,"length":4,
       "head":{"x":3,"y":4},
       "body":[{"x":3,"y":4},{"x":3,"y":3},{"x":2,"y":3},{"x":2,"y":2}]},
      {"id":"b","name":"opp","health":71,"length":3, "head":{"x":7,"y":8}, "body":[...]}
    ]
  },
  "you": { ... same shape as one entry in board.snakes ... }
}
```

Key facts:

- **`body` is ordered head → tail.** `body[0]` is the head (equals `head`);
  the last element is the tail tip. `body[1]` is your neck — moving onto it
  reverses into yourself and is illegal.
- **`you`** is your own snake; **`board.snakes`** includes you and every other
  living snake. Eliminated snakes disappear from the list.
- **`health`** is 0–100. You lose 1 per turn; eating food resets it to 100.

### Coordinate system (get this right)

**`(0,0)` is the BOTTOM-LEFT cell.** `x` grows to the right, `y` grows **up**:

```
up    = (x,   y+1)
down  = (x,   y-1)
left  = (x-1, y)
right = (x+1, y)
```

A move is **out of bounds** when the new cell fails `0 <= x < width and 0 <= y < height`.

## The rules that kill you

Each turn, after all snakes move simultaneously, a snake is eliminated if it:

1. moves **out of bounds**;
2. hits **any snake's body** (its own included — except a tail tip that is
   moving away, unless that snake just ate);
3. loses a **head-to-head**: when two heads land on the same cell, the **longer**
   snake survives and the shorter dies; **equal length → both die**;
4. **starves**: `health` reaches 0. Eating food (moving onto a food cell) sets
   `health` to 100 and grows you by one segment next turn.

## Core strategy

Build these up in `choose_move` (the starter has TODO markers for each):

1. **Don't die (safety filter).** Enumerate the 4 neighbor cells of your head;
   drop out-of-bounds cells, your neck, and any cell occupied by a snake body.
   A snake's tail tip is usually safe to enter (it moves away) — except when
   that snake just ate, when the tail stays put for a turn. The reliable "just
   ate" test is a **doubled tail** (`body[-1] == body[-2]`); `health == 100` is a
   hint but is also true at the very start before anyone has eaten.
2. **Avoid losing head-to-heads.** For each opponent at least as long as you,
   its head could move to any of its 4 neighbors next turn. Treat those cells as
   unsafe (you'd tie or lose). If you are strictly longer, that cell is a
   *winning* attack instead.
3. **Don't trap yourself (space control).** For each safe move, flood-fill the
   empty cells reachable after you step there (treat snake bodies as walls).
   Prefer the move with the most reachable space; never enter a pocket smaller
   than your length if a roomier move exists. This single idea beats most naive
   bots.
4. **Manage food and health.** Eat when health is getting low, or when you are
   not the longest snake (length decides head-to-heads). Don't greedily chase
   every food into a dead end — weigh food against space.
5. **(Advanced) Area control.** Approximate who "owns" each empty cell with a
   multi-source flood fill from every snake's head (closest head wins, longer
   wins ties); prefer moves that maximize the area you own and squeeze opponents.

Keep `/move` well under the 500 ms timeout — flood fills on an 11×11 board are
cheap, so single-ply look-ahead is plenty.

### Determinism

Your bot **must be deterministic given the board state** so your results
reproduce. Don't call unseeded `random` or read the wall clock. If you want to
break ties "randomly", seed a PRNG from the board (e.g. turn + your head
coordinates), not from `game.id` or the clock.

## The self-test loop

Iterate with the bundled tool (the practice harness):

```bash
battlesnake-selftest            # your bot vs the 3 sparring bots, 8 seeds each
battlesnake-selftest --games 16 # more seeds = steadier win-rate estimate
```

It prints per-opponent win-rate, average survival, and death causes, and renders
a sample game to `/workspace/selftest-replay.gif`. The sparring bots live in
`/opt/battlesnake/sparring/` (`randomish`, `hungry`, `spacer`) and you may read
them to study common patterns. Your launch contract is `start.sh` — it must
start your server on `$PORT`.

**It also checkpoints your work.** You have a limited time budget, and when it
runs out you are scored on the bot at **`/workspace/submission/`** — not your
latest in-progress edit. Every time `battlesnake-selftest` runs and your bot
starts cleanly, it copies your current bot there for you. So run it after each
improvement and your latest *working* bot is always saved: a broken edit at the
buzzer can't erase your progress, because the last clean snapshot is what's
graded. (If you never run selftest, scoring falls back to `/workspace`.)

## How you are scored

Your headline score is **win-rate against a HIDDEN, HELD-OUT ladder** of
reference snakes you cannot see — a **different** set from the sparring bots, and
it includes an **aggressive head-to-head** style the sparring set lacks. A bot
that only learns to beat the passive sparring bots will be punished. **Optimize
for general strength**, not for the three bots you can watch. There is also a
validity *gate* (your bot must respond correctly and survive a baseline game) and
zero-weight *diagnostics* (survival length, per-opponent win-rate, food).
