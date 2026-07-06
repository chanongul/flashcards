#!/usr/bin/env python3
"""Bake extra letter-spacing into the Sukhumvit Set fonts (Thai-only spacing).

CSS letter-spacing can't target a script, but Thai renders exclusively from
these self-hosted files (Fragment Mono handles all Latin), so widening each
glyph's advance width here letter-spaces Thai everywhere in the app — UI and
rich-text card content alike — with no CSS/DOM changes.

Zero-advance glyphs (combining marks: upper/lower vowels, tone marks) are
left untouched so they stay anchored to their base consonant.

Usage: python3 scripts/letterspace-thai.py [percent]
  percent — extra advance as % of em size (default 5). Re-running is NOT
  cumulative: it re-downloads the originals first.
"""

import io
import sys
import urllib.request

from fontTools.ttLib import TTFont

SRC = "https://raw.githubusercontent.com/bluenex/baansuan_prannok/master/fonts/sukhumvit-set"
WEIGHTS = ["Text", "Medium", "SemiBold", "Bold"]
DEST = "app/fonts"

percent = float(sys.argv[1]) if len(sys.argv) > 1 else 5.0

for w in WEIGHTS:
    name = f"SukhumvitSet-{w}.ttf"
    with urllib.request.urlopen(f"{SRC}/{name}") as resp:
        font = TTFont(io.BytesIO(resp.read()))

    upem = font["head"].unitsPerEm
    delta = round(upem * percent / 100)
    hmtx = font["hmtx"]
    widened = 0
    for glyph in hmtx.metrics:
        adv, lsb = hmtx.metrics[glyph]
        if adv > 0:  # skip combining marks
            hmtx.metrics[glyph] = (adv + delta, lsb)
            widened += 1

    font.save(f"{DEST}/{name}")
    print(f"{name}: +{delta}/{upem} units on {widened} glyphs")
