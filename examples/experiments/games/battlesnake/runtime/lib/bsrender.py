#!/usr/bin/env python3
"""Render a Battlesnake game (the engine's --output JSONL) to an animated GIF.

Our own renderer (the official `board`/`exporter` are AGPL and need a browser or
the live engine API). Pillow-only, fully offline, deterministic: flat fills, a
bundled default font, supersampled 2x for smooth rounded snakes.

Coordinate origin (0,0) is BOTTOM-LEFT, so board row y is drawn at image
row (height-1-y).

CLI:  python bsrender.py game.jsonl out.gif [--cell 34] [--ms 120]
"""
import json
import sys

from PIL import Image, ImageDraw, ImageFont

# palette
BG = (24, 27, 34)
PANEL = (33, 37, 46)
EMPTY = (44, 49, 60)
GRID = (33, 37, 46)
FOOD = (255, 92, 117)
TEXT = (235, 238, 242)
SUBTEXT = (150, 158, 170)
FALLBACK_COLORS = ["#3aa3ff", "#ff5c75", "#1fd1a5", "#f4c20d", "#b15cff",
                   "#ff8a3a", "#4be0c0", "#ff5cc7"]

SS = 2  # supersample factor


def _hex(c):
    c = (c or "").lstrip("#")
    if len(c) != 6:
        return (136, 136, 136)
    try:
        return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return (136, 136, 136)


def _lighten(rgb, f=0.4):
    return tuple(int(c + (255 - c) * f) for c in rgb)


def _darken(rgb, f=0.35):
    return tuple(int(c * (1 - f)) for c in rgb)


def _font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def _color_dist(a, b):
    return sum((x - y) ** 2 for x, y in zip(a, b)) ** 0.5


# Minimum RGB-euclidean separation between any two snakes in a replay. Two bots
# can independently pick near-identical colors (e.g. an agent whose info() color
# happens to match a reference snake's), which renders them indistinguishable.
_MIN_COLOR_DIST = 90.0


def _snake_colors(frames):
    """A VISUALLY DISTINCT color per snake id. Each snake keeps its chosen color
    unless it is missing/default OR clashes with a snake already placed in this
    replay; on a clash we substitute the fallback color farthest from every color
    already used, so every snake is easy to tell apart no matter what the bots
    picked."""
    chosen, order = {}, []
    for fr in frames:
        for s in fr["board"]["snakes"]:
            if s["id"] not in chosen:
                order.append(s["id"])
                c = s.get("customizations", {}).get("color")
                chosen[s["id"]] = _hex(c) if c and c != "#888888" else None
    palette = [_hex(c) for c in FALLBACK_COLORS]
    colors, used = {}, []
    for sid in order:
        col = chosen[sid]
        if col is None or any(_color_dist(col, u) < _MIN_COLOR_DIST for u in used):
            # the fallback maximizing the minimum distance to colors already used
            col = max(palette, key=lambda p: min((_color_dist(p, u) for u in used), default=1e9))
        colors[sid] = col
        used.append(col)
    return colors


def _names(frames):
    names = {}
    for fr in frames:
        for s in fr["board"]["snakes"]:
            names[s["id"]] = s["name"]
    return names


def _downsample(frames, max_frames):
    """Evenly thin a long game down to ~max_frames, always keeping the first and
    last frame, so a 200-turn game still produces a small, embeddable GIF."""
    n = len(frames)
    if max_frames <= 0 or n <= max_frames:
        return frames
    step = n / max_frames
    idx = sorted({int(i * step) for i in range(max_frames)} | {0, n - 1})
    return [frames[i] for i in idx]


def _wrap_entries(draw, entries, font, max_w, sep="    "):
    """Greedily pack "name: value" entries onto lines no wider than max_w."""
    lines, cur = [], ""
    for e in entries:
        trial = e if not cur else cur + sep + e
        if not cur or draw.textlength(trial, font=font) <= max_w:
            cur = trial
        else:
            lines.append(cur)
            cur = e
    if cur:
        lines.append(cur)
    return lines


def render_gif(frames, out_path, cell=34, ms=120, title=None, max_frames=140, scores=None):
    if not frames:
        raise ValueError("no frames to render")
    frames = _downsample(frames, max_frames)
    W = frames[0]["board"]["width"]
    H = frames[0]["board"]["height"]
    colors = _snake_colors(frames)
    names = _names(frames)
    ids = list(names.keys())

    s = SS
    pad = cell
    header = cell * 2
    legend_row = int(cell * 0.62)
    score_row = int(cell * 0.52)
    board_w = W * cell
    board_h = H * cell
    img_w = board_w + pad * 2

    # measurement draw (canvas scale) to fit the title + wrap the scores line
    _m = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    avail = (img_w - 2 * pad) * s
    f_small = _font(int(cell * 0.5))

    # fit the title so a long "Battlesnake run <run-id>" stays on one line
    ttl = title or "Battlesnake"
    tsize = int(cell * 0.85)
    while tsize > int(cell * 0.45) and _m.textlength(ttl, font=_font(tsize)) > avail:
        tsize -= 1
    f_turn = _font(tsize)

    # wrap the scores ("name: value" pairs) onto lines that fit
    score_lines = _wrap_entries(_m, [f"{n}: {v}" for n, v in scores], f_small, avail) \
        if scores else []

    legend = int(cell * 0.3) + len(ids) * legend_row
    score_block = (int(cell * 0.32) + len(score_lines) * score_row) if score_lines else 0
    img_h = header + board_h + legend + score_block + int(cell * 0.4)

    cw, ch = img_w * s, img_h * s
    cs = cell * s

    def cell_xy(x, y):
        # board (x,y) -> top-left pixel of cell on supersampled canvas
        px = (pad + x * cell) * s
        py = (header + (H - 1 - y) * cell) * s
        return px, py

    frames_out = []
    for fr in frames:
        im = Image.new("RGB", (cw, ch), BG)
        d = ImageDraw.Draw(im)

        # header: turn counter
        turn = fr["turn"]
        ttl = title or "Battlesnake"
        d.text((pad * s, int(pad * 0.4) * s), ttl, fill=TEXT, font=f_turn)
        d.text((pad * s, int(pad * 0.4 + cell * 0.95) * s), f"turn {turn}",
               fill=SUBTEXT, font=f_small)

        # board background panel (rounded)
        bx0, by0 = pad * s, header * s
        bx1, by1 = (pad + board_w) * s, (header + board_h) * s
        d.rounded_rectangle([bx0 - 4 * s, by0 - 4 * s, bx1 + 4 * s, by1 + 4 * s],
                            radius=6 * s, fill=PANEL)

        # empty cells
        gap = max(1, int(cell * 0.06)) * s
        rad = int(cs * 0.22)
        for y in range(H):
            for x in range(W):
                px, py = cell_xy(x, y)
                d.rounded_rectangle([px + gap, py + gap, px + cs - gap, py + cs - gap],
                                    radius=rad, fill=EMPTY)

        # hazards
        for hz in fr["board"].get("hazards", []):
            px, py = cell_xy(hz["x"], hz["y"])
            d.rounded_rectangle([px + gap, py + gap, px + cs - gap, py + cs - gap],
                                radius=rad, fill=_darken(EMPTY, 0.4))

        # food
        for fd in fr["board"].get("food", []):
            px, py = cell_xy(fd["x"], fd["y"])
            cx, cy = px + cs // 2, py + cs // 2
            r = int(cs * 0.30)
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=FOOD)
            d.ellipse([cx - r // 3, cy - r // 3, cx + r // 6, cy + r // 6],
                      fill=_lighten(FOOD, 0.5))

        # snakes
        for sk in fr["board"]["snakes"]:
            col = colors[sk["id"]]
            body = sk["body"]
            seg_r = int(cs * 0.30)
            inset = int(cs * 0.16)
            # connective body
            for i, c in enumerate(body):
                px, py = cell_xy(c["x"], c["y"])
                shade = col if i == 0 else (_darken(col, 0.10) if i % 2 else col)
                d.rounded_rectangle([px + inset, py + inset, px + cs - inset, py + cs - inset],
                                    radius=seg_r, fill=shade)
                # bridge to previous segment so the body reads continuous
                if i > 0:
                    pc = body[i - 1]
                    ppx, ppy = cell_xy(pc["x"], pc["y"])
                    mx0 = min(px, ppx) + inset
                    my0 = min(py, ppy) + inset
                    mx1 = max(px, ppx) + cs - inset
                    my1 = max(py, ppy) + cs - inset
                    d.rectangle([mx0, my0, mx1, my1], fill=col)
            # head with eyes, oriented by neck
            hx, hy = body[0]["x"], body[0]["y"]
            px, py = cell_xy(hx, hy)
            d.rounded_rectangle([px + inset, py + inset, px + cs - inset, py + cs - inset],
                                radius=seg_r, fill=_lighten(col, 0.12))
            dx, dy = 0, 0
            if len(body) > 1:
                dx = hx - body[1]["x"]
                dy = hy - body[1]["y"]
                if dx == 0 and dy == 0:
                    dy = 1
            else:
                dy = 1
            eye_r = max(2, int(cs * 0.10))
            cx, cy = px + cs // 2, py + cs // 2
            off = int(cs * 0.18)
            perp = (off, 0) if dy != 0 else (0, off)
            fwd = (int(dx * off * 0.6), int(-dy * off * 0.6))
            for sgn in (1, -1):
                ex = cx + sgn * perp[0] + fwd[0]
                ey = cy + sgn * perp[1] + fwd[1]
                d.ellipse([ex - eye_r, ey - eye_r, ex + eye_r, ey + eye_r], fill=(245, 245, 245))
                d.ellipse([ex - eye_r // 2, ey - eye_r // 2, ex + eye_r // 2, ey + eye_r // 2],
                          fill=(20, 20, 20))

        # legend: one row per snake (swatch + name + length + HP), stacked
        # vertically so long agent labels fit on any board.
        lx = pad * s
        ly0 = (header + board_h + int(cell * 0.3)) * s
        alive_ids = {s["id"] for s in fr["board"]["snakes"]}
        sw = int(cell * 0.42) * s
        for i, sid in enumerate(ids):
            ly = ly0 + i * legend_row * s
            col = colors[sid]
            alive = sid in alive_ids
            swatch = col if alive else _darken(col, 0.55)
            d.rounded_rectangle([lx, ly, lx + sw, ly + sw], radius=int(sw * 0.3), fill=swatch)
            sk = next((s for s in fr["board"]["snakes"] if s["id"] == sid), None)
            if sk is not None:
                label = f"{names[sid]}   L{sk['length']}  HP{sk['health']}"
            else:
                label = f"{names[sid]}   (dead)"
            d.text((lx + sw + int(cell * 0.25) * s, ly + int(sw * 0.05)), label,
                   fill=TEXT if alive else SUBTEXT, font=f_small)

        # scores line(s) below the player names: "name: value   name: value ..."
        if score_lines:
            sy = ly0 + len(ids) * legend_row * s + int(cell * 0.18) * s
            for ln in score_lines:
                d.text((lx, sy), ln, fill=TEXT, font=f_small)
                sy += score_row * s

        frames_out.append(im.resize((img_w, img_h), Image.LANCZOS))

    durations = [ms] * len(frames_out)
    durations[-1] = ms * 12  # linger on the final frame
    frames_out[0].save(out_path, save_all=True, append_images=frames_out[1:],
                       duration=durations, loop=0, disposal=2, optimize=True)
    return out_path


def load_frames(jsonl_path):
    frames = []
    with open(jsonl_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if "board" in obj and "turn" in obj:
                frames.append(obj)
    return frames


def main(argv):
    if len(argv) < 3:
        print("usage: bsrender.py game.jsonl out.gif [--cell N] [--ms N] [--title T]")
        return 2
    src, out = argv[1], argv[2]
    cell, ms, title = 34, 120, None
    i = 3
    while i < len(argv):
        if argv[i] == "--cell":
            cell = int(argv[i + 1]); i += 2
        elif argv[i] == "--ms":
            ms = int(argv[i + 1]); i += 2
        elif argv[i] == "--title":
            title = argv[i + 1]; i += 2
        else:
            i += 1
    frames = load_frames(src)
    render_gif(frames, out, cell=cell, ms=ms, title=title)
    print(f"wrote {out} ({len(frames)} frames)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
