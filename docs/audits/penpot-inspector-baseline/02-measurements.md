# 02 — Measurements

Generated from [`measurements.json`](./measurements.json) — that file is the
source of truth; if this table and the JSON ever disagree, the JSON wins and
this file is stale. All pixel values measured via `getBoundingClientRect()` /
`getComputedStyle()` against the live Penpot `2.17.2` DOM (the right-hand
Design/Inspect panel is ordinary HTML, not canvas-rendered), not eyeballed
from screenshots.

## Panel geometry

| Property | Value |
|---|---|
| Panel width | `318px` |
| Panel horizontal padding | `12px` |
| Panel background (dark) | `#18181A` |
| Panel background (light) | `#FFFFFF` |
| Inspect-tab panel background (dark) | `#121214` |
| Inspect-tab panel background (light) | `#FAFAFA` |

## Tab bar (Design / Prototype / Inspect)

| Property | Value |
|---|---|
| Tab bar height | `32px` |
| Active tab text color (dark) | `#7EFFF5` (teal) |
| Active tab text color (light) | `#6911D4` (purple) |
| Inactive tab text color (dark) | `#8F9DA3` |
| Inactive tab text color (light) | `#495E74` |

Dark and light theme don't just invert lightness — the **accent hue itself
changes** (teal in dark, purple in light). Any single-accent token plan is
wrong for matching this exactly; §04 flags this as a token gap.

## Section headers (`FILL`, `STROKE`, `SHADOW`, `LAYOUT`, …)

| Property | Value |
|---|---|
| Header row height | `32px` |
| Label font size | `12px` |
| Label font weight | `500` |
| Label transform | `uppercase` |
| Label letter-spacing | `normal` (not tracked out) |
| Label color (dark) | `#8F9DA3` |
| Label color (light) | `#495E74` |
| Collapsed-empty state | one `32px` row: title + trailing `+`, **no chevron** |

## Fields (numeric inputs, color rows, etc.)

| Property | Value |
|---|---|
| Row height | `32px` |
| Corner radius | `8px` |
| Background (dark) | `#212426` |
| Background (light) | `#F3F4F6` |
| Font size | `14px` |
| Text color (dark) | `#FFFFFF` |
| Text color (light) | `#000000` |
| Icon-label size (outer svg) | `16×16px` |
| Icon-label glyph size (inner) | `12×12px` |
| Internal gap (icon → input) | `4px` |

## Row rhythm

| Gap | Value |
|---|---|
| Within a tightly-paired row group (e.g. Rotation ↔ Radius) | `4px` |
| Between distinct row groups (e.g. W/H row ↔ X/Y row) | `16px` |

Measured absolute Y-origins at 100% zoom (dark theme, F1 rectangle
selected) illustrate the alternating rhythm: opacity/blend row `y=132`,
W/H row `y=180` (Δ16 from the row above's bottom), X/Y row `y=216` (Δ4),
rotation/radius row `y=252` (Δ4).

## Nudge ladder (measured, not assumed)

| Modifier | Step |
|---|---|
| `↑` / `↓` | `±1` |
| `Shift + ↑/↓` | `±10` |
| `Alt + ↑/↓` | `±0.1` |

Measured directly on the F1 rectangle's X field. This **supersedes** the
`±8` value a prior unmerged branch (`origin/fix/inspector-field-ergonomics`)
tried and reverted in favor of "Figma's model" — the real, measured Penpot
value is `±10` under Shift, i.e. the same value that branch called Figma's.
`panel-20`'s own STATE.md entry flagged this exact risk in advance; it's now
closed with a number instead of a memory.

## Scrub feel

- **Drag handle:** the field's own 16×16 icon glyph (e.g. the `character-x`
  icon to the left of the X axis input) — not a separate strip, not the
  numeric text itself.
- **Ratio:** `1px` of drag ≈ `1` unit, unmodified.
- **Shift held during drag:** `10×` multiplier — a 100px drag moves the value
  by 1000, matching the keyboard Shift step exactly. One coherent "10×" idea
  applied to both keyboard and pointer, not two unrelated numbers.

## Tab order (from the Width field)

`Width → Height → Lock ratio → X axis → Y axis → Rotation → Radius → Show
independent radius → Add layout → …Fill section controls, in reading order`.
Confirms Tab walks the panel top-to-bottom, left-to-right — no jumps.

## Keyboard: Enter / Escape / arithmetic

| Key | Behavior |
|---|---|
| `Enter` | commits the field and blurs it |
| `Escape` | **does not revert.** Measured: focused X (`100`), replaced with `500`, pressed Escape — the field blurred with `500` committed and the shape moved on canvas. Any code or doc assuming Penpot-style "Esc reverts" is wrong; this baseline does not support that assumption for Studio either — it's a fact about Penpot, not a design instruction. |
| Arithmetic | supported inline — typing `100+50` and pressing `Enter` commits `150` |

## Duplicate

Labeled `⌘D` / `Ctrl+D` in the context menu, but the raw shortcut did not
reliably reach the app under browser automation in this session — the
right-click → **Duplicate** menu entry is the reliable, authoritative
trigger and is what this audit used to build the F1 mixed-value sub-case.
(This is a note about driving Penpot via automation, not a claim about a
Penpot bug — a human using a real keyboard should not expect this.)

## Mixed-value rendering (F1 sub-case: two rectangles, one property mixed, one uniform)

### Design tab

| Case | Rendering |
|---|---|
| A mixed numeric field (X differs) | the literal text **`Mixed`** replaces the value, inside normal field chrome |
| A mixed section (Fill: two different colors) | the whole `FILL` section collapses to **one row reading `Mixed`**, with only a remove button — no swatch, no hex, no opacity field |
| A non-mixed section (Stroke: both shapes share `#000000`) | renders completely normally — Mixed is evaluated **per property**, not per selection as a whole |
| Aggregate multi-color view | a separate **`SELECTED COLORS`** section lists *every distinct color anywhere in the selection*, each as a full swatch+hex+opacity row, plus a "select items using this style" icon per color |

### Inspect tab (same two-rectangle selection)

| Case | Rendering |
|---|---|
| Header | reads **`2 Selected`**, not a layer name |
| A property with two distinct values (fill) | **repeats the label** as two separate rows (`Background` / `Background`), each with its own swatch+hex+opacity — the word "Mixed" is never used here |
| Geometry (`Size and position`) | the entire section is **omitted** rather than shown with `Mixed` placeholders |

Design and Inspect disagree on convention on purpose: Design is an editing
surface (one field, one write target, so "Mixed" as a placeholder makes
sense), Inspect is read-only reporting (so it just lists what's really
there, twice, rather than collapsing it).

## Color field chrome

One `28px`-tall inline row per fill/stroke entry: **swatch** (opens the full
picker — not captured, see below) → **hex text input** → **`%` opacity
number field** → **remove button**. The full saturation/hue popover was not
reliably triggerable via synthetic pointer events in this automation pass;
not a blocker since the inline row is what the large majority of edits use,
and it's fully measured above.

## Add-property / collapsed-empty convention

- **Collapsed-empty:** `Title` + trailing `+`, one `32px` row, no chevron —
  matches Studio's own Law 1 already (`docs/features/inspector-disclosure.md`).
- **On `+` click:** Penpot reveals the section's fields **and writes a real
  default value immediately** — clicking Stroke's `+` on a fresh rectangle
  writes a visible `1px solid #000000` stroke, not a placeholder. This is a
  **measured difference from Studio's own contract**, not a gap: Studio's
  `AddablePropertyField` (Law 3 in `docs/features/inspector-disclosure.md`)
  deliberately writes nothing until the user commits a value, because Studio
  edits real source files and a silent default write would show up as an
  unexplained diff. Keep Studio's rule; this is recorded so nobody "fixes"
  Studio to match Penpot here by accident.

## Click counts to the most common edit

| Fixture / edit | Clicks | Steps |
|---|---|---|
| F1 — change fill color | 2 | select the rectangle → type into the Fill hex field |
| F1 — resize via W field | 2 | select the rectangle → type into the W field |
| F1 — add a stroke from empty | 2 | select the rectangle → click Stroke's `+` (already-visible default stroke, no further input needed) |
| F2 — change font size | 2 | select the text layer → type into the Font Size field |
| F3 — change the board's gap | 2 | select the board → type into the column-gap field (row-gap is disabled in single-row mode) |
| F4 — get the source image back out | 2 | select the image, switch to Inspect tab → click `DOWNLOAD SOURCE IMAGE` |

Every common edit measured here is **2 clicks**: select, then act. Nothing in
Penpot's common path costs a 3rd click to reach the right field — no icon
rail, no search bar, no mode toggle to dismiss first. That is the actual bar
`STUDIO-LIVE-CANVAS-PLAN.md` §P6 means by "the P0 click counts for the
common edits matched or beaten."

## Fixture geometry snapshot

See [`01-fixtures.md`](./01-fixtures.md) for the full authored spec and the
rationale for each number; the raw values are duplicated into
`measurements.json` → `fixtureGeometrySnapshot` so a later automated gate can
read fixture facts without parsing markdown.
