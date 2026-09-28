"""Render the Instagram-style glyph used for the extension icons."""
import math
import os

from PIL import Image, ImageDraw, ImageFilter

S = 1024
OUT = os.path.join(os.path.dirname(__file__), "..", "icons")

STOPS = [
    (0.00, (254, 218, 117)),
    (0.25, (250, 126, 30)),
    (0.50, (214, 41, 118)),
    (0.75, (150, 47, 191)),
    (1.00, (79, 91, 213)),
]


def lerp_stops(t):
    t = max(0.0, min(1.0, t))
    for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
        if t <= t1:
            k = (t - t0) / (t1 - t0)
            return tuple(round(a + (b - a) * k) for a, b in zip(c0, c1))
    return STOPS[-1][1]


def gradient():
    small = 256
    img = Image.new("RGB", (small, small))
    px = img.load()
    cx, cy = small * 0.3, small * 1.07
    r = small * 1.25
    for y in range(small):
        for x in range(small):
            d = math.hypot(x - cx, y - cy) / r
            px[x, y] = lerp_stops(d)
    return img.resize((S, S), Image.BICUBIC).filter(ImageFilter.GaussianBlur(6))


def glyph():
    bg = gradient()
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.225), fill=255)

    fg = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(fg)
    stroke = int(S * 0.085)
    m = int(S * 0.2)
    d.rounded_rectangle((m, m, S - m, S - m), radius=int(S * 0.17), outline=255, width=stroke)
    c = S / 2
    r = S * 0.155
    d.ellipse((c - r, c - r, c + r, c + r), outline=255, width=stroke)
    dr = S * 0.045
    dx, dy = S * 0.655, S * 0.345
    d.ellipse((dx - dr, dy - dr, dx + dr, dy + dr), fill=255)

    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(bg, (0, 0), mask)
    white = Image.new("RGBA", (S, S), (255, 255, 255, 255))
    img.paste(white, (0, 0), fg)
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    big = glyph()
    for size in (16, 32, 48, 128):
        big.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, f"icon{size}.png"))
    big.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon512.png"))


if __name__ == "__main__":
    main()
