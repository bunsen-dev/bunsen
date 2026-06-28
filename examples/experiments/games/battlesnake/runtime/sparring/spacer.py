#!/usr/bin/env python3
"""Sparring tier 3 — flood-fill space control.

Among roomy safe moves (never traps itself) maximizes reachable open space,
nudging toward food when hungry. The strongest visible sparring bot; a real
step up from greedy `hungry`, but simpler than the held-out ladder.
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
import bsserver, bssafety as bs


def info():
    return {"name": "spacer", "color": "#1fa774", "head": "smart-caterpillar", "tail": "weight"}


def move(state, rng):
    options = bs.roomy_moves(state)
    if not options:
        return (bs.safe_moves(state) or ["down"])[0]
    hx, hy = state["you"]["head"]["x"], state["you"]["head"]["y"]
    food = bs.nearest_food(state)
    hungry = state["you"]["health"] <= 45

    def score(m):
        nx, ny = bs.step(hx, hy, m)
        sp = bs.reachable_after(state, m)
        term = float(sp)
        if hungry and food is not None:
            term += (9 - bs.manhattan(nx, ny, food["x"], food["y"])) * 0.5
        return term + rng.random() * 0.01

    return max(options, key=score)


if __name__ == "__main__":
    bsserver.serve(info, move)
