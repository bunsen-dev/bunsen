#!/usr/bin/env python3
"""Run one deterministic, headless OpenTTD game with a NoAI bot and report metrics.

This is the heart of the experiment. It is used in two places, unchanged:

  * the AGENT, during development, runs it to playtest its bot and get a fast
    compile/score feedback loop (`openttd-playtest`); and
  * the SCORER, to produce the *authoritative* result by re-running the bot from
    the pinned seed in an isolated container and reading metrics straight from
    game state (the agent never produces the savegame, so it cannot cheese it).

What it does:
  1. renders the pinned config template (config knobs come from env, so a later
     calibration sweep can vary seed/map/climate without editing content);
  2. stages the agent's `ai/StarterAI/` package and the baked, verifier-owned
     `BunsenReporter` into a fresh OpenTTD home;
  3. runs `openttd -v null:ticks=N -g` — the single-player null video driver runs
     exactly N game-ticks back-to-back with no real-time throttle, then writes a
     savegame on exit (our watchable replay artifact). A tiny engine patch makes
     it run the bot via `start_ai` once the new game is live (see engine/);
  4. parses the reporter's `METRIC ...` lines from stderr and writes metrics.json.

Outputs (under $OPENTTD_OUT, default ./openttd-out):
  metrics.json   the parsed result (gate + rating/value/cargo/balance + series)
  final.sav      the final savegame (load in any stock OpenTTD client to watch)
  openttd.log    the full engine stderr (debug + METRIC lines)
"""
from __future__ import annotations
import json
import os
import re
import shutil
import subprocess
import sys
import time

# Calibrated against the pinned 15.3 build: the in-game calendar advances exactly
# this many ticks per year here (measured 280k ticks => 10 yrs, 560k => 20 yrs,
# zero offset). Determinism does not depend on this value — it only maps the
# human-friendly "horizon in years" knob onto the engine's exact tick count.
TICKS_PER_YEAR = 28000

OPENTTD_BIN = os.environ.get("OPENTTD_BIN", "/usr/games/openttd")
REPORTER_SRC = os.environ.get("OPENTTD_REPORTER", "/opt/bunsen/reporter")
CFG_TMPL = os.environ.get("OPENTTD_CFG_TMPL", "/opt/bunsen/openttd.cfg.tmpl")


def env(name: str, default: str) -> str:
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def main() -> int:
    ai_dir = env("OPENTTD_AI_DIR", "/workspace/ai/StarterAI")
    seed = env("OPENTTD_SEED", "1234567")
    years = int(env("OPENTTD_HORIZON_YEARS", "12"))
    map_size = env("OPENTTD_MAP_SIZE", "9")  # 2^9 = 512 tiles per side
    climate = env("OPENTTD_CLIMATE", "0")  # temperate
    out_dir = os.path.abspath(env("OPENTTD_OUT", "./openttd-out"))
    ticks = years * TICKS_PER_YEAR

    if not os.path.isfile(os.path.join(ai_dir, "info.nut")):
        print(f"error: no info.nut under {ai_dir} — is the bot package there?", file=sys.stderr)
        return 2

    os.makedirs(out_dir, exist_ok=True)
    # A throwaway OpenTTD "personal dir" keeps the run hermetic and writable.
    home = os.path.join(out_dir, "ottd-home")
    pdir = os.path.join(home, ".local", "share", "openttd")
    if os.path.exists(home):
        shutil.rmtree(home)
    os.makedirs(os.path.join(pdir, "ai"), exist_ok=True)

    # Stage both scripts into the run's ai/ dir. The agent package is always named
    # StarterAI (its info.nut GetName/CreateInstance must stay "StarterAI").
    shutil.copytree(ai_dir, os.path.join(pdir, "ai", "StarterAI"))
    shutil.copytree(REPORTER_SRC, os.path.join(pdir, "ai", "BunsenReporter"))

    with open(CFG_TMPL, encoding="utf-8") as f:
        cfg = f.read()
    cfg = (cfg.replace("@SEED@", seed).replace("@MAP_X@", map_size)
              .replace("@MAP_Y@", map_size).replace("@CLIMATE@", climate))
    cfg_path = os.path.join(pdir, "openttd.cfg")
    with open(cfg_path, "w", encoding="utf-8") as f:
        f.write(cfg)

    log_path = os.path.join(out_dir, "openttd.log")
    run_env = dict(os.environ)
    run_env["HOME"] = home
    # The patched null driver runs these once the new game is live (agent first =>
    # it takes company 0; the reporter reads "the other company").
    run_env["OPENTTD_STARTUP_COMMANDS"] = "start_ai StarterAI; start_ai BunsenReporter"

    cmd = [OPENTTD_BIN, "-v", f"null:ticks={ticks}", "-g", "-c", cfg_path,
           "-G", seed, "-d", "script=4"]
    print(f"[run_openttd] {years} game-years ({ticks} ticks), seed {seed}, "
          f"map 2^{map_size}, climate {climate}", file=sys.stderr)
    t0 = time.time()
    with open(log_path, "wb") as log:
        proc = subprocess.run(cmd, env=run_env, stdout=log, stderr=subprocess.STDOUT)
    wall = round(time.time() - t0, 1)

    metrics = parse_metrics(log_path)
    metrics["seed"] = seed
    metrics["horizon_years"] = years
    metrics["ticks"] = ticks
    metrics["map_size"] = map_size
    metrics["climate"] = climate
    metrics["wall_seconds"] = wall
    metrics["engine_exit_code"] = proc.returncode

    # The null driver saves to autosave/exit.sav; surface it as the replay artifact.
    exit_sav = os.path.join(pdir, "save", "autosave", "exit.sav")
    if os.path.isfile(exit_sav):
        shutil.copyfile(exit_sav, os.path.join(out_dir, "final.sav"))
        metrics["replay_savegame"] = "final.sav"

    with open(os.path.join(out_dir, "metrics.json"), "w", encoding="utf-8") as f:
        json.dump(metrics, f, indent=2)

    maybe_checkpoint(ai_dir, metrics)
    print_summary(metrics, out_dir)
    return 0


def maybe_checkpoint(ai_dir: str, metrics: dict) -> None:
    """When the agent playtests (OPENTTD_CHECKPOINT=1), snapshot the bot whenever it
    *works* (compiles + survives) to /workspace/.openttd/last-good/. If the run later
    ends with the bot mid-edit/broken (e.g. an onTimeout:score run caught it between
    changes), the scorer falls back to this last-working version — so an unfinished
    final tweak can never drag the score below a bot the agent already had working.
    """
    if os.environ.get("OPENTTD_CHECKPOINT") != "1" or not metrics.get("not_bankrupt"):
        return
    ws = os.environ.get("BUNSEN_WORKSPACE_DIR", "/workspace")
    if not os.path.abspath(ai_dir).startswith(os.path.abspath(ws) + os.sep):
        return
    dest = os.path.join(ws, ".openttd", "last-good", "StarterAI")
    try:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if os.path.exists(dest):
            shutil.rmtree(dest)
        shutil.copytree(ai_dir, dest)
        print(f"[run_openttd] checkpointed working bot -> {dest}", file=sys.stderr)
    except OSError:
        pass


METRIC_RE = re.compile(
    r"METRIC agent=(\d+) year=(\d+) quarter=(\d+) rating=(-?\d+) "
    r"value=(-?\d+) cargo=(-?\d+) balance=(-?\d+) bankrupt=(\d+)")


def parse_metrics(log_path: str) -> dict:
    """Reduce the reporter's per-quarter stderr lines to a final result + series.

    The reporter prints, each quarter, either a `METRIC ...` line (the agent company
    is on the board) or `agent_missing=1` (it isn't). The *last* such event is the
    horizon state: a final METRIC means solvent; a final `agent_missing` after some
    metrics means the company went bankrupt; `agent_missing` with no metrics at all
    means it never founded.
    """
    series = []
    last_event = None          # "metric" | "missing"
    bot_broke = False          # the agent's bot failed to compile or died at runtime
    with open(log_path, encoding="utf-8", errors="replace") as f:
        for line in f:
            # The bot is the StarterAI package; the reporter is robust and won't die,
            # so a compile failure of StarterAI or *any* "script died" is the bot.
            if ("Failed to compile" in line and "StarterAI" in line) or \
               "The script died unexpectedly" in line:
                bot_broke = True
            if "agent_missing=1" in line:
                last_event = "missing"
                continue
            m = METRIC_RE.search(line)
            if m:
                last_event = "metric"
                series.append({
                    "agent": int(m.group(1)), "year": int(m.group(2)),
                    "quarter": int(m.group(3)), "rating": int(m.group(4)),
                    "value": int(m.group(5)), "cargo": int(m.group(6)),
                    "balance": int(m.group(7)), "bankrupt": int(m.group(8)),
                })

    quarters = len(series)
    # Failure: never compiled/registered, or compiled then crashed/bankrupted away.
    load_failed = bot_broke or quarters == 0
    survived = (last_event == "metric") and not bot_broke
    if survived:
        last = series[-1]
        return {
            "series": series, "company_exists": True, "not_bankrupt": 1,
            "rating": last["rating"], "company_value": last["value"],
            "cargo_delivered": last["cargo"], "balance": last["balance"],
            "final_year": last["year"], "quarters_reported": quarters,
        }
    return {
        "series": series, "company_exists": False, "not_bankrupt": 0,
        "load_failed": load_failed,
        "rating": 0, "company_value": 0, "cargo_delivered": 0, "balance": 0,
        "final_year": series[-1]["year"] if series else None,
        "quarters_reported": quarters,
    }


def print_summary(m: dict, out_dir: str) -> None:
    print("\n=== OpenTTD run summary ===", file=sys.stderr)
    if not m.get("not_bankrupt"):
        why = "bot failed to compile/register" if m.get("load_failed") else \
              "company went bankrupt or never closed a quarter"
        print(f"  GATE FAILED: {why}.", file=sys.stderr)
    else:
        print(f"  company survived to {m['final_year']} "
              f"({m['quarters_reported']} quarters)", file=sys.stderr)
        print(f"  performance rating : {m['rating']} / 1000", file=sys.stderr)
        print(f"  company value      : {m['company_value']}", file=sys.stderr)
        print(f"  cargo delivered    : {m['cargo_delivered']}", file=sys.stderr)
        print(f"  bank balance       : {m['balance']}", file=sys.stderr)
    print(f"  wall time          : {m['wall_seconds']}s", file=sys.stderr)
    print(f"  artifacts          : {out_dir}/metrics.json, final.sav, openttd.log",
          file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
