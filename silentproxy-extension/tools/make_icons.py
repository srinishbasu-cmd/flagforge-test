#!/usr/bin/env python3
"""Draw the extension icons (an intercept 'crosshair' ring) with Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "src" / "icons"
S = 512  # draw large, downsample for smooth edges


def draw() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, S - 1, S - 1), radius=S // 5, fill=(15, 23, 42, 255))
    orange = (249, 115, 22, 255)
    c, r, w = S // 2, int(S * 0.30), int(S * 0.07)
    d.ellipse((c - r, c - r, c + r, c + r), outline=orange, width=w)
    d.rectangle((int(S * 0.12), c - w // 2, int(S * 0.88), c + w // 2), fill=orange)
    d.rectangle((c - w // 2, int(S * 0.12), c + w // 2, int(S * 0.88)), fill=orange)
    d.ellipse((c - w, c - w, c + w, c + w), fill=(15, 23, 42, 255))
    d.ellipse((c - w // 2, c - w // 2, c + w // 2, c + w // 2), fill=orange)
    return img


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    base = draw()
    for size in (16, 32, 48, 128):
        base.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
    print("icons written to", OUT)
