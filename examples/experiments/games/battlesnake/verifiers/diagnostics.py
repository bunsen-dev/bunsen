#!/usr/bin/env python3
"""Diagnostics (weight 0) — colour on HOW the bot played, read from the cache the
win-rate scorer wrote. Reports a normalized survival score plus a human summary
of per-opponent win-rate, mean survival, and food efficiency. Never gates.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _ladder

# A full standard 11x11 game rarely exceeds this; used only to normalize the
# (zero-weight) survival diagnostic into [0,1].
SURVIVAL_NORM = float(os.environ.get("BATTLESNAKE_SURVIVAL_NORM", "120"))


def report(score, summary):
    out = os.environ.get("BUNSEN_EVAL_RESULT")
    if out:
        with open(out, "w") as f:
            json.dump({"score": score, "summary": summary}, f)
    print(summary)
    sys.exit(0)


def main():
    try:
        with open(_ladder.CACHE_PATH) as f:
            data = json.load(f)
    except Exception as e:
        report(0.0, f"No cached game results to diagnose: {e}")

    games = data["games"]
    if not games:
        report(0.0, "No games were played.")

    mean_survival = sum(g["survival"] for g in games) / len(games)
    mean_food = sum(max(0, g["final_length"] - data["start_length"]) for g in games) / len(games)
    deaths = {}
    for g in games:
        if not g["won"]:
            deaths[g["death"]] = deaths.get(g["death"], 0) + 1

    per = {}
    for opp in _ladder.HELD_OUT:
        n = opp["name"]
        gs = [g for g in games if g["opponent"] == n]
        w = sum(1 for g in gs if g["won"])
        mt = sum(g["survival"] for g in gs) / len(gs) if gs else 0
        per[n] = (100 * w // len(gs) if gs else 0, mt)

    survival_score = max(0.0, min(1.0, mean_survival / SURVIVAL_NORM))
    death_str = ", ".join(f"{k}:{v}" for k, v in sorted(deaths.items())) or "—"
    per_str = "; ".join(f"{k} {wr}% (surv {mt:.0f})" for k, (wr, mt) in per.items())
    summary = (f"Mean survival {mean_survival:.0f} turns, mean food eaten "
               f"{mean_food:.1f}. Per opponent: {per_str}. Losses by [{death_str}].")
    report(round(survival_score, 4), summary)


if __name__ == "__main__":
    main()
