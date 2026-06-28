#!/usr/bin/env python3
"""Held-out ladder tier A — pragmatic survivor.

Space-control with competitive eating: stays in roomy cells (never traps
itself), and seeks the nearest food whenever it is hungry OR not the longest
snake, so it keeps a length edge for head-to-heads. A distinct implementation
from the visible sparring bots.
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, "/opt/battlesnake/lib")
import bsserver, bssafety as bs


def info():
    return {"name": "pragmatic", "color": "#5b8def", "head": "default", "tail": "default"}


def move(state, rng):
    options = bs.roomy_moves(state)
    if not options:
        return (bs.safe_moves(state) or ["down"])[0]
    hx, hy = state["you"]["head"]["x"], state["you"]["head"]["y"]
    food = bs.nearest_food(state)
    eat = bs.should_eat(state, hunger=65)

    def score(m):
        nx, ny = bs.step(hx, hy, m)
        sp = bs.reachable_after(state, m)
        term = float(sp)
        if eat and food is not None:
            term += (11 - bs.manhattan(nx, ny, food["x"], food["y"])) * 1.2
        return term + rng.random() * 0.01

    return max(options, key=score)


if __name__ == "__main__":
    bsserver.serve(info, move)
