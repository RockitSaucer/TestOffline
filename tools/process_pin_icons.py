"""Isolate pin glyphs from HuntApp Layers naked JPGs → clean transparent PNGs.

CANONICAL PROCEDURE for new hunt-app / TestOffline map pins:
  docs/PIN_AND_TOOL_ICONS.md  (and TestOffline/AGENTS.md)

Aggressive white/background removal:
  1) Flood-fill from image edges (any light / near-bg fringe)
  2) Global pass: kill remaining high-luminance, low-saturation pixels
  3) Crop tight, fit square with almost no padding so glyphs can fill the pin

After running this script, update PIN_ICON_CATALOG in index.html from
icons/pins/_catalog.json and bump sw.js SHELL_CACHE.
"""
from __future__ import annotations

import json
import re
from collections import deque
from pathlib import Path

from PIL import Image, ImageFilter

SRC_DIR = Path(r"C:\Users\Rockit\Desktop\HuntApp\button icons\Layers naked")
OUT_DIR = Path(r"C:\Users\Rockit\Desktop\TestOffline\icons\pins")


def slugify(name: str) -> str:
    n = Path(name).stem.strip()
    n = re.sub(r"[\s\-]+", "_", n)
    n = re.sub(r"[^A-Za-z0-9_]", "", n)
    n = n.lower()
    if n == "dead_head":
        n = "deadhead"
    return n


def display_name(name: str) -> str:
    return re.sub(r"\s+", " ", Path(name).stem.strip())


def lum(r: int, g: int, b: int) -> float:
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def sat(r: int, g: int, b: int) -> int:
    return max(r, g, b) - min(r, g, b)


def is_bg_pixel(r: int, g: int, b: int, *, strict: bool = False) -> bool:
    """True for white / near-white / washed paper backgrounds (not saturated subjects)."""
    L = lum(r, g, b)
    S = sat(r, g, b)
    mn = min(r, g, b)
    # Pure / near white
    if mn >= 232 and S < 40:
        return True
    if L >= 245 and S < 50:
        return True
    # Light gray paper (JPEG AA around white)
    if L >= 220 and S < 28:
        return True
    if not strict and L >= 200 and S < 18:
        return True
    # Very light with mild warm cast
    if L >= 235 and S < 55 and mn >= 210:
        return True
    return False


def flood_clear_bg(im: Image.Image) -> Image.Image:
    """Flood from edges: mark connected background as transparent."""
    im = im.convert("RGBA")
    w, h = im.size
    px = im.load()
    visited = [[False] * w for _ in range(h)]
    q: deque[tuple[int, int]] = deque()

    def try_seed(x: int, y: int) -> None:
        if x < 0 or y < 0 or x >= w or y >= h or visited[y][x]:
            return
        r, g, b, a = px[x, y]
        # Seed on light bg OR very dark JPEG corners that are still "empty frame"
        # (some sources have dark corner pixels from compression — only seed if
        # neighbors are mostly light, handled by flood of light only)
        if is_bg_pixel(r, g, b, strict=False):
            visited[y][x] = True
            q.append((x, y))

    for x in range(w):
        try_seed(x, 0)
        try_seed(x, h - 1)
    for y in range(h):
        try_seed(0, y)
        try_seed(w - 1, y)

    # Also seed a ring just inside the border for padded frames
    for x in range(w):
        for y in (1, 2, h - 2, h - 3):
            if 0 <= y < h:
                try_seed(x, y)
    for y in range(h):
        for x in (1, 2, w - 2, w - 3):
            if 0 <= x < w:
                try_seed(x, y)

    while q:
        x, y = q.popleft()
        px[x, y] = (0, 0, 0, 0)
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if nx < 0 or ny < 0 or nx >= w or ny >= h or visited[ny][nx]:
                continue
            r, g, b, a = px[nx, ny]
            if is_bg_pixel(r, g, b, strict=False):
                visited[ny][nx] = True
                q.append((nx, ny))
            else:
                visited[ny][nx] = True  # stop at subject; don't re-check
    return im


def global_clear_light(im: Image.Image) -> Image.Image:
    """Second pass: remove remaining isolated white pockets + soft fringes."""
    im = im.convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            L = lum(r, g, b)
            S = sat(r, g, b)
            # Kill remaining white/light gray blobs inside the crop
            if is_bg_pixel(r, g, b, strict=False):
                px[x, y] = (0, 0, 0, 0)
                continue
            # Soften pale anti-alias fringe on silhouettes (near white-ish gray)
            if L >= 185 and S < 22:
                # Fade rather than hard-cut mid grays that may be soft edges of black
                # Only fully clear if very light
                if L >= 210:
                    px[x, y] = (0, 0, 0, 0)
                else:
                    # map L 185..210 → alpha 255..0 for residual gray AA
                    alpha = int(max(0, min(255, (210 - L) * (255 / 25))))
                    # keep dark channel for silhouette continuity
                    px[x, y] = (r, g, b, alpha)
            # Blood / color: fade only near-white highlights that are bg
            elif L >= 248 and S < 60:
                px[x, y] = (0, 0, 0, 0)
    return im


def harden_silhouette(im: Image.Image) -> Image.Image:
    """For mostly black art: force near-black opaque, wipe residual pale."""
    px = list(im.getdata())
    dark = pale = color = 0
    for r, g, b, a in px:
        if a < 20:
            continue
        L = lum(r, g, b)
        S = sat(r, g, b)
        if S >= 40 and L < 230:
            color += 1
        elif L < 90:
            dark += 1
        elif L > 180:
            pale += 1
    total = dark + pale + color
    if total < 10:
        return im
    # Colored subject (blood) — leave as-is after flood/global
    if color > total * 0.12:
        return im
    # Monochrome silhouette — re-encode: alpha from darkness
    out = im.copy()
    opx = out.load()
    w, h = out.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = opx[x, y]
            if a == 0:
                continue
            L = lum(r, g, b)
            S = sat(r, g, b)
            if L >= 200 and S < 30:
                opx[x, y] = (0, 0, 0, 0)
                continue
            # Map darkness → alpha; pure black solid
            if L <= 30:
                opx[x, y] = (0, 0, 0, 255)
            elif L >= 190:
                opx[x, y] = (0, 0, 0, 0)
            else:
                # mid AA: keep dark RGB, alpha from how dark
                alpha = int(max(0, min(255, (190 - L) * (255 / 160))))
                # darken residual gray fringes so they don't read as white box
                nr = min(r, 40)
                ng = min(g, 40)
                nb = min(b, 40)
                opx[x, y] = (nr, ng, nb, alpha)
    return out


def crop_alpha(im: Image.Image, pad: int = 1) -> Image.Image:
    bbox = im.getbbox()
    if not bbox:
        return im
    w, h = im.size
    l = max(0, bbox[0] - pad)
    t = max(0, bbox[1] - pad)
    r = min(w, bbox[2] + pad)
    b = min(h, bbox[3] + pad)
    return im.crop((l, t, r, b))


def to_square(im: Image.Image, size: int = 128, pad_ratio: float = 0.02) -> Image.Image:
    """Fit content nearly edge-to-edge so glyphs can fill the pin disc."""
    cw, ch = im.size
    if cw <= 0 or ch <= 0:
        return Image.new("RGBA", (size, size), (0, 0, 0, 0))
    content = max(cw, ch)
    pad = max(1, int(content * pad_ratio))
    side = content + pad * 2
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    ox = (side - cw) // 2
    oy = (side - ch) // 2
    canvas.paste(im, (ox, oy), im)
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def dominant_color(im: Image.Image) -> str:
    opaque = []
    for r, g, b, a in im.getdata():
        if a < 40:
            continue
        if r > 240 and g > 240 and b > 240:
            continue
        S = sat(r, g, b)
        L = lum(r, g, b)
        weight = max(1, a) * (1 + S / 40.0) * (1.5 if L < 80 else 0.6)
        opaque.append((r, g, b, S, L, weight))
    if not opaque:
        return "#1a1a1a"
    tw = sum(x[5] for x in opaque)
    r = int(sum(x[0] * x[5] for x in opaque) / tw)
    g = int(sum(x[1] * x[5] for x in opaque) / tw)
    b = int(sum(x[2] * x[5] for x in opaque) / tw)
    avg_sat = sum(x[3] * x[5] for x in opaque) / tw
    avg_lum = sum(x[4] * x[5] for x in opaque) / tw
    if avg_sat < 35 and avg_lum < 140:
        return "#1a1a1a"
    if r < 45 and g < 45 and b < 45:
        return "#1a1a1a"
    return f"#{r:02x}{g:02x}{b:02x}"


def process_one(path: Path) -> tuple[Image.Image, str]:
    im = Image.open(path)
    # Slight blur doesn't help; work at native res then upscale
    im = flood_clear_bg(im)
    im = global_clear_light(im)
    im = harden_silhouette(im)
    # One more flood in case global opened holes to edge
    im = flood_clear_bg(im)
    im = crop_alpha(im, pad=1)
    # Despeckle lone semi-transparent pixels
    im = im.filter(ImageFilter.MaxFilter(3)) if False else im
    squared = to_square(im, 128, pad_ratio=0.02)
    color = dominant_color(squared)
    return squared, color


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    files = []
    for pat in ("*.JPG", "*.jpg", "*.PNG", "*.png"):
        files.extend(sorted(SRC_DIR.glob(pat)))
    seen = set()
    catalog = []
    for f in files:
        sid = slugify(f.name)
        if sid in seen:
            continue
        seen.add(sid)
        squared, color = process_one(f)
        out = OUT_DIR / f"{sid}.png"
        squared.save(out, "PNG", optimize=True)
        name = display_name(f.name)
        catalog.append(
            {
                "id": sid,
                "name": name,
                "src": f"icons/pins/{sid}.png",
                "defaultColor": color,
            }
        )
        # quick alpha coverage check
        a = [p[3] for p in squared.getdata()]
        opaque = sum(1 for v in a if v > 20)
        print(f"{name:16} -> {sid}.png  default={color}  opaque%={100 * opaque / len(a):.1f}")

    meta = OUT_DIR / "_catalog.json"
    with open(meta, "w", encoding="utf-8") as fh:
        json.dump(catalog, fh, indent=2)
    print("done", len(catalog), "pins →", OUT_DIR)


if __name__ == "__main__":
    main()
