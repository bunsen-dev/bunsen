#!/usr/bin/env python3
"""Sparring tier 2 — greedy-food.

Among safe moves, walks toward the nearest food (Manhattan), breaking ties by
how much open space the move leaves (light flood fill) then a seeded coin flip.
Avoids head-to-head losses. Beats randomish handily; loses to real space control.
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
import bsserver, bssafety as bs


def info():
    return {"name": "hungry", "color": "#f4c20d", "head": "beluga", "tail": "bolt"}


def move(state, rng):
    options = bs.safe_moves(state)
    if not options:
        return "down"
    hx, hy = state["you"]["head"]["x"], state["you"]["head"]["y"]
    food = bs.nearest_food(state)
    if food is None:
        # no food: just keep the most open space
        return max(options, key=lambda m: (bs.reachable_after(state, m), rng.random()))
    fx, fy = food["x"], food["y"]
    def key(m):
        nx, ny = bs.step(hx, hy, m)
        return (bs.manhattan(nx, ny, fx, fy), -bs.reachable_after(state, m), rng.random())
    return min(options, key=key)


if __name__ == "__main__":
    bsserver.serve(info, move)
