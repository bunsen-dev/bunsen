"""Tiny stdlib HTTP harness that serves a Battlesnake bot from a move function.

A reference snake is just:

    import bsserver, bssafety as bs
    def info():  return {"color": "#33aaff"}
    def move(state, rng):  return bs.safe_moves(state)[0]
    bsserver.serve(info, move)

`serve` reads the port from $PORT (or argv[1], default 8000), binds 0.0.0.0,
and serves GET / (info), POST /start, POST /move, POST /end. The `rng` passed to
`move` is a per-turn `random.Random` seeded from the board state (turn + head
x/y + length), NOT from game.id or the clock, so tie-breaks are deterministic
given the board — without being a single fixed exploitable move order.
"""
import json
import os
import random
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def rng_for(state, salt=0):
    # Seed only from reproducible board state (NOT game.id, which is a fresh
    # random UUID each game) so a bot's tie-breaks replay identically given a
    # fixed engine seed, while still not being a single fixed exploitable order.
    you = state.get("you", {})
    head = you.get("head", {})
    return random.Random(f"{state.get('turn', 0)}:{head.get('x')}:{head.get('y')}:"
                         f"{you.get('length')}:{salt}")


def serve(info_fn, move_fn, default_port=8000):
    port = int(os.environ.get("PORT") or (sys.argv[1] if len(sys.argv) > 1 else default_port))

    base_info = {"apiversion": "1", "author": "bunsen", "color": "#888888",
                 "head": "default", "tail": "default"}
    extra = info_fn() if info_fn else {}
    base_info.update({k: v for k, v in (extra or {}).items() if v is not None})

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
            self._json(base_info)

        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0) or 0)
            raw = self.rfile.read(n) if n else b"{}"
            path = self.path.rstrip("/")
            if path.endswith("move"):
                try:
                    state = json.loads(raw)
                    mv = move_fn(state, rng_for(state))
                    if mv not in ("up", "down", "left", "right"):
                        mv = "up"
                except Exception:
                    mv = "up"
                self._json({"move": mv})
            else:  # /start, /end
                self._json({})

    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
