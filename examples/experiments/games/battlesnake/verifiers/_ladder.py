"""The HIDDEN, held-out scoring configuration: which reference snakes the agent
is scored against, and the held-out seed set. This file lives in verifiers/ so
in the default (dedicated) scorer container it is NOT mounted into the agent's
container — the agent cannot read it (anti-leakage).

The held-out ladder is a DIFFERENT set of implementations from the visible
sparring bots, and deliberately includes a style (aggressive head-to-head
hunting) the sparring set lacks, so an agent that over-fits the sparring bots
does not generalize here.
"""
import json
import os
import sys

_LADDER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ladder")
_PY = sys.executable


def agent_name():
    """Display/engine name for the agent's snake: '<agent>_<model>' when both are
    known (e.g. 'claude-code_claude-sonnet-4-6'), so cross-model replays are
    self-labeling. Agent id comes from BUNSEN_AGENT; model from the run manifest.
    Degrades to just the agent id, then to 'agent'."""
    name = os.environ.get("BUNSEN_AGENT") or "agent"
    model = None
    run_dir = os.environ.get("BUNSEN_RUN_DIR", "/bunsen/run")
    try:
        with open(os.path.join(run_dir, "manifest.json")) as f:
            model = (json.load(f).get("agent") or {}).get("model")
    except Exception:
        pass
    return f"{name}_{model}" if model else name


AGENT_NAME = agent_name()


def _bot(name):
    return {"name": name, "cmd": [_PY, os.path.join(_LADDER_DIR, name + ".py")]}


# Aggregate win-rate across all three decides the headline score.
HELD_OUT = [_bot("pragmatic"), _bot("hunter"), _bot("areacontrol")]

# Board / match config (env-overridable for a later calibration sweep).
WIDTH = int(os.environ.get("BATTLESNAKE_WIDTH", "11"))
HEIGHT = int(os.environ.get("BATTLESNAKE_HEIGHT", "11"))
GAMETYPE = os.environ.get("BATTLESNAKE_GAMETYPE", "standard")
MOVE_TIMEOUT_MS = int(os.environ.get("BATTLESNAKE_MOVE_TIMEOUT_MS", "500"))

# Held-out seed set (distinct from the dev seeds 1..N the self-test uses). The
# count is env-tunable; a larger set tightens the win-rate estimate.
_SEED_COUNT = int(os.environ.get("BATTLESNAKE_SCORED_SEED_COUNT", "12"))
_ALL_SCORED_SEEDS = [
    1009, 2017, 3023, 4051, 5077, 6079, 7103, 8117,
    9133, 10159, 11171, 12203, 13217, 14249, 15263, 16273,
]
SCORED_SEEDS = _ALL_SCORED_SEEDS[:_SEED_COUNT]

# Where the win-rate scorer caches full per-game results for the diagnostics
# criterion to read (scorers share the dedicated container).
CACHE_PATH = "/tmp/battlesnake_results.json"

# How the agent's bot is launched inside the scorer container. The agent
# checkpoints its latest WORKING bot to /workspace/submission/; scoring grades
# that checkpoint if present, and otherwise falls back to the live /workspace
# bot (so an agent that never checkpoints is still graded on its working dir).
SUBMISSION_DIR = "/workspace/submission"
AGENT_BOT_CMD = ["bash", "-c",
                 "if [ -f /workspace/submission/start.sh ]; then "
                 "exec bash /workspace/submission/start.sh; "
                 "else exec bash /workspace/start.sh; fi"]
