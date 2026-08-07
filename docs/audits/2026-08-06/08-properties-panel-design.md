# Properties Panel Design Audit

Scope: `src/admin/pages/site/panels/PropertiesPanel/**`, `src/admin/pages/site/property-controls/**`,
`src/admin/pages/site/sidebars/**`, `src/ui/components/**` primitives, `src/styles/globals.css`.

## Headline finding

This panel is **much further along than a typical audit would expect**. WS-6.1–6.4 of
`STUDIO-IMPORT-V2-PLAN.md` are largely *already shipped*: `ScrubInput` (drag-to-scrub +
arrow-key nudge + Shift/Alt modifiers + `MIXED`), `StyleTargetChip` (WS-6.2's honest
element/class chip), `AlignBar`, `SpacingBoxControl` (padding/margin box-model diagram),
`BorderControl` (per-side + per-corner), `SizeSection`/`PositionSection` (paired W/H,
TRBL grid), and the Figma-ish section order (Position → Size → Layout → Spacing →
Background → Border → Effects → Typography → Interaction, `cssControlTypes.ts:374-382`)
all exist and are wired into `StyleSectionsEditor`. The remaining work is narrower than
"redesign from scratch": (1) two specific widgets (`SpacingBoxControl`, `BorderControl`)
are *less* dense than Figma despite being visually impressive, (2) several numeric/enum
controls fall back to generic text/select rows instead of the icon-toggle/scrub treatment
neighboring sections already have, (3) multi-selection (2+ nodes, 2+ classes) cannot edit
styles at all — no `MIXED` wiring outside the board-frame bulk inspector, and (4) the
panel's minimum width (300px) and default (360px) are 1.25–2.2× Figma's ~240px.

---

## Q1 — Density audit (px measurements)

| Element | Current px | Evidence | Figma target | Verdict |
|---|---|---|---|---|
| Panel default width | 360px | `uiSlice.ts:29` `PROPERTIES_PANEL_DEFAULT_WIDTH = 360` | ~240px | **Too wide** |
| Panel min/max width | 300 / 520px | `workspaceLayout.ts:9-10` `SIDEBAR_MIN_WIDTH=300, MAX=520` | ~200–320px | **Min too high** |
| Panel header height | 36px | `PanelHeader.module.css:8` | ~32-40px | OK |
| Section toggle (accordion header) row | min-height 32px | `Section.module.css:27` | 32px | **Matches** |
| Input / Select / ScrubInput / ColorInput field height (sm, the default) | 28px | `Input.module.css:48-52`, `Select.module.css:100-105`, `ScrubInput.module.css:44-46` | 32px | Close (Figma is 32, panel default is `sm`=28, `md`=32 exists but is unused by default) |
| Input xs size | 24px | `Input.module.css:42-46` | n/a | — |
| Generic `ClassPropertyRow` inline row | grid `100px 1fr`, `min-height: 28px` | `ControlRow.module.css:4-10` | Figma has **no side label column** at all — label is inside the field or an icon | **Label column costs ~100px of the panel's ~330px usable width (≈30%) on every generic row** |
| Row vertical gap (Section body) | `var(--space-s)` ≈ 6-8px | `Section.module.css:106-109`, `StackedPropertyGrid.module.css:8-11` | ~8px | OK |
| Style-target chip row | padding `var(--space-2xs) var(--space-s)` ≈ 4-6/6-8px, chip height 22px | `StyleTargetChip.module.css:1-6,35-40` | n/a (Studio-only) | OK, compact |
| Search bar row | `padding-top: var(--space-8xl)` (32-40px) + `padding-bottom: var(--space-l)` (10-12px) | `StyleSurface.module.css:40-44` | n/a | Reasonable — it's an absolutely-positioned overlay, not extra flow height |
| **SpacingBoxControl (padding+margin diagram)** | `max-width: 280px; aspect-ratio: 4/3` → **~210px tall** | `SpacingBoxControl.module.css:22-28` | Figma: one row per box (~28-32px each), 2 rows total ≈ 60-70px | **~3× taller than Figma's equivalent** |
| **BorderControl side/corner pickers + 3 field rows** | `SidePicker`/`CornerPicker` boxes + 3-4 `FieldRow`s each ≈ 130-160px combined | `BorderControl.tsx:255-369` | Figma: 1 row (fill+width+style) + 1 row (4 radius numbers) ≈ 60px | **~2-2.5× taller** |
| Style category rail (right column) | fixed 32px column, `StyleSurface.module.css:6-10` `grid-template-columns: minmax(0,1fr) 32px` | always reserved even when nothing needs it | n/a | Minor — 32px is permanently subtracted from the ~330px content column on every row |

**Net:** the *row-level* rhythm (28-32px controls, 32px section headers, 6-8px gaps) already
matches Figma's cadence closely. The density problem is concentrated in (a) the 100px label
column used by every non-curated row, (b) the panel's own width budget (300-520px vs
Figma's ~240), and (c) two specific "visual" widgets that are geometrically striking but
consume 2-3× the vertical space of Figma's plain numeric equivalents.

---

## Q2 — Layout structure

- **Section count:** 9 curated `CLASS_STYLE_SECTIONS` (Position, Size, Layout, Spacing,
  Background, Border, Effects, Typography, Interaction — `cssControlTypes.ts:383-552`) +
  the Module section + a Custom-properties catch-all (`StyleSectionsEditor.tsx:109-121`).
  All are `Section` accordions and **are already collapsible**
  (`StyleSectionsEditor.tsx:169-178`, default open/closed driven by the
  `propertiesSectionsExpanded` preference).
- **Order:** already matches WS-6.1's Figma-shaped order almost exactly (comment at
  `cssControlTypes.ts:374-382` states this explicitly) — Position/Size/Auto-layout/
  Spacing/Fill(Background)/Stroke(Border)/Effects/Typography, with Interaction appended
  as Studio's own addition. **No reordering work needed.**
- **Missing top row (WS-6.1's first row):** the "align row: 6 icon buttons + distribute"
  for the *selected element relative to its siblings/parent* does not exist for node
  selection. `AlignBar` (`src/ui/components/AlignBar/`) exists but is wired **only** into
  `FrameBulkInspector.tsx` (board-frame bulk alignment) — grep confirms zero other usages.
- **Missing "Export" section** (WS-6.1's last row, PNG 1×/2×/SVG) — no export control
  anywhere under `PropertiesPanel/` (verified: no "Export"/"PNG"/"SVG export" strings).
- **Scroll:** one continuous scroll container (`StyleSurface.module.css:6-19`,
  `overflow-y: auto`), with a sticky rail (`railSticky`, `position: sticky`) and an
  absolutely-positioned sticky search bar. This is the right shape — not a stacked-tabs
  problem — but with 9 sections + Module + Custom all expanded by default (`defaultOpen`
  true for size/layout/spacing per `cssControlTypes.ts:401,417,444`), a freshly selected
  element can present 4 open sections (~600-900px of content) before any scrolling,
  which is the *opposite* problem from "too much chrome": for a typical `<div>` most users
  scroll past Effects/Typography/Interaction just to reach the class picker's next action.
- **Chrome vs. controls, rough tally for a single class with a few properties set:**
  PanelHeader 36px + StyleTargetChip row ~30px + search bar overlay (0 extra flow height)
  + per-open-section header 32px × N. For 3 default-open sections (Size, Layout, Spacing)
  that's 3×32=96px of section-header chrome before any control renders — acceptable, this
  is exactly Figma's own per-section header cost.
- **Rail column:** permanently reserves 32px of horizontal width
  (`StyleSurface.module.css:10`) regardless of content — on a 360px panel with ~16-24px of
  padding, that rail is ~9-10% of the panel's total width spent on navigation chrome that a
  scroll-spy + section list could otherwise absorb (Figma has no persistent icon rail at
  all inside its inspector — this is a Studio-only addition, useful for search/filter
  jump-to but not free).

---

## Q3 — Label strategy: text that should be an icon or unit-suffix

Already converted to icon/in-field labels (good — do not touch):
- Size: `W`/`H`/`Min W`/`Min H`/`Max W`/`Max H` in-field labels via `ScrubInput`'s `label`
  prop (`SizeSection.tsx:70,81,92,...`).
- Position offsets: `ArrowBarUp/Right/Down/LeftIcon` as leading icon-labels
  (`PositionSection.tsx:122-169`, `.directionCell` in `LayoutSection.module.css:147-171`).
- Spacing (padding/margin): no label at all, in-diagram number
  (`SpacingBoxControl.tsx` `SideInput`).
- Border sides/corners: click targets on a diagram (`BorderControl.tsx` `SidePicker`/
  `CornerPicker`), though the 3 field rows below (`Width`/`Style`/`Color`) still use
  full-word `FieldRow` labels (`BorderControl.tsx:408-415`) — a shorter Figma treatment
  would be a small swatch + numeric field with no word "Color"/"Width" at all.

Still full-word labels where Figma uses icons — every one of these renders through
`ClassPropertyRow` → `ControlRow`'s 100px label column (`ControlRow.module.css:6-10`)
using `cssPropertyLabel()` (`cssControlTypes.ts:352-355`, turns `textAlign` into
"Text align"):
1. `textAlign` (`left/center/right/justify`) — currently a `SelectControl` dropdown
   (`cssControlTypes.ts:95`, dispatched via `getCSSPropertyControlType` → `'select'` in
   `ClassPropertyRow.tsx:226-248`). Figma: 4 icon buttons (align-left/center/right/justify).
2. `textDecoration` (`none/underline/line-through/overline`) — same dropdown pattern.
   Figma: icon toggle.
3. `textTransform` (`none/uppercase/lowercase/capitalize`) — same. Figma: icon toggle
   or abbreviated `Aa`/`AA`/`aa` chips.
4. `fontStyle` (`normal/italic`) — same dropdown. Figma: a single `I` toggle button.
5. `objectFit` (`cover/contain/fill/none/scale-down`) — dropdown; Figma-style tools use
   a 5-icon row.
6. `overflow`/`overflowX`/`overflowY` — dropdown; low-value to convert (rare + long labels
   are fine here), noted for completeness only.
7. `cursor`, `pointerEvents`, `userSelect`, `scrollBehavior` (Interaction section) — all
   `SelectControl` dropdowns with a "Cursor"/"Pointer events" word label above in stacked
   layout (`StackedPropertyGrid` via `InteractionSection.tsx`). Lower priority (rare edits)
   but still eligible for icon compaction later.
8. `opacity` — plain text/number row with no `%` suffix affordance
   (`NUMBER_TYPED_PROPS` in `cssControlTypes.ts:51`, rendered as generic `TextControl`,
   no unit chrome). Figma always shows `%` inline.
9. `boxSizing` — dropdown with the full string `border-box`/`content-box`; Figma has no
   direct equivalent but a 2-icon toggle (`⬚`/`▢`) would compact it.

---

## Q4 — Field grouping

**Already composite (keep):**
- W/H + Min/Max paired rows — `SizeSection.tsx:66-133` (`sizeGrid`, 2-col).
- TRBL 2×2 grid for position offsets — `PositionSection.tsx:120-171`,
  `.positionDirectionsGrid` (`LayoutSection.module.css:137-141`).
- 4-up padding/margin — `SpacingBoxControl` (exists, but see Q1 — should be **replaced**
  with a compact numeric-row variant, not removed).
- 4-up corner radius — `BorderControl`'s `CornerPicker` + single shared radius field
  (exists, same "too tall" issue as spacing).
- `Typography`/`Background`/`Interaction` paired stacked cells via `StackedPropertyGrid`
  (`TypographySection.tsx`, `BackgroundSection.tsx`, `InteractionSection.tsx`).

**Missing (WS-6.1/6.4 asked for these, not built):**
1. **Link-aspect-ratio toggle for W/H.** `SizeSection.tsx` has no lock icon between the W
   and H `DimensionCell`s — `aspectRatio` is a separate free-text `GenericSizeRow` below the
   grid (`SizeSection.tsx:136-145`), not a toggle that keeps W/H proportional while dragging.
2. **9-dot / 3×3 alignment grid.** `AlignmentControl` (`LayoutSection/AlignmentControl.tsx`)
   renders `align-items`/`justify-content` as two separate linear `SegmentedControl` rows
   (cross-axis row + main-axis row), not Figma's single 3×3 grid where one click sets both
   axes at once. `AlignBar` (the actual grid-shaped primitive) exists but is used only for
   *board-frame* alignment (`FrameBulkInspector.tsx`), never for flex/grid item alignment.
3. **Top-of-panel align/distribute row for a selected element** relative to its parent
   (WS-6.1's row 1) — does not exist at all outside board-frame multi-select.
4. **Multi-selection style editing** — `MultiSelectionInspector.tsx` (2+ nodes) and
   `MultiSelectorInspector.tsx` (2+ classes) render **only an action bar** (duplicate/wrap/
   copy/cut/paste/delete + a plain layer list — `MultiSelectionInspector.tsx:1-28`
   docblock says so explicitly). Neither mounts `StyleSurface`/`StyleSectionsEditor`, so
   there is **no way to bulk-edit fill/size/spacing across a multi-selection** the way
   Figma does. `MIXED`/`ScrubInput` combo is proven to work (`FrameBulkInspector.tsx:34-35,
   186-269`) but is wired to zero node/class multi-select surfaces — confirmed via grep,
   `MIXED`/`isMixed` appear only in `FrameBulkInspector.tsx` and the primitives themselves.

---

## Q5 — Number input ergonomics

| Capability | Status | Evidence |
|---|---|---|
| Drag-to-scrub (label drag) | **Implemented**, but only wired into `SizeSection`'s 6 fields (W/H/MinW/MinH/MaxW/MaxH) | `ScrubInput.tsx:114-162`, `SizeSection.tsx:201-211` |
| Arrow-key nudge ±1 / Shift ±10 / Alt ×0.1 | Implemented in `ScrubInput` | `ScrubInput.tsx:186-205`, `scrubMath.ts:93-101` |
| **A second, inconsistent nudge system** (Shift step = **8**, not 10) used everywhere else (`TokenAwareInput`, `BorderControl`'s plain `Input`s, `FieldRow` outline/offset) | `numericNudge.ts:17-21` `BASE_NUDGE=1, SHIFT_NUDGE=8, FINE_NUDGE=0.1` vs. `ScrubInput`'s default `shiftStep=10` (`ScrubInput.tsx:82`) | Two different "big nudge" magnitudes for what should be one interaction model |
| Math expressions (`"100/2"`, `"+=8"`) | **Not implemented anywhere.** Both regexes reject arithmetic. | `scrubMath.ts:23` `NUMERIC_LENGTH_RE`, `numericNudge.ts:41` `NUDGEABLE_RE` — both `^(-?\d*\.?\d+)([a-z%]*)$`, no operator support |
| Unit switching (px/%/rem/auto as a UI affordance, not retyping) | **Not implemented.** Unit is inferred from whatever string is already there; there is no dropdown/cycle control to switch units without retyping the whole value. | `ScrubInput.tsx:58-59` (`unit` prop only sets the *fallback* unit for an empty field) |
| `auto`/`fill`/`hug` keyword handling | Implemented — `SCRUB_KEYWORDS` render but don't scrub/nudge (by design, documented) | `scrubMath.ts:26-33` |
| Mixed-value state (`MIXED`) | Implemented in the primitive and in `FrameBulkInspector`; **absent from node/class multi-select** — see Q4 #4 | `src/ui/components/MixedValue/`, `FrameBulkInspector.tsx:186-269` |
| Drag-scrub coverage elsewhere (gap, TRBL offsets, padding/margin sides, border width/radius, outline offset, opacity, z-index, line-height, letter-spacing) | **Keyboard nudge only** (`handleNudgeKeydown`), no drag affordance — inconsistent with SizeSection | `PositionSection.tsx` uses `TokenAwareInput` (no drag), `BorderControl.tsx:267-280,354-366` uses plain `Input` + `handleNudgeKeydown`, `SpacingBoxControl.tsx` uses `TokenAwareInput` |

---

## Q6 — Color control

`ColorControl` → `ColorValueInput` → `TokenizedColorField` → `ColorInput` (native
`<input type="color">` swatch) + `Input` text field + a token-suggestion dropdown.

| Figma capability | Present? | Evidence |
|---|---|---|
| Swatch preview | Yes | `ColorInput.tsx` |
| Hex/rgb typed entry | Yes | `TokenizedColorField.tsx:141-161` |
| Alpha channel | **No** — `<input type="color">` cannot represent alpha; the text field accepts `rgba(...)` strings but the swatch picker itself can't set/preview alpha, so there's no alpha slider anywhere | `ColorInput.tsx:63-71` (`type="color"`, browser-native, hex-only) |
| Eyedropper (`EyeDropper` API) | **No** — not referenced anywhere in the color stack | grep: no `EyeDropper` usage in repo |
| Hex/rgb/hsl format toggle | **No** — the field always displays whatever string is stored; no cycle-format control | `TokenizedColorField.tsx` has no format state |
| Recent colors | **No** — no MRU list; the dropdown only shows framework color tokens | `TokenizedColorField.tsx:57-224` |
| Design-token picker | **Yes, and this is a genuine Studio advantage over vanilla Figma** — the dropdown suggests the project's own `--color-*` tokens, filtered by typed query, with live hover-preview on canvas | `TokenizedColorField.tsx:54-101,162-198` |

**Net:** the token integration is best-in-class and worth keeping/highlighting; alpha,
eyedropper, format-toggle, and recents are the four real gaps.

---

## Q7 — Typography control

`TypographySection` (`StackedPropertyGrid` over `fontFamily`, `[fontSize,fontWeight]`,
`[lineHeight,letterSpacing]`, `[textAlign,fontStyle]`, `[textDecoration,textTransform]`,
`whiteSpace`, `color`, `textShadow` — `TypographySection.tsx:15-24`).

| Capability | Present? | Notes |
|---|---|---|
| Font family picker | **Yes, rich** — `FontFamilyControl.tsx` is a full `ContextMenu` popover grouped into Base/Font tokens/Installed fonts, with live hover-preview using the actual font stack (`FontFamilyControl.tsx:117-182`). Better than a plain text input. |
| Weight | Yes — `SelectControl` sourced from `getFontWeightOptions` (font-aware) | `ClassPropertyRow.tsx:226-231`, `fontWeightOptions.ts` |
| Size | Yes — token-aware (`getCSSPropertyTokenSource('fontSize') → 'typography'`), autocompletes to the typography scale | `cssControlTypes.ts:148-150` |
| Line-height | Yes, plain text/nudge (length-nudge eligible, `cssControlTypes.ts:178`) — no token source by design (documented reasoning) |
| Letter-spacing | Same as line-height |
| Alignment | Dropdown, not icon toggle — see Q3 #1 |
| Decoration | Dropdown, not icon toggle — see Q3 #2 |
| Transform | Dropdown, not icon toggle — see Q3 #3 |
| Truncation (`text-overflow`/`-webkit-line-clamp`) | **Missing entirely** — not in `CSSPropertyBag`'s typography section list at all; no "truncate to N lines" affordance anywhere in the panel |

---

## Q8 — The panel shell

- **Width:** resizable via `SidebarResizeHandle` (`RightSidebar.tsx:59-69`), range
  300-520px (`workspaceLayout.ts:9-10`), default 360px (`uiSlice.ts:29`). Also has an
  independent **floating** mode with its own draggable width (`PropertiesPanel.tsx:62`
  `DEFAULT_WIDTH = 360`, `useDraggablePanel`). Two width states to keep in sync if the
  target width changes.
- **Tabs:** no browser-tab-style tabs inside the panel — the Styles/Attributes switch
  (`PropertiesPanelBody.tsx:188-207`, `nodeViewSwitcher`) is the closest thing, plus the
  `StyleCategoryRail` scroll-spy rail. This is fine and matches Figma's own single-scroll
  model — not a problem to fix.
- **The rail:** `StyleCategoryRail` (`StyleCategoryRail.tsx`) is scroll-spy navigation, not
  a second content area — reasonable, but see Q1/Q2 for its fixed 32px cost.
- **Collapse:** the panel can be fully hidden (`data.collapsed`,
  `PropertiesPanel.tsx:129-138`) and toggled docked/floating
  (`PanelModeButton`, `PropertiesPanel.tsx:329-348`).
- **1280px viewport usability:** `LeftSidebar` has its own independent width
  (`LEFT_SIDEBAR_DEFAULT_WIDTH`, same `workspaceLayout.ts` min/max as the right side —
  confirm exact left constants if touched) plus the canvas. At 1280px with a 360px right
  panel + a left sidebar of comparable width (~260-300px typical), the canvas viewport
  shrinks to roughly 620-660px — workable but tight; the 300px *minimum* on the right
  panel (vs. a Figma-like 240px) is the single easiest lever to recover ~60px of canvas
  width at the low end without any component redesign.
- **Left sidebar relationship:** independent slice/width state
  (`leftSidebarWidth` in `uiSlice.ts:83`), no coordination constraint between the two
  sidebars' widths (each resizes independently, can both be dragged wide simultaneously
  and starve the canvas — no combined min-canvas-width guard found).

---

## Q9 — Token/style compliance issues (already flagged for the rewrite)

Spot-checked every CSS module read during this audit — **no hex/rgb/hsl literals and no
`var(--x, fallback)` fallbacks were found** in `PropertiesPanel/**`, `property-controls/**`,
or the relevant `ui/components/**` (ScrubInput, ControlRow, Select, Input, ColorInput,
AlignBar, Section). The codebase is already gate-clean here — `css-token-policy.test.ts`
and `no-css-var-fallbacks.test.ts` should continue to pass through a rewrite as long as new
CSS keeps using `var(--token)` only. Two minor drift notes for a rewrite to fix rather than
carry forward:
1. `StackedPropertyGrid.module.css` and `ClassPropertyRow.module.css` both hand-roll a
   "label column width" concept (`--class-remove-label-column: 100px` in
   `ClassPropertyRow.module.css:9`, the bare `100px` literal in `ControlRow.module.css:6`
   and `LayoutSection.module.css:103`) — three separate un-tokenized `100px` literals for
   what is conceptually one design value. A rewrite that removes the 100px label column
   (Q1/Q3) should also remove all three instead of leaving dead ones behind.
2. `Section.module.css:34` hardcodes `border-radius: 12px` on `.sectionToggle` instead of
   `var(--panel-radius)` (same numeric value, wrong indirection) — not a gate failure
   (12px isn't hex/rgb) but worth aligning to the token during the rewrite for the
   "don't introduce ad-hoc radius values" rule in `CLAUDE.md`.

---

## TARGET PANEL SPEC

### Section order (unchanged — already correct, do not reorder)

```
[Style-target chip: Editing  Element | .card]      ← StyleTargetChip, keep
[Search bar, sticky]                                ← SearchBar, keep
─────────────────────────────────────────────────────
Module (schema-driven props)                        ← keep, Section accordion
─────────────────────────────────────────────────────
Position    [switch: Relative|Absolute|▾]  [TRBL 2×2 grid]  z-index
Size        W/H row · Min row · Max row · [link-aspect toggle NEW] · aspectRatio · boxSizing
Layout      [Flex|Grid|▾] → direction/wrap icons, [3×3 align grid NEW], gap
Spacing     [compact 4-up row NEW — replaces box diagram, see below]
Background  fill row, image, size/repeat pair, position, object-fit/position pair
Border      [compact 4-up width/style/color rows + 4-up radius row NEW]
Effects     opacity(%) · shadow · filter · transform · transition · animation
Typography  family · [size/weight] · [LH/LS] · [align-icons/style-icon NEW] ·
            [decoration-icons/transform-icons NEW] · truncate(NEW) · color · shadow
Interaction cursor/pointer-events pair, user-select/scroll-behavior pair
Custom      generic key/value long-tail (unchanged)
```

### New row compositions

1. **Compact Spacing 4-up** (replaces `SpacingBoxControl`'s diagram as the DEFAULT view;
   keep the diagram as an optional "Advanced" disclosure toggle if design wants to preserve
   it — do not delete the geometry work, gate it behind a toggle):
   ```
   Padding  [link 🔗] [T ▸0] [R ▸0] [B ▸0] [L ▸0]     ← one row, 28px tall
   Margin   [link 🔗] [T ▸0] [R ▸0] [B ▸0] [L ▸0]     ← one row, 28px tall
   ```
   Each cell = `ScrubInput` with in-field label (`T`/`R`/`B`/`L`), same as `SizeSection`'s
   `DimensionCell`. Total: ~2×28px + row gap ≈ 64px, vs. today's ~210px diagram.

2. **Compact Border 4-up** (replaces the `SidePicker`/`CornerPicker` diagrams as default):
   ```
   Border  [🔗] [swatch ■] [width ▸1px] [style ▾ solid]     ← one row
   Radius  [🔗] [TL ▸0] [TR ▸0] [BR ▸0] [BL ▸0]              ← one row
   ```

3. **3×3 alignment grid** (new `AlignGrid` primitive, or extend `AlignBar` for item-level
   use): one 24×24px 9-dot grid, click sets `align-items` + `justify-content` together;
   Shift-click or a small side toggle to set only one axis for parity with today's two
   separate rows. Wire into `LayoutSection.tsx` next to `FlexDirectionControl`, replacing
   `AlignmentControl`'s two `SegmentedControl` rows (keep `AlignmentControl` as an
   "advanced" fallback for axis-only edits, same pattern as Border's Advanced disclosure).

4. **Icon-toggle rows** for `textAlign`, `textDecoration`, `textTransform`, `fontStyle`,
   `objectFit`, `boxSizing`: new shared `IconToggleGroup` primitive (segmented row of
   icon-only buttons, wraps the existing `SegmentedControl` visual language already used by
   `FlexDirectionControl`/`FlexWrapControl`). Dispatch from `ClassPropertyRow.tsx`'s switch
   statement — add an `'icon-toggle'` `CSSControlType` case alongside `'select'`.

5. **Top-of-panel align/distribute row** for a selected element (WS-6.1 row 1): mount
   `AlignBar` (already built) above the style-target chip when exactly one node is
   selected and its parent uses flex/grid — align relative to siblings, same primitive
   `FrameBulkInspector` already proves works.

### Target control heights / paddings (mostly already correct — confirm during rewrite)

- Field height: keep `sm` = 28px as the panel default (do NOT switch everything to `md`
  32px — that would widen the density gap, not close it).
- Section header: keep 32px (`Section.module.css:27`).
- Row gap: keep `var(--space-s)`.
- **Remove the 100px fixed label column** from every row that gets a composite/icon
  treatment (spacing, border, align, icon-toggle rows). Where a text label genuinely
  can't be replaced (rare CSS properties, Custom properties editor), shrink the column
  from `100px` to a new token (`--panel-label-column: 72px` or similar) — add this to
  `globals.css` rather than leaving three separate hardcoded `100px` literals.
- Panel width: lower `SIDEBAR_MIN_WIDTH` for the right sidebar specifically (introduce a
  `RIGHT_PANEL_MIN_WIDTH = 260` distinct from the left sidebar's minimum, since Figma's
  ~240 plus this panel's persistent 32px rail argues for ~260-280 as the practical floor)
  and drop the default from 360 → ~300-320.

### New shared primitives needed in `src/ui/components/`

| Primitive | Purpose | Notes |
|---|---|---|
| `IconToggleGroup` | Segmented icon-only row for `textAlign`/`textDecoration`/`textTransform`/`fontStyle`/`objectFit`/`boxSizing` | Thin wrapper over the existing `SegmentedControl` visual chrome; new component because `SegmentedControl` today always takes text-labeled `options` (confirm before reusing directly vs. extending `SegmentedControl` itself with an icon-only mode — extending may be simpler than a new component; check `SegmentedControl.tsx` API before deciding) |
| `AlignGrid` | 3×3 alignment matrix for flex/grid item align+justify in one click | Distinct from `AlignBar` (board-frame align/distribute along one axis at a time) — `AlignGrid` sets both axes from one grid |
| `FieldRow` (compact variant) | Already effectively exists as `ControlRow`; needs a **no-label / icon-label** mode that doesn't reserve the 100px column | Could be a new `layout: 'icon'` variant on `ControlRow` rather than a new component — cheaper |
| `ScrubInput` unit-cycle affordance | Small clickable unit suffix (px/%/rem/auto) that cycles or opens a mini-menu | Extend existing `ScrubInput`, not a new primitive — add an optional `units: string[]` prop |
| Math-expression evaluator | Parse `"100/2"`, `"4*8"`, `"+=8"` before falling back to `parseScrubValue` | Not a UI primitive — a pure function in `scrubMath.ts` (`evaluateNumericExpression`), reused by both `ScrubInput` and `numericNudge.ts` |

`ScrubInput`, `MIXED`/`MixedValue`, `AlignBar`, `SegmentedControl`, `ControlRow` all
already exist and should be **extended**, not replaced.

### Token additions needed in `globals.css`

- `--panel-label-column: 72px` (or similar) — replaces the three hardcoded `100px`
  literals in `ControlRow.module.css:6`, `ClassPropertyRow.module.css:9`,
  `LayoutSection.module.css:103` with one source of truth, sized down from 100px.
- No new color/radius/spacing tokens are required — the existing `--space-*`/`--text-*`
  scale and `--radius`/`--radius-sm`/`--panel-radius`/`--input-radius` already cover every
  measurement this spec calls for. `Section.module.css:34`'s hardcoded `border-radius: 12px`
  should switch to `var(--panel-radius)` (same value) while touching that file.

---

## Effort estimate summary

| Item | Effort | Depends on |
|---|---|---|
| Compact Spacing 4-up row (default view, diagram behind toggle) | M | `ScrubInput` (exists) |
| Compact Border 4-up row (default view, diagram behind toggle) | M | `ScrubInput`, `Select`, `ColorValueInput` (exist) |
| `IconToggleGroup` / `SegmentedControl` icon-only mode + wiring 6 properties | M | `SegmentedControl` (exists, needs icon-only option) |
| `AlignGrid` 3×3 primitive + `LayoutSection` wiring | M | new primitive |
| Top-of-panel `AlignBar` row for single-node selection | S | `AlignBar` (exists, proven in `FrameBulkInspector`) |
| Multi-selection style editing (`MIXED` wiring into `MultiSelectionInspector`/`MultiSelectorInspector`) | L | `ScrubInput`+`MIXED` (exist), needs a "resolve N nodes' styles → mixed bag" reducer, new territory |
| Math-expression evaluator in `scrubMath.ts`/`numericNudge.ts` | S | none |
| Unit-cycle affordance on `ScrubInput` | S | none |
| Color: alpha channel + eyedropper + format toggle + recents | L | `EyeDropper` API feature-detect, alpha requires abandoning native `<input type=color>` for a custom picker |
| Panel width min/default reduction | S | `workspaceLayout.ts` constants |
| Remove 100px label column literals → token, shrink | S | new token above |
| Truncation control (`-webkit-line-clamp`) | S | new `CSSPropertyBag` fields if not already present — verify schema first |
| Export section (PNG/SVG) | L | new feature, not a density fix — likely out of scope for "make it smaller" |

---

## Files read (full list)

`PropertiesPanel.tsx`, `PropertiesPanel.module.css`, `PropertiesPanelBody.tsx`,
`StyleSurface.tsx`, `StyleSurface.module.css`, `StyleCategoryRail.tsx`,
`StyleCategoryRail.module.css`, `StyleTargetChip.tsx`, `StyleTargetChip.module.css`,
`SizeSection.tsx`, `SizeSection.module.css`, `PositionSection.tsx`, `cssControlTypes.ts`,
`ClassPropertyRow.tsx`, `ClassPropertyRow.module.css`, `StackedPropertyGrid.tsx`,
`StackedPropertyGrid.module.css`, `BackgroundSection.tsx`, `TypographySection.tsx`,
`InteractionSection.tsx`, `LayoutSection/LayoutSection.tsx`,
`LayoutSection/AlignmentControl.tsx`, `LayoutSection.module.css`,
`SpacingBoxControl/SpacingBoxControl.tsx`, `SpacingBoxControl/SpacingBoxControl.module.css`,
`BorderControl/BorderControl.tsx`, `StyleSectionsEditor.tsx`, `MultiSelectionInspector.tsx`,
`RightSidebar/RightSidebar.tsx`, `RightSidebar/RightSidebar.module.css`,
`ScrubInput/ScrubInput.tsx`, `ScrubInput/ScrubInput.module.css`, `ScrubInput/scrubMath.ts`,
`ControlRow/ControlRow.tsx`, `ControlRow/ControlRow.module.css`, `AlignBar/` (listing +
usage grep), `ColorControl.tsx`, `ColorValueInput.tsx`, `ColorInput/ColorInput.tsx`,
`TokenizedColorField.tsx`, `FontFamilyControl.tsx`, `TokenAwareInput.tsx`,
`numericNudge.ts`, `Section/Section.module.css`, `ClassPicker.module.css`,
`PanelHeader/PanelHeader.module.css`, `FrameSizePanel.tsx`, `uiSlice.ts` (panel width
defaults), `workspaceLayout.ts` (sidebar min/max), `SidebarResizeHandle.tsx`,
`globals.css` (spacing/text/radius token scan), plus `STUDIO-IMPORT-V2-PLAN.md` §WS-6.
