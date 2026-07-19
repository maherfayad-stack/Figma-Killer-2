# PENPOT DESIGN TAB — EXHAUSTIVE 1:1 AUDIT & REMEDIATION PLAN

Human ask (2026-07-19, dogfood round 6, WITH side-by-side screenshots — "9th time"):
> "do the same [+/add model] also for layout and container and others… there is a lot
> of redundant info like here there is **title and current**… in penpot it's much
> faster easier and cleaner, with not all these un-needed details. Look again at penpot
> design tab implementation and make it 100% 1:1. Make an audit between both and
> document **every tiny little detail**."

This is that audit, at maximum granularity. **Every Penpot claim is cited to real source**
under `../penpot/frontend/src/app/main/ui/`. It supersedes the Design-tab portion of
`PENPOT-PARITY-CHECKLIST.md`. Read `workspace/sidebar/options/` = `WSO/`.

Legend: ✅ match · ⚠️ present-but-wrong · ❌ missing · ➕ we render extra (delete) ·
📐 dimension/token · 🎯 exact remediation.

---

# PART A — SYSTEMIC RULES (apply to every section)

These four rules are violated *repeatedly* across our Inspector; fixing them once, everywhere,
is 80% of the "1:1" gap.

## A1. The shared `title-bar*` contract — `ui/components/title_bar.cljs:14-42`
Every collapsible section header is ONE component. Its exact structure:
```
[.title-bar (+ section class)]
  IF collapsable:                          ; collapsable = (section has ≥1 value)
    [.title-wrapper]
      <button on-click=on-collapsed>
        [icon  arrow-right (collapsed) | arrow-down (expanded)  size="s"]   ; THE chevron
        [.title  <label>]
  ELSE (empty section):
    [.title-only  <label>]                 ; NO chevron at all, just the label text
  {children}                               ; e.g. the [+] icon-button, the [⋮] menu, the [−]
```
**Consequences we get wrong:**
- An **empty** section shows **label + `+` only, NO chevron** (`.title-only`). We render a
  chevron always (our `Panel` always shows a disclosure arrow).
- The chevron is `arrow-right`→`arrow-down` (real Penpot SVGs, size "s"), left of the label.
- The `+`/`⋮`/`−` action buttons live in the SAME row, right-aligned, as `title-bar` children.
- 🎯 Build ONE `AddableSection` primitive matching this exactly; every optional section uses it.

## A2. NO "current value" caption lines — the #1 redundancy
Grep of `measures.cljs`, `layer.cljs`, `layout_container.cljs`, `fill.cljs`, `text.cljs`:
**there is no secondary text node under any control.** The live value is shown by (a) the
input's own `:value`, or (b) the segmented button's `:selected` state. Nothing else.

Ours: `CurrentValueLine` + `formatCurrentValue` (`inspector-computed-values.ts:111`) emit a
literal `Current: <value>` line under **~15 controls** (Inspector.tsx:1063, 1228, 1615, 1879,
2279, 2346, 2395, 2606). This is exactly the "title AND current / un-needed details" the human
keeps flagging.
- 🎯 Delete every `CurrentValueLine` render + `formatCurrentValue`. Keep the **seed** (the
  control already pre-fills from computed style — the value just lives *in* the field now).

## A3. The bare-block rule — header + measures have NO section title
`layer.cljs` and `measures.cljs` contain **no `title-bar*`**. They are flat blocks at the very
top: no "Layer" heading, no "Size & position" heading, no chevron, no uid readout.
Ours wraps both in `<Panel title="Layer">` / `<Panel title="Size & position">` and prints a
`node.uid` mono line (Inspector.tsx:800-809).
- 🎯 Render both as bare `<div>` blocks. Delete the uid line, the "Layer"/"Size & position"
  titles, and their chevrons.

## A4. Universal control metrics — 📐 from `*.scss`
- Control **height = `$s-32` = 32px** (measures.scss:34,189; every `numeric-input`, `select`).
- **border-radius = `$br-8` = 8px** (measures.scss:36,188,222).
- Inner **padding = `$s-8` = 8px**; **gaps = `--sp-xs` = 4px** (measures.scss:18,35,207).
- Numeric field = `[icon/letter span][number input]` inside one 32px rounded tertiary-bg box.
  The leading token is either an **icon** (`i/rotation`, `i/corner-radius`, `i/gap-vertical`…)
  or a **1-char letter** (`W` `H` `X` `Y` `Z` or `MIN W`/`MAX H`) in `.icon-text`.
- Rows use CSS **grid with `subgrid`** so the W/H/X/Y columns align vertically (layer.scss:37,
  measures.scss:160). Our fl…box rows don't column-align across rows — a visible difference.
- Segmented groups = ONE rounded (`$br-8`) tertiary-bg container, buttons inside, active =
  quaternary bg + teal fg (radio_buttons.scss). We have `SegmentedGroup` for this (W4b-5) ✅.

---

# PART B — SECTION-BY-SECTION DEEP AUDIT (top-to-bottom, exact order)

Order verbatim from `WSO/shapes/frame.cljs:100-173` (rect = same minus presets/clip/frame-grid):
**layer → measures → component → LAYOUT → grid-cell → layout-item → constraints → FILL →
STROKE → SELECTED-COLORS → SHADOW → BLUR → GUIDES(frame-grid) → EXPORT.**

---

## B1. LAYER HEADER — `WSO/menus/layer.cljs` · 📐 layer.scss:81
**Penpot:** bare `.element-set-content`, no title. Grid columns:
`[blend-select (wide)] [opacity (small)] [eye] [lock]`.
- **Blend mode** `<select>`, default `:normal`, **16 options** (layer.cljs:189-204):
  Normal · Darken · Multiply · Color burn · Lighten · Screen · Color dodge · Overlay ·
  Soft light · Hard light · Difference · Exclusion · Hue · Saturation · Color · Luminosity.
  Hovering an option live-previews it on canvas (we can't/needn't replicate the preview).
- **Opacity**: `.input` = `%` span + numeric, min 0, max 100, placeholder `--`, right-aligned;
  **disabled when the layer is hidden**.
- **Eye** icon-button: `i/shown` when visible (click → hide), `i/hide` when hidden (click →
  show). aria "toggle-layer". When hidden, whole section gets `.hidden` (dimmed).
- **Lock** icon-button: `i/unlock` when unlocked (click → lock), `i/lock` when locked.

**Ours (Inspector.tsx:770-863):** `<Panel title="Layer">` + type-icon + label + **uid line** +
`LayerHeaderRow` = blend `GroupSelect` ✅ + opacity `GroupSelect` ✅ + **2 disabled
`StubIconButton`s** (eye `shown`, lock `unlock`).
| Delta | Verdict | 🎯 |
|---|---|---|
| Wrapped in titled Panel + uid line | ➕ | Render bare, drop title/chevron/uid (A3) |
| Blend list — verify all 16 present in `BLEND_MODE_GROUP` | ⚠️ | reconcile to the 16 above, same labels |
| Eye/lock are disabled stubs | ⚠️ | W4b-8: eye→`hidden` class (real); lock stays honest stub (disclosed) |
| Opacity not disabled-when-hidden | ⚠️ | disable opacity when hidden class present |

---

## B2. MEASURES — `WSO/menus/measures.cljs` · 📐 measures.scss
**Penpot:** bare `.element-set`, aria `shape-measures-section`, **no title**. Sub-rows gated by
`type->options` (measures.cljs:58-77):
- generic (group/text/path/bool/circle/svg) → **size · position · rotation**
- **rect** → + **radius**
- **frame** → **presets · size · position · rotation · radius · clip-content · show-in-viewer**

### B2a. Presets row (frame only) — measures.cljs:470-532
`[.presets-wrapper: "Size presets" label + arrow chevron]` opens a **dropdown**: a
`search-bar*` (autofocus, placeholder "Search…") + `.preset-list`. List items are **category
headers** (disabled, e.g. "Android", "iOS", "Web") followed by presets; each preset row =
`[name] [width " x " height]`, and a **tick** (`i/tick`) when it equals current W×H
(measures.cljs:496-515). Then an **orientation** `radio-buttons` (wide): **`i/size-vertical`
(portrait) + `i/size-horizontal` (landscape)**, selected by `(> width height)`. Then a
**`i/fit-content` icon-button** (aria "fit-content").
> ⛔ CORRECTION to prior passes: these are **orientation portrait/landscape + fit-content**, NOT
> "phone/tablet" device-type icons. The presets are a **searchable text dropdown**, not quick
> device buttons.

### B2b. Size row — measures.cljs:534-595
`[W field][H field][proportion-lock button]`. W/H = `.icon-text` letter ("W"/"H") + numeric,
**min 0.01**, placeholder `--`/`Mixed`. Disabled when the element is flex auto/fill sized.
Proportion-lock icon-button: `i/lock` (locked, `.selected`) / `i/unlock` (unlocked), disabled
if `:multiple`.

### B2c. Position row — measures.cljs:597-648
`[X field][Y field]`. `.icon-text` "X"/"Y" + numeric. **Disabled when flex-child & not
absolute** (an in-flow item can't be positioned).

### B2d. Rotation + Radius row — measures.cljs:650-685
`[rotation field][border-radius-menu]`. Rotation = `i/rotation` glyph + numeric, **min -359
max 359**, wraps. Radius = `border-radius-menu*` (B2e).

### B2e. Border radius — `WSO/menus/border_radius.cljs`
- **Collapsed:** `.radius-1` = `i/corner-radius` (size "s") + single numeric (min 0, nillable)
  + a **`i/corner-radius` icon-button toggle** (`.selected` when expanded).
- **Expanded** (toggle on): `.radius-4` = **4 small inputs**, order **TL(r1) · TR(r2) · BL(r4) ·
  BR(r3)** (note the r1/r2/r4/r3 layout), + the same toggle button. aria
  "show-single-corners"/"hide-all-corners".

### B2f. Clip-content + Show-in-viewer (frame only) — measures.cljs:687-717
Two icon checkboxes: **clip-content** (`i/clip-content`, checked = clips) + **show-in-viewer**
(`i/play`, checked = shown in view mode).

**Ours:** `SizePositionSection` (element, Inspector.tsx:2212) + `FrameSizeSection` (frame, 2469),
both `<Panel title="Size & position">`. Has W/H/X/Y/rotation/radius direct fields (W4b-3a) ✅,
per-corner toggle + aspect-lock (W4b-7) ✅ — **but each field carries a `Current:` caption**;
frame version uses **text device buttons "Phone/Tablet/Desktop"** + `DEVICE_QUICK_PRESETS`.
| Delta | Verdict | 🎯 |
|---|---|---|
| Titled Panel | ➕ | bare block (A3) |
| `Current:` under W/H/X/Y/rot/radius | ➕ | delete all (A2) |
| Frame presets = text device buttons | ⚠️ | replace with **searchable "Size presets" dropdown** (name + "W×H" + tick) per B2a |
| No orientation portrait/landscape radios | ❌ | add `size-vertical`/`size-horizontal` radios + `fit-content` button |
| Radius toggle = separate stub earlier | ✅ now (W4b-7) | verify corner order TL/TR/BL/BR + inline `corner-radius` toggle icon (not a distinct stub) |
| No clip-content / show-in-viewer (frame) | ❌ | add the 2 icon-checkboxes (`clip-content`,`play`) for frames |
| X/Y not disabled when in-flow | ⚠️ | disable X/Y unless absolute (we partially do) |
| Rows not column-aligned (no subgrid) | ⚠️ | grid-align W/H/X/Y columns (A4) |

---

## B3. COMPONENT — `WSO/menus/component.cljs`
Only for component instances. Ours = `ComponentPropsSection` (instance-only branch) ✅ shape.
Out of the "make Design tab 1:1 for normal shapes" scope; leave as-is.

---

## B4. LAYOUT — `WSO/menus/layout_container.cljs:1287-1420` · the human's headline ask
**Penpot title-bar** "Layout" (`labels.layout`), collapsable **only once a layout exists**:
- **Empty** (no layout): `.title-only` "Layout" + **`+` (`i/add`)** → adds flex layout.
- **Has layout**: chevron + "Layout" + **`⋮` (`i/menu`)** (opens add-layout dropdown to switch
  **Flex ↔ Grid**) + **`−` (`i/remove`)** (removes layout).

**Flex body** (open + flex), layout_container.cljs:1328-1349:
- **Row 1** `.first-row`: **align-items** (`align-row`: start/center/end — 3 radio icons, icons
  are column-aware via `get-layout-flex-icon`) + **direction** (`direction-row-flex`: row /
  row-reverse / column / column-reverse — 4 radio icons) + **wrap** (`wrap-row`: single toggle
  button, `wrap` icon, `.selected` when wrapping).
- **Row 2** `.second-row`: **justify-content** (`justify-content-row`: start/center/end/
  space-between/space-around/space-evenly — 6 radio icons, column-aware) + **help** icon-button
  (`i/help`).
- **When wrap=wrap**: **align-content** row (start/center/end/space-between/space-around/
  space-evenly — 6 icons; icon set `align-content-column-*` / `align-content-row-*`).
- **Gap** row: `[row-gap: i/gap-vertical]` + `[column-gap: i/gap-horizontal]`, min 0, each
  disabled per wrap state.
- **Padding**: **simple** = `[vertical p1: i/padding-top-bottom][horizontal p2:
  i/padding-left-right]`; a **`padding` mode toggle button** switches to **multiple** = 4 sides
  `[top: padding-top][right: padding-right][bottom: padding-bottom][left: padding-left]`.

**Grid body** (open + grid): `direction-row-grid` (row/column) + grid align/justify rows +
`edit-grid` button + track editors.

**Ours (Inspector.tsx:2670):** `<Panel title="Layout container" icon="flex">`, always shown
with all rows, **no `+`/`⋮`/`−` add-model**; groups use `hideLabel` (W4b-3b) ✅. No wrap-driven
align-content gating visible; padding present.
| Delta | Verdict | 🎯 |
|---|---|---|
| No add-model (always populated) | ❌ | wrap in `AddableSection`: empty→`+`; added→`⋮`(flex↔grid)+`−` |
| Title "Layout container" | ⚠️ | rename → **"Layout"** |
| Direction has 4 options? verify row-reverse/col-reverse | ⚠️ | ensure all 4 in `DIRECTION_GROUP` |
| align-content only when wrap | ⚠️ | gate align-content row on wrap=on |
| Gap = single combined? | ⚠️ | Penpot has **row-gap + column-gap** separate (we collapse to one `gap-*` — disclosed carry-forward, OK) |
| Padding simple↔multiple toggle | ⚠️ | verify the 4-side toggle exists (`padding` mode button) |
| icon-only rows | ✅ (W4b-3b) | keep |

---

## B5. LAYOUT ITEM — `WSO/menus/layout_item.cljs:762-952`
**Penpot title-bar with a DYNAMIC title** (layout_item.cljs:799-822):
"Flex board" / "Grid board" / "Layout board" (when it's a container & not a child) ·
"Flex element" / "Grid element" / "Layout element" (when it's a child). collapsable when has
layout content.
Body:
- **Position row** (when child or absolute): `static | absolute` radio (wide) + **z-index**
  field (`.icon-text` "Z").
- **Behaviour row**: horizontal (`i/fixed-width` fix / `i/fill-content` fill / `i/hug-content`
  auto) + vertical (same icons **rotated**). `fix` always; `fill` when has-fill; `auto` when
  container.
- **Align-self** (when child & flex parent): start / center / end — **`allow-empty`** (can
  deselect back to none).
- **Margin** (when child): simple `[vertical m1: margin-top-bottom][horizontal m2:
  margin-left-right]` or multiple 4-side (`margin-top/right/bottom/left`) + `margin` mode toggle.
- **Size constraints** (when h/v sizing = fill): `[MIN W][MAX W]` and/or `[MIN H][MAX H]`
  (`.icon-text` letters).

**Ours (Inspector.tsx:2948):** `<Panel title="Layout item">` + align-self group (has
`noConfidentDefault`) ✅ + grow group. Missing most: dynamic title, position static/absolute +
z-index, behaviour fix/fill/auto with the exact icons, margin simple/multiple, size constraints.
| Delta | Verdict | 🎯 |
|---|---|---|
| Static title "Layout item" | ⚠️ | dynamic title (Flex/Grid/Layout × board/element) |
| No position static/absolute + z-index | ❌ | add radio + Z field |
| Behaviour icons | ⚠️ | map fix/fill/auto → `fixed-width`/`fill-content`/`hug-content` (v rotated) |
| No margin controls | ❌ | add simple/multiple margin (maps to Tailwind `m*`/`mx`/`my`/`mt…`) |
| No min/max size constraints | ❌ | add MIN/MAX W/H (maps to `min-w-`/`max-w-`/`min-h-`/`max-h-`) |
| align-self ✅ | ✅ | keep |

---

## B6. CONSTRAINTS — `WSO/menus/constraints.cljs`
Penpot: shows only for non-layout children (pin left/right/top/bottom/center/scale). Vector-ish;
maps poorly to DOM flow. **Ours: absent.** 🎯 Disclose as out-of-scope (no clean DOM analog) OR
add later; not a headline gap. Leave documented, deferred.

---

## B7. FILL — `WSO/menus/fill.cljs:200-267`
**Penpot title-bar** "Fill", collapsable when has-fills. **`+` (`i/add`, disabled when
`can-add-fills?` is false)** always (unless multiple). Body = N × `color-row*` (B12 anatomy).
**Frame only:** a **"Show in exports"** checkbox (label `show-fill-on-export`, `status-tick`
icon when checked) — fill.cljs:252-267.

**Ours:** `FillSection` (Inspector.tsx:3126) with W4b-6 add-model ✅.
🎯 Verify: (a) empty state is `title-only` (no chevron) per A1; (b) "Show in exports" checkbox
present for frames; (c) no `Current:` caption.

---

## B8. STROKE — `WSO/menus/stroke.cljs:200-230`
**Penpot title-bar** "Stroke", collapsable when has-strokes. `+` (`i/add`). Body = N ×
`stroke-row*`: **color swatch + hex + opacity %**, **width** numeric, **style** select
(solid / dotted / dashed / mixed), **position** select (center / inner / outer), stroke **caps**
(for open paths), `−` remove.
**Ours:** `StrokeSection` (3212), W4b-6 add-model ✅ (single value: `border`). Missing the
style/position selects.
🎯 add stroke **style** (`border-solid/-dashed/-dotted`) + **width** already; position n/a for
DOM border (disclose). Empty state `title-only`. No caption.

---

## B9. SELECTED COLORS — `WSO/menus/color_selection.cljs`
**Penpot:** a title-bar section aggregating **every color used across the selection** as editable
swatches; editing one swatch updates all shapes using it. **Ours: absent (❌).**
🎯 New section: scan the focused node's `background-color`/`color`/`border-color` → render each
as a `ColorControl` swatch (reuse W4b-3c). Editing rewrites that specific property. Disclose it's
per-node (not cross-selection) since we inspect one node.

---

## B10. SHADOW — `WSO/menus/shadow.cljs:140-185`
**Penpot title-bar** "Shadow", collapsable when has-shadows. `+` (`i/add`). Body = N ×
`shadow-row*`: `⋮` reorder handle + **type select (Drop shadow / Inner shadow)** + **eye**
toggle (per-shadow hide) + `−` remove; expanded row body = **X · Y · Blur · Spread** numerics +
a **color row**.
**Ours:** `ShadowSection` (3273), W4b-6 add-model ✅ (single `box-shadow`). 
🎯 Verify empty=`title-only`; the expanded row exposes X/Y/Blur/Spread + color + Drop/Inner
select (screenshot shows we already have `⋮ Drop shadow ▾ 👁 −` + `X/Y/Blur/Spread/color` — good;
just confirm no caption + title-only empty state).

---

## B11. BLUR — `WSO/menus/blur.cljs:265-300`
**Penpot title-bar** "Blur" / "Blur effects", collapsable when blur-values exist. `+` (`i/add`,
only when under the limit). Body = a blur **value** numeric (+ layer/background blur type).
**Ours: absent (❌).** 🎯 New `AddableSection`: `+` adds `blur-sm` (or `backdrop-blur-sm`), body =
numeric mapping to `blur-[Npx]`; `−` removes.

---

## B12. GUIDES (frame-grid) — `WSO/menus/frame_grid.cljs` (frames only)
**Penpot:** square/columns/rows layout **guides** on a board, `+` to add, each with color +
params. Vector-overlay concept. **Ours: absent (❌).** 🎯 Low-priority; add the `+` shell and
**disclose** the add is a stub if no DOM analog, OR defer. Document, don't fake.

---

## B13. EXPORT — `WSO/menus/exports.cljs:205-264`
**Penpot title-bar** "Export", collapsable when has-exports. `+` (`i/add`). Body = N × row:
**format select** (PNG / JPG / WEBP / SVG / PDF) + **scale select** (0.5x / 0.75x / 1x / 1.5x /
2x / 4x / 6x) + **suffix** text input + `−` remove; + an "Export" action button.
**Ours: absent (❌).** 🎯 Add the `+` shell; wire to our real export affordance if one exists,
else disclose stub. Document.

---

## B14. TYPOGRAPHY (text shapes) — `WSO/menus/text.cljs` + `typography.cljs`
**Penpot** (text.cljs): font-family, font-size, line-height, letter-spacing, font-variant
(weight/style); **text-align** (left/center/right/justify — `text-align-*` icons); **direction**
(ltr/rtl); **vertical-align** (top/middle/bottom); **grow** (fixed/auto-width/auto-height);
**decoration** (underline `i` / line-through / none); **text-transform** (upper/lower/title).
**Ours:** `TypographySection` (2999) has size/weight/leading/tracking/text-align (with
`seedFromLive` fix) + color. Missing: vertical-align, direction, decoration, transform, grow.
| Delta | 🎯 |
|---|---|
| No text-decoration | add underline/line-through (`underline`/`strikethrough`) |
| No text-transform | add upper/lower/capitalize |
| No vertical-align / direction / grow | add (map to `content-*`, `dir`, `w-auto/h-auto`) |
| `Current:` captions | delete (A2) |

---

# PART C — ICON INVENTORY (exact Penpot `i/*` ids to vendor/verify)
Confirm each exists in `packages/ui/src/icons/registry.ts` (source
`../penpot/frontend/resources/images/icons/*.svg`, MPL-2.0):
- Header: `shown`, `hide`, `unlock`, `lock`, `percentage`.
- Measures: `size-vertical`, `size-horizontal`, `fit-content`, `rotation`, `corner-radius`,
  `clip-content`, `play`, `tick`, `arrow` (presets chevron).
- Layout: `add`, `menu`, `remove`, `help`, `wrap`, `align-content-{row,column}-{start,center,
  end,around,between,evenly,stretch}`, direction icons, `gap-vertical`, `gap-horizontal`,
  `padding-top-bottom`, `padding-left-right`, `padding-top/right/bottom/left`.
- Layout-item: `fixed-width`, `fill-content`, `hug-content`, `margin-top-bottom`,
  `margin-left-right`, `margin-top/right/bottom/left`, `margin`.
- Sections: `add`, `remove`, `menu`, `status-tick` (fill checkbox), `arrow-right`, `arrow-down`.
- Typography: `text-align-{left,center,right,justify}`, `underline`, `strikethrough`.
> Many landed in W4b-2/3a/3b. The git status shows `align-content-*`, `padding-*`,
> `gap-horizontal` newly added — good; verify the full list above is registered.

---

# PART D — SEQUENCED WORKSTREAMS (all UI → static-gated, human dogfoods)

Ordered by visible impact. Each ends with a static gate + a screenshot the human compares.

### W4b-9 — SYSTEMIC DECLUTTER ★ do first (pure deletion/re-home, no new controls)
Implements **A1–A4**: delete all `CurrentValueLine`/`formatCurrentValue`; de-Panel + un-title
the Layer header and Measures block (bare `<div>`s, drop the uid line); delete `ContentSection`
and `CodeSection` from the Design stack; introduce the `AddableSection` primitive (A1) and
retrofit Fill/Stroke/Shadow onto it (empty = `title-only`, no chevron). Column-align W/H/X/Y via
grid (A4). **This alone closes most of the "redundant / not clean" gap.**

### W4b-10 — LAYOUT + BLUR/EXPORT add-model
Generalize `AddableSection` to **Layout** (empty→`+`; added→`⋮` flex↔grid + `−`; rename
"Layout"), gate align-content on wrap, verify padding simple/multiple toggle. Add **Blur** and
**Export** `+` shells (real where possible, disclosed stub otherwise).

### W4b-11 — MEASURES fidelity
Replace text device buttons with the **searchable Size-presets dropdown** (name + "W×H" + tick),
add **orientation portrait/landscape radios + fit-content**, add **clip-content/show-in-viewer**
(frames), confirm per-corner order TL/TR/BL/BR + inline `corner-radius` toggle.

### W4b-12 — LAYOUT ITEM + TYPOGRAPHY completeness
Dynamic layout-item title; position static/absolute + z-index; behaviour fix/fill/auto icons;
margin simple/multiple; min/max size constraints. Typography: decoration, transform,
vertical-align, direction, grow.

### W4b-13 — SELECTED COLORS section (B9).

### W4b-8 (already queued) — Visibility (eye) toggle → `hidden` class; lock stays honest stub.

### FINAL — strict holistic side-by-side sweep vs the human's screenshots.

---

# PART E — ACCEPTANCE CHECKLIST (sharpened, per-detail)
- [ ] Panel opens into TWO **title-less** clusters (layer header, then measures) — no "Layer" /
      "Size & position" headings, **no uid line**, no chevron on either.
- [ ] **Zero** `Current: …` caption lines anywhere in the tab.
- [ ] Every optional section (Layout, Fill, Stroke, Shadow, Blur, Guides, Export) shows
      **label + `+` only, NO chevron** when empty; expands to chevron + `−` (+ `⋮` for Layout)
      once populated.
- [ ] Measures: searchable Size-presets dropdown (name + "W×H" + tick), orientation
      portrait/landscape radios, fit-content button, W/H/X/Y grid-aligned, per-corner TL/TR/BL/BR.
- [ ] Layout renamed "Layout", add-model wired, align-content only when wrap.
- [ ] Layout item: dynamic title, static/absolute + z, behaviour icons, margin, min/max.
- [ ] SELECTED COLORS present when the node has colors.
- [ ] No Content or Code panel in the Design tab.
- [ ] Controls are 32px tall, 8px radius, 4/8px gaps; segmented groups = one tertiary pill.

---

# PART F — HONEST LIMITS (disclose, never fake)
- **Constraints / Guides / Export / Selected-colors** are partly vector-native in Penpot; where
  our code-first DOM model can't fully back them, render the Penpot chrome with a **disclosed
  stub** add-action, never a silent no-op.
- **Gap** (single combined `gap-*` vs Penpot's row-gap+column-gap), **single-valued
  Fill/Stroke/Shadow** (one CSS property vs Penpot arrays), and **stroke position** (no DOM
  analog) are disclosed carry-forwards from earlier passes.
- **Live blend-mode hover-preview** on canvas is a Penpot-renderer feature we intentionally skip.
