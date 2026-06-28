#!/usr/bin/env python3
"""Gate scorer — is the agent's bot a VALID Battlesnake server?

Separates "broken" from merely "weak":
  1. GET /        returns 200 with an `apiversion`.
  2. POST /move   returns 200 with a legal move (up/down/left/right) on a normal
     1v1 board state.
  3. The bot survives past a minimum number of turns in a baseline 1v1 game
     against the weakest sparring bot — the same kind of game it is scored in,
     so a bot tuned for 1v1 is not failed on a solo edge case. A bot that
     crashes / always returns junk gets moved "up" by the engine and dies fast.

Score 1.0 if all pass, else 0.0. Gates the rest of the evaluation.
"""
import json
import os
import sys
import urllib.request

sys.path.insert(0, "/opt/battlesnake/lib")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bsengine
import _ladder

MIN_TURNS = int(os.environ.get("BATTLESNAKE_GATE_MIN_TURNS", "15"))
# Several seeds: the gate keeps the BEST survival, so an unlucky early
# head-to-head vs the erratic `randomish` baseline can't false-fail a valid bot.
GATE_SEEDS = [424242, 424243, 424244, 424245, 424246]
SPARRING_BASELINE = os.path.join(
    os.environ.get("BATTLESNAKE_SPARRING", "/opt/battlesnake/sparring"), "randomish.py")

# A normal 1v1 board state (two snakes) for the /move smoke check.
SAMPLE_MOVE_STATE = {
    "game": {"id": "gate", "ruleset": {"name": "standard"}, "map": "standard", "timeout": 500},
    "turn": 3,
    "board": {
        "height": 11, "width": 11, "food": [{"x": 5, "y": 5}, {"x": 2, "y": 8}], "hazards": [],
        "snakes": [
            {"id": "you", "name": "you", "health": 95,
             "body": [{"x": 1, "y": 1}, {"x": 1, "y": 0}, {"x": 0, "y": 0}],
             "head": {"x": 1, "y": 1}, "length": 3},
            {"id": "opp", "name": "opp", "health": 90,
             "body": [{"x": 9, "y": 9}, {"x": 9, "y": 10}, {"x": 10, "y": 10}],
             "head": {"x": 9, "y": 9}, "length": 3},
        ],
    },
    "you": {"id": "you", "name": "you", "health": 95,
            "body": [{"x": 1, "y": 1}, {"x": 1, "y": 0}, {"x": 0, "y": 0}],
            "head": {"x": 1, "y": 1}, "length": 3},
}


def report(score, summary):
    out = os.environ.get("BUNSEN_EVAL_RESULT")
    if out:
        with open(out, "w") as f:
            json.dump({"score": score, "summary": summary}, f)
    print(summary)
    sys.exit(0 if score >= 1 else 1)


def main():
    agent_cmd = json.loads(os.environ["BATTLESNAKE_AGENT_CMD"]) \
        if os.environ.get("BATTLESNAKE_AGENT_CMD") else _ladder.AGENT_BOT_CMD
    try:
        you = bsengine.start_bots([{"name": _ladder.AGENT_NAME, "cmd": agent_cmd}])
    except Exception as e:
        report(0.0, f"Bot did not start a server: {e}")
    bot = you[0]
    try:
        # 1) info endpoint
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{bot.port}/", timeout=2) as r:
                info = json.loads(r.read())
            if "apiversion" not in info:
                report(0.0, "GET / response missing 'apiversion'.")
        except Exception as e:
            report(0.0, f"GET / failed: {e}")

        # 2) move endpoint returns a legal move on a normal 1v1 state
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{bot.port}/move",
                data=json.dumps(SAMPLE_MOVE_STATE).encode(),
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=2) as r:
                mv = json.loads(r.read()).get("move")
            if mv not in ("up", "down", "left", "right"):
                report(0.0, f"POST /move returned an illegal move: {mv!r}")
        except Exception as e:
            report(0.0, f"POST /move failed: {e}")

        # 3) survives a baseline 1v1 game vs the weakest sparring bot
        try:
            opp = bsengine.start_bots(
                [{"name": "baseline", "cmd": [sys.executable, SPARRING_BASELINE]}])
        except Exception as e:
            report(0.0, f"Could not start the baseline opponent: {e}")
        try:
            best = -1
            for seed in GATE_SEEDS:
                res = bsengine.play_running(you + opp, seed=seed, width=11, height=11)
                if res.get("error"):           # engine/wall-clock issue, not a death
                    continue
                best = max(best, res["snakes"].get(_ladder.AGENT_NAME, {}).get("turns", 0))
        finally:
            bsengine.stop_bots(opp)
        if best < 0:
            report(0.0, "Baseline games did not complete (engine error).")
        if best < MIN_TURNS:
            report(0.0, f"Bot survived at most {best} turns in a baseline 1v1 game "
                        f"(needs >= {MIN_TURNS}). Likely making fatal moves.")
        report(1.0, f"Valid bot: responds correctly and survived {best} turns in a "
                    f"baseline 1v1 game.")
    finally:
        bsengine.stop_bots(you)


if __name__ == "__main__":
    main()
