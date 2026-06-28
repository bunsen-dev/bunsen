#!/usr/bin/env python3
"""Sparring tier 1 — random-but-legal.

Picks a uniformly random move among those that don't immediately kill it
(walls, bodies, own neck). Ignores head-to-head danger, so it is erratic and
weak: the floor of the ladder. Deterministic given the engine seed.
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
import bsserver, bssafety as bs


def info():
    return {"name": "randomish", "color": "#9aa7b0", "head": "default", "tail": "default"}


def move(state, rng):
    options = bs.safe_moves(state, avoid_h2h=False)
    return rng.choice(options) if options else "down"


if __name__ == "__main__":
    bsserver.serve(info, move)
