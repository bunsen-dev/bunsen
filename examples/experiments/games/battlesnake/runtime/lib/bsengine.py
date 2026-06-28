"""Run Battlesnake games via the official `battlesnake play` CLI and parse the
authoritative JSONL output. Shared by the self-test tool and the win-rate scorer.

The engine is the source of truth: we only start the bot servers, invoke the
CLI deterministically (`--seed N --sequential`), and read its `--output` file.
"""
import json
import os
import signal
import socket
import subprocess
import time
import urllib.request

ENGINE_BIN = os.environ.get("BATTLESNAKE_BIN", "/opt/battlesnake/bin/battlesnake")


def _free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _wait_ready(port, timeout=10.0):
    deadline = time.time() + timeout
    url = f"http://127.0.0.1:{port}/"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.05)
    return False


class _Bot:
    def __init__(self, name, cmd, color=None, cwd=None):
        self.name = name
        self.cmd = cmd            # list[str]
        self.color = color
        self.cwd = cwd
        self.port = _free_port()
        self.proc = None

    def start(self):
        env = dict(os.environ)
        env["PORT"] = str(self.port)
        self.proc = subprocess.Popen(
            self.cmd, env=env, cwd=self.cwd,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return _wait_ready(self.port)

    def stop(self):
        # The bot runs in its own session/process group (start_new_session), so
        # kill the whole group — a start.sh that backgrounds the real server
        # would otherwise orphan it holding the port.
        if not self.proc:
            return
        try:
            pgid = os.getpgid(self.proc.pid)
        except (ProcessLookupError, OSError):
            pgid = None
        for sig in (signal.SIGTERM, signal.SIGKILL):
            if self.proc.poll() is not None:
                break
            try:
                if pgid is not None:
                    os.killpg(pgid, sig)
                else:
                    self.proc.send_signal(sig)
            except (ProcessLookupError, OSError):
                break
            try:
                self.proc.wait(timeout=3)
            except Exception:
                pass


def _classify_deaths(frames, all_names):
    """Approximate per-snake outcome from the per-turn frames (the JSONL output
    does not carry elimination causes). Returns {name: {turns, final_length, death}}.
    death is 'starved' (health hit 0), 'collision' (vanished otherwise), or
    'survivor'."""
    info = {n: {"turns": 0, "final_length": 0, "death": "collision", "last_health": None}
            for n in all_names}
    seen_last = {}
    for fr in frames:
        for s in fr["board"]["snakes"]:
            n = s["name"]
            if n not in info:
                info[n] = {"turns": 0, "final_length": 0, "death": "collision", "last_health": None}
            info[n]["turns"] = fr["turn"]
            info[n]["final_length"] = s["length"]
            info[n]["last_health"] = s["health"]
            seen_last[n] = fr["turn"]
    last_turn = frames[-1]["turn"] if frames else 0
    for n, d in info.items():
        if seen_last.get(n) == last_turn:
            d["death"] = "survivor"
        elif d["last_health"] is not None and d["last_health"] <= 1:
            d["death"] = "starved"
    return info


def start_bots(specs):
    """Start a set of bot servers and return the list of running _Bot handles.
    On any failure, tears down everything started so far and raises RuntimeError."""
    running = []
    try:
        for b in specs:
            bot = _Bot(b["name"], b["cmd"], b.get("color"), b.get("cwd"))
            if not bot.start():
                raise RuntimeError(f"bot '{b['name']}' failed to start")
            running.append(bot)
        return running
    except Exception:
        for bot in running:
            bot.stop()
        raise


def stop_bots(running):
    for bot in running:
        bot.stop()


def play_running(running, seed, width=11, height=11, gametype="standard",
                 timeout_ms=500, out_path=None, wall_clock=30, engine_bin=None):
    """Run one game against already-running bot servers (`running` = list of
    _Bot). Reuses long-lived servers so a scorer can loop many seeds cheaply.

    `wall_clock` bounds a single game: each move is already capped at
    `timeout_ms`, and games on an 11x11 board terminate in well under 30s, so a
    timeout signals a stuck engine/bot rather than a long-but-legitimate game."""
    engine_bin = engine_bin or ENGINE_BIN
    cleanup_out = out_path is None
    if out_path is None:
        out_path = f"/tmp/bs_game_{os.getpid()}_{seed}.jsonl"
    try:
        argv = [engine_bin, "play", "-W", str(width), "-H", str(height),
                "-g", gametype, "--seed", str(seed), "--sequential",
                "--timeout", str(timeout_ms), "--output", out_path]
        for bot in running:
            argv += ["--name", bot.name, "--url", f"http://127.0.0.1:{bot.port}"]
        try:
            subprocess.run(argv, timeout=wall_clock,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            # Distinct outcome: not a draw, not a win — a stuck game. Callers
            # decide how to count it; the gate must not read it as a turn-0 death.
            return {"winner": None, "is_draw": False, "turns": -1, "frames": [],
                    "snakes": {}, "result": None, "error": "engine wall-clock timeout"}
        return parse_output(out_path, [b.name for b in running])
    finally:
        if cleanup_out:
            try:
                os.remove(out_path)
            except OSError:
                pass


def play_game(bots, seed, **kw):
    """Convenience: start the given bots, play one game, tear them down."""
    running = start_bots(bots)
    try:
        return play_running(running, seed, **kw)
    finally:
        stop_bots(running)


def parse_output(out_path, names):
    if not os.path.exists(out_path):
        return {"winner": None, "is_draw": False, "turns": 0, "frames": [],
                "snakes": {}, "error": "no engine output"}
    frames, result = [], None
    with open(out_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue                   # tolerate a truncated/partial line
            if "winnerId" in obj:          # final result line
                result = obj
            elif "board" in obj and "turn" in obj:  # per-turn frame
                frames.append(obj)
            # else: the line-1 game-metadata object — ignore
    snakes = _classify_deaths(frames, names)
    winner = None
    is_draw = True
    if result is not None:
        is_draw = bool(result.get("isDraw"))
        winner = result.get("winnerName") or None
        if winner == "":
            winner = None
    turns = frames[-1]["turn"] if frames else 0
    return {"winner": winner, "is_draw": is_draw, "turns": turns,
            "frames": frames, "snakes": snakes, "result": result, "error": None,
            "out_path": out_path}
