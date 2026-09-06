# Studio inspector — the progressive-disclosure pass

**Goal:** make the Properties panel as small, calm and fast to use as Figma's
right sidebar, **without removing a single capability**. Everything that is
reachable today stays reachable; the difference is that it stops being *resident*.

This is the second half of [`STUDIO-FIGMA-PARITY-PLAN.md`](STUDIO-FIGMA-PARITY-PLAN.md)
§10 **Track G**. Track G's first two passes shipped *density* — the label gutter
died, fields grew in-field glyphs, sections became hairlines. That work is done
and this plan does not redo it. What is left is *disclosure*: Figma's panel is
not smaller because its controls are smaller. It is smaller because **at rest it
does not draw controls for things you have not used yet.**

Read [§1 The five laws](#1-the-five-laws) before executing any part. Each part in
§4 is a self-contained work order.

---

## 0. The reference set

Every part below cites these by number. They are the pasted Figma captures from
the 2026-09-06 review session.

| # | What it shows | The disclosure lesson |
|---|---|---|
| **F1** | Position: 6 align buttons + 1 overflow, X/Y, rotation + flip/more | Align is a 7-button row, not a section |
| **F2** | The align overflow menu — Tidy up, Distribute vertical/horizontal, with shortcuts | Rare geometry actions live in a menu, not the panel |
| **F3** | Layout, no auto-layout: 4 mode buttons, W/H, Clip content | 3 rows for the whole layout story when layout is off |
| **F4** | Auto layout (vertical): mode buttons, W ▾ / H Hug, 3×3 align pad, gap, ⚙, padding H/V, expand-padding icon, Clip content | Mode reveals exactly its own fields |
| **F5** | Auto-layout **settings popover**: Preview, Inside stroke, Canvas stacking, Align text baseline, Auto spacing, Layout | The ⚙ is where the 5 rarely-touched knobs went |
| **F6** | Auto layout (horizontal): identical shape, gap glyph rotated, wrap toggle appears in the header row | Same controls, direction-aware icons |
| **F7** | Auto layout (grid): `1 × Auto` track cell, both gaps | Grid is a *mode*, not a second section |
| **F8** | Grid's settings popover — only Inside stroke + Layout | The popover's contents shrink with the mode |
| **F9** | Padding **expanded** to 4 individual fields, the expand toggle stays lit | 2 fields → 4, in place, toggle-remembered |
| **F10** | Appearance collapsed: opacity, corner radius, expand-corners icon | 1 row for opacity + radius |
| **F11** | Appearance expanded: 4 corner fields + a ⚙ | Same expand idiom as padding |
| **F12** | Blend-mode menu behind the droplet icon in the Appearance header — 20 modes | 20 options cost **one icon** |
| **F13** | Empty Fill / Stroke / Effects — title row + `+`, nothing else | **An unused section costs one line** |
| **F14** | A fill row (swatch, hex, %, eye, −) with the colour picker as a **separate floating panel**: tabs, fill-type icons, contrast, eyedropper, model select, "On this page" recents. Plus a **Selection colors** section | The editor is never inline |
| **F15** | Gradient in the same picker: type dropdown, reverse/rotate, stops list | One picker, many fill kinds |
| **F16** | Stroke: colour row + position dropdown + weight + ⚙ + per-side icon | 2 rows for all of stroke |
| **F17** | Stroke **settings popover**: Basic/Dynamic/Brush tabs, Style, Width profile, Join, Miter angle | Advanced stroke is a tabbed popover |
| **F18** | Stroke per-side menu: All / Top / Bottom / Left / Right / Custom | Per-side is a menu, not four resident fields |
| **F19** | Stroke sides **custom**: 4 individual weights | …until you ask for it |
| **F20** | Effects `+` menu: Inner shadow, Drop shadow, Layer blur, Background blur, Noise, Texture, Glass, Shader | Adding is typed, from a menu |
| **F21** | Effect editor popover: X/Y/Blur/Spread/Colour + "Show behind transparent areas" | Each list item edits in a popover |
| **F22** | Effect **styles** picker behind the grid icon in the section header | Library ≠ local value; different icon |
| **F23** | Typography collapsed: family / weight+size / line-height+letter-spacing / align+valign+⚙ | **All of typography in 4 rows** |
| **F24** | Text styles picker behind the same grid icon | Consistent with F22 |
| **F25** | Type settings popover — **Basics**: alignment, decoration, case, vertical trim, list style, paragraph spacing, truncate, wrap | 8 controls, zero resting cost |
| **F26** | Type settings — **Details**: indentation, letter case, numbers (OpenType) | Depth without weight |
| **F27** | Type settings — **Variable**: slant + weight axis sliders | Font-dependent controls appear only when the font has them |
| **F28** | A text node's **entire** panel: Position, Layout, Appearance, Typography, Fill, Stroke, Effects — one screen, no scroll | The whole point |
| **F29** | Absolutely-positioned node: X/Y + constraint dropdowns + the crosshair widget | Constraints appear only in absolute mode |
| **F30** | The W field's dropdown: Fixed width (54) / Hug contents / **Add min width…** / **Add max width…** / Apply variable… | Min/max are *added*, not shown |
| **F31** | The same panel after "Add min width" — one extra row, in place | Add-on-demand, one row per add |

---

## 1. The five laws

Everything in §4 is an application of one of these. When a decision is not
covered by a work order, decide it with these.

### Law 1 — An unused section costs one line (F13)

Figma's Fill, Stroke and Effects sections are *lists*. Empty list ⇒ a title and a
`+`. Studio today renders every property of every curated section in
`CLASS_STYLE_SECTIONS` ([`cssControlTypes.ts:384`](src/admin/pages/site/panels/PropertiesPanel/cssControlTypes.ts#L384))
whether or not anything is set — nine sections × their full property list, always.

**Rule:** a section with zero set properties and no mandatory control renders as
`▸ Title  [+]` and nothing more.

### Law 2 — Rare options live in a popover anchored to the thing they modify (F5, F8, F17, F21, F25–F27)

Figma has exactly one shape for this: a small **⚙ / sliders icon** at the right
edge of the control cluster it belongs to, opening a floating panel. It never
uses an "Advanced" accordion inside the panel — that would still cost a row and
still push everything below it down.

**Rule:** anything used in under ~10% of edits goes behind a `⚙` popover on its
own cluster. Studio's existing "Advanced" disclosures (BorderControl's shorthand
block, `CustomPropertiesSection`) become popovers.

### Law 3 — Optional fields are *added*, never pre-drawn (F30, F31)

Figma does not show min-width and max-width. It shows W, with a dropdown that
offers *Add min width…*. Once added the row exists and can be removed again.
Studio's `SizeSection` draws all six dimension cells at all times
([`SizeSection.tsx:169-174`](src/admin/pages/site/panels/PropertiesPanel/SizeSection.tsx#L169)).

**Rule:** a property with no value and no default-worth is not a field. It is a
menu item on the field it constrains.

### Law 4 — Multi-value properties expand in place, and remember (F9, F11, F18–F19)

Padding is one pair of fields with a toggle to four. Corner radius is one field
with a toggle to four. Stroke weight is one field with a menu to four. The
toggle stays lit while expanded, so the state is legible, and it is per-user
sticky, not per-selection.

**Rule:** never draw four sides when the four are equal. Draw one, plus the
expand affordance.

### Law 5 — The mode chooses the fields (F3, F4, F6, F7, F29)

A frame with no auto-layout shows W/H and Clip content. Turn on vertical
auto-layout and the align pad, gap and padding appear. Switch to grid and the
track cell replaces the align pad. Nothing is disabled-but-visible; it is absent.

Studio already does this correctly for `display: flex | grid`
([`LayoutSection.tsx:216-320`](src/admin/pages/site/panels/PropertiesPanel/LayoutSection/LayoutSection.tsx#L216))
and for `position` offsets
([`PositionSection.tsx:120`](src/admin/pages/site/panels/PropertiesPanel/PositionSection.tsx#L120)).
**This law is already law here.** Extend it, do not re-litigate it.

---

## 2. Where we actually are

Honest current state, so nobody re-solves a solved problem.

**Already Figma-shaped — do not touch:**

- Geometry tokens: `--inspector-row-h: 24px`, `--inspector-header-h: 32px`,
  `--inspector-pad-x: 8px` ([`globals.css:225-242`](src/styles/globals.css#L225)).
  Panel floor 260px, default 300 ([`workspaceLayout.ts:18`](src/admin/state/workspaceLayout.ts#L18)).
  These match Figma's 240px + our rail. **The panel is not too wide. It is too tall.**
- `Section` is already a hairline + title + `actions` slot with an `indicator`
  dot ([`Section.tsx`](src/ui/components/Section/Section.tsx)) — F13's anatomy
  minus the empty-state rule.
- `SectionStylesMenu` in the `actions` slot is already F22/F24's styles picker.
- In-field glyphs, `ScrubInput` drag-scrub, `SegmentedControl` icon skin,
  `MIXED`, hover-preview, provenance strike-through. All shipped.
- Mode-driven reveal for flex/grid/position (Law 5).

**The disclosure gap, section by section:**

| Section | Today | Figma ref |
|---|---|---|
| Position | `DropdownSwitcher` + 4 offsets + zIndex, no align row | F1, F2, F29 |
| Size | **6 dimension cells always drawn** + aspect/box-sizing | F30, F31 |
| Layout | good mode reveal, but a 6-entry `FALLBACK_SPEC` grid always below it | F3–F8 |
| Spacing | `SpacingBoxControl` — a 4:3 box-model diagram, **the tallest block in the panel** ([`SpacingBoxControl.module.css:24-28`](src/admin/pages/site/panels/PropertiesPanel/SpacingBoxControl/SpacingBoxControl.module.css#L24)) | F4, F9 |
| Background | 6-entry always-on grid, no fill *list*, no real picker | F13–F15 |
| Border | per-side + per-corner diagrams + an Advanced disclosure | F16–F19 |
| Effects | 5-entry always-on grid of raw CSS text fields | F13, F20–F22 |
| Typography | 8-entry always-on grid | F23, F25–F27 |
| Interaction | 2-entry always-on grid | — |
| Appearance | **does not exist** — `opacity` lives in Effects, radius in Border | F10–F12 |

**The missing primitive:** there is no `Popover`. `ContextMenu`
([`ContextMenu.tsx`](src/ui/components/ContextMenu/ContextMenu.tsx)) already does
portalled, anchored, outside-dismiss positioning over
[`floatingPosition.ts`](src/ui/lib/floatingPosition.ts) — but it is a *menu*
(roving focus, `menuitem` children). Laws 2 and 4 need an anchored **panel** that
holds arbitrary controls. This is the one thing that must be built before most of
§4 can start.

---

## 3. Phase 0 — the four primitives (do these first)

Nothing in §4 lands cleanly without these. All four are in `src/ui/components/`
and are covered by the same gates as their neighbours.

### 3.1 `InspectorPopover` (M) — blocks G3, G5, G6, G7, G8, G9

An anchored, portalled, dismissible **panel** (not a menu). Extract the anchoring
from `ContextMenu` into a shared `useAnchoredFloating` hook in `src/ui/lib/` and
build both on it — do not fork the positioning maths, and do not leave
`ContextMenu` with its own copy.

```
<InspectorPopover anchorRef={btnRef} onClose={…} title="Auto layout settings" width={244}>
```

- `role="dialog"`, `aria-label` from `title`, focus trapped, `Esc` closes,
  outside-pointer dismiss via the existing `useOutsidePointerDismiss`.
- A close `×` in its header (F5, F17, F21, F25 all have one).
- Renders at `--panel-radius` on `--bg-surface` with `--shadow-panel`.
- Opens to the **left** of the inspector by default and flips at the viewport
  edge — Figma always opens leftward (F14, F17, F21, F25) so the popover never
  covers the field you are editing.
- **Sticky per trigger id**, not per selection: reopening the same ⚙ on a
  different node re-opens where it was.

### 3.2 `PropertyList` (M) — blocks G6, G7, G8

The Fill / Stroke / Effects list shape (F13, F14, F16, F20). One component,
three consumers.

- Empty ⇒ renders **nothing but its header's `+`** (Law 1). The header itself is
  the existing `Section` with `actions`.
- Non-empty ⇒ a row per entry: `[leading]  [summary]  [value]  [👁]  [−]`.
- Row click opens the entry's editor in an `InspectorPopover` anchored to the row.
- `+` opens either a typed `ContextMenu` (F20) or adds a default entry (F14's `+`
  adds an opaque fill immediately).
- The eye toggle is **not** cosmetic: it must map to a real CSS write. For fills
  and effects, hiding an entry removes it from the emitted declaration but keeps
  it in the list — this needs a store-side representation, see §5 *Open decisions*.

### 3.3 `ExpandableFieldCluster` (S) — blocks G4, G5, G7

F9 / F11 / F19's one-becomes-four idiom, as a primitive so padding, radius and
stroke sides cannot drift.

- Props: `collapsed` (1–2 fields), `expanded` (n fields), `expandLabel`, and a
  `linked` boolean derived from whether all sides are currently equal.
- The toggle button carries `pressed` while expanded and is persisted in
  `editorPreferences` per cluster id.
- **Auto-collapse rule:** when an external change makes all sides equal again,
  the cluster relinks — `BorderControl` already implements exactly this
  ([`BorderControl.tsx`](src/admin/pages/site/panels/PropertiesPanel/BorderControl/BorderControl.tsx),
  "auto-relinks when external changes bring all sides back to a uniform value").
  Lift that logic into this primitive and delete the copy.

### 3.4 `AddablePropertyField` (S) — blocks G2

F30 / F31's "Add min width…". A field whose trailing chevron opens a
`ContextMenu` listing: its own mode options, then `Add <constraint>…` items for
each unset companion property, then any project-token apply action.

- Adding writes nothing — it *reveals* the row in an unset state with the
  computed value as placeholder. The property is only written on first commit.
  (This matters: Studio writes real CSS to the user's file. "Add min width" must
  not put `min-width: 0` in their source.)
- The revealed row carries a `−` that both clears the property and re-hides it.

---

## 4. The work orders

Ordered by value per hour. Each is independently landable and independently
reviewable. Effort: `S` ≤ half a day · `M` 1–3 days.

---

### G1 — The empty-section law · **S** · *no dependencies* · **do this first**

> **Figma:** F13. Fill, Stroke and Effects on a plain frame are three lines total.
> **Us:** nine sections, each rendering its full property grid unconditionally.

This is the single largest height win in the plan and it touches one file.

**Change** [`StyleSectionsEditor.tsx`](src/admin/pages/site/panels/PropertiesPanel/StyleSectionsEditor.tsx):

1. Add a `collapsedWhenEmpty` flag to `ClassStyleSectionDefinition`. Set it on
   `background`, `border`, `effects`, `interaction`, `typography`. **Not** on
   `size`, `layout`, `spacing`, `position` — those are Figma's always-present
   Position/Layout block (F1, F3) and must keep their controls.
2. In `StyleSectionGroup`, when `collapsedWhenEmpty && setCount === 0 &&
   !styleQuery`, render the `Section` with no body and an `actions` slot of
   `[styles picker] [+]`. `+` reveals the section body for this selection only
   (component state, cleared on `nodeId` change).
3. Keep `defaultOpen` honest: a section that has set properties opens; one that
   does not is a single line. The `propertiesSectionsExpanded` preference stops
   meaning "expand empty sections".

**Do not** hide a section that has a value set at a *non-active* breakpoint —
that would hide the user's own work. Compute `setCount` across contexts for the
purpose of this rule, and mark such a section with the existing `indicator` dot.

**Acceptance:** a plain `<div>` with two classes set renders a panel that fits a
900px-tall viewport with no scroll.

---

### G2 — Size: constraints on demand · **S** · *needs 3.4*

> **Figma:** F30, F31 — W and H only; min/max are menu items that add a row.
> Also F3's `W 266 / H 435` and F4's `H 325 Hug`.
> **Us:** [`SizeSection.tsx`](src/admin/pages/site/panels/PropertiesPanel/SizeSection.tsx)
> draws two sizing segmented controls + **six** dimension cells + an aspect/box-sizing pair. Four rows, minimum, always.

**Target — 2 rows at rest:**

```
[ W  266 ▾ ]  [ H  435 ▾ ]          ← AddablePropertyField ×2
[ Fixed | Hug | Fill ]              ← only when the axis mode is ambiguous
```

**Instructions:**

1. Replace the six `DimensionCell`s with two `AddablePropertyField`s (W, H). Each
   chevron menu carries, per F30: the three sizing intents (`Fixed` / `Hug` /
   `Fill` — Studio's `SIZING_OPTIONS`, already correct and already
   parent-aware via [`elementSizing.ts`](src/admin/pages/site/panels/PropertiesPanel/elementSizing.ts)),
   then `Add minimum width…` / `Add maximum width…`, then `Apply variable…`
   wired to the existing spacing/size token catalogue.
2. **Fold the sizing segmented control into the field's own dropdown.** Today it
   is a separate full-width row per axis; Figma puts it in the W dropdown (F30's
   ✓ *Fixed width (54)*). That removes a whole row per axis and is where users
   already look. Keep the segmented control visible **only** while the axis mode
   is `hug` or `fill` — then the field shows the word instead of a number
   (F4's `H 325 Hug`) and the mode needs to be legible without opening a menu.
3. A revealed min/max row is a normal `DimensionCell` with its existing glyph
   (`MinWidthIcon` &c. — keep them, they are good) plus a `−`.
4. Move `aspectRatio` and `boxSizing` into the Layout ⚙ popover (G3). Neither is
   touched in normal work and `boxSizing` is usually a project-wide reset.
5. Keep `data-testid="css-size-input-*"` on the fields that survive; add
   `data-testid="css-size-add-<prop>"` to the menu items.

**Acceptance:** an element with only `width` set renders one row.

---

### G3 — Layout: the settings popover · **M** · *needs 3.1*

> **Figma:** F3 (off), F4 (vertical), F6 (horizontal + wrap), F7 (grid), and the
> ⚙ popovers F5 / F8 whose contents change with the mode.
> **Us:** [`LayoutSection.tsx`](src/admin/pages/site/panels/PropertiesPanel/LayoutSection/LayoutSection.tsx)
> gets the reveal right (Law 5, already) but always renders a 6-entry
> `FALLBACK_SPEC` grid of `alignSelf/justifySelf/flex/gaps/gridColumn/gridRow/overflow*` below it.

**Target:**

```
[ Flex | Grid | ▾ ]                       ← unchanged, already correct
  (flex)  [dir icons] [wrap]              ← unchanged
          [align pad 3×3]  [gap] [⚙]      ← ⚙ is new; align pad is G3.3
          [padding H] [padding V] [⊞]     ← G4 moves in here
  [ ] Clip content                        ← overflow, promoted from fallback
```

**Instructions:**

1. **Add the ⚙** to the right of the gap field, opening an `InspectorPopover`
   titled *Layout settings*. Move into it, in this order, and delete their
   fallback rows:
   - `alignSelf`, `justifySelf`, `flex` — these describe how *this* element
     behaves in its **parent**, not how it lays out its children. Mixing the two
     in one section is the conceptual bug behind half the section's height.
   - `rowGap` / `columnGap` (the split-axis case; unified `gap` stays outside)
   - `gridColumn` / `gridRow`
   - `aspectRatio`, `boxSizing` (from G2)
   - Per F5's *Inside stroke* / F8, add nothing Figma-specific we do not have.
   The popover's contents are **mode-filtered** exactly as F5 vs F8 differ: grid
   mode hides the flex-only entries and vice versa.
2. **Promote `overflow` to a checkbox** labelled *Clip content* (F3, F4, F6, F7 —
   it is present in every single layout state). `overflow: hidden` when checked,
   property cleared when not. `overflowX` / `overflowY` stay in the ⚙ for the
   asymmetric case. This is a rename in the UI only — the CSS written is
   unchanged and must stay `overflow`.
3. **The wrap toggle moves to the cluster header** (F6 shows it at the top-right
   of the Auto layout block, not inline). `FlexWrapControl`'s three segments
   become one toggle button; `wrap-reverse` moves to the ⚙.
4. Keep `DISPLAY_DEPENDENT_PROPS` pruning on clear — it is correct and the
   popover makes it more important, not less (an orphan is now invisible *and*
   behind a click).

---

### G3.3 — `AlignGrid`, the 3×3 pad · **S** · *no dependencies*

> **Figma:** F4, F6, F7 — one 3×3 pad replaces two linear alignment rows.
> **Us:** two stacked `AlignmentControl`s, each a full-width `SegmentedControl`
> with a caption ("Align", "Justify").

Already scoped in the parity plan's *New primitives needed*. Build
`src/ui/components/AlignGrid/` — a 3×3 button grid writing
`alignItems` + `justifyContent` as one gesture, with the axis meaning derived
from `flexDirection` exactly as `alignmentOptions.tsx` does now.

Two captioned rows (≈56px) become one uncaptioned pad (≈48px) that is also
*faster* — one click instead of two. Keep the linear controls as the grid's
keyboard model (arrow keys move within the pad).

For grid mode this maps to `alignItems` + `justifyItems`, which is what
`GridAxisControl` already does — same pad, different write targets.

---

### G4 — Spacing: padding as two fields · **M** · *needs 3.3*

> **Figma:** F4 — `[⊓ 66] [⊐ 155]`, one row, with an expand icon to F9's four.
> **Us:** [`SpacingBoxControl`](src/admin/pages/site/panels/PropertiesPanel/SpacingBoxControl/SpacingBoxControl.tsx) —
> a 4:3-locked box-model diagram, `max-width: 280px`, the tallest single block in
> the panel (~253px measured in the parity plan). It is a beautiful control that
> costs a quarter of the viewport to set one padding value.

**Target — padding lives in the Layout cluster (F4), margin keeps a section:**

```
Layout ▸ …
  [⊓ 66] [⊐ 155] [⊞]        ← horizontal / vertical padding + expand (F9)
Spacing ▸
  [⊓ 0]  [⊐ 0]  [⊞]         ← margin, same idiom
```

**Instructions:**

1. Build the collapsed form on `ExpandableFieldCluster`: two `TokenAwareInput`s
   (horizontal = left+right, vertical = top+bottom) → four on expand, in F9's
   order (left, top / right, bottom — match the screenshot's reading order).
   Keep token autocomplete; it is better than Figma and is not up for removal.
2. **Move padding into the Layout section**, under the align pad, per F4. Padding
   is a layout property of a container; margin is a relationship with siblings.
   Figma separates them and so should we. The `spacing` section keeps margin
   alone and gains `collapsedWhenEmpty` from G1.
3. **The diagram survives as an opt-in.** Put `SpacingBoxControl` behind the
   Spacing section's ⚙ (`InspectorPopover`, *Box model*), where it can be as
   large as it likes. It is genuinely the best control for "which side is which"
   on an unfamiliar element, and deleting it would lose real capability. It is
   just the wrong *default*.
4. Wire drag-scrub into these fields — they are `TokenAwareInput`, which has no
   scrub. Either give `TokenAwareInput` the `ScrubInput` gesture or compose them.
   The parity plan flags "drag-scrub wired only into SizeSection's six fields" as
   an open inconsistency; this work order closes it for padding and margin.

---

### G5 — Appearance: a section that does not exist yet · **S** · *needs 3.1, 3.3*

> **Figma:** F10 (opacity + radius, one row), F11 (four corners), F12 (blend mode
> behind the droplet in the header).
> **Us:** `opacity` is buried in Effects' grid; corner radius is inside
> `BorderControl`'s corner diagram; `mixBlendMode` is not curated at all.

**Create a new `appearance` section**, positioned between `size` and `background`
(F28's order: Position, Layout, Appearance, Typography, Fill, Stroke, Effects):

```
Appearance                       [👁] [💧]     ← visibility, blend mode (F12)
[ ◧ 100% ]   [ ⌜ 0 ]   [⊞]                     ← opacity, radius, expand corners
```

**Instructions:**

1. Move `opacity` out of `EFFECTS_SPEC` and the four `border*Radius` longhands
   out of `BorderControl`'s corner picker into this section.
2. Radius uses `ExpandableFieldCluster` — one field → four (F11), same idiom as
   padding. `CornerRadiusIcon` already exists.
3. The header `actions` slot gets a droplet button opening a `ContextMenu` of
   `mixBlendMode` values, grouped exactly as F12 groups them (Normal / darken
   family / lighten family / contrast family / difference family / colour family).
   Add `mixBlendMode` to the curated property list; it currently falls into
   `CustomPropertiesSection`.
4. The eye button writes `visibility: hidden` — **not** `display: none`. Studio
   already has `toggleNodeHidden` on the tree, which is a *different* thing
   (it removes the node from the page). Both must exist and the tooltips must
   say which is which: "Hide element (keeps its space)" vs the layer-tree hide.
5. The ⚙ in F11 carries the corner *smoothing* control, which is a Figma vector
   feature with no CSS equivalent. **Skip it.** Do not invent a control to fill
   the icon's place — leave the icon out.

---

### G6 — Fill: a real colour picker and a fill list · **M** · *needs 3.1, 3.2*

> **Figma:** F13 (empty = one line), F14 (row + picker + Selection colors),
> F15 (gradient stops).
> **Us:** [`BackgroundSection.tsx`](src/admin/pages/site/panels/PropertiesPanel/BackgroundSection.tsx) —
> a 6-entry always-on grid; `ColorInput` is a native `<input type="color">`
> (no alpha, no eyedropper, no model toggle, no recents).

This is the largest single work order and the one users will feel most.

**Instructions:**

1. **Rename the section to `Fill`** and rebuild it on `PropertyList`:
   - Empty ⇒ `Fill  [⊞] [+]` (F13). `+` adds an opaque colour fill.
   - `backgroundColor` is entry 1. `backgroundImage` (gradient or URL) is entry 2.
     The `background` shorthand becomes the "unparseable, shown read-only with a
     jump-to-source" escape hatch, not a peer field.
   - `backgroundSize` / `backgroundRepeat` / `backgroundPosition` / `objectFit` /
     `objectPosition` move into the **entry's own popover** — they are properties
     of *that image fill*, and drawing five of them for an element with no image
     is the exact defect this plan exists to fix.
2. **Build `ColorField` + `ColorPickerPopover`** (F14). This is the missing
   primitive the parity plan already identified. Required, in F14's layout:
   - saturation/value square + hue rail + **alpha rail**;
   - model select (`HSL` / `RGB` / `HEX`) and a hex/value field;
   - the **eyedropper** — `EyeDropper` API where available, with a canvas-frame
     fallback that samples the iframe (we own the canvas, so this is tractable);
   - the contrast readout (F14's `16.67 : 1  ✓✓ AA`) — the plumbing for this
     already exists as `contrastAgainst` on `ColorControl`/`TokenizedColorField`,
     currently unpassed by most callers. Pass it.
   - **"On this page"** recents (F14's bottom strip) — for us this is the
     project's own colour tokens plus colours already used in this file. This is
     strictly better than Figma's version because we have the token catalogue;
     keep `TokenizedColorField`'s token integration as the **first** tab.
   - Tabs: *Custom* | *Libraries* (F14) → for us *Custom* | *Tokens*.
3. **Gradients** (F15): a stops list in the same popover, writing a
   `linear-gradient(…)` / `radial-gradient(…)` to `backgroundImage`. Round-trip
   correctness matters more than the editor: parse an existing gradient from the
   user's CSS into stops, and if it does not round-trip losslessly, **refuse to
   open the visual editor and say why** — that is this repo's first invariant, and
   silently rewriting someone's gradient is exactly the kind of write it forbids.
4. **Selection colours** (F14, bottom right): when 2+ nodes are selected, list
   every distinct colour in the selection and let one edit rewrite all of them.
   This is the multi-select style editing the parity plan flags as
   "wired to **zero** node/class surfaces". It belongs here, in
   `MultiSelectionInspector`, and it is the highest-value multi-select feature.

---

### G7 — Stroke · **M** · *needs 3.1, 3.2, 3.3*

> **Figma:** F16 (2 rows), F17 (settings popover, tabbed), F18 (side menu),
> F19 (custom sides).
> **Us:** [`BorderControl`](src/admin/pages/site/panels/PropertiesPanel/BorderControl/BorderControl.tsx) —
> a side-picker diagram + a corner-picker diagram + an Advanced shorthand
> disclosure, ~130–160px before the corner block.

**Target — F16 exactly:**

```
Stroke                                   [⊞] [+]
[ ■ 000000  100 %  👁  − ]                        ← PropertyList entry
[ Inside ▾ ] [ ≡ 1 ] [⚙] [◱]                      ← position, weight, settings, sides
```

**Instructions:**

1. Rebuild on `PropertyList`; empty ⇒ one line (Law 1).
2. The colour row uses G6's `ColorField`. Weight is one `ScrubInput` with
   `StrokeWeightIcon` (exists).
3. **The side picker becomes a menu, not a diagram** (F18): `All / Top / Bottom /
   Left / Right / Custom`, where *Custom* expands to F19's four fields via
   `ExpandableFieldCluster`. Delete the side-picker diagram; keep the
   auto-relink logic (lifted into 3.3).
4. `borderStyle` moves into the ⚙ popover as F17's *Style* row, alongside
   `outline` / `outlineOffset` and the `border*` shorthands currently in
   Advanced. F17's Width profile / Join / Miter angle are vector-only —
   **skip them**, and do not add a Dynamic/Brush tab we cannot honour.
5. `position: Inside | Center | Outside` (F16) maps to `box-sizing` +
   `outline` vs `border` in CSS and **is not a faithful translation**. Ship the
   dropdown with only the values we can honestly write, or omit it. Do not fake
   it. (See §5.)
6. The corner-radius half of `BorderControl` is already gone to G5. What remains
   after this order is small enough that `BorderControl` should be **deleted**
   and its logic split into the stroke `PropertyList` entry editor and G5's
   radius cluster. Do not leave a shell.

---

### G8 — Effects · **M** · *needs 3.1, 3.2*

> **Figma:** F13 (empty), F20 (typed `+` menu), F21 (per-effect popover editor),
> F22 (effect styles picker).
> **Us:** [`EffectsSection.tsx`](src/admin/pages/site/panels/PropertiesPanel/EffectsSection.tsx) —
> five always-on rows of raw CSS text fields (`boxShadow`, `filter`,
> `backdropFilter`, `transform`, `transformOrigin`, `transition`, `animation`).
> Typing `0 4px 4px rgba(0,0,0,.25)` by hand is not a design tool.

**Instructions:**

1. `PropertyList`, empty ⇒ one line.
2. `+` opens a typed menu (F20) mapped to CSS:
   | Menu item | Writes |
   |---|---|
   | Drop shadow | a `box-shadow` layer |
   | Inner shadow | a `box-shadow … inset` layer |
   | Layer blur | `filter: blur()` |
   | Background blur | `backdrop-filter: blur()` |
   Noise / Texture / Glass / Shader have no CSS equivalent — omit them rather
   than shipping a menu item that writes something else.
3. **`box-shadow` is a comma-separated list and must be modelled as one.** Parse
   the stored value into layers; each layer is a `PropertyList` row; the row's
   popover is F21 exactly (X, Y, Blur, Spread, Colour, inset checkbox). Re-emit
   by joining. Same refusal rule as gradients: if it does not round-trip, keep
   the raw text field for that value and say why.
4. `transform` / `transformOrigin` / `transition` / `animation` are not effects
   in Figma's sense and are edited as text by people who know the syntax. Move
   them to the section's ⚙ popover, or to `CustomPropertiesSection`. Do not
   invent visual editors for them in this pass.
5. F22's effect-styles picker is our existing `SectionStylesMenu` — it is already
   in the `actions` slot. Nothing to build; just make sure it survives the
   rebuild.

---

### G9 — Typography · **M** · *needs 3.1*

> **Figma:** F23 — the *entire* typography model in four rows, plus F25/F26/F27's
> three-tab settings popover.
> **Us:** [`TypographySection.tsx`](src/admin/pages/site/panels/PropertiesPanel/TypographySection.tsx)
> — an 8-entry grid: family, weight+size, line-height+letter-spacing,
> align+style, decoration+transform, colour, white-space, text-shadow.

**Target — F23 exactly, 4 rows:**

```
[ Inter                          ▾ ]
[ Regular  ▾ ]        [ 12  ▾ ]
[ ⇕ Auto ]            [ ⟺ 0% ]
[ ≡ ≡ ≡ ]  [ ⊤ ⊹ ⊥ ]           [⚙]
```

**Instructions:**

1. Keep rows 1–3 as they are; they are already correct.
2. Row 4 pairs `textAlign` (existing icon group) with a **vertical-align** icon
   group. Studio has no vertical align — the honest mapping is `alignItems` on
   the text node's own box, which only applies in flex context. If it cannot be
   written honestly for the selected node, **render the group disabled with a
   tooltip that says why** rather than omitting the row; the asymmetry with
   Figma is a real difference and hiding it is the lie this repo's second
   invariant forbids.
3. **The ⚙ opens a tabbed `InspectorPopover`** (F25–F27):
   - **Basics** (F25): `fontStyle`, `textDecoration`, `textTransform`,
     `whiteSpace`, `textOverflow`, `textIndent`, plus paragraph spacing
     (`margin-block` on the text node). Everything currently in rows 4–5 and 7.
   - **Details** (F26): `fontVariantNumeric`, `fontFeatureSettings`,
     `hangingPunctuation`, `fontKerning`. These are not curated today and fall
     into `CustomPropertiesSection`; curate them here.
   - **Variable** (F27): axis sliders from `font-variation-settings`.
     **Render this tab only when the resolved font actually exposes axes** —
     we can read that from the loaded font face via `@core/fonts`. A variable-font
     tab on Helvetica is noise.
4. `color` moves to the **Fill** section for text nodes (F28 shows a text node's
   colour under Fill, not Typography). `textShadow` moves to **Effects** as a
   shadow layer.

**Result:** 8 grid entries → 4 rows, with more capability than today, because
Details and Variable expose properties that are currently only reachable by
typing a property name into the custom-properties editor.

---

### G10 — Position and align · **S** · *needs 3.3-adjacent work only*

> **Figma:** F1 (align row + X/Y + rotation), F2 (the overflow menu), F29
> (constraints in absolute mode).
> **Us:** [`PositionSection.tsx`](src/admin/pages/site/panels/PropertiesPanel/PositionSection.tsx)
> is correct in structure (Law 5 already applies) but has **no align row at all**,
> and `AlignBar` is built and mounted only in `FrameBulkInspector`.

**Instructions:**

1. **Mount `AlignBar` at the top of the Position section for single-node
   selection** (F1's first row). This is the parity plan's "highest value per
   hour" item and it is a mount, not a build. For a single node inside a flex
   parent, the six align buttons write the parent's `alignItems`/`justifyContent`
   or the node's `alignSelf` — decide per case in `elementSizing.ts`'s style, and
   disable with a reason where neither is honest.
2. **The 7th button is an overflow menu** (F2): *Tidy up*, *Distribute vertical
   spacing*, *Distribute horizontal spacing*, with their shortcuts rendered via
   the existing `Kbd`. `AlignBar` already takes `onDistribute` and `onTidy` —
   move them from resident buttons into this menu for the single-node and
   multi-node inspectors alike.
3. X/Y stay as the TRBL cluster they are. In `position: absolute`, add F29's
   constraint dropdowns (`Left ▾` / `Top ▾`) — for CSS these choose *which* of
   left/right and top/bottom the offsets are written to, which is a real and
   frequently-wanted choice we currently express only by which of four fields the
   user types in. The crosshair widget in F29 is optional polish; the two
   dropdowns are the substance.
4. `zIndex` moves into the Position ⚙ popover with `rotate` (currently only
   reachable as a `transform` string) as F1's third row.

---

## 5. Sequencing

```
Phase 0   3.1 InspectorPopover ─┬─→ G3 ─┬─→ G4 (also needs 3.3)
          3.2 PropertyList ─────┼─→ G6 ─┴─→ G7
          3.3 ExpandableCluster ┼─→ G5
          3.4 AddableField ─────┴─→ G2      G8   G9

G1 ── no dependencies, land it first, alone, and measure ──
G3.3 AlignGrid ── independent ──
G10 ── independent (AlignBar is already built) ──
```

**Suggested waves:**

| Wave | Orders | Why together |
|---|---|---|
| 1 | **G1**, G10, G3.3 | Zero new primitives; biggest visible win per hour; establishes the height baseline |
| 2 | Phase 0 (all four primitives) | One agent, one PR, no feature churn — these are the contract everything else codes against |
| 3 | G2, G5, G9 | Independent consumers of different primitives; no file overlap |
| 4 | G3, G4 | Both rewrite the Layout cluster — **same agent, same PR**, or they will collide |
| 5 | G6, G7, G8 | All three are `PropertyList` consumers; G7 depends on G6's `ColorField` |

**Collision warning:** G3, G4 and G3.3 all touch
`LayoutSection/`. G5 and G7 both dismantle `BorderControl`. Do not dispatch those
pairs in parallel. Everything else is file-disjoint.

---

## 6. The measurement gate

Do not start G1 without a baseline, and do not close any order without a
re-measure. Fabricated height numbers are how a density plan drifts.

**Before wave 1**, capture the rendered height of every section for three
fixtures — a plain `<div>`, a styled card, a text node — at panel width 300 and
record them in `docs/audits/`. The parity plan's existing numbers (Effects 398→257px,
Border 404→373px, SpacingBoxControl ~253px, measured 2026-08-30) are the last
known values; verify rather than trust them.

**The one number that matters — F28:** a text node's entire inspector, with
Position, Layout, Appearance, Typography, Fill, Stroke and Effects all present,
fits in **one 900px viewport with no scroll**. That is the screenshot. That is
the acceptance test. Write it as a real test: render the panel for the text
fixture, assert `scrollHeight <= clientHeight`.

Secondary budgets, at rest, panel width 300:

| Section | State | Budget |
|---|---|---|
| Any `collapsedWhenEmpty` section | empty | **32px** (one header) |
| Position | relative, no offsets | ≤ 88px |
| Size | width only | ≤ 56px |
| Layout | flex, gap + padding set | ≤ 180px |
| Appearance | opacity + radius | ≤ 56px |
| Typography | family/size/leading set | ≤ 120px |
| Fill | one colour | ≤ 64px |

---

## 7. What we deliberately do not copy

Studio writes CSS into someone's repository. Figma writes to a scene graph it
owns. Four of these screenshots show controls that cannot be honestly translated,
and shipping a lookalike would violate the "one honest target" invariant.

| Figma control | Ref | Why not |
|---|---|---|
| Corner smoothing (squircles) | F11 ⚙ | No CSS equivalent. Omit the icon, do not fill it with something else. |
| Width profile / Join / Miter, Dynamic + Brush strokes | F17 | Vector-only. |
| Noise / Texture / Glass / Shader effects | F20 | No CSS equivalent. A menu item that writes something else is worse than a missing menu item. |
| Stroke position Inside/Center/Outside | F16 | Only "inside" is honestly expressible (`box-sizing: border-box`). Ship the values we can write, or omit the dropdown. |
| Canvas stacking, Align text baseline, Auto spacing | F5 | Figma layout-engine concepts with no direct CSS. |

And three things where **we should stay better than Figma**, and no work order may
regress them:

1. **Token autocomplete** in every length field (`TokenAwareInput`). Figma's
   variables are worse than this.
2. **Provenance** — the struck-through "this class loses to that one" strip. Figma
   has no cascade, so it has no equivalent, and it is the single most useful thing
   our panel does that theirs does not.
3. **Honest refusal.** Where a write cannot land in one place, we say so. Figma
   never has to. Every popover added by this plan must carry its refusal copy.

---

## 8. Open decisions — need a human call

1. **The eye toggle's storage model.** F14 and F16 hide a fill/stroke without
   deleting it. CSS has no "disabled declaration". Options: (a) write nothing and
   keep the entry in a UI-only list — lost on reload; (b) keep it as a commented
   declaration in the user's CSS — pollutes their source; (c) omit the eye.
   **Recommendation: (c) for v1**, add it only if (b) turns out to be acceptable
   to the user whose file it is.
2. **Does padding move into Layout (G4.2)?** It is the right model and it is what
   Figma does, but it means the Spacing section holds only margin, which will read
   as odd until people get used to it.
3. **`visibility: hidden` vs the layer-tree hide (G5.4).** Two hides, one word.
   Needs naming, not engineering.
4. **Vertical align (G9.2)** — disabled-with-a-reason, or absent? Disabled rows
   cost height, which is what this plan is spending.

---

## 9. Handoff

Every order updates [`docs/design.md`](docs/design.md) → "The inspector" in the
same change, and writes a `STATE.md` entry per
[`docs/agent-refs/handoff-protocol.md`](docs/agent-refs/handoff-protocol.md).
`panel-designer` owns §3 and G1–G10; `store-engineer` is needed for G6.4
(multi-select) and G8.3 (shadow-layer modelling); `test-engineer` owns the §6
measurement gate.

Gates that will bite: `css-token-policy`, `no-css-var-fallbacks`,
`button-primitive-usage` (new popovers must use `Button`),
`no-third-party-icons` (run `bun run icons:sync` after adding any icon),
`boundary-validation` (gradient / box-shadow parsers are boundaries — TypeBox
them, no `as`).
