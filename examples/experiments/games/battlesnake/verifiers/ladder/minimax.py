#!/usr/bin/env python3
"""Strong 1v1 Battlesnake bot: iterative-deepening alpha-beta MAXIMIN.

Strategy (strictly deeper lookahead than the depth-2 reference):
  * A faithful standard-ruleset simulator (move -> -1 health -> feed -> grow ->
    eliminate, with head-to-head and tail-vacate semantics).
  * Iterative deepening alpha-beta maximin over both snakes' moves. We pick the
    move whose WORST-CASE opponent reply is best, deepening 2 -> 3 -> 4 -> ...
    under a hard wall-clock budget, and returning the best move from the deepest
    fully-evaluated ply (with PV move-ordering carried between iterations so the
    deeper search prunes hard and a time-out still returns a good move).
  * Move ordering: my moves by mobility (the deep-search proxy) plus a 1-ply
    reachable-space ordering at the root; opponent moves "toward my head" first so
    the worst case surfaces early and alpha-beta cuts more.
  * Refined leaf eval: Voronoi area control (mine - theirs), length advantage,
    a hard reachable-space trap penalty for ME and a symmetric trap BONUS when the
    OPPONENT is boxed in, and layered food pull (urgent when starving, plus a pull
    toward length parity so we never fall behind and lose head-to-heads).

Deterministic given the board (only the passed-in `rng` breaks exact ties; the
clock is used ONLY as a search budget guard, never for a move choice). Never
crashes: every risky path is guarded and falls back to bs.roomy_moves/safe_moves.
1v1 focus; degrades to 1-ply Voronoi space control with >1 opponent.
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

# ---- search/eval tuning ----
import os as _os
BUDGET = max(0.02, int(_os.environ.get("BATTLESNAKE_BUDGET_MS","380"))/1000.0)          # wall-clock seconds for the whole search (engine timeout 500ms)
import os as _os2
MAX_DEPTH = int(_os2.environ.get("BATTLESNAKE_MAX_DEPTH","99"))         # iterative deepening cap (time-bounded long before this)
WIN = 1e7
LOSS = -1e7
DRAW = -5000.0         # mutual death: far better than a certain loss, worse than any live eval
AREA_W = 2.0           # per-cell Voronoi area-control weight (mine - theirs)
LEN_W = 18.0           # per-length advantage
TRAP_W = 12.0          # per-cell deficit when reachable space < length (me: penalty, opp: bonus)


def info():
    return {"name": "minimax", "color": "#1f6feb", "head": "smart-caterpillar", "tail": "bolt"}


# --------------------------------------------------------------------------
# Standard-ruleset simulator (1v1). Reused/verified shape from the reference.
# --------------------------------------------------------------------------
def _snapshot(state):
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
    """Apply one full turn (move -> -1 health -> feed -> eliminate) to a COPY."""
    w, h = sim["w"], sim["h"]
    food = set(sim["food"])
    snakes = {sid: {"body": list(s["body"]), "health": s["health"]}
              for sid, s in sim["snakes"].items()}

    for sid, s in snakes.items():
        mv = moves.get(sid)
        if mv is None:
            mv = "up"
        hx, hy = s["body"][0]
        dx, dy = DIRS[mv]
        s["body"] = [(hx + dx, hy + dy)] + s["body"][:-1]
        s["health"] -= 1

    eaten = set()
    for sid, s in snakes.items():
        head = s["body"][0]
        if head in food:
            s["health"] = 100
            s["body"].append(s["body"][-1])
            eaten.add(head)
    food -= eaten

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
        if head in s["body"][1:]:
            dead.add(sid)
            continue
        for oid in ids:
            if oid == sid:
                continue
            o = snakes[oid]
            if head in o["body"][1:]:
                dead.add(sid)
                break
            if head == o["body"][0]:
                if len(s["body"]) <= len(o["body"]):
                    dead.add(sid)
                break
    for sid in dead:
        snakes.pop(sid, None)
    return {"w": w, "h": h, "food": food, "snakes": snakes}


def _occupied(sim):
    """Blocked cells; a snake's tail tip is free unless it just ate (health 100)."""
    blocked = set()
    for s in sim["snakes"].values():
        body = s["body"]
        last = len(body) - 1
        keep_tail = s["health"] == 100
        for i, c in enumerate(body):
            if i == last and not keep_tail:
                continue
            blocked.add(c)
    return blocked


def _voronoi2(sim, me, opp, blocked):
    """Simultaneous multi-source BFS: cells owned by me vs opp (closer wins,
    longer wins distance ties). Returns (mine, theirs)."""
    w, h = sim["w"], sim["h"]
    owner, q = {}, deque()
    for sid, s in sim["snakes"].items():
        head = s["body"][0]
        ln = len(s["body"])
        owner[head] = (sid, 0, ln)
        q.append((head[0], head[1], sid, 0, ln))
    mine = 0
    theirs = 0
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


def _flood(sim, start, cap, blocked):
    """Count empty cells reachable from `start`'s neighbours (capped)."""
    w, h = sim["w"], sim["h"]
    sx, sy = start
    seen = {(sx, sy)}
    q = deque([(sx, sy)])
    count = 0
    while q:
        x, y = q.popleft()
        for mv in MOVES:
            dx, dy = DIRS[mv]
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in blocked and (nx, ny) not in seen:
                seen.add((nx, ny))
                q.append((nx, ny))
                count += 1
                if count >= cap:
                    return count
    return count


# --------------------------------------------------------------------------
# Leaf evaluation
# --------------------------------------------------------------------------
def _evaluate(sim, me, opp):
    snakes = sim["snakes"]
    s = snakes[me]
    o = snakes[opp]
    blocked = _occupied(sim)

    mine, theirs = _voronoi2(sim, me, opp, blocked)
    len_me = len(s["body"])
    len_opp = len(o["body"])
    s_head = s["body"][0]
    o_head = o["body"][0]
    health = s["health"]

    score = (mine - theirs) * AREA_W
    score += (len_me - len_opp) * LEN_W

    # Hard trap detection: if we can't reach as many cells as our own length we
    # are getting boxed in and will die soon. Symmetric bonus for trapping them.
    my_reach = _flood(sim, s_head, len_me + 2, blocked)
    if my_reach <= len_me:
        score -= (len_me - my_reach + 1) * TRAP_W
    opp_reach = _flood(sim, o_head, len_opp + 2, blocked)
    if opp_reach <= len_opp:
        score += (len_opp - opp_reach + 1) * TRAP_W

    # Food: urgent pull when starving; pull to length parity so we never fall
    # behind (shorter snakes lose every head-to-head); mild top-up otherwise.
    if sim["food"]:
        hx, hy = s_head
        fd = min(abs(fx - hx) + abs(fy - hy) for fx, fy in sim["food"])
        if health < 35:
            score += max(0, 25 - fd) * (35 - health) * 0.15
        if len_me <= len_opp:
            score += max(0, 11 - fd) * 1.8
        elif health < 60:
            score += max(0, 6 - fd) * 0.5

    return score


# --------------------------------------------------------------------------
# Move ordering helpers (operate on a sim state)
# --------------------------------------------------------------------------
def _my_order(sim, sid, blocked, heads):
    """Non-fatal moves for `sid`, ordered by mobility (free neighbours) desc.
    Keeps moves onto opponent head cells (potential head-to-head)."""
    s = sim["snakes"][sid]
    hx, hy = s["body"][0]
    w, h = sim["w"], sim["h"]
    out = []
    for mv in MOVES:
        dx, dy = DIRS[mv]
        nx, ny = hx + dx, hy + dy
        if not (0 <= nx < w and 0 <= ny < h):
            continue
        if (nx, ny) in blocked and (nx, ny) not in heads:
            continue
        free = 0
        for mv2 in MOVES:
            ax, ay = nx + DIRS[mv2][0], ny + DIRS[mv2][1]
            if 0 <= ax < w and 0 <= ay < h and (ax, ay) not in blocked:
                free += 1
        out.append((-free, mv))
    if not out:
        for mv in MOVES:
            dx, dy = DIRS[mv]
            nx, ny = hx + dx, hy + dy
            if 0 <= nx < w and 0 <= ny < h:
                out.append((0, mv))
        if not out:
            return list(MOVES)
    out.sort(key=lambda t: t[0])
    return [m for _, m in out]


def _opp_order(sim, opp, my_head, blocked, heads):
    """Non-fatal opponent moves, ordered by closeness to MY head (most
    threatening first) so the worst case surfaces early for better pruning."""
    s = sim["snakes"][opp]
    ox, oy = s["body"][0]
    w, h = sim["w"], sim["h"]
    mx, my = my_head
    out = []
    for mv in MOVES:
        dx, dy = DIRS[mv]
        nx, ny = ox + dx, oy + dy
        if not (0 <= nx < w and 0 <= ny < h):
            continue
        if (nx, ny) in blocked and (nx, ny) not in heads:
            continue
        out.append((abs(nx - mx) + abs(ny - my), mv))
    if not out:
        for mv in MOVES:
            dx, dy = DIRS[mv]
            nx, ny = ox + dx, oy + dy
            if 0 <= nx < w and 0 <= ny < h:
                out.append((0, mv))
        if not out:
            return list(MOVES)
    out.sort(key=lambda t: t[0])
    return [m for _, m in out]


# --------------------------------------------------------------------------
# Alpha-beta maximin
# --------------------------------------------------------------------------
class _Timeout(Exception):
    pass


def _value(sim, me, opp, depth, alpha, beta, deadline):
    if time.time() > deadline:
        raise _Timeout
    snakes = sim["snakes"]
    me_alive = me in snakes
    opp_alive = opp in snakes
    if not me_alive and not opp_alive:
        return DRAW
    if not me_alive:
        return LOSS - depth          # die as LATE as possible
    if not opp_alive:
        return WIN + depth           # win as SOON as possible
    if depth <= 0:
        return _evaluate(sim, me, opp)

    blocked = _occupied(sim)
    heads = {ss["body"][0] for ss in snakes.values()}
    my_head = snakes[me]["body"][0]
    my_moves = _my_order(sim, me, blocked, heads)
    opp_moves = _opp_order(sim, opp, my_head, blocked, heads)

    best = -INF
    for mv in my_moves:
        worst = INF
        b = beta                     # min-node tightening bound
        for omv in opp_moves:
            ns = _step(sim, {me: mv, opp: omv})
            v = _value(ns, me, opp, depth - 1, alpha, b, deadline)
            if v < worst:
                worst = v
                if worst < b:
                    b = worst
                if alpha >= b:        # min-node cutoff
                    break
        if worst > best:
            best = worst
            if best > alpha:
                alpha = best
            if alpha >= beta:         # max-node cutoff
                break
    return best


def _root(sim, me, opp, depth, order, deadline):
    """Top max node. Returns (best_move, best_val, scored, aborted) where scored
    is a list of (worst, move, fully_evaluated)."""
    best = -INF
    best_move = None
    alpha = -INF
    scored = []
    aborted = False
    blocked = _occupied(sim)
    heads = {ss["body"][0] for ss in sim["snakes"].values()}
    my_head = sim["snakes"][me]["body"][0]
    opp_moves = _opp_order(sim, opp, my_head, blocked, heads)
    for mv in order:
        if time.time() > deadline:
            aborted = True
            break
        try:
            worst = INF
            b = INF
            full = True
            for omv in opp_moves:
                ns = _step(sim, {me: mv, opp: omv})
                v = _value(ns, me, opp, depth - 1, alpha, b, deadline)
                if v < worst:
                    worst = v
                    if worst < b:
                        b = worst
                    if alpha >= b:    # this move can't beat best; cut (upper bound only)
                        full = False
                        break
        except _Timeout:
            aborted = True
            break
        scored.append((worst, mv, full))
        if worst > best:
            best = worst
            best_move = mv
            if best > alpha:
                alpha = best
    return best_move, best, scored, aborted


# --------------------------------------------------------------------------
# >1 opponent / solo fallback: 1-ply Voronoi space control
# --------------------------------------------------------------------------
def _voronoi_owned(state, my_head_after):
    board = state["board"]
    w, h = board["width"], board["height"]
    you_id = state["you"]["id"]
    blocked = bs.occupied(board)
    sources = [("me", my_head_after, len(state["you"]["body"]))]
    for s in board["snakes"]:
        if s["id"] != you_id:
            sources.append((s["id"], (s["head"]["x"], s["head"]["y"]), len(s["body"])))
    owner, q = {}, deque()
    for sid, (sx, sy), ln in sources:
        if not bs.in_bounds(sx, sy, w, h):
            continue
        prev = owner.get((sx, sy))
        if prev is None or (0, -ln) < (prev[1], -prev[2]):
            owner[(sx, sy)] = (sid, 0, ln)
            q.append((sx, sy, sid, 0, ln))
    mine = 0
    while q:
        x, y, sid, d, ln = q.popleft()
        if owner.get((x, y)) != (sid, d, ln):
            continue
        if sid == "me":
            mine += 1
        for mv in MOVES:
            nx, ny = bs.step(x, y, mv)
            if not bs.in_bounds(nx, ny, w, h) or (nx, ny) in blocked:
                continue
            prev = owner.get((nx, ny))
            if prev is None or (d + 1, -ln) < (prev[1], -prev[2]):
                owner[(nx, ny)] = (sid, d + 1, ln)
                q.append((nx, ny, sid, d + 1, ln))
    return mine


def _fallback_move(state, rng, options):
    you = state["you"]
    hx, hy = you["head"]["x"], you["head"]["y"]
    food = bs.nearest_food(state)
    eat = bs.should_eat(state, hunger=60)

    def score(m):
        nx, ny = bs.step(hx, hy, m)
        v = float(_voronoi_owned(state, (nx, ny)))
        v += bs.reachable_after(state, m) * 0.25
        if eat and food is not None:
            v += max(0, 12 - bs.manhattan(nx, ny, food["x"], food["y"])) * 0.6
        return v + rng.random() * 0.001

    return max(options, key=score)


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------
def _decide(state, rng):
    start = time.time()
    deadline = start + BUDGET
    you = state["you"]
    board = state["board"]
    opps = [s for s in board["snakes"] if s["id"] != you["id"]]

    safe = bs.safe_moves(state)
    roomy = bs.roomy_moves(state, safe)
    fallback_list = roomy or safe or list(MOVES)
    fallback = fallback_list[0]

    # Not a clean 1v1: degrade to 1-ply Voronoi space control.
    if len(opps) != 1:
        options = roomy or safe
        if not options:
            return fallback
        try:
            return _fallback_move(state, rng, options)
        except Exception:
            return fallback

    me = you["id"]
    opp = opps[0]["id"]
    sim = _snapshot(state)
    if me not in sim["snakes"] or opp not in sim["snakes"]:
        return fallback

    # Initial candidate moves + ordering (1-ply reachable space, roomy first).
    blocked0 = _occupied(sim)
    heads0 = {ss["body"][0] for ss in sim["snakes"].values()}
    cands = _my_order(sim, me, blocked0, heads0)
    if not cands:
        return fallback
    roomy_set = set(roomy)
    cands.sort(key=lambda m: (m not in roomy_set, -bs.reachable_after(state, m)))
    order = cands

    best_move = fallback if fallback in cands else cands[0]
    depth = 2
    while depth <= MAX_DEPTH:
        if time.time() > deadline:
            break
        bm, bv, scored, aborted = _root(sim, me, opp, depth, order, deadline)
        if bm is not None:
            ties = [m for (w, m, f) in scored if f and w == bv]
            best_move = rng.choice(ties) if ties else bm
        if aborted:
            break
        scored.sort(key=lambda t: -t[0])
        nxt = [m for (w, m, f) in scored]
        for m in cands:
            if m not in nxt:
                nxt.append(m)
        order = nxt
        depth += 1
    return best_move


def move(state, rng):
    try:
        mv = _decide(state, rng)
        if mv in MOVES:
            return mv
    except Exception:
        pass
    try:
        opts = bs.roomy_moves(state) or bs.safe_moves(state)
        if opts:
            return opts[0]
    except Exception:
        pass
    return "up"


if __name__ == "__main__":
    bsserver.serve(info, move)
