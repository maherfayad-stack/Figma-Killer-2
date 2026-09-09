# Penpot inspector baseline (P0)

Measured baseline of a self-hosted Penpot `2.17.2`'s Design/Prototype/Inspect
panel, for `STUDIO-LIVE-CANVAS-PLAN.md` Track P (P1 onward) to build against.
Produced by `panel-designer` per work order `panel-20` in `STATE.md`. **Read
`01-fixtures.md` first if you're wondering why the fixture numbers look like
one specific run's choices rather than a handed-down spec** — the original
architect's exact fixture definitions were never persisted anywhere this
execution could recover; this baseline authored its own and is now the
canonical version.

## Read in this order

1. **[`00-setup.md`](./00-setup.md)** — the exact Penpot version, Docker
   image tags, account, and theme-switching mechanism every other file in
   here assumes. Also documents two automation gotchas (synthetic
   pointer-event drag, Duplicate shortcut) for whoever next drives Penpot
   this way.
2. **[`01-fixtures.md`](./01-fixtures.md)** — the four fixtures (rectangle,
   text, flex board + two children, image) and their exact authored
   geometry, plus the mixed-value sub-case built on the rectangle fixture.
3. **[`measurements.json`](./measurements.json)** — the machine-readable
   source of truth. Valid JSON, schema documented inline via key names;
   `02-measurements.md` is generated from it and must never diverge from it
   by hand.
4. **[`02-measurements.md`](./02-measurements.md)** — every number from the
   JSON, in table form with context: panel/section/field geometry, colors
   per theme, the real nudge ladder (`±1` / `±10` / `±0.1`), scrub ratio,
   tab order, keyboard behavior, click counts to the six most common edits.
5. **[`03-operating-behaviors.md`](./03-operating-behaviors.md)** — the
   narrative facts that don't reduce to a table: how the panel's *shape*
   changes with selection (not just its values), why Escape doesn't revert
   in Penpot, the two different Mixed-value conventions in Design vs.
   Inspect, and the one place this baseline recommends Studio *not* copy
   Penpot (add-property writing a real default value on click).
6. **[`04-token-gaps.md`](./04-token-gaps.md)** — every `--inspector-*`
   token in `src/styles/globals.css` compared against what was actually
   measured, plus the new tokens P1/P3 will need (Penpot's accent color
   changes *hue* between themes, not just lightness) and one concept
   (`--inspector-label-w`) that doesn't survive contact with Penpot's
   icon-glyph field labels at all.

## Screenshots

`screenshots/<fixture>/<theme>/<tab>.png` — 24 required
(4 fixtures × {dark, light} × {Design, Prototype, Inspect}) plus 2 bonus
captures kept because they're directly useful evidence, not because the
count needed padding:

- `f3-flexboard/dark/design-child.png` — the same board fixture with one
  **child** selected instead of the board itself, showing Penpot's
  `FLEX ELEMENT` per-child panel (vs. the board's own `LAYOUT`/`FLEX BOARD`
  sections). Direct evidence for `STUDIO-LIVE-CANVAS-PLAN.md` §P1's "the
  write target is a rule, not a mode."
- `f1-rectangle-mixed/{dark,light}/{design,inspect}.png` — the mixed-value
  sub-case (two rectangles, one differing property, one matching property),
  captured in both themes and both tabs since Design and Inspect render
  Mixed completely differently (see `03-operating-behaviors.md`).

All 26 files verified post-hoc by sampling the right panel's background
pixel color (dark ≈ `rgb(24,24,26)`, light = `rgb(255,255,255)`) rather than
trusted by eye — see `00-setup.md` for why that check existed at all.

## Status

Complete. Nothing in `STUDIO-LIVE-CANVAS-PLAN.md` Track P (P1 onward) is
blocked by missing baseline data as of this audit. Two things are explicitly
**not** covered and are named as such rather than silently missing:

- The full color-picker popover's exact chrome (saturation/hue panel) — the
  inline swatch+hex+opacity row is fully measured; the popover itself
  wasn't reliably triggerable under this session's browser automation. Flag
  for whoever lands P3's Fill/Stroke sections if the popover's own geometry
  turns out to matter.
- Whether Penpot's Fill/Stroke/Shadow **list** rows (multiple entries in one
  section) introduce a third gap value beyond the two (`4px`/`16px`) this
  baseline measured — none of the four fixtures needed more than one entry
  per section. Check when P3 gets there.
