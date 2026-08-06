# OpenSluice brand assets

Standalone files with hardcoded colours, for external use (the root README,
docs, posts, slides). In-product rendering uses `apps/web/src/shared/Logo.tsx`
plus the CSS tokens instead, so the mark follows the app's theme.

| File | Use on |
| --- | --- |
| `mark.svg` | Dark surfaces — water `#f5f5f5`, blade `#f7931a` |
| `mark-light.svg` | Light surfaces — water `#0a0a0a`, blade `#f7931a` |
| `lockup-dark.svg` | Dark surfaces — mark + wordmark, font embedded |
| `lockup-light.svg` | Light surfaces — mark + wordmark, font embedded |
| `../../apps/web/public/favicon.svg` | Browser tabs; theme-aware via a media query |
| `../../apps/web/public/favicon-{16,32,48}.png`, `favicon.ico` | Legacy tab icons |
| `../../apps/web/public/apple-touch-icon.png`, `icon-{192,512}.png` | Home-screen and PWA icons |

The rasters are generated from the same geometry by `scripts/make-favicons.ts`
and are checked in. Rerun that script whenever the mark changes; do not edit
the PNGs by hand.

## The mark

A 24×24 viewBox holding exactly two flat shapes: a raised gate blade above,
and the water it has released below. No strokes, no gradients, no text.

| Element | Geometry | Colour |
| --- | --- | --- |
| Water | `<path d="M3 12h6v3h12v6H3z"/>` | `#f5f5f5` on dark, `#0a0a0a` on light |
| Blade | `<rect x="9.5" y="3" width="3" height="7.5"/>` | `#f7931a` always |

The water is a two-level step: it enters at the upper level on the left
(y=12), drops three units, and runs out along the lower level to the right.
That step is the point of the mark — value moving between two levels once the
gate is open.

### The ≤16px optical variant

At 16 rendered pixels the 3-unit blade and the 3-unit step both land on
roughly two device pixels and smear into grey. The variant below thickens
both shapes and pushes the mark out toward the edges of the box so the
silhouette survives. Use it only for the 16px raster layer.

| Element | Geometry |
| --- | --- |
| Water | `<path d="M2.5 11.5h6.5v4H21.5v6H2.5z"/>` |
| Blade | `<rect x="9" y="2" width="4" height="8"/>` |

The gap is preserved exactly: blade bottom y=10, water top y=11.5, still 1.5
units. Everything above 16px uses the standard geometry.

### The gap never closes

The 1.5-unit space between the bottom of the blade (y=10.5) and the top of
the water (y=12) is the "Open" in OpenSluice. It is not a rendering artifact
and it is not negative space to be tightened. Never narrow it, never close
it, never let the two shapes touch or overlap at any size.

## The lockup

Ratios, all expressed against the mark height `M`:

| Measure | Value | At M=24 |
| --- | --- | --- |
| Gap, mark box to wordmark | 0.32 × M | 7.68 |
| Wordmark cap height | 0.78 × M | 18.72 |
| Clear space, all four sides | 0.5 × M | 12 |

The wordmark is Space Grotesk 700 at `letter-spacing: -0.03em`. Space Grotesk
has a cap height of 0.70em, so the font size is `0.78 × M / 0.70` — 26.74px at
M=24. "Open" takes the text colour (`#ffffff` on dark, `#0a0a0a` on light) and
"Sluice" takes `#f7931a`.

The clear space is already baked into the two lockup SVGs, so they can be
placed flush against other content. Do not crop it back out.

Below a 20px mark height the wordmark stops being legible; use the mark alone.

### Why the font is embedded

GitHub renders SVGs referenced from Markdown through `<img>`, which sandboxes
external resources — a webfont fetched over the network would silently fall
back to the system sans and the lockup would not be the lockup. Both lockup
files therefore carry the full `latin` 700 Space Grotesk woff2 (12.8kB,
from `@fontsource/space-grotesk`) as a base64 data URI inside an inline
`<style>` `@font-face` block. Text stays live text, which keeps the files
small and the wordmark crisp at any size.

## Single-colour contexts

Where only one ink is available — engraving, a stamp, a one-colour print, a
monochrome partner lockup — both mark shapes and the whole wordmark take that
single ink. The gap still does the work. On an orange background, use black.

## Don'ts

- No strokes, no outlines, no gradients, no shadows, no rotation.
- No text or symbol inside either shape.
- Never recolour the blade. It is `#f7931a` in every two-colour context.
- Never redraw or nudge the geometry — copy these files, or the path data
  above, verbatim.
- Never close or narrow the 1.5-unit gap, and never overlap the shapes.
- Don't restyle the wordmark: no other family, weight, tracking, or case, and
  no other colour split than "Open" in the text colour and "Sluice" in orange.
- Don't use the ≤16px variant above 16px, or the standard geometry at 16px.

## Family logic

OpenTill and OpenSluice are one family, built from the same two-shape grammar.

OpenTill is a coin dropping into an open till: value arriving and being kept.
OpenSluice is a gate raised out of the way so value can move between two
levels: value passing through. In both marks the orange shape is the element
in motion — the coin, the blade that moved — and the neutral shape is the
structure it moves through.

Both marks keep the identical 1.5-unit open gap between the two shapes. That
gap is the shared signature of the family, and it is the reason both products
can be recognised as the same thing at 16 pixels.
