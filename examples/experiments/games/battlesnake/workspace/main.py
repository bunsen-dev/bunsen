#!/usr/bin/env python3
"""Starter Battlesnake bot — makes legal, non-suicidal moves out of the box.

This is YOUR bot. It already avoids walls, your own body, and other snakes, so
it survives a while — but it does not yet seek food, control space, or handle
head-to-heads, so it will lose most games against the scored ladder. Improve the
`choose_move` function (see the TODOs). Keep it DETERMINISTIC given the board so
your results reproduce: don't use unseeded randomness or wall-clock time.

The Battlesnake API: https://docs.battlesnake.com/api
Board coordinates: (0,0) is the BOTTOM-LEFT cell; up = y+1.

Run locally:  PORT=8000 python3 main.py   (then `battlesnake-selftest`)
"""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DIRS = {"up": (0, 1), "down": (0, -1), "left": (-1, 0), "right": (1, 0)}


def info():
    # Customize your snake's appearance: https://docs.battlesnake.com/api/customizations
    return {"apiversion": "1", "author": "you", "color": "#33aaff",
            "head": "default", "tail": "default"}


def choose_move(state):
    """Return one of "up", "down", "left", "right".

    Starter logic: keep only moves that stay on the board and don't hit any
    snake's body, then pick the first. It's deterministic and won't suicide, but
    it's not trying to win yet.
    """
    you = state["you"]
    board = state["board"]
    width, height = board["width"], board["height"]
    head = you["head"]

    # Cells occupied by any snake body (your own included).
    blocked = set()
    for snake in board["snakes"]:
        for part in snake["body"]:
            blocked.add((part["x"], part["y"]))

    safe = []
    for move, (dx, dy) in DIRS.items():
        nx, ny = head["x"] + dx, head["y"] + dy
        if not (0 <= nx < width and 0 <= ny < height):
            continue          # would hit a wall
        if (nx, ny) in blocked:
            continue          # would hit a snake body
        safe.append(move)

    # TODO: prefer moves toward the nearest food in board["food"] when health is low.
    # TODO: prefer moves that keep the most open space (flood fill) so you don't trap yourself.
    # TODO: avoid head-to-head moves into cells an equal-or-longer opponent can reach.
    if not safe:
        return "down"         # no safe move — we're probably done for
    return safe[0]


# ---- HTTP server (you usually don't need to touch below here) ----
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._json(info())

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(n) if n else b"{}"
        if self.path.rstrip("/").endswith("move"):
            try:
                mv = choose_move(json.loads(raw))
            except Exception:
                mv = "up"
            self._json({"move": mv})
        else:
            self._json({})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
