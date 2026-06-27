#!/usr/bin/env python3
"""Score OpenTTD's authoritative company performance rating into [0,1].

Reads /tmp/openttd-score/metrics.json (written by the gate criterion's
simulate_and_gate.sh) and emits rating/1000 as the score.

The 0-1000 performance rating is the game's own holistic metric — it already folds in
company value, cargo delivered, cargo variety, vehicles, stations, min profit, and loan
— so it is the single scored signal (see experiment.yaml). Company value and cargo
delivered stay in metrics.json for the narrative report, but are not scored separately
(they would double-count the rating and saturate against fixed targets).
"""
import json
import os

METRICS_PATH = os.environ.get("OPENTTD_METRICS", "/tmp/openttd-score/metrics.json")


def main() -> int:
    try:
        m = json.load(open(METRICS_PATH))
    except Exception:
        m = {}

    raw = m.get("rating", 0) or 0
    score = max(0.0, min(1.0, raw / 1000.0))
    summary = f"Performance rating {raw}/1000"

    with open(os.environ["BUNSEN_SCORE_FILE"], "w") as f:
        f.write(str(score))
    with open(os.environ["BUNSEN_SUMMARY_FILE"], "w") as f:
        f.write(summary)
    print(f"rating: {score:.3f} — {summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
