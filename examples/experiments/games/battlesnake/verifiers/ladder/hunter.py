#!/usr/bin/env python3
"""Held-out ladder tier B — aggressive head-to-head hunter.

A style the visible sparring set does NOT contain (a generalization probe). On a
roomy, well-fed base it actively steers toward the head of any strictly-shorter
nearby opponent to win the head-to-head; otherwise it controls space and eats to
stay long. Punishes bots that only learned to beat passive sparring partners.
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, "/opt/battlesnake/lib")
import bsserver, bssafety as bs


def info():
    return {"name": "hunter", "color": "#e0245e", "head": "tiger-king", "tail": "round-bum"}


def _prey(state):
    you = state["you"]; my_len = len(you["body"])
    hx, hy = you["head"]["x"], you["head"]["y"]
    best, bd = None, 1e9
    for s in state["board"]["snakes"]:
        if s["id"] == you["id"] or len(s["body"]) >= my_len:
            continue
        d = bs.manhattan(hx, hy, s["head"]["x"], s["head"]["y"])
        if d < bd:
            best, bd = s, d
    return best, bd


def move(state, rng):
    options = bs.roomy_moves(state)
    if not options:
        return (bs.safe_moves(state) or ["down"])[0]
    you = state["you"]
    hx, hy = you["head"]["x"], you["head"]["y"]
    prey, pd = _prey(state)
    hunting = prey is not None and pd <= 5 and you["health"] > 25
    food = bs.nearest_food(state)
    eat = bs.should_eat(state, hunger=55)

    def score(m):
        nx, ny = bs.step(hx, hy, m)
        term = float(bs.reachable_after(state, m))
        if hunting:
            term += (22 - bs.manhattan(nx, ny, prey["head"]["x"], prey["head"]["y"])) * 1.6
        elif eat and food is not None:
            term += (11 - bs.manhattan(nx, ny, food["x"], food["y"])) * 1.2
        return term + rng.random() * 0.01

    return max(options, key=score)


if __name__ == "__main__":
    bsserver.serve(info, move)
