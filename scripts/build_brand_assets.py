"""Generate apple-touch-icon.png and og-image.png from PIL.

Run once after design changes. Outputs to web/. The favicon.svg is hand-edited.
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
WEB = REPO / "web"

ACCENT = (74, 144, 226)   # #4A90E2
TEXT   = (26, 26, 26)     # #1a1a1a
MUTED  = (102, 102, 102)  # #666
LINE   = (230, 230, 230)  # #e6e6e6
WHITE  = (255, 255, 255)

SF      = "/System/Library/Fonts/SFCompact.ttf"
HEL_TTC = "/System/Library/Fonts/Helvetica.ttc"  # fallback


def font(size, weight=0):
    """SFCompact has variable axes via index; fall back to Helvetica."""
    try:
        return ImageFont.truetype(SF, size, index=weight)
    except (OSError, IOError):
        return ImageFont.truetype(HEL_TTC, size)


def draw_target(draw, cx, cy, r, stroke_width):
    """The site's mark: outer ring, inner filled dot. Calibration target."""
    draw.ellipse(
        [cx - r, cy - r, cx + r, cy + r],
        outline=ACCENT, width=stroke_width,
    )
    inner = r * 0.38
    draw.ellipse(
        [cx - inner, cy - inner, cx + inner, cy + inner],
        fill=ACCENT,
    )


def make_apple_touch_icon():
    size = 180
    img = Image.new("RGB", (size, size), WHITE)
    draw = ImageDraw.Draw(img)
    # iOS auto-rounds corners and trims a few pixels at the edges, so we fill
    # ~80% of the canvas and let the OS treatment do the rest.
    draw_target(draw, size // 2, size // 2, r=int(size * 0.4), stroke_width=12)
    out = WEB / "apple-touch-icon.png"
    img.save(out, "PNG", optimize=True)
    print(f"wrote {out} ({out.stat().st_size // 1024} KB)")


def make_og_image():
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), WHITE)
    draw = ImageDraw.Draw(img)

    # ---- top: dot + wordmark ----
    # Big lockup. "· predictopoly" with the dot as accent.
    word_font = font(120, weight=2)  # semibold
    word = "predictopoly"
    word_bbox = draw.textbbox((0, 0), word, font=word_font)
    word_w = word_bbox[2] - word_bbox[0]
    word_h = word_bbox[3] - word_bbox[1]

    dot_r = 18
    gap = 28
    total_w = dot_r * 2 + gap + word_w
    start_x = (W - total_w) // 2
    word_y = 170
    dot_cy = word_y + word_h // 2 + 8  # visually align dot with x-height

    draw.ellipse(
        [start_x, dot_cy - dot_r, start_x + dot_r * 2, dot_cy + dot_r],
        fill=ACCENT,
    )
    draw.text(
        (start_x + dot_r * 2 + gap, word_y),
        word, font=word_font, fill=TEXT,
    )

    # ---- tagline ----
    tag_font = font(40, weight=0)
    tag = "calibration training on resolved Polymarket questions"
    tag_bbox = draw.textbbox((0, 0), tag, font=tag_font)
    tag_w = tag_bbox[2] - tag_bbox[0]
    draw.text(((W - tag_w) // 2, 350), tag, font=tag_font, fill=MUTED)

    # ---- slider visualization ----
    # Horizontal rail with a thumb at ~62%, suggesting the predict-the-probability UI.
    rail_y = 490
    rail_x0 = 240
    rail_x1 = W - 240
    rail_h = 6
    draw.rounded_rectangle(
        [rail_x0, rail_y - rail_h // 2, rail_x1, rail_y + rail_h // 2],
        radius=3, fill=LINE,
    )
    # Filled portion up to thumb
    p = 0.62
    thumb_x = int(rail_x0 + (rail_x1 - rail_x0) * p)
    draw.rounded_rectangle(
        [rail_x0, rail_y - rail_h // 2, thumb_x, rail_y + rail_h // 2],
        radius=3, fill=ACCENT,
    )
    # Thumb circle
    thumb_r = 18
    draw.ellipse(
        [thumb_x - thumb_r, rail_y - thumb_r, thumb_x + thumb_r, rail_y + thumb_r],
        fill=ACCENT,
    )
    # Bubble above thumb showing "62%"
    bub_font = font(32, weight=2)
    bub = "62%"
    bub_bbox = draw.textbbox((0, 0), bub, font=bub_font)
    bub_w = bub_bbox[2] - bub_bbox[0]
    bub_h = bub_bbox[3] - bub_bbox[1]
    bub_pad = 14
    bub_x0 = thumb_x - bub_w // 2 - bub_pad
    bub_x1 = thumb_x + bub_w // 2 + bub_pad
    bub_y0 = rail_y - thumb_r - 18 - bub_h - bub_pad
    bub_y1 = rail_y - thumb_r - 18
    draw.rounded_rectangle(
        [bub_x0, bub_y0, bub_x1, bub_y1],
        radius=8, fill=ACCENT,
    )
    draw.text(
        (thumb_x - bub_w // 2, bub_y0 + bub_pad // 2 - 2),
        bub, font=bub_font, fill=WHITE,
    )

    # End labels
    label_font = font(22, weight=0)
    draw.text((rail_x0 - 10, rail_y + 30), "0% No", font=label_font, fill=MUTED, anchor="lt")
    no_label_w = draw.textbbox((0, 0), "100% Yes", font=label_font)[2]
    draw.text((rail_x1 - no_label_w + 10, rail_y + 30), "100% Yes", font=label_font, fill=MUTED, anchor="lt")

    out = WEB / "og-image.png"
    img.save(out, "PNG", optimize=True)
    print(f"wrote {out} ({out.stat().st_size // 1024} KB)")


def main():
    make_apple_touch_icon()
    make_og_image()


if __name__ == "__main__":
    main()
