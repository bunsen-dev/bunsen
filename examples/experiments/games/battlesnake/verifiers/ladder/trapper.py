#!/usr/bin/env python3
"""trapper — aggressive area-denial 1v1 Battlesnake bot.

Strategy: maximin search over a standard-ruleset simulator (1-4 turns deep via
iterative deepening under a wall-clock budget), scoring leaves primarily by
TERRITORY DOMINANCE (my Voronoi area minus the opponent's) and by how CONFINED
the opponent is. It actively herds the opponent into smaller space and toward
dead ends, never self-traps (own reachable space is guarded), and when strictly
longer it walks into winning head-to-heads (the simulator scores those as kills).

Deterministic given the board: the only randomness is the passed-in `rng`, used
solely to break exact ties. Wall-clock time is used ONLY to bound the search, and
never to choose a move. 1v1 focus; degrades to 1-ply space control vs >1 opp.

Single self-contained file: imports only bsserver, bssafety, and the stdlib.
"""
import os
import sys
import time
from collections import deque

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, "/opt/battlesnake/lib")
import bsserver, bssafety as bs

MOVES = bs.MOVES
DIRS = bs.DIRS
INF = float("inf")

# --- search budget / terminal values ---
import os as _os
BUDGET = max(0.02, int(_os.environ.get("BATTLESNAKE_BUDGET_MS","300"))/1000.0)          # wall-clock seconds for the whole decision (engine timeout 500ms)
import os as _os2
MAX_DEPTH = int(_os2.environ.get("BATTLESNAKE_MAX_DEPTH","99"))          # iterative deepening ceiling (turns); the budget usually caps it
WIN = 1e7              # opponent eliminated, we survive
LOSS = -1e7            # we are eliminated
DRAW = -2e6            # mutual elimination (better than a loss, worse than living)

# --- leaf evaluation weights ---
W_AREA = 6.0           # Voronoi territory differential (me - opp): the core denial signal
W_LEN = 25.0           # length advantage (decides head-to-heads and area ties)
W_HEALTH = 0.30        # mild pull to keep health up
W_MOB = 6.0            # immediate mobility differential (sharpens corner-herding)
W_TRAP = 50.0          # bonus per cell the opponent is confined below its length
W_TRAP_KILL = 4000.0   # opponent nearly boxed (<=1 cell) -> near-certain kill soon
W_SELF = 80.0          # penalty per cell WE are confined below our length
W_SELF_KILL = 6000.0   # we are nearly boxed -> avoid hard
W_PURSUE = 1.6         # when strictly longer, close distance to herd/win head-to-heads


class _Timeout(Exception):
    pass


def info():
    return {"name": "trapper", "color": "#ff3b30", "head": "evil", "tail": "hook"}


# ===================== standard-ruleset simulator (1v1) =====================
def _snapshot(state):
    """Build a sim state {w,h,food:set,snakes:{id:{body:[(x,y)],health}}}."""
    b = state["board"]
    snakes = {}
    for s in b["snakes"]:
        snakes[s["id"]] = {
            "body": [(c["x"], c["y"]) for c in s["body"]],
            "health": s["health"],
        }
    return {"w": b["width"], "h": b["height"],
            "food": {(f["x"], f["y"]) for f in b["food"]},
            "snakes": snakes}


def _step(sim, moves):
    """Apply one turn (move -> -1 health -> feed -> eliminate) to a COPY."""
    w, h = sim["w"], sim["h"]
    food = set(sim["food"])
    snakes = {sid: {"body": list(s["body"]), "health": s["health"]}
              for sid, s in sim["snakes"].items()}

    # move: prepend new head, pop tail
    for sid, s in snakes.items():
        mv = moves.get(sid)
        if mv is None:
            mv = "up"
        hx, hy = s["body"][0]
        dx, dy = DIRS[mv]
        s["body"] = [(hx + dx, hy + dy)] + s["body"][:-1]
        s["health"] -= 1

    # feed: head on food -> health 100, grow (duplicate tail)
    eaten = set()
    for sid, s in snakes.items():
        head = s["body"][0]
        if head in food:
            s["health"] = 100
            s["body"].append(s["body"][-1])
            eaten.add(head)
    food -= eaten

    # eliminate (computed against post-move state, applied together)
    dead = set()
    ids = list(snakes.keys())
    for sid in ids:
        s = snakes[sid]
        hx, hy = s["body"][0]
        if not (0 <= hx < w and 0 <= hy < h) or s["health"] <= 0:
            dead.add(sid)
    for sid in ids:
        if sid in dead:
            continue
        s = snakes[sid]
        head = s["body"][0]
        if head in s["body"][1:]:          # self collision
            dead.add(sid); continue
        for oid in ids:
            if oid == sid:
                continue
            o = snakes[oid]
            if head in o["body"][1:]:       # body collision
                dead.add(sid); break
            if head == o["body"][0]:        # head-to-head: shorter/equal loses
                if len(s["body"]) <= len(o["body"]):
                    dead.add(sid)
                break
    for sid in dead:
        snakes.pop(sid, None)
    return {"w": w, "h": h, "food": food, "snakes": snakes}


def _occupied(sim):
    """Cells blocked by bodies this turn (each tail freed unless it just ate)."""
    blocked = set()
    for s in sim["snakes"].values():
        body = s["body"]
        last = len(body) - 1
        for i, c in enumerate(body):
            if i == last and s["health"] != 100:
                continue
            blocked.add(c)
    return blocked


def _voronoi_both(sim, me, opp, blocked):
    """Simultaneous multi-source BFS from every head: a cell is owned by whoever
    reaches it first (longer snake wins ties). Returns (my_cells, opp_cells)."""
    w, h = sim["w"], sim["h"]
    owner, q = {}, deque()
    for sid, s in sim["snakes"].items():
        head = s["body"][0]
        ln = len(s["body"])
        owner[head] = (sid, 0, ln)
        q.append((head[0], head[1], sid, 0, ln))
    mine = theirs = 0
    while q:
        x, y, sid, d, ln = q.popleft()
        if owner.get((x, y)) != (sid, d, ln):
            continue
        if sid == me:
            mine += 1
        elif sid == opp:
            theirs += 1
        for mv in MOVES:
            dx, dy = DIRS[mv]
            nx, ny = x + dx, y + dy
            if not (0 <= nx < w and 0 <= ny < h) or (nx, ny) in blocked:
                continue
            prev = owner.get((nx, ny))
            if prev is None or (d + 1, -ln) < (prev[1], -prev[2]):
                owner[(nx, ny)] = (sid, d + 1, ln)
                q.append((nx, ny, sid, d + 1, ln))
    return mine, theirs


def _free_space(sim, head, blocked, cap):
    """Free cells the snake at `head` can move into (4-connected flood, bodies as
    walls), capped — we only need to know whether it exceeds `cap`. Also returns
    the immediate mobility (number of open neighbour cells of the head)."""
    w, h = sim["w"], sim["h"]
    hx, hy = head
    seen = set()
    q = deque()
    for mv in MOVES:
        dx, dy = DIRS[mv]
        nx, ny = hx + dx, hy + dy
        if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in blocked and (nx, ny) not in seen:
            seen.add((nx, ny))
            q.append((nx, ny))
    mob = len(seen)
    count = 0
    while q:
        x, y = q.popleft()
        count += 1
        if count >= cap:
            break
        for mv in MOVES:
            dx, dy = DIRS[mv]
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in blocked and (nx, ny) not in seen:
                seen.add((nx, ny))
                q.append((nx, ny))
    return count, mob


def _evaluate(sim, me, opp):
    """Score a non-terminal leaf from my perspective (both snakes alive)."""
    s = sim["snakes"][me]
    o = sim["snakes"][opp]
    my_len = len(s["body"])
    op_len = len(o["body"])
    blocked = _occupied(sim)

    me_area, opp_area = _voronoi_both(sim, me, opp, blocked)
    my_free, my_mob = _free_space(sim, s["body"][0], blocked, my_len + 2)
    opp_free, opp_mob = _free_space(sim, o["body"][0], blocked, op_len + 2)

    score = W_AREA * (me_area - opp_area)
    score += W_LEN * (my_len - op_len)
    score += W_HEALTH * s["health"]
    score += W_MOB * (my_mob - opp_mob)

    # Trap pressure: the more the opponent is confined below its own length, the
    # closer it is to dying. Reward it hard; reward an almost-sealed box harder.
    if opp_free <= op_len:
        score += W_TRAP * (op_len - opp_free + 1)
    if opp_free <= 1:
        score += W_TRAP_KILL

    # Self-preservation mirrors the above: never confine ourselves below length.
    if my_free <= my_len:
        score -= W_SELF * (my_len - my_free + 1)
    if my_free <= 1:
        score -= W_SELF_KILL

    # When strictly longer, close in on the opponent's head to herd it and set up
    # winning head-to-heads (we win those by length); kept modest so it never
    # overrides safety or territory.
    if my_len > op_len:
        hx, hy = s["body"][0]
        ox, oy = o["body"][0]
        dist = abs(hx - ox) + abs(hy - oy)
        score += max(0.0, (sim["w"] + sim["h"]) - dist) * W_PURSUE

    # Stay fed enough to keep a length edge / avoid starving in long games.
    if sim["food"] and (s["health"] < 50 or my_len <= op_len):
        hx, hy = s["body"][0]
        d = min(abs(fx - hx) + abs(fy - hy) for fx, fy in sim["food"])
        fw = 1.0 if my_len <= op_len else 0.0
        if s["health"] < 50:
            fw += (50 - s["health"]) / 50.0 * 3.0
        if s["health"] < 20:
            fw += 3.0
        score += max(0.0, 18.0 - d) * fw
    return score


# ===================== maximin search with alpha-beta =====================
def _cands(sim, sid):
    """Candidate moves for `sid`: on-board and not reversing into the neck.
    Body collisions / head-to-heads are left for the simulator to resolve."""
    s = sim["snakes"][sid]
    body = s["body"]
    hx, hy = body[0]
    neck = body[1] if len(body) > 1 else None
    w, h = sim["w"], sim["h"]
    out = []
    for mv in MOVES:
        dx, dy = DIRS[mv]
        nx, ny = hx + dx, hy + dy
        if not (0 <= nx < w and 0 <= ny < h):
            continue
        if neck is not None and (nx, ny) == neck:
            continue
        out.append(mv)
    return out or list(MOVES)


def _ordered_cands(sim, sid):
    """Candidate moves ordered by open-neighbour count (toward space first) to
    improve alpha-beta pruning. Cheap heuristic; does not affect correctness."""
    cands = _cands(sim, sid)
    if len(cands) < 2:
        return cands
    blocked = _occupied(sim)
    w, h = sim["w"], sim["h"]
    hx, hy = sim["snakes"][sid]["body"][0]
    scored = []
    for mv in cands:
        dx, dy = DIRS[mv]
        cx, cy = hx + dx, hy + dy
        openn = 0
        for m2 in MOVES:
            ex, ey = DIRS[m2]
            nx, ny = cx + ex, cy + ey
            if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in blocked:
                openn += 1
        scored.append((openn, mv))
    scored.sort(reverse=True)
    return [mv for _, mv in scored]


def _maxnode(sim, me, opp, depth, alpha, beta, deadline):
    snakes = sim["snakes"]
    me_alive = me in snakes
    opp_alive = opp in snakes
    if not me_alive and not opp_alive:
        return DRAW
    if not me_alive:
        return LOSS - depth          # earlier death (bigger depth left) is worse
    if not opp_alive:
        return WIN + depth           # earlier kill (bigger depth left) is better
    if depth <= 0:
        return _evaluate(sim, me, opp)
    if time.time() > deadline:
        raise _Timeout()
    value = -INF
    for mv in _ordered_cands(sim, me):
        v = _minnode(sim, me, opp, mv, depth, alpha, beta, deadline)
        if v > value:
            value = v
        if value > alpha:
            alpha = value
        if alpha >= beta:
            break
    return value


def _minnode(sim, me, opp, my_mv, depth, alpha, beta, deadline):
    value = INF
    for omv in _ordered_cands(sim, opp):
        ns = _step(sim, {me: my_mv, opp: omv})
        v = _maxnode(ns, me, opp, depth - 1, alpha, beta, deadline)
        if v < value:
            value = v
        if value < beta:
            beta = value
        if beta <= alpha:
            break
    return value


def _root(sim, me, opp, root_opts, depth, deadline, rng, pv):
    """One full-width root search at the given depth. Returns (best_move, value).
    May raise _Timeout if the budget is exceeded mid-search."""
    # Try the previous iteration's best move first (principal-variation ordering).
    ordered = list(root_opts)
    if pv in ordered:
        ordered.remove(pv)
        ordered.insert(0, pv)
    alpha = -INF
    best_val = -INF
    best_mv = ordered[0]
    for mv in ordered:
        v = _minnode(sim, me, opp, mv, depth, alpha, INF, deadline)
        vt = v + rng.random() * 1e-6     # deterministic exact-tie break only
        if vt > best_val:
            best_val = vt
            best_mv = mv
        if v > alpha:
            alpha = v
    return best_mv, best_val


# ===================== move entry point =====================
def _greedy(state, root_opts, rng):
    """1-ply space-control fallback (also used vs >1 opponent)."""
    you = state["you"]
    hx, hy = you["head"]["x"], you["head"]["y"]
    food = bs.nearest_food(state)
    eat = bs.should_eat(state, hunger=60)

    def score(m):
        nx, ny = bs.step(hx, hy, m)
        t = float(bs.reachable_after(state, m))
        if eat and food is not None:
            t += max(0.0, 12.0 - bs.manhattan(nx, ny, food["x"], food["y"])) * 0.6
        return t + rng.random() * 0.01

    return max(root_opts, key=score)


def _decide(state, rng):
    deadline = time.time() + BUDGET
    you = state["you"]
    board = state["board"]

    # Candidate root moves: never self-trapping, never suicidal (falls back safely).
    root_opts = bs.roomy_moves(state)
    if not root_opts:
        root_opts = bs.safe_moves(state)
    if not root_opts:
        # Truly cornered: pick the on-board move with the most reachable space.
        hx, hy = you["head"]["x"], you["head"]["y"]
        w, h = board["width"], board["height"]
        onboard = [m for m in MOVES if bs.in_bounds(*bs.step(hx, hy, m), w, h)]
        root_opts = onboard or ["down"]
        return max(root_opts, key=lambda m: (bs.reachable_after(state, m), rng.random()))

    opps = [s["id"] for s in board["snakes"] if s["id"] != you["id"]]
    if len(opps) != 1:
        return _greedy(state, root_opts, rng)        # solo or >1 opp: degrade

    if len(root_opts) == 1:
        return root_opts[0]

    sim = _snapshot(state)
    me, opp = you["id"], opps[0]

    # Sensible default before any timed search can be cut short.
    best_move = _greedy(state, root_opts, rng)
    pv = best_move
    for depth in range(1, MAX_DEPTH + 1):
        try:
            mv, val = _root(sim, me, opp, root_opts, depth, deadline, rng, pv)
        except _Timeout:
            break
        best_move = mv
        pv = mv
        if val >= WIN or val <= LOSS:        # forced result found; deeper won't help
            break
        if time.time() > deadline:
            break
    return best_move


def move(state, rng):
    try:
        mv = _decide(state, rng)
        if mv in MOVES:
            return mv
    except Exception:
        pass
    # Absolute never-crash fallback.
    try:
        opts = bs.roomy_moves(state) or bs.safe_moves(state)
        if opts:
            return opts[0]
    except Exception:
        pass
    return "down"


if __name__ == "__main__":
    bsserver.serve(info, move)
