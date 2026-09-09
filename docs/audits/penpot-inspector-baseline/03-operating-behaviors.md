# 03 — Operating behaviors

Narrative companion to `02-measurements.md`'s tables — the "how it feels to
use" facts that don't reduce to a single number, plus the full detail behind
a few numbers that deserve more than a table row. Everything here was
exercised directly against the running Penpot `2.17.2` instance (see
`00-setup.md`), not inferred from a screenshot.

## Selection → panel, and the panel's shape changes with what's selected

Nothing is selected: the Design tab shows only two fields, **Canvas
background** and **Pixel grid color** — page-level settings, not a blank
panel. There is no "select something" empty state; the panel always has
*something* to show.

A shape with no layout parent (a bare rectangle, or a board with no layout
applied) shows a **`CONSTRAINTS`** section (Left/Top anchor pickers + a
"fix when scrolling" checkbox) — Penpot's resize-behavior contract for
free-floating elements.

The moment that same shape becomes a flex or grid child, `CONSTRAINTS`
**disappears entirely** and is replaced by **`FLEX ELEMENT`** (or the grid
equivalent): a `Static`/`Absolute` toggle, sizing-behavior icon buttons
(hug/fill-equivalent), and a z-index field. This is Penpot's own version of
the plan's "is this editing the element or a layout parent" ambiguity — and
Penpot's answer is: **the section itself changes identity**, not just its
contents. The panel never shows both `CONSTRAINTS` and `FLEX ELEMENT` at
once, and never shows a disabled/grayed version of the one that doesn't
apply. This is the strongest real-world precedent for
`STUDIO-LIVE-CANVAS-PLAN.md` §P1's "the write target is a rule, not a mode"
— Penpot resolves the ambiguity structurally (different section, full stop)
rather than with a chip or a toggle the user has to read.

## The "mode chooses the fields" law is real in Penpot, not just Studio's

On the F3 flex board (single row, no wrap): the **Row gap** field renders
`[disabled]` — present, visible, but not editable — because it's
meaningless in that configuration. Only **Column gap** is live. This
directly matches Studio's existing Law 5
(`docs/features/inspector-disclosure.md`) — Penpot didn't invent a new idea
here, it's independent confirmation of the same rule from a second real
product.

## Nudge ladder and scrub, together

Both live under one mental model in Penpot: **Shift = ×10, Alt = ×0.1**, and
it applies identically whether you're pressing arrow keys or dragging the
field's icon-glyph. A user who learns the keyboard ladder already knows the
scrub ladder. See `02-measurements.md` for the exact numbers; the operating
fact worth stating in prose is that **there is only one ladder**, expressed
two ways — Studio should not invent a different multiplier for scrub than
for keyboard nudge.

## Escape does not revert — a genuine surprise worth flagging loudly

This was tested directly, twice (once cleanly with `element.select()` to
guarantee real text selection before typing, once via a messier Ctrl+A
attempt that turned out to trigger "select all layers" instead because focus
had silently moved — worth knowing if anyone repeats this: **`Ctrl+A` inside
a Penpot numeric field is not reliable text-select-all**; use
`document.activeElement.select()` or Home+Shift+End instead). Both times,
**Escape committed the typed value and blurred the field** — it did not
restore the pre-edit value. This contradicts the everyday assumption
("Escape cancels") that a lot of inspector-field code silently carries. It
is a fact about **Penpot**, recorded here so nobody copies it into Studio by
assuming Penpot parity requires it — Studio's own Escape-reverts behavior
(if it has one) should be evaluated on its own merits, not discarded because
"that's not what Penpot does."

## Duplicate: the keyboard shortcut is fragile, the context menu isn't

`⌘D`/`Ctrl+D` is Penpot's labeled shortcut for Duplicate (visible in the
right-click context menu), but repeated attempts to fire it via the
automation's `press` command did not duplicate the selected shape — no
error, just silently no-op, most likely intercepted by the host browser
chrome (bookmark-manager shortcut on some platforms) before reaching the
page. **Right-click → `Duplicate` from the context menu worked every time**
and is what built the F1 mixed-value sub-case. Not a Penpot bug — a note for
whoever next automates this tool, and mild evidence that a global
keyboard-shortcut menu with visible labels (Penpot's context menu shows
every shortcut inline: Copy `⌘C`, Cut `⌘X`, Duplicate `⌘D`, Group `⌘G`,
Create component `⌘K`, …) is a good redundancy pattern regardless.

## Mixed values: two different conventions in two tabs, on purpose

Fully detailed with a table in `02-measurements.md` → "Mixed-value
rendering." The narrative point: Penpot does **not** use one mixed-value
idiom everywhere. The **Design** tab (an editing surface) shows the literal
word `Mixed` as a placeholder you can type over to set all selected shapes
at once — a single field, one write target, matching Studio's own existing
"Mixed shows as *Mixed*; typing sets all" contract
(`docs/features/inspector-disclosure.md` §4 G9, cited directly in
`STUDIO-LIVE-CANVAS-PLAN.md` §P2 rule 9 as "kept"). The **Inspect** tab (a
read-only report) instead lists every distinct value as its own row under a
repeated label — because there is no write target to unify around, so
collapsing to "Mixed" would just be lossy. **This is the concrete argument
for why Studio's own future read-only Inspect tab (P1's spec: "provenance,
the winning rule, the computed CSS, the source path") should not reuse the
editing surface's Mixed-placeholder idiom** — it should report, not offer a
single field to overwrite N nodes' worth of source.

## Add-property writes a real value, not a placeholder — and that's a real, intentional Studio/Penpot difference

Clicking `+` next to a genuinely empty section (Stroke, Shadow, Blur, Export
on a bare rectangle) in Penpot **both reveals the fields and immediately
writes a working default** — a real `1px solid #000000` stroke appears on
canvas the instant you click, before you've typed anything. Studio's
existing `AddablePropertyField` contract is the opposite by explicit design
(Law 3, `docs/features/inspector-disclosure.md`: "a reveal that emitted
`min-width: 0` would be a bug, not a convenience" — because Studio writes
real source files, and an uncommitted-looking value appearing in a `.tsx` on
disk the moment you open a menu would be a real correctness bug, not a UX
nicety). **Do not "fix" this to match Penpot** — this is the one place this
baseline explicitly recommends divergence, because the two products have
different truths underneath the same-looking button.

## Picker chrome: what was and wasn't captured

The inline color row (swatch, hex input, opacity, remove) is fully measured
(`02-measurements.md`). The full saturation/hue/eyedropper popover that
opens from clicking the swatch was **not** reliably triggerable via this
session's synthetic `PointerEvent` automation — clicks landed but no popover
opened, and this was not worth burning further turns chasing since the
inline row (which is what the overwhelming majority of real edits touch —
type a hex code) is already fully documented. Flagging this explicitly
rather than silently shipping an incomplete claim: **if P3's Fill/Stroke
section work needs the full picker's exact chrome, that still needs a human
(or a future session with real mouse control) to open it and screenshot it.**

## Click counts

See `02-measurements.md` → "Click counts to the most common edit." Every
common edit checked was exactly **2 clicks**: select the shape, then act on
the one field that matters. No search bar, no icon rail, no mode toggle sits
between selection and the edit — directly matching
`STUDIO-LIVE-CANVAS-PLAN.md` §4.0's diagnosis of what makes Studio's current
panel slow (search bar + icon rail + mode-choosing-before-editing all cost a
click or a glance that buys nothing).
