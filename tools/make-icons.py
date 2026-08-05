#!/usr/bin/env python3
"""
Peek — icon generator.

Renders src/icons/icon-{16,32,48,128}.png. Monochrome, matching the rest of
the extension: an ink squircle with the two-pane "preview layer" glyph knocked
out of it in paper white.

Everything is drawn at 16× and downsampled, which is what gives the small
sizes clean edges. The 16px icon drops the back pane — at that size two
overlapping rectangles are indistinguishable from noise.

    python3 tools/make-icons.py
"""

from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "src" / "icons"
SS = 16  # supersample factor

INK = (24, 24, 27, 255)
PAPER = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)


def rr(draw, box, radius, **kw):
    draw.rounded_rectangle(box, radius=radius, **kw)


def render(size, layered=True):
    S = size * SS
    img = Image.new("RGBA", (S, S), CLEAR)
    d = ImageDraw.Draw(img)

    def u(f):
        """Fraction of the icon's edge → device units."""
        return f * S

    # The badge. Inset slightly so the icon has the same optical weight as
    # the browser's own toolbar glyphs rather than crowding them.
    pad = u(0.045)
    rr(d, (pad, pad, S - pad - 1, S - pad - 1), radius=u(0.235), fill=INK)

    if layered:
        # Back pane: an outline, offset up and to the right. It overlaps the
        # front pane by one corner only — enough to say "behind", not so much
        # that two of its sides vanish into the knockout.
        stroke = max(1, round(u(0.034)))
        rr(
            d,
            (u(0.455), u(0.175), u(0.835), u(0.505)),
            radius=u(0.075),
            outline=(255, 255, 255, 135),
            width=stroke,
        )
        # Knock a gap out of it so the front pane reads as being in front.
        gap = u(0.042)
        rr(
            d,
            (u(0.165) - gap, u(0.435) - gap, u(0.640) + gap, u(0.830) + gap),
            radius=u(0.112),
            fill=INK,
        )
        rr(d, (u(0.165), u(0.435), u(0.640), u(0.830)), radius=u(0.080), fill=PAPER)
    else:
        # One pane, centred and larger — legible at 16px.
        rr(d, (u(0.235), u(0.265), u(0.765), u(0.735)), radius=u(0.105), fill=PAPER)

    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        img = render(size, layered=size >= 32)
        path = OUT / f"icon-{size}.png"
        img.save(path)
        print(f"wrote {path.relative_to(OUT.parent.parent.parent)} ({size}×{size})")


if __name__ == "__main__":
    main()
