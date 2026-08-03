"""Isolate toolbar tool glyphs from HuntApp Tool Icons → transparent PNGs.

Same background-removal pipeline as process_pin_icons.py.
"""
from __future__ import annotations

import re
from collections import deque
from pathlib import Path

from PIL import Image

SRC_DIR = Path(r"C:\Users\Rockit\Desktop\HuntApp\button icons\Tool Icons")
OUT_DIR = Path(r"C:\Users\Rockit\Desktop\TestOffline\icons\tools")

# Map source filenames → app asset names
NAME_MAP = {
    "measure": "measure.png",
    "draw_shape": "draw.png",
    "draw": "draw.png",
    "track": "track.png",
    "layers": "layers.png",
}


def slugify(name: str) -> str:
    n = Path(name).stem.strip()
    n = re.sub(r"[\s\-]+", "_", n)
    n = re.sub(r"[^A-Za-z0-9_]", "", n)
    return n.lower()


def lum(r: int, g: int, b: int) -> float:
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def sat(r: int, g: int, b: int) -> int:
    return max(r, g, b) - min(r, g, b)


def is_bg_pixel(r: int, g: int, b: int, *, strict: bool = False) -> bool:
    L = lum(r, g, b)
    S = sat(r, g, b)
    mn = min(r, g, b)
    if mn >= 232 and S < 40:
        return True
    if L >= 245 and S < 50:
        return True
    if L >= 220 and S < 28:
        return True
    if not strict and L >= 200 and S < 18:
        return True
    if L >= 235 and S < 55 and mn >= 210:
        return True
    # Checkerboard / near-white PNG grid remnants
    if L >= 210 and S < 12:
        return True
    return False


def flood_clear_bg(im: Image.Image) -> Image.Image:
    im = im.convert("RGBA")
    w, h = im.size
    px = im.load()
    visited = [[False] * w for _ in range(h)]
    q: deque[tuple[int, int]] = deque()

    def try_seed(x: int, y: int) -> None:
        if x < 0 or y < 0 or x >= w or y >= h or visited[y][x]:
            return
        r, g, b, a = px[x, y]
        # Transparent already, or light bg
        if a < 20 or is_bg_pixel(r, g, b, strict=False):
            visited[y][x] = True
            q.append((x, y))

    for x in range(w):
        try_seed(x, 0)
        try_seed(x, h - 1)
    for y in range(h):
        try_seed(0, y)
        try_seed(w - 1, y)
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
            if a < 20 or is_bg_pixel(r, g, b, strict=False):
                visited[ny][nx] = True
                q.append((nx, ny))
            else:
                visited[ny][nx] = True
    return im


def global_clear_light(im: Image.Image) -> Image.Image:
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
            if is_bg_pixel(r, g, b, strict=False):
                px[x, y] = (0, 0, 0, 0)
                continue
            if L >= 185 and S < 22:
                if L >= 210:
                    px[x, y] = (0, 0, 0, 0)
                else:
                    alpha = int(max(0, min(255, (210 - L) * (255 / 25))))
                    px[x, y] = (r, g, b, alpha)
            elif L >= 248 and S < 60:
                px[x, y] = (0, 0, 0, 0)
    return im


def harden_silhouette(im: Image.Image) -> Image.Image:
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
    if total < 10 or color > total * 0.12:
        return im
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
            if L <= 30:
                opx[x, y] = (0, 0, 0, 255)
            elif L >= 190:
                opx[x, y] = (0, 0, 0, 0)
            else:
                alpha = int(max(0, min(255, (190 - L) * (255 / 160))))
                opx[x, y] = (min(r, 40), min(g, 40), min(b, 40), alpha)
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


def to_square(im: Image.Image, size: int = 128, pad_ratio: float = 0.04) -> Image.Image:
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


def process_one(path: Path) -> Image.Image:
    im = Image.open(path)
    im = flood_clear_bg(im)
    im = global_clear_light(im)
    im = harden_silhouette(im)
    im = flood_clear_bg(im)
    im = crop_alpha(im, pad=1)
    return to_square(im, 128, pad_ratio=0.04)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    files = []
    for pat in ("*.JPG", "*.jpg", "*.PNG", "*.png", "*.jpeg", "*.JPEG"):
        files.extend(sorted(SRC_DIR.glob(pat)))
    if not files:
        raise SystemExit(f"No tool icons in {SRC_DIR}")
    written = []
    for f in files:
        sid = slugify(f.name)
        out_name = NAME_MAP.get(sid)
        if not out_name:
            print(f"skip unknown: {f.name} ({sid})")
            continue
        squared = process_one(f)
        out = OUT_DIR / out_name
        squared.save(out, "PNG", optimize=True)
        a = [p[3] for p in squared.getdata()]
        opaque = sum(1 for v in a if v > 20)
        print(f"{f.name:20} -> {out_name}  opaque%={100 * opaque / len(a):.1f}")
        written.append(out_name)
    print("done", len(written), "tool icons →", OUT_DIR)


if __name__ == "__main__":
    main()
