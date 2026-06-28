#!/usr/bin/env python3
"""Held-out ladder tier C — Voronoi area control (strongest).

Picks among roomy (non-self-trapping) safe moves the one that maximizes OWNED
empty space: a simultaneous multi-source BFS from every snake's head where each
cell is won by whichever snake reaches it first (longer wins ties). Eats to keep
a length edge. The top rung of the ladder.
"""
import os, sys
from collections import deque
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, "/opt/battlesnake/lib")
import bsserver, bssafety as bs


def info():
    return {"name": "areacontrol", "color": "#7b2ff7", "head": "cosmic-horror", "tail": "cosmic-horror"}


def _voronoi_owned(state, my_head_after):
    board = state["board"]; w, h = board["width"], board["height"]
    you_id = state["you"]["id"]
    blocked = bs.occupied(board)        # snake bodies (tails freed); blocks PROPAGATION
    # Sources: my candidate next-head cell + every opponent's CURRENT head. Heads
    # sit on occupied cells, so they are valid seeds even though `blocked` would
    # otherwise reject them — only their propagation is blocked by bodies.
    sources = [("me", my_head_after, len(state["you"]["body"]))]
    for s in board["snakes"]:
        if s["id"] != you_id:
            sources.append((s["id"], (s["head"]["x"], s["head"]["y"]), len(s["body"])))
    owner, q = {}, deque()
    for sid, (sx, sy), ln in sources:
        if not bs.in_bounds(sx, sy, w, h):
            continue
        prev = owner.get((sx, sy))
        if prev is None or (0, -ln) < (prev[1], -prev[2]):
            owner[(sx, sy)] = (sid, 0, ln); q.append((sx, sy, sid, 0, ln))
    mine = 0
    while q:
        x, y, sid, d, ln = q.popleft()
        if owner.get((x, y)) != (sid, d, ln):
            continue
        if sid == "me":
            mine += 1
        for mv in bs.MOVES:
            nx, ny = bs.step(x, y, mv)
            if not bs.in_bounds(nx, ny, w, h) or (nx, ny) in blocked:
                continue
            prev = owner.get((nx, ny))
            if prev is None or (d + 1, -ln) < (prev[1], -prev[2]):
                owner[(nx, ny)] = (sid, d + 1, ln); q.append((nx, ny, sid, d + 1, ln))
    return mine


def move(state, rng):
    options = bs.roomy_moves(state)
    if not options:
        return (bs.safe_moves(state) or ["down"])[0]
    you = state["you"]
    hx, hy = you["head"]["x"], you["head"]["y"]
    food = bs.nearest_food(state)
    eat = bs.should_eat(state, hunger=65)

    def score(m):
        nx, ny = bs.step(hx, hy, m)
        term = float(_voronoi_owned(state, (nx, ny)))
        if eat and food is not None:
            term += (12 - bs.manhattan(nx, ny, food["x"], food["y"])) * 0.7
        return term + rng.random() * 0.01

    return max(options, key=score)


if __name__ == "__main__":
    bsserver.serve(info, move)
