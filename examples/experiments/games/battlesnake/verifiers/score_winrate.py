#!/usr/bin/env python3
"""Primary scorer — win-rate of the agent's bot vs the HIDDEN held-out ladder.

Plays the agent's bot against each held-out reference snake over the held-out
seed set, scores the aggregate win-rate in [0,1], renders the most decisive game
to an embeddable GIF artifact, and caches full per-game results for the
diagnostics criterion.

The engine is the authoritative adjudicator: the score is read from the engine's
own result line, never from anything the agent printed.
"""
import json
import os
import sys

sys.path.insert(0, "/opt/battlesnake/lib")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bsengine
import bsrender
import _ladder

START_LENGTH = 3  # snakes start at length 3; growth above this == food eaten


def report(score, summary, artifacts=None):
    out = os.environ.get("BUNSEN_EVAL_RESULT")
    payload = {"score": score, "summary": summary}
    if artifacts:
        payload["artifacts"] = artifacts
    if out:
        with open(out, "w") as f:
            json.dump(payload, f)
    print(summary)
    sys.exit(0)


def main():
    agent_cmd = json.loads(os.environ["BATTLESNAKE_AGENT_CMD"]) \
        if os.environ.get("BATTLESNAKE_AGENT_CMD") else _ladder.AGENT_BOT_CMD
    scorer_out = os.environ.get("BUNSEN_SCORER_OUTPUT", "/tmp")
    os.makedirs(scorer_out, exist_ok=True)

    try:
        you = bsengine.start_bots([{"name": _ladder.AGENT_NAME, "cmd": agent_cmd}])
    except Exception as e:
        report(0.0, f"Bot failed to start, win-rate 0%: {e}")

    games = []
    errors = []
    best = None  # (priority, frames, title)
    try:
        for opp in _ladder.HELD_OUT:
            try:
                running_opp = bsengine.start_bots([opp])
            except Exception as e:  # an opponent failing to start is an env issue
                errors.append(f"{opp['name']}: start failed ({e})")
                continue
            try:
                for seed in _ladder.SCORED_SEEDS:
                    try:
                        r = bsengine.play_running(
                            you + running_opp, seed=seed,
                            width=_ladder.WIDTH, height=_ladder.HEIGHT,
                            gametype=_ladder.GAMETYPE, timeout_ms=_ladder.MOVE_TIMEOUT_MS)
                    except Exception as e:
                        errors.append(f"{opp['name']}@{seed}: {e}")
                        continue
                    if r.get("error"):
                        errors.append(f"{opp['name']}@{seed}: {r['error']}")
                    you_info = r["snakes"].get(_ladder.AGENT_NAME, {})
                    won = r["winner"] == _ladder.AGENT_NAME
                    games.append({
                        "opponent": opp["name"], "seed": seed, "won": won,
                        "is_draw": r["is_draw"], "turns": r["turns"],
                        "survival": you_info.get("turns", 0),
                        "final_length": you_info.get("final_length", 0),
                        "death": you_info.get("death", "?"),
                        "error": r["error"],
                    })
                    prio = (1 if won else 0, r["turns"])
                    if r["frames"] and (best is None or prio > best[0]):
                        best = (prio, r["frames"], opp["name"])
            finally:
                bsengine.stop_bots(running_opp)
    finally:
        bsengine.stop_bots(you)

    # Win-rate counts only games that actually completed (a timed-out or errored
    # game is recorded as a non-win but flagged, never silently a clean loss).
    total = len(games)
    wins = sum(1 for g in games if g["won"])
    score = wins / total if total else 0.0

    # cache full results for the diagnostics criterion (shared scorer container)
    with open(_ladder.CACHE_PATH, "w") as f:
        json.dump({"games": games, "wins": wins, "total": total, "score": score,
                   "start_length": START_LENGTH, "errors": errors}, f)

    # per-opponent breakdown for the summary
    per = {}
    for opp in _ladder.HELD_OUT:
        n = opp["name"]
        gs = [g for g in games if g["opponent"] == n]
        w = sum(1 for g in gs if g["won"])
        per[n] = f"{100 * w // len(gs) if gs else 0}%"

    artifacts = []
    if best is not None:
        gif_path = os.path.join(scorer_out, "replay.gif")
        run_id = os.environ.get("BUNSEN_RUN_ID", "")
        title = f"Battlesnake run {run_id}" if run_id else "Battlesnake run"
        # scores shown on the replay: the headline win-rate + per-opponent breakdown
        gif_scores = [("win-rate", f"{100 * score:.0f}%")] + \
                     [(opp["name"], per[opp["name"]]) for opp in _ladder.HELD_OUT]
        try:
            bsrender.render_gif(best[1], gif_path, title=title, scores=gif_scores)
            artifacts.append({"path": "replay.gif", "mediaType": "image/gif"})
        except Exception as e:
            print(f"warning: GIF render failed: {e}", file=sys.stderr)

    summary = (f"Win-rate {100 * score:.0f}% ({wins}/{total}) vs the held-out ladder. "
               f"Per opponent: " + ", ".join(f"{k} {v}" for k, v in per.items()) + ".")
    if errors:
        summary += f" ({len(errors)} game(s) errored/timed out and were flagged.)"
    if not total:
        summary = "No held-out games completed (engine/opponent errors); win-rate 0%."
    report(round(score, 4), summary, artifacts or None)


if __name__ == "__main__":
    main()
