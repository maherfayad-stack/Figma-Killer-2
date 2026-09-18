# 01 — Fixtures

**Provenance note (read first):** the work order (`STATE.md` `panel-20`) said
the exact fixture definitions and `measurements.json` schema lived in "this
session's architect transcript," to be reproduced verbatim here. That
transcript was never persisted anywhere this execution could read — not in
`STATE.md`, not in `STUDIO-LIVE-CANVAS-PLAN.md`, not in a scratch file. Two
prior execution attempts died before writing anything to disk, so there was
no partial artifact to recover either. The fixture set below is therefore
**authored fresh by this run**, constrained only by what `STUDIO-LIVE-CANVAS-PLAN.md`
§P0 actually specifies (four fixtures: rectangle, text layer, flex board,
image; Mixed folded into the rectangle fixture as a sub-case per `panel-20`'s
own "Decisions" line) and by what makes a legible, reproducible reference.
**This file is now the source of truth going forward** — nothing superseded
it, so treat every number here as intentional, not as a placeholder.

All four fixtures live in one Penpot file (`New File 1`, in the
`panel-baseline-2@studio.local` personal space), one per page, so each can be
revisited independently. Viewport for every screenshot: **1600×1000**, zoom
**100%**.

## F1 — Rectangle (`Page 1`)

A single rectangle with every basic Design-tab section populated (fill,
stroke, radius) so the panel is at its **fully-populated rest state**, not
its empty-section state.

| Property | Value |
|---|---|
| Position | X `100`, Y `100` |
| Size | W `240`, H `160` |
| Corner radius | `8` (uniform) |
| Fill | solid `#1e88e5` |
| Stroke | `1px` solid `#000000`, center alignment (Penpot default) |
| Rotation | `0` |

### F1 sub-case — Mixed value (multi-select)

Built by duplicating the F1 rectangle (`⌘D` via context menu → `Duplicate`,
not the keyboard shortcut directly — see `00-setup.md`), then:

- moving the duplicate to X `400` (Y unchanged at `100`, so **Y matches, X
  differs**)
- changing the duplicate's fill to solid `#e53935` (differs from the
  original's `#1e88e5`; **stroke is left untouched on both**, so stroke
  matches)
- multi-selecting both rectangles (shift-click the second layer row)

This gives one property that's fully mixed (fill), one that's partially
mixed (X differs, Y and everything else geometric matches except W/H which
are identical), and one that's fully uniform (stroke) — enough to see Penpot
render all three cases at once. See `03-operating-behaviors.md` → "Mixed
values" for what each renders as.

## F2 — Text (`Page 2`)

A single text layer, sized explicitly (not auto-width) so the Design panel's
full **Text** section — family, size, weight, line-height, letter-spacing,
case/decoration toggles, alignment — is visible at once.

| Property | Value |
|---|---|
| Content | `The quick brown fox jumps` |
| Position | X `100`, Y `100` |
| Size | W `300`, H `24` (fixed, not auto) |
| Font | Source Sans Pro, size `24`, weight `400` |
| Line height | `1.2` (Penpot default, left untouched) |
| Letter spacing | `0` (default) |
| Fill | solid `#000000` (default) |
| Text align | left (default) |

## F3 — Flex board with two children (`Page 3`)

A board with Penpot's **Flex layout** applied (the plan's "container-vs-element
split" — P3 §4), containing two rectangle children, so both the
container-level `LAYOUT`/`FLEX BOARD` sections and the per-child `FLEX
ELEMENT` section are captured.

**Board ("Board"):**

| Property | Value |
|---|---|
| Position | X `100`, Y `100` |
| Size | W `480`, H `200` |
| Layout | Flex, direction row (Penpot default on "Add layout" → "Flex layout") |
| Column gap | `16` (row gap is disabled by Penpot itself in single-row, no-wrap mode — see `03-operating-behaviors.md`) |
| Padding | `24` all sides (vertical `24`, horizontal `24`) |
| Fill | solid `#ffffff` |

**Child A ("Rectangle", first):**

| Property | Value |
|---|---|
| Size | W `120`, H `80` |
| Fill | solid `#43a047` |
| Resulting position (flex-computed) | X `24`, Y `24` relative to the board's own origin — i.e. exactly the padding value, confirming the padding took effect |

**Child B ("Rectangle", second):**

| Property | Value |
|---|---|
| Size | W `120`, H `80` |
| Fill | solid `#fb8c00` |
| Resulting position (flex-computed) | X `160`, Y `24` — `24 (child A start) + 120 (child A width) + 16 (gap)` |

Screenshots for this fixture were captured twice at the Design tab: once
with the **board itself** selected (`design.png` — container view, `LAYOUT`
+ `FLEX BOARD` sections) and once with **one child** selected
(`design-child.png` — bonus capture, `FLEX ELEMENT` section, not one of the
required 24 but kept because it's the clearest evidence of Studio's "is this
editing the element or its layout parent" ambiguity risk called out in the
panel-designer brief).

## F4 — Image (`Page 4`)

A single bitmap fill inserted via Penpot's Image tool (`⇧K`), uploaded from a
locally-generated 300×200 PNG (a plain diagonal gradient — content is
irrelevant, only that it's a real raster asset with natural dimensions
matters).

| Property | Value |
|---|---|
| Position | X `100`, Y `100` (set explicitly after insert; Penpot drops it wherever the viewport center is by default) |
| Size | W `300`, H `200` (Penpot's own natural size on insert — left untouched) |
| Fill | `Image` (bitmap, not solid — Fill section shows a thumbnail chip labeled "Image" instead of a hex value) |

## What's deliberately *not* a fixture

A grid-layout board, a component instance, and a shape with a shadow/blur
applied were all considered and dropped — the plan's four named fixtures
(rectangle, text, flex board, image) are the contract in
`STUDIO-LIVE-CANVAS-PLAN.md` §P0, and `02-measurements.md` already captures
grid vs. flex as a menu choice (`Add layout` offers both) without needing a
fifth fixture to prove it exists.
