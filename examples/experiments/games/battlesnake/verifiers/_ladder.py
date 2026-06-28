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


# The strong reference bots (minimax/survivor/trapper) iterative-deepen under a
# wall-clock budget. Pin them to a FIXED depth so scored games are fast AND
# deterministic (reproducible) instead of timing-dependent; the generous budget
# just guarantees depth-2 always completes even on a loaded scorer host.
os.environ.setdefault("BATTLESNAKE_MAX_DEPTH", "2")
os.environ.setdefault("BATTLESNAKE_BUDGET_MS", "2000")
os.environ.setdefault("BATTLESNAKE_LOOKAHEAD_DEPTH", "2")

# Aggregate win-rate across the whole panel decides the headline score. The panel
# is a DIFFICULTY SPREAD of ACTIVE bots (they engage and resolve games quickly —
# no defensive stalling that would drag long games into the per-game wall-clock):
#   areacontrol  - 1-ply Voronoi space control (medium; the low end weak agents can win some of)
#   hunter       - aggressive head-to-head 1-ply (medium; a style the sparring set lacks)
#   minimax      - depth-2 alpha-beta maximin, area-control eval (strong)
#   trapper      - depth-2 maximin, aggressive space-denial eval (strong, different style)
# The two strong maximin bots cap even a frontier-written bot near ~50% each (you
# can't dominate an equally-strong bot in a symmetric game), so win-rate no longer
# saturates at 100% for top models while still differentiating weaker ones. Add a
# stronger snake here to re-open headroom as models improve (the metric is unbounded).
HELD_OUT = [_bot("areacontrol"), _bot("hunter"), _bot("minimax"), _bot("trapper")]

# Board / match config (env-overridable for a later calibration sweep).
WIDTH = int(os.environ.get("BATTLESNAKE_WIDTH", "11"))
HEIGHT = int(os.environ.get("BATTLESNAKE_HEIGHT", "11"))
GAMETYPE = os.environ.get("BATTLESNAKE_GAMETYPE", "standard")
MOVE_TIMEOUT_MS = int(os.environ.get("BATTLESNAKE_MOVE_TIMEOUT_MS", "500"))
# Per-game wall-clock guard. Strong bots can push games to ~350 turns; this gives
# room for those (and a moderately-slow agent bot) to finish naturally rather than
# being killed. A killed game counts as a non-win, so keep this generous.
WALL_CLOCK = int(os.environ.get("BATTLESNAKE_WALL_CLOCK_S", "45"))

# Held-out seed set (distinct from the dev seeds 1..N the self-test uses). The
# count is env-tunable; a larger set tightens the win-rate estimate.
_SEED_COUNT = int(os.environ.get("BATTLESNAKE_SCORED_SEED_COUNT", "9"))
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
