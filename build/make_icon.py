"""Draws the app icon: a gold coin like First to Forever's, with a profile card being
carried by an arrow onto a second card. Writes icon.png (512) and icon.ico."""
import math, os
from PIL import Image, ImageDraw, ImageFilter

S = 1024
here = os.path.dirname(os.path.abspath(__file__))
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

def radial(size, inner, outer):
    g = Image.new("RGBA", (size, size))
    px = g.load()
    c = size / 2
    for y in range(size):
        for x in range(size):
            t = min(1, math.hypot(x - c, y - c) / c)
            px[x, y] = tuple(int(inner[i] + (outer[i] - inner[i]) * t) for i in range(4))
    return g

def lin(size, top, bottom):
    g = Image.new("RGBA", size)
    d = ImageDraw.Draw(g)
    for y in range(size[1]):
        t = y / max(1, size[1] - 1)
        d.line([(0, y), (size[0], y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(4)))
    return g

def mask_circle(r, pad=0):
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).ellipse([S/2-r, S/2-r, S/2+r, S/2+r], fill=255)
    return m

# gold ring
ring = lin((S, S), (255, 226, 120, 255), (196, 120, 20, 255))
img.paste(ring, (0, 0), mask_circle(500))
img.paste(lin((S, S), (150, 90, 10, 255), (255, 214, 90, 255)), (0, 0), mask_circle(458))
# dark face
img.paste(radial(S, (44, 38, 34, 255), (14, 12, 11, 255)), (0, 0), mask_circle(440))

d = ImageDraw.Draw(img)

def card(x, y, w, h, top, bottom, alpha=255):
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).rounded_rectangle([x, y, x + w, y + h], radius=34, fill=alpha)
    layer.paste(lin((S, S), top, bottom), (0, 0), m)
    ld = ImageDraw.Draw(layer)
    # head and shoulders
    cx = x + w / 2
    ld.ellipse([cx - 52, y + 70, cx + 52, y + 174], fill=(40, 30, 18, 230))
    ld.pieslice([cx - 100, y + 190, cx + 100, y + 390], 180, 360, fill=(40, 30, 18, 230))
    # settings lines
    for i, lw in enumerate((0.62, 0.45)):
        yy = y + 330 + i * 46
        ld.rounded_rectangle([x + 40, yy, x + 40 + (w - 80) * lw, yy + 20], radius=10, fill=(40, 30, 18, 200))
    return layer

shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle([250, 300, 540, 760], radius=34, fill=(0, 0, 0, 160))
ImageDraw.Draw(shadow).rounded_rectangle([500, 250, 790, 710], radius=34, fill=(0, 0, 0, 160))
img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(18)))
img.alpha_composite(card(236, 286, 290, 450, (190, 160, 110, 255), (120, 96, 62, 255)))
img.alpha_composite(card(486, 236, 290, 450, (255, 228, 130, 255), (240, 160, 50, 255)))

# arrow from the old card to the new one
arrow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ad = ImageDraw.Draw(arrow)
pts = []
for i in range(60):
    t = i / 59
    x = 250 + 520 * t
    y = 800 - 260 * t - 170 * math.sin(math.pi * t) * 0.6
    pts.append((x, y))
for i in range(len(pts) - 1):
    w = 18 + 26 * (i / len(pts))
    ad.line([pts[i], pts[i + 1]], fill=(255, 120 + int(60 * i / 60), 40, 255), width=int(w))
tip = pts[-1]
ang = math.atan2(pts[-1][1] - pts[-6][1], pts[-1][0] - pts[-6][0])
L = 120
ad.polygon([
    (tip[0] + math.cos(ang) * 60, tip[1] + math.sin(ang) * 60),
    (tip[0] + math.cos(ang + 2.4) * L, tip[1] + math.sin(ang + 2.4) * L),
    (tip[0] + math.cos(ang - 2.4) * L, tip[1] + math.sin(ang - 2.4) * L),
], fill=(255, 190, 60, 255))
glow = arrow.filter(ImageFilter.GaussianBlur(14))
img.alpha_composite(glow)
img.alpha_composite(arrow)

img = img.resize((512, 512), Image.LANCZOS)
img.save(os.path.join(here, "icon.png"))
img.resize((256, 256), Image.LANCZOS).save(os.path.join(here, "icon.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("ok")
