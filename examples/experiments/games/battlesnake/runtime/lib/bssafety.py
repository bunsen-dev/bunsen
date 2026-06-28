"""Shared Battlesnake board helpers used by the bundled reference snakes.

Implements the standard ruleset's geometry and "don't die" safety filter:
coordinate origin (0,0) is the BOTTOM-LEFT cell, +y is up, so
  up=(x,y+1)  down=(x,y-1)  left=(x-1,y)  right=(x+1,y)

These helpers are deliberately dependency-free (stdlib only) so a reference
snake is a single small file plus this module.
"""
from collections import deque

DIRS = {"up": (0, 1), "down": (0, -1), "left": (-1, 0), "right": (1, 0)}
MOVES = ("up", "down", "left", "right")


def step(x, y, mv):
    dx, dy = DIRS[mv]
    return x + dx, y + dy


def in_bounds(x, y, w, h):
    return 0 <= x < w and 0 <= y < h


def _just_ate(snake):
    """A snake's tail stays put for one turn after eating (doubled tail), so the
    tail cell is NOT safe to enter that turn."""
    body = snake["body"]
    if snake.get("health") == 100 and snake.get("length", len(body)) > 3:
        return True
    return len(body) >= 2 and body[-1] == body[-2]


def occupied(board, ignore_moving_tails=True):
    """Set of (x,y) cells blocked by snake bodies this turn.

    By default a snake's tail tip is treated as free (it will vacate), except
    for snakes that just ate (their tail does not move)."""
    blocked = set()
    for s in board["snakes"]:
        body = s["body"]
        last = len(body) - 1
        keep_tail = (not ignore_moving_tails) or _just_ate(s)
        for i, c in enumerate(body):
            if i == last and not keep_tail:
                continue
            blocked.add((c["x"], c["y"]))
    return blocked


def opponent_head_threats(state, my_len):
    """Cells an equal-or-longer opponent could move into next turn (head-to-head
    we'd lose or tie). Returns set of (x,y)."""
    you_id = state["you"]["id"]
    board = state["board"]
    w, h = board["width"], board["height"]
    threats = set()
    for s in board["snakes"]:
        if s["id"] == you_id:
            continue
        if len(s["body"]) < my_len:
            continue  # we'd win this head-to-head
        hx, hy = s["head"]["x"], s["head"]["y"]
        for mv in MOVES:
            nx, ny = step(hx, hy, mv)
            if in_bounds(nx, ny, w, h):
                threats.add((nx, ny))
    return threats


def safe_moves(state, avoid_h2h=True):
    """The standard safety filter: legal, non-suicidal moves from the current head."""
    you = state["you"]
    board = state["board"]
    w, h = board["width"], board["height"]
    hx, hy = you["head"]["x"], you["head"]["y"]
    blocked = occupied(board)
    threats = opponent_head_threats(state, len(you["body"])) if avoid_h2h else set()
    safe, risky = [], []
    for mv in MOVES:
        nx, ny = step(hx, hy, mv)
        if not in_bounds(nx, ny, w, h):
            continue
        if (nx, ny) in blocked:
            continue
        if (nx, ny) in threats:
            risky.append(mv)  # legal but a stronger head could trade with us
            continue
        safe.append(mv)
    # Prefer fully-safe moves; fall back to head-to-head-risky ones before dying.
    return safe if safe else risky


def flood_fill(start, board, blocked=None, cap=None):
    """Count empty cells reachable from `start` (4-connected), treating snake
    bodies as walls. Used for space-control evaluation."""
    w, h = board["width"], board["height"]
    if blocked is None:
        blocked = occupied(board)
    sx, sy = start
    if not in_bounds(sx, sy, w, h) or (sx, sy) in blocked:
        return 0
    seen = {(sx, sy)}
    q = deque([(sx, sy)])
    count = 0
    while q:
        x, y = q.popleft()
        count += 1
        if cap and count >= cap:
            break
        for mv in MOVES:
            nx, ny = step(x, y, mv)
            if in_bounds(nx, ny, w, h) and (nx, ny) not in blocked and (nx, ny) not in seen:
                seen.add((nx, ny))
                q.append((nx, ny))
    return count


def reachable_after(state, mv):
    """Flood-fill space available if we take move `mv` (head advances one cell).

    After the move our current head cell becomes the neck and stays occupied —
    only the tail vacates, which `occupied()` already frees — so we must NOT free
    the head cell here (doing so lets the fill leak back through our own body and
    over-counts space, rating a self-trap as roomy)."""
    you = state["you"]
    board = state["board"]
    hx, hy = you["head"]["x"], you["head"]["y"]
    nx, ny = step(hx, hy, mv)
    blocked = occupied(board)
    return flood_fill((nx, ny), board, blocked)


def nearest_food(state, frm=None):
    board = state["board"]
    foods = board.get("food", [])
    if not foods:
        return None
    if frm is None:
        frm = (state["you"]["head"]["x"], state["you"]["head"]["y"])
    fx, fy = frm
    return min(foods, key=lambda f: abs(f["x"] - fx) + abs(f["y"] - fy))


def manhattan(ax, ay, bx, by):
    return abs(ax - bx) + abs(ay - by)


def max_opponent_length(state):
    you_id = state["you"]["id"]
    lens = [len(s["body"]) for s in state["board"]["snakes"] if s["id"] != you_id]
    return max(lens) if lens else 0


def roomy_moves(state, options=None):
    """Of the given safe moves, keep those that don't trap us (reachable space >=
    our length); fall back to all options if none qualify, ordered by space."""
    you = state["you"]
    my_len = len(you["body"])
    if options is None:
        options = safe_moves(state)
    if not options:
        return []
    spaced = [(m, reachable_after(state, m)) for m in options]
    roomy = [m for m, sp in spaced if sp >= my_len]
    if roomy:
        return roomy
    spaced.sort(key=lambda t: -t[1])
    return [m for m, _ in spaced]


def should_eat(state, hunger=70):
    """Eat when health is getting low OR when we're not the longest snake
    (length advantage decides head-to-heads)."""
    you = state["you"]
    return you["health"] < hunger or len(you["body"]) <= max_opponent_length(state)
