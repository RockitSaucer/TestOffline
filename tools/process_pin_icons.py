"""Isolate pin glyphs from HuntApp Layers naked JPGs → transparent PNGs."""
from __future__ import annotations

import json
import re
from pathlib import Path

from PIL import Image

SRC_DIR = Path(r"C:\Users\Rockit\Desktop\HuntApp\button icons\Layers naked")
OUT_DIR = Path(r"C:\Users\Rockit\Desktop\TestOffline\icons\pins")


def slugify(name: str) -> str:
    n = Path(name).stem.strip()
    n = re.sub(r"[\s\-]+", "_", n)
    n = re.sub(r"[^A-Za-z0-9_]", "", n)
    n = n.lower()
    # match existing catalog ids
    if n == "dead_head":
        n = "deadhead"
    return n


def display_name(name: str) -> str:
    return re.sub(r"\s+", " ", Path(name).stem.strip())


def remove_bg_and_crop(im: Image.Image, white_thresh: int = 245, soft: int = 18) -> Image.Image:
    im = im.convert("RGBA")
    pixels = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            mx = max(r, g, b)
            mn = min(r, g, b)
            if r >= white_thresh and g >= white_thresh and b >= white_thresh:
                pixels[x, y] = (r, g, b, 0)
                continue
            # near-white / low-sat light background
            if mn >= white_thresh - soft and (mx - mn) < 28:
                avg = (r + g + b) / 3.0
                if avg >= white_thresh - 5:
                    pixels[x, y] = (r, g, b, 0)
                else:
                    alpha = int(max(0, min(255, (white_thresh - avg) * (255.0 / soft))))
                    pixels[x, y] = (r, g, b, alpha)
    bbox = im.getbbox()
    if not bbox:
        return im
    pad = 2
    l = max(0, bbox[0] - pad)
    t = max(0, bbox[1] - pad)
    r = min(w, bbox[2] + pad)
    btm = min(h, bbox[3] + pad)
    return im.crop((l, t, r, btm))


def to_square(im: Image.Image, size: int = 128, pad_ratio: float = 0.08) -> Image.Image:
    cw, ch = im.size
    content = max(cw, ch)
    pad = int(content * pad_ratio)
    side = content + pad * 2
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    ox = (side - cw) // 2
    oy = (side - ch) // 2
    canvas.paste(im, (ox, oy), im)
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def dominant_color(im: Image.Image) -> str:
    """Prefer true subject color; near-black silhouettes → #1a1a1a (ignore gray AA)."""
    opaque = []
    for r, g, b, a in im.getdata():
        if a < 40:
            continue
        if r > 240 and g > 240 and b > 240:
            continue
        sat = max(r, g, b) - min(r, g, b)
        lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
        # Weight saturated / solid pixels more than soft anti-alias fringes
        weight = max(1, a) * (1 + sat / 40.0) * (1.5 if lum < 80 else 0.6)
        opaque.append((r, g, b, sat, lum, weight))
    if not opaque:
        return "#1a1a1a"
    tw = sum(x[5] for x in opaque)
    r = int(sum(x[0] * x[5] for x in opaque) / tw)
    g = int(sum(x[1] * x[5] for x in opaque) / tw)
    b = int(sum(x[2] * x[5] for x in opaque) / tw)
    avg_sat = sum(x[3] * x[5] for x in opaque) / tw
    avg_lum = sum(x[4] * x[5] for x in opaque) / tw
    # Monochrome black/gray silhouette → solid dark pin body
    if avg_sat < 35 and avg_lum < 120:
        return "#1a1a1a"
    if r < 45 and g < 45 and b < 45:
        return "#1a1a1a"
    return f"#{r:02x}{g:02x}{b:02x}"


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
        im = Image.open(f)
        cleaned = remove_bg_and_crop(im)
        squared = to_square(cleaned, 128)
        color = dominant_color(squared)
        out = OUT_DIR / f"{sid}.png"
        squared.save(out, "PNG")
        name = display_name(f.name)
        catalog.append(
            {
                "id": sid,
                "name": name,
                "src": f"icons/pins/{sid}.png",
                "defaultColor": color,
            }
        )
        print(f"{name:16} -> {sid}.png  default={color}  content={cleaned.size}")

    meta = OUT_DIR / "_catalog.json"
    with open(meta, "w", encoding="utf-8") as fh:
        json.dump(catalog, fh, indent=2)
    print("done", len(catalog), "pins →", OUT_DIR)


if __name__ == "__main__":
    main()
