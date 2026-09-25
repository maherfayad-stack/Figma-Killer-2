# Inspector progressive disclosure
> **Purpose:** the properties panel's density contract: laws, goals G1–G12, the field model, the height gate · **Read when:** touching the inspector, or reading a "Law n" / "§4 Gn" code comment · **Trust:** current · **Owner:** panel-designer · **Verified:** not yet

The properties panel's density contract: five laws, ten goals (G1–G10), the
field model every numeric control shares, and the list of Figma controls Studio
deliberately refuses to copy.

This page is the **authoritative reference for the vocabulary the inspector
source cites**. Roughly fifty files under
`src/admin/pages/site/panels/PropertiesPanel/`, `src/ui/components/` and
`src/core/` carry comments of the form *"Law 3 (§1)"*, *"§4 G5"*, *"G9.2 / §7 /
§8.4"*, *"G4.9"*, *"G6.2"*. The section numbers below are the ones those
comments mean — `§1` is the laws, `§4` is the goals, `§5` the field model, `§6`
the measurement gate, `§7` the do-not-copy list, `§8` the resolved decisions.
**Keep the numbering stable.** (`§2` was folded into `§1` before this page
existed and is deliberately never reused; `§5` was empty until W8-1 wrote the
field model into it, which added a section without renumbering one.)

> **How the panel is built.** The inspector is the Penpot-exact panel of
> Track P: a Design / Prototype / Inspect shell (`src/admin/pages/site/inspector/`),
> one `INSPECTOR_SECTIONS` manifest entry per section, each re-skinned to the
> measured Penpot baseline (`docs/audits/penpot-inspector-baseline/`); the write
> target is resolved by `resolveWriteTarget.ts` ("the write target is a rule, not
> a mode"), and computed values are read through `SelectionModel` (from the live
> DOM at Tier 2). `SelectorInspector.tsx`, the separate surface for a bare CSS
> selector, keeps its search bar and category rail. Every law and primitive below
> applies to all of it. The same rules in design language are in
> [`docs/design.md`](../design.md) → "The inspector"; why the panel was rebuilt this
> way is LIVE §7.3 in [`docs/decisions.md`](../decisions.md).

---

## Status

G1–G12 shipped: G9 completed in W8-1, G11 (Export) added in W8-4, G12
(Studio extras) added when P3 completed (`STATE.md` `panel-25`, item 11).
One piece did not, and is an open row in
[`ROADMAP.md`](../../ROADMAP.md) §13:

| Open | What is missing |
|---|---|
| **G6.4 — Selection colours** | Listing every distinct colour across a multi-node selection and rewriting all of them from one edit. Deferred at `FillSection.tsx`. Its blocker — store-side multi-select style editing — is gone as of W8-3 phase 1 (`setNodesInlineStyles`, §9); what remains is the aggregation UI and the class-target half, which is W8-3 phase 3. |

**§6 — The measurement gate — closed** (`STATE.md` `panel-27`, P6). A real
gate now runs in two halves: the static/manifest half
(`src/__tests__/inspector/measurement.test.ts`) and the real, laid-out-DOM
half (`tests/e2e/inspector-panel-measurement.e2e.ts`, Playwright). See §6
below for what each asserts and the real numbers they measured.

One goal was superseded rather than shipped as written: **G8.4** moved
`transform`/`transition`/`animation` out of Effects, but into a full
**Animations** section rather than into a `⚙` popover. P3 item 11 (Studio
extras, `STATE.md` `panel-25`) finished the move: `transform`/
`transformOrigin` landed on their own `TransformSection.tsx` (no Penpot
section claims them; Figma's own motion lives in prototyping, not the style
panel), and `animation`/`transition` landed on
`inspector/sections/AnimationsSection.tsx` — reusing
`AnimationEditorPopover.tsx`/`AnimationScrubRow.tsx` unchanged, which is
where the structured per-entry editor and scrub row still live. See **G12**
below for the full six-section list.

---

## §1. The five laws

Everything in §4 is an application of one of these. When a decision is not
covered by a work order, decide it with these.

### Law 1 — An unused section costs one line (F13)

Figma's Fill, Stroke and Effects sections are *lists*. Empty list ⇒ a title and a
`+`.

**Rule:** a section with zero set properties and no mandatory control renders as
`Title  [+]` and nothing more — **and it is not a disclosure**. No chevron, no
toggle, no body: there is nothing behind the chevron, so offering one is a lie
that costs a click and grows the header by an empty box. The header earns its
accordion the moment something is applied.

Was implemented once, centrally, as `collapsedWhenEmpty` on
`ClassStyleSectionDefinition` (`classStyleSections.ts`), applied by
`StyleSectionGroup` in `StyleSectionsEditor.tsx`. P3 is complete
(`STATE.md` `panel-25`) — that registry and renderer are deleted, and every
section now applies the SAME law locally, in its own file, through the
`Section` primitive's **`empty`** prop (e.g. `StrokeSection.tsx`'s own
`setAnywhere` check, `TransformSection.tsx`'s own — see each migrated
section's own doc for its copy of this reasoning). Callers still pass the
fact ("nothing is applied"), never the presentation — no section special-
cases its own header. Emptiness is still judged **across every context**,
not just the active breakpoint — a value living on another tab is still the
user's own work and must never be hidden behind a `+`.

**Layout is the one section that rests as a *collapsed disclosure* rather
than an empty header, and that is deliberate (`STATE.md` panel-39).** The
law's "no chevron, no body" clause is about a section with nothing behind it.
Layout on a plain block is not that: `overflow` ("Clip content"), padding,
margin and the item-level `flex`/`gridColumn`/`gridRow` are real, working CSS
on any element regardless of its own `display`, and `Section`'s `empty` prop
would delete them. So Layout rests at **one row** like every other unused
section — a title, an "Add auto layout" `+`, and an indicator dot if anything
it claims IS set — but its chevron discloses a real body in one click. The
cost of getting this wrong was measured: rendering that body unconditionally
was 199px on every selection with no layout at all, the single largest line
item in the Design tab's overflow of its 900px budget (§6). This exception is
for a section whose controls apply to every node; a section that genuinely
has nothing to show still takes `empty`.

**"Nothing is applied" means nothing STORED — Fill is the one section (so
far) where that alone is not the whole story.** `STATE.md` `panel-30`: a
node whose `background-color` resolves through an ambient/global CSS rule
the parser captured but never attached to this node's `classIds`, or whose
`color` is plain unremarkable inheritance, renders a real colour on the
canvas that nothing in `storedStyles` explains — and `FillSection.tsx`'s
`setAnywhere` used to be blind to it, collapsing next to a canvas that
plainly disagreed. `setAnywhere` now ALSO opens when
`renderedNotStored.ts`'s `rendersUnstoredValue` says the frame is genuinely
painting/inheriting something no stored source explains (gated by the
Tier 2 `computedValuesLoading` flag, and, for `color`, by `isTextNode` — an
ordinary container's inherited black text is not the element's own paint the
way a body's white background is). The row this reveals is presented per
§5.0's three-tier vocabulary below, generalized from a scalar field to a
`PropertyList` row — see that section for the full account, including why
the section's "N set" INDICATOR still counts only `storedStyles`.

**`panel-32` widened the same fact: "nothing stored" is not the only way a
property's value can be true and invisible — it can be stored SOMEWHERE, just
not at the ACTIVE EDITING CONTEXT.** `FillSection.tsx`'s `storedStyles` is
built from `collapsedStyleBag.ts`'s `buildContextOnlyClassChain` — by design,
it drops a class's BASE declaration entirely once a breakpoint/condition
context is active (see that module's own doc: "a value set only at BASE reads
as unset-here"). A user on a mobile project, viewing a non-desktop breakpoint
tab, whose `.title` class declares `color` at base with no override at that
breakpoint, hit exactly this: the colour is genuinely their own CSS, plainly
rendering, and Fill still showed nothing — a DIFFERENT hole than panel-30's
(that one had NO stored source anywhere; this one has one, just not here).
`rendersUnstoredValue` now takes a second, required argument —
`storedAtActiveContext` — and a real class source elsewhere in the node's
EFFECTIVE (base + override) provenance chain is, on its own, enough reason to
show the row muted; the CSS-initial-value guard is never consulted for that
branch (a declared source is never a UA default). The muted row's own popover
now also states, via an informational `SourceConstraintNotice`
(`writeTargetNote`), that editing saves a NEW declaration at the active
context rather than touching the one being shown — the actual write mechanism
(`commitApi.ts`'s `writeToTarget`: a class target with an active context
always calls `setClassContextStyles`, never `updateClassStyles`) was already
honest; only the copy was silent about it. The header's own "Add text
colour"/"Add solid color fill" buttons are gated on the ROW's visibility
(stored or muted) now, not on `storedStyles` alone — offering "Add" beside a
colour that is plainly showing was the same lie in a different control.

Stroke's per-side colour row and Shadow/Blur's structured layer rows have the
identical class of gap (their own `setAnywhere`/row-visibility checks are
ALSO context-only), and were deliberately NOT migrated in the same change:
Stroke's row reads four sides through a uniform/mixed model with its own
`ColorValueInput`+`placeholder` idiom (distinct from Fill's "show the real
value, muted" idiom — see `StrokeSection.tsx`), and Shadow/Blur's rows are
structured multi-field values (offset/blur/spread/colour, or a blur radius)
with **no muted-rendering concept at all today** (`EffectsSection.tsx`, which
merged them in P2-F: "no `currentStyles` bag is built here" — a genuinely separate, larger
feature: parsing a computed `box-shadow`/`filter` string into a synthetic
muted layer, then wiring per-synthetic-layer write-target resolution). A
future session must still reuse `rendersUnstoredValue`, not reimplement this
check, when it takes those two on.

### Law 2 — Rare options live in a popover anchored to the thing they modify (F5, F8, F17, F21, F25–F27)

Figma has exactly one shape for this: a small **⚙ / sliders icon** at the right
edge of the control cluster it belongs to, opening a floating panel. It never
uses an "Advanced" accordion inside the panel — that would still cost a row and
still push everything below it down.

**Rule:** anything used in under ~10% of edits goes behind a `⚙` popover on its
own cluster.

### Law 3 — Optional fields are *added*, never pre-drawn (F30, F31)

Figma does not show min-width and max-width. It shows W, with a dropdown that
offers *Add min width…*. Once added the row exists and can be removed again.

**Rule:** a property with no value and no default-worth is not a field. It is a
menu item on the field it constrains.

`AddablePropertyField`'s menu *reveals a row and writes nothing* — the property
is written on first commit. We edit real files; a reveal that emitted
`min-width: 0` would be a bug, not a convenience.

**The Module block obeys this too, since `panel-41`.** It used to walk a
module's whole `schema` and draw a control per key regardless — on a
Studio-imported `<img className src alt />` that meant three resident select
rows (`loading`, `fetchPriority`, `decoding`) for attributes the JSX never
wrote. `renderModuleTabContent` now partitions the rows by whether the user's
source sets them, and `ModuleBlock` puts the rest behind the block header's
own disclosure (`N more`). Three rules make it honest:

- The partition asks `selectedNode.props`, **not** the resolved prop bag. The
  resolved bag folds in `definition.defaults`, so every schema key is
  "present" there and the partition would be a no-op. A node *inserted* in the
  editor is seeded with those same defaults in its own `props`
  (`mutations.ts`), so its rows stay resident — the fold is a fact about
  parsed source, which is where pre-drawn rows come from.
- A **breakpoint override counts as set** even when the base value is absent.
  The user wrote it; hiding the only row that shows it would hide their edit.
- The disclosure is the header's trailing button, not a row of its own,
  because a row costs exactly what it hides. It is a fold, not a deletion:
  one click mounts every row under the same `property-control-<key>` test id,
  with the same `ParamPromotableRow` wiring the Visual-Component param surface
  drives.

### Law 4 — Multi-value properties expand in place, and remember (F9, F11, F18–F19)

Padding is one pair of fields with a toggle to four. Corner radius is one field
with a toggle to four. Stroke weight is one field with a menu to four. The
toggle stays lit while expanded, so the state is legible, and it is per-user
sticky, not per-selection.

**Rule:** never draw four sides when the four are equal. Draw one, plus the
expand affordance.

`ExpandableFieldCluster` is the one idiom. `linked` is derived from the values,
never stored; expanding writes nothing; the expand state is sticky per cluster
id because the panel remounts on every selection change.

### Law 5 — The mode chooses the fields (F3, F4, F6, F7, F29)

A frame with no auto-layout shows W/H, and Clip content one click inside the
collapsed Layout row (Law 1's own exception, above). Turn on vertical
auto-layout and the section opens with the align pad, gap and padding.
Switch to grid and the track cell replaces the align pad. Nothing is
disabled-but-visible; it is absent.

This already held for `display: flex | grid` (`LayoutSection.tsx`) and for
`position` offsets (`PositionSection.tsx`). **This law is already law here.**
Extend it, do not re-litigate it.

---

## §3. The four primitives

Nothing in §4 lands cleanly without these. All four live in `src/ui/components/`
and are covered by the same gates as their neighbours.

### §3.1 `InspectorPopover` — used by G3, G5, G6, G7, G8, G9

An anchored, portalled, dismissible **panel** (not a menu). It shares
`ContextMenu`'s anchoring rather than forking the positioning maths. Because it
portals out of the panel, it sets `data-field-skin="inspector"` on its own root —
any future portalled inspector surface must do the same, or it renders
admin-shaped pill controls inside the design tool.

**Viewport fit.** `useAnchoredFloating` only picks a *side*; it cannot help a
panel that is taller than the viewport, which is every tabbed ⚙ popover opened
from a trigger low in the Properties panel. `InspectorPopover` therefore runs a
second, pure pass — `fitFloatingToViewport` in `src/ui/lib/floatingViewportFit.ts`
— that clamps the origin against a 12px viewport margin and returns a
`max-height` ceiling, published as `--inspector-popover-max-height`. The panel
then never extends past the bottom (or any) screen edge; `.body` scrolls the
overflow instead. Height is read from `offsetHeight`, not
`getBoundingClientRect()`, because the latter includes the enter animation's
`scale()` and measures short. Geometry is unit-tested in
`src/ui/lib/floatingViewportFit.test.ts`.

### §3.2 `PropertyList` — used by G6, G7, G8

The Fill / Stroke / Effects list shape (F13, F14, F16, F20). One component,
three consumers.

- Empty ⇒ renders **nothing but its header's `+`** (Law 1). The header is the
  existing `Section` with `actions` and `empty` — the second is what takes the
  chevron and the toggle away, not just the body.
- Non-empty ⇒ a row per entry: `[leading] [summary] [value] [👁] [−]`.

### §3.3 `ExpandableFieldCluster` — used by G4, G5, G7

F9 / F11 / F19's one-becomes-four idiom, as a primitive, so padding, radius and
stroke sides cannot drift apart.

- Props: `collapsed` (1–2 fields), `expanded` (n fields), `expandLabel`, and a
  `linked` boolean **derived** from whether all sides are currently equal —
  never stored.
- The toggle carries `pressed` while expanded and is persisted in
  `editorPreferences` per cluster id, because the panel remounts on every
  selection change.
- `collapsedIcon` / `expandedIcon` override the default 2×2 grid glyph per
  state. Radius passes a chain link while collapsed and the grid while
  expanded, because for radius the toggle really is Figma's **link** — it
  decides which declaration is written, not only how many fields are drawn
  (G5).

### §3.4 `AddablePropertyField` — used by G2

F30 / F31's "Add min width…". A field whose trailing chevron opens a
`ContextMenu` listing its own mode options, then `Add <constraint>…` for each
unset companion property, then any project-token apply action.

- Adding **writes nothing** — it *reveals* the row in an unset state with the
  computed value as placeholder. The property is written on first commit. This
  matters: Studio writes real CSS to the user's file, so "Add min width" must
  not put `min-width: 0` in their source.
- The revealed row carries a `−` that both clears the property and re-hides it.

---

## §4. The goals (G1–G12)

### G1 — The empty-section law

> **Figma:** F13. Fill, Stroke and Effects on a plain frame are three lines total.

A section marked `collapsedWhenEmpty` with nothing set renders as `Title [+]`
and nothing more — a static header, not a collapsed accordion (`Section`'s
`empty` prop; see Law 1). `+` reveals the body for that selection only, and a
`+` that writes a real value (Fill's colour, Effects' shadow, Animations')
reveals in the same gesture — otherwise a user who keeps
`propertiesSectionsExpanded` off would add a fill and be shown a closed
section. The flag is set
on `spacing`, `fill`, `border`, `effects`, `animations`, `interaction`,
`typography` — and **not** on `position`, `size`, `layout`, `appearance`, which
keep their controls always present (`position`/`size`/`layout` are Figma's
always-present Position/Layout block, F1/F3; `appearance` joined the
never-collapse set when G5 introduced it — see `classStyleSections.ts`).
Margin (the only property left in `spacing` once G4 moved padding into
`layout`) *does* collapse: an element with no margin costs one line, same as
any other empty section.

A section with a value set at a *non-active* breakpoint is **not** empty for the
purpose of this rule — hiding it would hide the user's own work. Such a section
carries the existing `indicator` dot.

**Export (G11) obeys this law without the flag.** It is not a set of CSS
properties, so it is not in `classStyleSections.ts` at all (see G11 for why);
it implements the same one-line-plus-`+` rest state directly in
`ExportSection.tsx`. `emptySectionLaw.test.tsx` therefore still covers exactly
the seven flagged CSS sections and nothing more.

**Acceptance:** a plain `<div>` with two classes set renders a panel that fits a
900px-tall viewport with no scroll.

### G2 — Size: constraints on demand (F30/F31)

Six always-drawn dimension cells become two `AddablePropertyField`s (W, H) whose
chevron menu carries the sizing intent (`Fixed`/`Hug`/`Fill`), then *Add minimum
width…* / *Add maximum width…*, then *Apply variable…*. The sizing segmented
control folds into the field's own dropdown.

**Acceptance:** an element with only `width` set renders one row.

*Shipped deviation:* `aspectRatio` and `boxSizing` went into a **Size** `⚙`
popover, not the Layout `⚙`.

#### Hug/Fill is resolved against the real parent (W8-4)

`Fixed`/`Hug`/`Fill` are **intents**, and the CSS that expresses an intent
depends entirely on how the element's parent lays it out. `elementSizing.ts`
classifies each axis against the parent's *computed* `display`/`flex-direction`
(`sizingAxisRole`) and writes accordingly:

| Parent / axis | Fill | Hug |
|---|---|---|
| flex, **main** axis | `flex: 1 1 0` (clears the axis length) | `width\|height: fit-content` + `flex: 0 0 auto` |
| flex, **cross** axis | `align-self: stretch` (clears the axis length) | `width\|height: fit-content` |
| grid | `justify-self` (inline) / `align-self` (block) `: stretch`, clears the axis length | `width\|height: fit-content` |
| block | `width\|height: 100%` | `width\|height: fit-content` |

The earlier model wrote `fit-content`/`100%` unconditionally. `100%` on a flex
child resolves against the container's content box and ignores `gap`, so a
"Fill" item in a gapped row **overflowed the row and shoved its siblings out** —
the control claimed one thing and the source did another.

**Read-back mirrors the write.** `currentSizingMode` asks the same role
question and looks for the same marker `sizingPatch` would have left, so the
picker always reflects what is really in the source. A `width: 100%` on a flex
child reads as **Fixed** — there it *is* just a literal length.

**No parent layout ⇒ no Hug/Fill.** When the element's parent can't be resolved
(its parent is a JSX call site in another file, nothing has rendered it on the
canvas yet, or it has no parent node), the axis stays on `Fixed` and the Hug /
Fill menu rows render **disabled with a named reason as their tooltip**
(`AddablePropertyFieldMode.disabledReason`) rather than disappearing. The parent
layout comes from `useSizingParentLayout` — a live `getComputedStyle` read of
the parent's rendered element, the same source `SingleNodeAlignRow` uses for
G10; a stored declaration cannot tell you what the cascade resolved `display`
to.

### G3 — Layout: the settings popover (F3–F8)

A `⚙` opens a mode-filtered *Layout settings* popover holding `alignSelf` /
`justifySelf` / `flex` — which describe how *this* element behaves in its
**parent**, not how it lays out its children, the conceptual bug behind half the
section's height — plus split-axis `rowGap`/`columnGap` and
`gridColumn`/`gridRow`. `overflow` is promoted to a *Clip content* checkbox (a UI
rename only; the CSS written stays `overflow`), and the wrap toggle moves to the
cluster header.

**G3.4 — one direction control, not two (P9).** `FlexDirectionControl`'s
`row | column | row-reverse | column-reverse` segments duplicated a choice the
mode row above already makes (*Horizontal stack* writes `flex-direction: row`),
so the same fact had two pickers with different glyphs on adjacent rows. It and
`WrapToggleButton` are replaced by `FlexFlowControl` — a **reverse** toggle
whose glyph follows the current axis, beside the **wrap** toggle, as one
cluster. Nothing became unreachable: `row`/`column` are the mode row and
`wrap-reverse` is still the Layout settings `⚙`. The wrap toggle clears
`flex-wrap` when switched off (`nowrap` is the initial value); the reverse
toggle writes the plain axis instead, because clearing `column-reverse` would
fall back to `row` and silently turn a column into a row.

The two gap fields now carry their own marks (`RowGapIcon` / `GapIcon`) rather
than sharing one — a picture of a column gap over a field writing `row-gap` is
the same small lie the panel refuses everywhere else.

*Shipped correction:* the `⚙` is **resident on the Clip-content row**, not
anchored to the gap field, so `alignSelf`/`justifySelf`/`flex`/`gridColumn`/
`gridRow` stay reachable on a node that is not a container
(`LayoutSettingsButton.tsx`).

### G3.3 — `AlignGrid`, the 3×3 pad (F4/F6/F7)

Two captioned linear alignment rows (~56px) become one uncaptioned 3×3 pad
(~48px) that writes `alignItems` + `justifyContent` in one gesture — one click
instead of two — keeping the linear controls as its keyboard model. Grid mode
maps to `alignItems` + `justifyItems`.

### G4 — Spacing: padding as a linked box (F4/F9)

Padding **moves into the Layout section**: padding is a layout property of a
container, margin is a relationship with siblings. Its toggle cycles three
states — **all sides -> horizontal/vertical -> four sides** (P9). The `all`
state is Figma's link: one field, writing the four longhands in a single
history entry (`LinkedSidesField.tsx`). It is not the `padding` shorthand —
here the link is about how many fields are drawn, unlike corner radius (G5.5),
where the shorthand is what a human writes and the link picks the declaration.
Before P9 the H/V pair was the whole collapsed state, so the most common
padding gesture of all — one number on every side — took two edits. The `SpacingBoxControl`
diagram — the tallest single block in the panel — survives as an opt-in behind
the Spacing `⚙` (*Box model*), because it is the best control for "which side is
which" and only the wrong *default*.

**G4.9** — the drag-scrub gesture is wired into the padding/margin
`TokenAwareInput`s (`ScrubTokenField.tsx`), closing the parity plan's
"drag-scrub wired only into SizeSection's six fields" inconsistency.

### G5 — Appearance: a section that did not exist (F10–F12)

A new `appearance` section between `size` and `background` collecting `opacity`
(out of Effects), the four `border*Radius` longhands (out of `BorderControl`) on
an `ExpandableFieldCluster`, a droplet button in the header opening a grouped
`mixBlendMode` menu, and an eye that writes `visibility: hidden` — **not**
`display: none`, which is the layer tree's different hide (**G5.4**). Corner
smoothing is skipped, and its icon left out rather than filled with an
invention.

- **G5.5 — The radius link writes the shorthand (P9).** The cluster's toggle is
  a chain link, and it chooses the *declaration*: **linked** writes
  `border-radius: 12px` and clears the four longhands, **unlinked** writes the
  four longhands and clears the shorthand. Never both — a shorthand and a
  longhand in one rule resolve by source order, which a property bag does not
  model. Before P9 the linked field wrote four longhands regardless, so a
  hand-written `border-radius: 12px` came back as four lines the first time
  anything touched it.

  Unlinking converts from the parsed shorthand (`borderRadiusShorthand.ts`,
  CSS's own 1/2/3/4-component expansion), in one patch, so no corner is
  invented and no measurement is needed. That module **refuses** three shapes
  — the elliptical `/` form, a value containing a function call, and more than
  four components — and a refused shorthand keeps its text in the collapsed
  field while the four corner fields disable with the reason.

### G6 — Fill: a real colour picker and a fill list (F13–F15)

Background is renamed **Fill** and rebuilt on `PropertyList`: empty ⇒ one line,
`backgroundColor` and each `backgroundImage` layer as entries, and
`backgroundSize` / `Position` / `Repeat` / `Attachment` / `Origin` / `Clip` /
`blend-mode` moved into the *layer's own popover* — drawing seven of them for an
element with no image is the exact defect this page exists to prevent.

- **G6.2** — `ColorPickerPopover`: SV square + hue rail + **alpha rail**, model
  select (HSL/RGB/HEX), the **eyedropper** (feature-detected on
  `window.EyeDropper`), the contrast readout, and an "On this page" recents strip
  that for us is the project's own colour tokens — strictly better than Figma's,
  so `TokenizedColorField`'s token integration stays as the **first** tab.
- **G6.2b — one click, not two (`STATE.md` panel-33).** The Text and
  Solid-fill rows' `summary` slot IS the swatch-plus-hex/token field
  (`ColorFieldRow`, `FillColorField.tsx`): the row's own swatch opens
  `ColorPickerPopover` directly, the same primitive G6.2 describes, with no
  intermediate "Text colour"/"Solid fill" popover in between. The row's text
  field stays free-typeable for a hex value or a `var(--token)` name, exactly
  as `ColorControl` behaves everywhere else in this panel. The one row shape
  that still opens the section's own row-activation popover is
  `writeTarget.kind === 'none'` (no honest place to land a write): a disabled
  swatch cannot open its own picker to explain why it's disabled, so
  `ColorWriteRefusalBody` states the reason there instead — that path was
  already a single click, never the reported defect. The swatch itself paints
  the RESOLVED colour (`ColorPickerPopover`'s own `value`/`resolvedValue`
  contract), never the raw `var(--token)` string — a project custom property
  has no meaning in the admin's own document, only inside the canvas iframe
  that declares it, so painting it verbatim left the swatch blank even though
  the frame rendered a real colour.
- **G6.3** — gradients round-trip or refuse: parse the user's existing gradient
  into stops, and if it does not round-trip losslessly, **refuse to open the
  visual editor and say why** (`gradientValue.ts`).
- **G6.4** — *(open)* Selection colours: with 2+ nodes selected, list every
  distinct colour in the selection and let one edit rewrite all of them.
- **G6.5 — Fill is N layers, honestly (W8-4).** `background-image` is a
  comma-separated list whose first entry paints TOPMOST, and the Fill list now
  models it that way: `backgroundLayers.ts` applies the proven
  `boxShadowLayers.ts` pattern — comma-list parse → one `PropertyList` row per
  layer → byte-identical re-join, **or refuse** with a named reason. It refuses
  a top-level `var()` (which could expand to any number of layers, desyncing
  every satellite's alignment), unbalanced parens, an empty segment, and any
  value it could not re-join exactly. Layers add / remove / reorder with the
  same gestures Effects' shadow layers use.
  - `backgroundColor` is **pinned bottom-most**, not treated as layer N+1 — CSS
    paints it below every layer and it has no per-layer satellites of its own.
  - The six positioning satellites became **per-layer**, edited
    inside each row's popover, following CSS Backgrounds 3 §2.1: a shorter list
    repeats cyclically (the control is labelled "(all layers)" so the edit that
    splits the list is not a surprise), and a list with
    MORE values than layers is **refused per property** — CSS ignores the
    extras, but a per-layer write would delete them from the user's file. The
    refusal is per property, never per section: an odd `background-size` must
    not hide six layers the user can still edit.
  - `objectFit` / `objectPosition` moved OUT of the background satellites into
    their own **Content fit** row. They size the element's own replaced content,
    which paints above the background entirely; bundling them with the image
    fill conflated two unrelated things.
  - Satellites set with no layer to apply to (`background-size: cover` alone, or
    alongside a refused layer list) get a **Background sizing** row rather than
    vanishing from the inspector.
  - The visibility eye stays omitted — §8 decision 1 is unchanged by this. What
    changed is the layer list, not the fact that CSS has no honest way to store
    a hidden-but-present paint.

- **G6.7 — Blend mode on a fill layer (P9).** Figma shows a fill's blend mode on
  the fill row itself, so `background-blend-mode` moved out of the layer
  popover's satellite list onto the row (`LayerBlendSelect`, a `Select`).
  **`mix-blend-mode` is NOT what a per-fill blend maps onto** — that is the
  element's blend against what is behind it, and it already has one control, in
  the Layer section. CSS has no general "blend one fill of an element against
  another fill of the same element"; what it has is `background-blend-mode`,
  a per-layer list composited within the element's own background stack. So the
  control exists on `background-image` layer rows ONLY: the Text, Content-fit
  and Solid-fill rows get no blend control rather than a decorative one that
  writes the element-level property behind the user's back.

  Writing one layer's blend emits the whole list, the untouched layers at their
  CSS initial — there is no "leave the others alone" syntax. A declaration
  `backgroundLayers.ts` refused to split per layer keeps the row's select
  disabled with the reason, and the popover keeps its whole-property raw field.
  The gradient row's stop count moved into its summary, where the blend select
  now sits.

- **G6.6 — Image fill, from the project's own files.** The Fill header has two
  "add a layer" buttons: a paint bucket (gradient) and an image. The image one
  opens `ImageSourcePicker` — three sources, in the order a designer reaches for
  them:
  1. **This project** — every image already on disk in the open workspace, from
     `GET /admin/api/studio/project-assets` (`server/handlers/studio/projectAssets.ts`),
     a `readdir` filtered to image extensions. `node_modules`, `.git`, `dist`,
     `.studio` and Studio's own `prototype/` scaffold are never offered.
  2. **Upload** — lands a file through `POST /admin/api/studio/asset-drop`
     (`dropStudioAsset`), the route for every image a literal URL will
     reference: into the app's own `public/` (under the app root, so a
     monorepo's `apps/web/public/`, not the project's), through the shared
     pipeline (magic-number sniffing, symlink-aware containment on the real
     path, collision-safe naming, SVG sanitisation, content dedupe). No CMS
     media library is involved: Studio's assets live on disk, in the user's repo.
  3. **URL** — written verbatim, for a CDN image.

  Nothing is written until a source is chosen — the button never inserts a
  speculative `url('')` into the user's source.

  **Which URL gets written is the load-bearing decision, and the server makes
  it** (`server/handlers/studio/assetSiteUrl.ts`, IMG-1). It is never Studio's
  own `/admin/api/studio/asset?dir=…` endpoint — that is an admin-origin URL,
  meaningless in the user's repo, and pasting it into their stylesheet would be
  exactly the lying edit this product refuses. It is the URL *their* site
  serves the file at. The upload's response carries it as `src`, and every
  entry of `project-assets` carries `{ relPath, src, buildSafe }`; the picker
  writes `src` verbatim and derives nothing. The rule: relative to the app
  root, a file under `public/` is served verbatim from the site root by every
  recognised framework, so `url('/hero.png')` works in dev and in a production
  build, from an inline `style` attribute and from a CSS file alike.

  A file elsewhere under the app root (`src/assets/hero.png`, reached through
  an `import` in the user's code) still gets a root-relative URL, because it is
  the only thing that can work at all and it *does* work on their dev server,
  but `buildSafe: false`: the picker labels that tile **"dev only"** and says
  why in its tooltip, rather than quietly shipping a background that 404s after
  `npm run build`. A file outside the app root has no URL (`src: null`); its
  tile is disabled and says nothing serves it. The admin previews a tile
  through the authenticated read endpoint; the reverse mapping URL → file
  (`imageFillPreviewSrc`) matches the written URL against each listed file's
  server `src`, never re-deriving a path from the URL.

  An image layer's popover then carries the two Figma controls, both pure sugar
  over satellites the rows underneath still show:
  - **Fit** — Cover / Contain / Stretch / Tile, writing `background-size` +
    `background-repeat` as a pair. A pair matching no preset selects **no**
    segment (`custom`) instead of being snapped to the nearest one, and an
    *unset* pair reads as **Tile**, because that is what the browser is
    genuinely doing. Choosing Tile writes the CSS initials, which collapse the
    declarations away entirely rather than leaving `auto, repeat` behind.
  - **Position** — the 3×3 keyword puck over `background-position`. Selection is
    exact: `50% 50%` lights the centre cell, `12px 40%` lights nothing.

  Either control disappears when its property was refused per-layer — that
  property's whole-declaration raw field with its reason is already there, and a
  friendly control on top of it would write the very per-layer value the parse
  refused to invent.

  **Cut in this pass:** the canvas does not rewrite a project-relative `url()`
  to the asset endpoint, so an image fill previews in the inspector (row swatch,
  layer thumbnail, picker grid) but not yet on the canvas frame itself. Apply-
  variable (PR #75) on the URL field is also not wired.

### G7 — Stroke (F16–F19)

Rebuilt on `PropertyList` (empty ⇒ one line), colour row on G6's picker, weight
as one `ScrubInput`. **The side picker is a menu, not a diagram** — `All / Top /
Bottom / Left / Right / Custom`, where *Custom* expands to four fields via
`ExpandableFieldCluster`. `borderStyle` moves into the `⚙`; width profile, join,
miter and the Dynamic/Brush tabs are vector-only and skipped; stroke position
ships only the values we can honestly write (§7).

What remained was small enough that `BorderControl` was **deleted**, not left as
a shell (**G7.6**).

### G8 — Effects (F13/F20–F22)

> **Merged again, P2-F (owner decision OD-4).** P3 items 7-8 had split this
> section into `ShadowSection.tsx` and `BlurSection.tsx`, following Penpot,
> which keeps them apart. Figma draws one **Effects** section, the owner's bar
> is Figma, and the split cost a 33px header plus a section gap on every
> selection — so shadows and blurs are one `INSPECTOR_SECTIONS` entry again:
> `inspector/sections/EffectsSection.tsx`, one header, one `+` menu (Drop
> shadow, Inner shadow, Text shadow | Layer blur, Background blur), one
> `PropertyList` with the shadow rows first, and one per-row editor,
> `EffectEditorPopover.tsx`. The models below did not change.
>
> *Earlier history, `STATE.md` `panel-25` P3 items 7-8, 11:* **G8.4**'s own `transform`/
> `transformOrigin` ⚙ has no Penpot section either — item 11 (Studio extras)
> gave it a real one, `TransformSection.tsx`, ending its stopover in
> `classStyleSections.ts`'s registry. The vocabulary below (the typed "+"
> menu, the round-trip refusal rule, F21's field shape) is unchanged — only
> the file names and section boundary moved.

`PropertyList` with a typed `+` menu mapping only to real CSS: Drop shadow → a
`box-shadow` layer, Inner shadow → `… inset`, Layer blur → `filter: blur()`,
Background blur → `backdrop-filter: blur()`. Noise / Texture / Glass / Shader are
omitted rather than shipped as a menu item that writes something else.

- **G8.3** — `box-shadow` is a comma-separated list and is **modelled** as one:
  parsed into layers (`boxShadowLayers.ts`), one `PropertyList` row per layer,
  each editing in an F21 popover (X, Y, Blur, Spread, Colour, inset), re-emitted
  by joining. Same refusal rule as gradients — if it does not round-trip, keep
  the raw text field and say why (`EffectEditorPopover.tsx`'s `'raw'` mode).
- **G8.4** — `transform` / `transformOrigin` / `transition` / `animation` are not
  effects in Figma's sense and move out of the section. *Superseded:* they are
  now owned by a full Animations section, not a `⚙`.

### G9 — Typography (F23/F25–F27)

An 8-entry grid becomes **four rows** — family / weight+size /
line-height+letter-spacing / align+valign+`⚙` — with *more* capability than
before, because the popover's Details and Variable tabs expose properties
previously reachable only by typing a property name into the custom-properties
editor.

*Superseded (`STATE.md` `panel-25`, P3 item 9):* this section now lives at
`src/admin/pages/site/inspector/sections/TextSection.tsx` (its ⚙ popover at
`TextSettingsPopover.tsx`, both under `sections/`), its own
`INSPECTOR_SECTIONS` manifest entry gated on `isTextNode`, not a
`classStyleSections.ts` registry member anymore. The four rows themselves are
unchanged; what changed is that the section dropped the Law-1
`collapsedWhenEmpty` posture this doc describes below — a text layer, by
Penpot's own confirmed behavior, always has real font values to show, so
there is no genuinely empty state to collapse to (see that file's own doc).

- **G9.4 — the relocation, completed in W8-1.** `color` moved to **Fill** and
  `textShadow` to **Effects**, which is what Figma does: a text node's colour
  *is* its fill, and a text shadow *is* a shadow. It could not ship with the
  rest of G9 because G6 (Fill) and G8 (Effects) had not yet run, and moving
  either first would have deleted the only way to reach it. Ownership is
  declared in `classStyleSections.ts` — exactly one section claims a property,
  because that array drives both the "N set" count and the style search.
  Concretely: Fill grows a **Text** row (topmost, since text paints over the
  box's own background) plus an "Add text colour" header button, and Effects
  grows `text-shadow` rows through the same `boxShadowLayers.ts` parser under
  `TEXT_SHADOW_GRAMMAR` — the same grammar narrowed to three lengths and no
  `inset`, with `EffectEditorPopover`'s `variant: 'text'` omitting the Spread
  and Inset controls that `text-shadow` has no concept of. This section is now
  literally F23's four rows.

- **G9.2** — vertical align: the honest CSS mapping is `alignItems` on the text
  node's own box, which only applies in flex context. Where it cannot be written
  honestly the group renders **disabled with a tooltip that says why**, rather
  than disappearing — the asymmetry with Figma is a real difference, and hiding
  it is the lie this repo's second invariant forbids (`verticalAlignWrite.ts`).
- **G9.3** — the `⚙` opens a tabbed popover: **Basics** (`fontStyle`,
  `textDecoration`, `textTransform`, `whiteSpace`, `textOverflow`, `textIndent`,
  paragraph spacing), **Details** (`fontVariantNumeric`, `fontFeatureSettings`,
  `hangingPunctuation`, `fontKerning`), **Variable** (axis sliders from
  `font-variation-settings`). The Variable tab renders **only when the resolved
  font actually exposes axes** (`src/core/fonts/variationAxes.ts`) — a
  variable-font tab on Helvetica is noise.

### G10 — Position and align (F1/F2/F29)

`AlignBar` mounts at the top of the Position section for single-node selection,
with a 7th overflow button carrying *Tidy up* / *Distribute vertical spacing* /
*Distribute horizontal spacing*. F29's constraint dropdowns appear in absolute
mode — one per axis, offering Figma's five constraints (Left / Right / Left and
right / Centre / Scale) and reading back the one the edited bag declares. Each
constraint's inset fields follow it: one field per pinned edge, two for the
constraints that pin both (see G10.3). `rotate` is now **resident** on the section's
third row (`RotationRow.tsx`, paired with `ZIndexSettingsRow` on the same row)
rather than tucked behind a popover — it writes the standalone `rotate`
property and refuses, with a reason, when `transform` already contains a
rotate function. `zIndex` keeps its own small sliders-icon `⚙` trigger
(`ZIndexSettingsRow`).

- **G10.2 — Flip horizontal / vertical (W8-1).** Two toggles beside the
  rotation field, writing the standalone **`scale`** property (`scale: -1 1` /
  `1 -1`) for the same reason rotation writes standalone `rotate`: one honest
  declaration instead of rewriting one item of a `transform` function list.
  The value model is `flipValue.ts`. Two refusals, both disabled-with-a-reason
  per §8.4 rather than hidden: `transform` already carrying a scale-family
  function (CSS applies `scale` first, so both would compound invisibly), and
  a `scale` value outside the plain-number space the toggles can reproduce
  (`50%`, a `var()`, a third z component). Rotation stays live through both —
  the collisions are independent. An unflipped element gets no `scale`
  declaration at all, never a no-op `scale: 1 1`.

- **G10.3 — The constraints crosshair (W8-4, completed P9).** Figma's
  constraints widget sits beside the per-axis constraint dropdowns in
  absolute/fixed mode (`ConstraintsDiagram.tsx`) — four edge bars plus a
  centring line per axis, over a square standing for the containing block.

  **Crosshair and dropdown are two faces of one model.** P9 replaced the old
  two-option `Left ▾ / Right ▾` side picker — which only chose *which inset
  property the value field wrote to*, leaving stretch, Centre and Scale
  reachable by crosshair clicks alone — with a dropdown over the same five
  constraints. Both surfaces read and write through `useConstraintAxes`, so
  they cannot disagree about which constraint an axis is in, and a refused
  constraint is a **disabled option carrying its reason** rather than a choice
  that silently does nothing. The inset fields stay: one per pinned edge, two
  for the constraints that pin both.

  Every mapping and every refusal lives in one pure module,
  `constraintMapping.ts` (unit-tested in `constraintMapping.test.ts`);
  `useConstraintAxes.ts` supplies it the three things it cannot compute — the
  element's live insets, its parent's padding box, and whether that parent
  really is the containing block. The components own pixels and pointer events
  only:

  | Constraint | The CSS it actually is |
  |---|---|
  | Left / Top | the start inset set, the end inset cleared |
  | Right / Bottom | the end inset set, the start inset cleared |
  | Left and right (stretch) | **both** insets set, `width`/`height` cleared |
  | Centre | `left: 50%` plus a `-50%` pull-back |
  | Scale | both insets as **percentages** of the containing block, size cleared |

  Centring writes the **standalone `translate` property**, never a
  `transform: translateX(-50%)`, for the same reason `RotationRow` writes
  standalone `rotate` and G10.2 writes standalone `scale`: one honest
  declaration instead of rewriting one item of a function list. That leaves
  exactly two collisions, both refused by name and surfaced as the disabled
  control's tooltip (§8.4): `transform` already carrying a translate-family
  function (CSS applies `translate` first, so the two would compound), and a
  `translate` whose component on this axis is somebody else's real value
  (`10px`, a `calc()`, a `var()`, a third z component). Leaving centring
  releases only a pull-back this control itself wrote.

  **Scale refuses without a measurement.** Percent insets are derived from the
  element's used insets and the containing block's padding box, read off the
  live canvas frame; with no frame reporting one, Scale is disabled with that
  reason rather than converting against a guess. A `fixed` element resolves
  against the viewport, which this read does not measure, so Scale refuses
  there too.

  **The whole cluster is gated on positioned context**
  (`resolvePositionedContext`): `fixed` passes (the viewport is a real frame of
  reference), `absolute` passes only when the element's own parent really is
  its containing block, and an unverifiable parent stays disabled — the same
  "no frame, no claim" posture `resolveAlignWrite` takes for the align row.
  Normal-flow positions never reach the cluster at all (Law 5 already keeps
  the constraints shape absolute-only).

  **One constraint change is one undo entry.** The multi-write limitation W8-4
  recorded (stretch sets both insets and clears the size, landing as three
  history entries because the crosshair replayed its plan property by
  property) is gone: `useConstraintAxes` commits the whole plan through
  `commitStyleMany`.

  The cluster's gate is stricter than the old side picker was, deliberately.
  A side picker moving a value from `left` to `right` needed no measurement;
  a *constraint* is a claim about the element's relationship to its parent, so
  with no frame rendering that parent the dropdown is disabled with the
  "can't verify" reason. The inset fields beside it stay editable throughout —
  they are ordinary declarations, not claims.

### G11 — Export (W8-4)

> **Figma:** the Export block at the bottom of the right panel. Empty ⇒ a title
> and a `+`; add an export setting and it becomes a row of *format + scale*
> with a run button.

`inspector/sections/ExportSection.tsx` (P3 item 10, `STATE.md` `panel-25`) —
its own `INSPECTOR_SECTIONS` manifest entry (`order: 9`, right after Text and
before the `styles` composer), not a bespoke mount at the bottom of
`StyleSurface.tsx` anymore. The typed `+` menu is `NODE_EXPORT_MENU`
(`nodeExportModel.ts`, unchanged): **PNG @1× / @2× / @3×** and **SVG** add a
row; **Copy as PNG**, **Copy CSS** and **Copy JSX** run immediately, because a
copy has no settings to keep and parking one in the list would mean "add the
row, then press its button" for a single verb.

**Copy as PNG carries a `⌘⇧C` hint**, resolved from the keybindings registry
via the entry's `commandId` — it is the discoverable half of the global
shortcut, not a second implementation of it. Both call `copyPngToClipboard`
(`nodeExportClient.ts`), which is `fetchNodePngBlob` plus
`navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])`.

**Why it is not in `classStyleSections.ts`, and never was.** Every entry in
that registry is a set of *CSS properties on a style target*; Export is a
statement about the *node*, unaffected by which style target happens to be
open, meaningful on an unclassed element, and matching no property search. So
it was always mounted once, node-level, rather than through that registry —
this migration only moves *where* it mounts (its own manifest entry, gated by
its own `appliesTo`), not that decision. The rows are per-selection session
state, not persisted: Studio's file is the user's repository, and writing an
export setting into their `.tsx` is not a trade this tool makes. The row list
resets on selection change via the section's own internal `key={nodeId}`
remount (`ExportSection.tsx`'s own doc) rather than the manifest's shared
mount loop, which keys every entry by a constant section id.

**One disclosed behaviour change from the pre-migration mount:** before this
migration, Export rendered unconditionally once `nodeId`/`activePageId`/a
Studio session were present, regardless of `StyleSurface.tsx`'s own
`canEditStyleHere`/`nothingWritable` gates (a read-only role, or a
structurally-locked node with no writable class, could still export/copy).
Migrating Export into the shared `INSPECTOR_SECTIONS` render loop — required
both by this series' own "don't touch the mount loop" rule and by Penpot
ordering (Export must render *before* the `styles` composer, not after it) —
means Export is now hidden in those same two states, same as every other
migrated section. See `STATE.md` `panel-25`'s Section 10 entry for the full
reasoning; flagged for a human call on whether a follow-up should restore
Export's independence from write-permission gating.

**PNG** — `POST /admin/api/studio/node-png`. The page is photographed through
the existing capture pipeline (`captureFrames`, the same one `studio_screenshot`
and the share snapshot use), and the node's own rectangle is cut out of the
result. The rect and the scale both come from the capture's own report
(`nodeRects` + `imageScale`), never from the requested density — the pipeline
clamps `dpr` against its resolution caps, and deriving the crop from what was
actually rendered is what keeps the cut correct when it does.
`resolveNodeCropBox` rounds outward (so a fractional rect never clips the
element), clamps a rect that overhangs the frame, and refuses two cases by
name: a 0×0 element, and one that lies entirely outside what was photographed.

`nodeId` is **optional** on that route. Omitted, the whole captured frame comes
back uncropped — the "nothing selected" case of ⌘⇧C, where there is no element
to crop to (`page.rootNodeId` is a `base.body` node whose children *are* the
iframe body, so nothing in the DOM carries its `data-node-id`).

**SVG** — no route. Whether a node *has* an honest vector form is a fact about
the parse the browser already holds, not a rendering question:
`resolveNodeSvgExport` reads `props.svg` (the markup `inlineSvg.ts` serialised
for `base.svg`) or an `<img src>` resolving to an `.svg`, and everything else
is refused **by name** — `rasterized-html`, `raster-image`, `dynamic-svg` —
rather than wrapped in an `<svg><image href="data:…">` shell. That shell is
what "export anything as SVG" tools emit; it hands the user a file that claims
to be vector and is not, which is the read-side version of the write invariant
in `PROJECT-BRIEF.md`.

**Copy CSS** — `collectNodeCssDeclarations` over the `provenanceByProperty`
map `useSelectionModel()` already computes. Only properties something *declares* are
copied (a full computed bag is the UA's opinion, not the element's design),
each at its provenance **winner**'s value; a property the panel marks
`ambiguous` falls back to the frame's real computed value rather than picking
one of the candidate declarations at random. A node with no class gets bare
declarations under a comment header, never an invented selector.

**Copy JSX** — `POST /admin/api/studio/node-jsx` returns the node's own source
verbatim, located with `locateJsxElement.ts` — the same locator every codemod
resolves its write target with, so "the JSX you copied" and "the JSX an edit
would rewrite" are the same span by construction. Never regenerated from the
tree.

Both routes require a session (`nodeExportRoutes.ts`): a capture runs *on
behalf of* a user id, and the JSX is the contents of a file in their
repository.

### G12 — Studio extras (P3 item 11, `STATE.md` `panel-25`)

> **Figma:** no equivalent. Component call-site props, HTML attributes, raw
> `transform`, motion, `cursor`/`pointer-events`, and the uncurated CSS long
> tail have no Penpot section to land in — Figma's own component instance
> override surface, prototyping tab, and "add variable" flow cover different
> ground. These five concerns had no Penpot home before P3 started (the
> plan's own item-11 gloss names them "Component props, Attributes, Custom
> properties") and still don't; this is where Studio's own additions live,
> at the tail of the Design-tab scroll, after Export.

P3's last item folded the remaining "no Penpot home" concerns into their own
`INSPECTOR_SECTIONS` manifest entries — the same one-continuously-scrolling
column every other section renders in, no separate tab. **S5 then moved four
of them off the Design tab's always-mounted height**, because none of them is
something a designer reaches for often enough to pay 164px for on every
selection at the 12px section gap (152px while panel-39 held it at 8px — see §6):

| order | id | Component | Where it mounts | Claims |
|---|---|---|---|---|
| 3 | `component` | `ComponentSection.tsx` | Design, inline, directly under Measures — ONE selected `studio.instance` only | call-site props |
| 11 | `transform` | `TransformSection.tsx` | Design **More**, and Prototype expanded | `transform`, `transformOrigin` |
| 12 | `animations` | `AnimationsSection.tsx` | Design **More**, and Prototype expanded | `animation*`, `transition` |
| 13 | `interaction` | `InteractionSection.tsx` | Design **More**, and Prototype expanded | `cursor`, `pointerEvents`, `userSelect`, `scrollBehavior` |
| 14 | `customProperties` | `CustomPropertiesSection.tsx` (manifest wrapper) | Design **More** | every uncurated key |

Two manifest fields carry that, and nothing else changed about any of these
components:

- **`tabs`** (default `['design']`) — which `InspectorShell` tabs mount the
  section. The three motion/behaviour sections are `['design', 'prototype']`:
  expanded on Prototype, which is the tab that exists for exactly this
  material, and still reachable from Design so a CSS `transform` doesn't
  require knowing to switch tabs.
- **`designGroup`** (default `'primary'`) — `'more'` means "render inside the
  ONE collapsed `Section title="More"` at the end of the Design tab", which
  `StyleSurface.tsx` mounts with the same loop it uses for the continuous
  scroll. Collapsed, the four of them cost one 32px header between them.

The retired `attributes` entry is gone entirely: `panel-29` removed it from
the manifest on direct user feedback and parked `AttributesSection.tsx` /
`.module.css` / `htmlAttributesModel.ts` "unmounted but intact", which is the
`No dead code` rule's exact failure mode. S5 deleted all three and their
tests. The `htmlAttributes` **prop** is untouched — the publisher,
`htmlImport`, and every base module's renderer still read it; only its
retired editor UI is gone.

**The Component section, after P2-G (UX-4, UX-7, UX-14, UX-16).** It is no
longer at the tail: an instance's props are the thing an instance is selected
to edit, so the entry is `order: 3`, directly under Measures — Penpot's frame
order (layer → measures → component → layout) and Figma's. It is drawn as ONE
title row, `SectionStaticHeader` reading "Button · Local" with Detach and Swap
as icon buttons in the trailing slot, where it used to stack a "Component"
section title, a filled band repeating the name, and a bordered actions row.
Swap opens an `InspectorPopover` instead of pushing the props down. The
section does not mount for a multi-selection (`showsComponentSection`): the
anchor's call-site values are not the selection's, and every row, Detach and
Swap would have written the anchor alone. It is also the one entry with
`writes: 'call-site'`: `StyleSurface` replaces the style sections with one
notice when no style target is writable, which is always the case for an
instance with no class, and before P2-G that notice swallowed the props too.
`designCallSiteSections` still mounts it above the notice. A Detach refusal
shows the parser's sentence under the title, and `explainDetachConstraint`
alone decides whether "duplicate as a new file" is offered. A prop's control
depends on its declared kind, which only the project's component catalog
knows, so while that fetch is in flight (`useLocalComponentCatalog()` returns
`null`) the section draws one disabled `ControlRow` with a field-height
skeleton per prop the call site sets — never a guessed text box that becomes a
dropdown a moment later. A catalog that has already arrived is read on the
first render, so selecting the next instance draws no placeholder.

**Separate entries, not one "Studio extras" component** — Component only applies
to `studio.instance` nodes (the others apply to any node), and cramming
several different `appliesTo` predicates behind one component's internal `if`
ladder would reintroduce the per-node-kind branching this whole series spent
eleven sections removing. `component` is a near-verbatim move
(`InstanceCallSiteView.tsx`, renamed) off its old bespoke Module-section
home; `transform`/`interaction` follow
Law 1's empty-header/`forceOpen` disclosure exactly like Stroke/Effects;
`animations` is the heaviest port, combining what used to be two exports
(`AnimationsSection` the body, `AnimationsSectionActions` the header "+"
menu) into one component with its own local Law-1 disclosure —
`AnimationEditorPopover.tsx`/`AnimationScrubRow.tsx`/`animationValue.ts`/
`keyframesModel.ts`/`transitionValue.ts` are all reused unchanged.

`customProperties` stays last, exactly as it always has — every OTHER
migrated section narrows its own bag to the handful of properties it claims;
this one instead claims "every uncurated key" (`!isCuratedProperty`), the
Webflow/Framer-style escape hatch `CustomPropertiesSection.tsx` (kept at its
original path, widened with an additive `forceOpen` prop) has always been.
It has two call sites: the manifest wrapper here (`forceOpen` always on,
serving one node and N alike), and `StyleRuleComposer.tsx`.

**The ambient/global-selector surface is the one place that is not a manifest
section.** Picking a class in the Classes panel (`SelectorsPanel`) makes
`PropertiesPanelBody.tsx` mount `SelectorInspector.tsx` instead of
`StyleSurface`. The manifest sections all read `useSelectionModel()`, which
needs a selected node, and this surface has none, so it renders two things:

- `StyleRuleComposer.tsx`: the rule's own stored bag (base, the active custom
  condition's or the active breakpoint's `contextStyles`) through `CustomPropertiesSection`, and nothing
  else.
- `StyleCategoryRail.tsx`: the "one button per CSS category" rail. It loops
  over `classStyleSections.ts`'s `CLASS_STYLE_SECTIONS`, which is `[]`, so it
  renders no category buttons.

`CLASS_STYLE_SECTIONS` stays exported, empty, because `SelectorInspector.tsx`,
`StyleCategoryRail.tsx` and `cssControlTypes.ts` (`ALL_CURATED_CSS_PROPERTIES`)
still import it. A multi-selection does not use this surface: it renders the
ordinary `INSPECTOR_SECTIONS` column (§9.0), with `MultiSelectTargetBar.tsx`
above it (§9.4).

---

## §5. The field model

§1–§4 are about which controls exist and when. This section is about how a
**numeric field behaves once you are typing in it** — one model, shared by all
three field kinds, because the alternative is what shipped before W8-1: three
components that each answered "what does typing `50` mean?" differently, in a
panel where a designer moves between them dozens of times a minute.

The three kinds, and the one module each rule lives in:

| Field kind | Where | Used for |
|---|---|---|
| `ScrubInput` | `src/ui/components/ScrubInput/` | Drag-the-label numerics with no token scale: W/H, rotation, corner radii, shadow offsets, stroke weight, `opacity`/`zIndex`/`lineHeight`/`letterSpacing` |
| `ScrubTokenField` / `TokenAwareInput` | `PropertiesPanel/LayoutSection/`, `property-controls/` | Length fields with token autocomplete: padding, margin, `gap`, the insets, `fontSize`. `ScrubTokenField` IS `TokenAwareInput` plus the scrub gesture — not a fourth field kind |
| `TextControl` / the frame W-H inputs | `property-controls/`, `FrameSizePanel.tsx` | The generic property row that has no mark to drag, and a board frame's own size |

### §5.0 A field shows what the element renders, never an empty box

Every field asks the same question before it renders, and one module answers it:
`resolveStyleFieldDisplay` (`PropertiesPanel/styleFieldDisplay.ts`).

    1. the value STORED on the active target (this class rule at this
       breakpoint, or this node's `style=""`) — the thing an edit replaces;
    2. otherwise the CURRENT value — the frame's real `getComputedStyle`
       reading, which already folds in whatever an inline `style={{}}`
       contributes. Shown MUTED (`--text-muted`), with the row still unset;
    3. otherwise nothing, and only then is a `placeholder` (the spec default)
       a hint.

This replaced "show the current value as a grey `placeholder` behind an empty
field", which read as *this element has no width* on an element that is plainly
320px wide. The user's report was exactly that: "the panel should be prefilled
already with the current values even if inline styles."

**Set-ness is a separate fact and is unchanged.** `isSet` still means "the
active target declares this property", and it is what drives the row's
`data-state`, its muted caption, the indicator dot, the "N set" section meta,
and the remove button. What a field displays never changes what the panel
claims about the source. The presentational half travels as `inherited`:
`data-inherited="true"` on the row, and the `inherited` prop on `ScrubInput` /
`AddablePropertyField` / `RevealedField` / `ScrubTokenField`.

Law 1's disclosure is judged on the STORED bag and is untouched by prefill
for every scalar-field section — **except Fill**, as of `STATE.md` panel-30
(widened by `panel-32`): `FillSection.tsx`'s `setAnywhere` and its
`PropertyList` row guards for `color`/`backgroundColor` now ALSO consult
`renderedNotStored.ts`'s `rendersUnstoredValue`, the same three-tier idea
above generalized from a scalar field to a `PropertyList` ROW
(`PropertyListEntry.muted`/`removable`, not `resolveStyleFieldDisplay`'s
`inherited`/`isSet` pair, since a list row has no single "field" to prefill —
it either exists, muted, or doesn't exist at all). `rendersUnstoredValue`
takes a `storedAtActiveContext` argument (`panel-32`) so it also fires for a
property declared elsewhere in the node's effective class chain — base, while
a breakpoint/condition tab is active — not only for a property nothing
declares anywhere. See §4's Law 1 for the full account, the non-inherited
"true CSS initial value" guard (`cssInitialValues.ts`) that keeps an ordinary
element from flooding open (never consulted for the "declared elsewhere"
branch — a real source is never a UA default), and why Stroke/Effects
remain governed by the STORED-bag-only rule this paragraph originally stated
for their OWN list rows (their scalar sibling fields, e.g. Stroke's weight
inputs, already go through `resolveStyleFieldDisplay` and were never affected
by either gap).

**A prefilled value commits like any other.** Dragging Width from its rendered
`320px` to `340px` sets `width: 340px` on the target — that is what the user
asked for. Committing the *same* value writes nothing, because every field's
commit path compares against what it was displaying, so focus-then-blur can
never silently add a declaration.

**A disagreeing multi-selection is never prefilled.** `MIXED` in either bag
short-circuits the rule: a value none of the selected elements necessarily has
is not a value, and the field says "Mixed" (§9.3).

### §5.0a Typography leads on a text layer

`CLASS_STYLE_SECTIONS` stays one fixed registry. What varies per selection is
the order it is RENDERED in, and exactly one rule varies it
(`PropertiesPanel/styleSectionOrder.ts`): when every selected node is a text
layer, **Typography renders first** — in the section list and in the category
rail, which read the same ordered list so they stay in lockstep. Everything
else keeps its relative order underneath.

A node is a text layer when it has no element children AND either its module
declares `inlineTextEdit` (the registry fact the canvas's double-click editor
already asks — `base.text`, `base.link`, `base.button`, plus any plugin module
that declares one) or its host tag renders text (`p`, `h1`–`h6`, `span`, `a`,
`label`, `li`, `strong`, `em`, …). The no-children clause is what keeps an
`<a>` wrapping a card, or an `<li>` wrapping a row of controls, out of it.
Figma reaches the same place by only HAVING a Text section on a text layer.

**Superseded for the single-node surface (`STATE.md` `panel-25`, P3 item 9):**
Typography itself migrated out of `CLASS_STYLE_SECTIONS` to its own
`INSPECTOR_SECTIONS` manifest entry (`TextSection.tsx`), which reaches the
exact same outcome Figma's own model does — a Text section that only EXISTS
on a text layer, rather than one that is promoted to the top of a fixed list
— by gating its `appliesTo` on this file's own `isTextNode`, reused (not
duplicated) from `styleSectionOrder.ts`. `orderStyleSections`/
`isTextSelection`/this section's own "Typography renders first" reordering
stays live, unchanged, for the one surface this migration didn't touch:
`StyleCategoryRail.tsx` (in `SelectorInspector.tsx`'s ambient global-selector
surface), which still renders the `CLASS_STYLE_SECTIONS` list directly; that
list is empty and has no `typography` entry to promote, so the reordering is
an inert no-op there, not a bug. (The other
former caller, the multi-select composer, is deleted — see §9.0.) It resolves
for real when the ambient surface joins the manifest too.

### §5.1 Commit coerces; it never writes what CSS rejects

A typed value goes through one coercion on commit (blur / Enter / Tab):
`resolveCommitValue` (`scrubMath.ts`) for scrub fields, `resolveTokenValue`
(`tokenUtils.ts`) for token-aware ones. Both do the same three things in the
same order: a recognised keyword (`auto`/`fill`/`hug`) passes through; a number
or an arithmetic expression is evaluated and given **the field's own unit**
when it carries none; anything else is kept as the user's literal text.

**The field's own unit** is one value, resolved once per row (`fieldUnit`,
`ClassPropertyRow.tsx`), and it drives all three of the commit coercion, the
empty-field nudge, and the empty-field drag — so those cannot disagree.
`isUnitlessNumberProp` (`cssControlTypes.ts`) names the three properties whose
unit is `''`: `opacity` and `zIndex`, which are unitless by type, and
`lineHeight`, which is not — it accepts lengths, but its idiomatic value is the
ratio `1.5`, and `1.5px` is a *different declaration*, not a tidier spelling of
it. Everything else is a length and takes the computed placeholder's unit when
it carries one (so a `rem`-based stylesheet keeps scrubbing in `rem`), else
`px`. `letter-spacing: 1.5` is invalid CSS, so `letterSpacing` is deliberately
not in the unitless set.

The bug this closes: typing `50` into Width used to emit `width: 50`, which is
not a declaration — the browser drops it, and the user's stylesheet now
contains a line that does nothing. A field whose whole job is producing a valid
value must not be able to produce an invalid one.

The third branch is the one that keeps this honest. `calc(100% - 8px)`,
`var(--space-md)` and `10px 20px` are all real CSS we did not fully parse, so
they are written back exactly as typed. **We never rewrite CSS we only partly
understood** — the same rule the gradient (G6.3) and box-shadow (G8.3) parsers
follow.

### §5.2 Arithmetic, through one evaluator

`100/2`, `100 + 8`, `100px*2`, `(80+20)/2` all evaluate on commit.
`evaluateNumericExpression` (`src/ui/components/ScrubInput/numericExpression.ts`)
is the single parser; `scrubMath`, `numericNudge` and `tokenUtils` all call it,
so a field that scrubs also nudges and also does maths.

It is a parser, so it is a boundary: TypeBox validates the result on the way
out, and every refusal returns `null` so the caller keeps the literal. Two
refusals are worth naming — **mixed units** (`100px + 8em`: picking one of two
units would be a guess) and **division by zero** — because in both cases the
tempting behaviour is to produce *something*.

### §5.3 One nudge model: 1 / 10 / 0.1

Plain ↑/↓ is ±1, Shift is ±10, Alt is ±0.1, and **Alt beats Shift** when both
are held (the more specific request wins). `nudgeStepFor` is the only resolver,
and drag-scrub calls it too, so the ladder is one function rather than one
function plus a hand-written `altKey ? 0.1 : shiftKey ? 10 : 1` in the gesture.

The three magnitudes are **defined** in `scrubMath.ts` and re-exported from
`numericNudge.ts`, which is still the module whose header explains them. They
had to move down: `src/ui` cannot import from `src/admin`, and W8-2 put the
drag gesture in `src/ui`, so leaving the numbers in admin would have guaranteed
a second copy — which is exactly how the ±8 drift happened the first time.

Before W8-1 there were three ladders — ±10 in `ScrubInput`, ±8 in
`numericNudge` ("an 8px design scale"), and a hand-rolled ±8 in
`FrameSizePanel` — so the same keypress moved a value by a different amount
depending on which component drew the field. A caller may still widen the model
for a value space where 1 is meaningless (`AnimationEditorPopover` steps
milliseconds by 10); it may not re-decide it.

`opacity` and `zIndex` are in the nudge set (`isNudgeableProp`,
`cssControlTypes.ts`) — they are single numbers, and having no keyboard step
was an omission rather than a decision. They are the two unitless members, so
their empty-field unit is `''`: nudging an unset opacity must not invent
`opacity: 1px`.

### §5.4 Enter commits and keeps focus

Enter commits the value, re-selects the text so the next keystroke replaces it,
and leaves the caret in the field — Figma's behaviour. All three field kinds
used to `blur()` instead, which meant the panel's keyboard focus fell out from
under a user adjusting one value repeatedly.

Blur still commits (clicking away is not a discard) and Escape still reverts.
`TextControl` — a module's or component's plain text props, and the style rows
that have no scrub mark — joined this model in P2-G (UX-16): it used to write
on every keystroke, one call-site source edit per character on a component
prop, and Escape had nothing to go back to. `textFieldDraft.ts` holds its
commit rule (`decideTextCommit`: write only what was typed, and only when it
changes the value).
Escape's revert needs care: the blur it triggers fires *before* React has
re-rendered the reverted draft, so both `ScrubInput` and `TokenAwareInput` set
a flag that makes that one blur discard instead of commit — otherwise Escape
writes the very value it was pressed to abandon.

**A parked caret commits nothing (ERR-1).** Keeping focus means the caret
usually sits in a field that has nothing left to say. `ScrubInput` tracks one
bit, `typed` — set by a keystroke into the text, cleared by every commit,
nudge, revert and sync — and while it is clear the field follows its `value`
exactly as an unfocused one does, and blur and Enter commit nothing. Before
this, a parked field kept its stale text and wrote it back on click-away: type
a width, Enter, ⌘Z, click the canvas, and the undo was undone and the redo
stack cleared. The same happened to an agent edit, a resync or a selection
change that landed while the caret sat there. Text the user IS typing is never
overwritten by an external change, and still commits on blur.

### §5.5 One scrub engine, and the mark is the handle

Drag-a-number is one interaction, so it is one module: `useScrubDrag`
(`src/ui/components/ScrubInput/useScrubDrag.ts`). It owns the whole state
machine — the keyword/token refusal, the 1/10/0.1 per-pixel ladder, `min`/`max`
clamping, the empty-field unit, the rAF-coalesced preview channel, the
click-with-no-movement fallthrough to focusing the field, and the final value
computed fresh from `pointerup`'s own `clientX`.

`ScrubInput` and `ScrubTokenField` both call it. They could not share the
gesture by one rendering the other — a token-aware field is an `Input` plus an
autocomplete dropdown, so a component that renders `ScrubInput` cannot also be
`TokenAwareInput` — and before W8-2 they therefore each carried their own copy.
The copies had drifted: the token-aware one had no rAF coalescing (a fast
padding drag fired one editor-store write per `pointermove` instead of one per
frame), no `min`/`max`, and its own inline ladder. What the two field kinds
share is the state machine, not the markup, so that is what was extracted.

**A numeric field scrubs when, and only when, it draws a mark.** The mark IS
the drag handle — the letterform (`W`, `H`, `L`) or the glyph inside the
field's leading edge. This is why `PROPERTY_FIELD_GLYPHS` (`cssPropertyIcons.ts`)
is now load-bearing beyond looks: `ClassPropertyRow` renders a nudgeable
property that has a glyph as a scrub field and one that has none as a plain
typed field, because a row whose only visible name is a caption in a column the
row does not own has nothing honest to drag. Adding a property to that map
therefore gives it the gesture, for free — which is the intended path for the
rows the look pass will convert. `fontSize` got its mark in W8-2 for exactly
this reason: it was the one length in the typography block with nothing to grab.

Every numeric in the panel now scrubs: the TRBL insets and the constraint
offsets (their direction arrow moved from a column beside the field into the
field, where it is both the name and the handle), `gap`, all five corner radii,
`opacity`, `zIndex`, `fontSize`, `lineHeight`, `letterSpacing`, padding and
margin, W/H, rotation, stroke weight, the shadow offsets.

Two deliberate exclusions, both the same rule — *a single number is not the
whole value*:

- **Grid track templates.** `GridTrackControl` writes `repeat(N, 1fr)` from a
  segmented count picker, and its custom field holds a free-form template
  (`200px 1fr 200px`). There is no single number to scrub, and scrubbing one
  term of a multi-term value would be rewriting CSS we only partly understood
  (§5.1's third branch). `NUDGE_PROPS` has excluded grid templates since W8-1
  for the same reason; W8-2 did not change that.
- **`aspectRatio`, `flex`, `transform`, shadows.** Same argument. Shadows are
  reached instead through `EffectEditorPopover`, where each *term* is its own
  `ScrubInput` and each one does have a single number.

`opacity` is scrubbable and clamped to `0..1`, but its field is unitless
`0`–`1` rather than Figma's `0`–`100%`, so at the shared 1-unit-per-pixel base
step a plain drag saturates immediately and only Alt (0.1) is fine enough to be
useful. The fix is the percentage *presentation*, not a bespoke ladder — this
section's whole point is that a field may not re-decide the model — and that
presentation belongs to the look pass. Recorded here so it reads as a known
edge, not an oversight.

---

## §6. The measurement gate

> **Closed** (`STATE.md` `panel-27`, Track P's P6), then re-measured twice.
> This section used to describe a pre-P3 panel — a category rail
> (`--inspector-rail-w`, `StyleCategoryRail`) beside a `StyleSectionsEditor`
> call, and a budget table keyed by the OLD category names (Position/Size/
> Layout/Appearance/Typography/Fill/Stroke/Effects). Both are gone from the
> single-node surface: P1 deleted the rail entirely
> (`SelectorInspector.tsx`'s separate ambient/global surface is the only
> place `StyleCategoryRail` still mounts), and P3 replaced the category
> registry with the `INSPECTOR_SECTIONS` manifest
> (`src/admin/pages/site/inspector/sections/index.ts`) `StyleSurface.tsx`
> mounts as one continuous scroll. S5 (WS-14.5) cut 164px of always-mounted
> Design-tab height and gave the 900px number a spec — which, when it was
> finally run (panel-37), showed the tab was still **334–564px out of
> reach**. panel-39 was the first density pass (down to 0 / 198 / 191 / 55px
> on F1–F4); **panel-41 closed the rest**: three of the four fixtures now fit
> a 900px window outright, the budget is asserted STRICTLY against the room
> the panel has, and the one fixture that does not fit — F2, a text layer —
> is 36px over with every one of those pixels attributable to a value the
> user's source sets.

Do not start a density change without a baseline, and do not close one without
a re-measure. Fabricated height numbers are how a density plan drifts.

**The gate is three files, not one**, because `bun test`'s `happy-dom`
environment builds a DOM but does not lay it out — `scrollHeight`/
`scrollWidth`/a real rendered row offset are unavailable there (see
`src/__tests__/inspector/measurement.test.ts`'s own header comment for the
full explanation):

- **`src/__tests__/inspector/measurement.test.ts`** (`bun test`, static) —
  asserts the manifest shape (16 entries, in order, `order` 0–15 with no gaps
  or dupes, plus which entries carry `tabs`/`designGroup`), the frozen
  `--inspector-*` token table (`--inspector-row-h`/`--inspector-header-h` =
  32px each, no `clamp()`/`vw`, no section CSS module reaching back into the
  fluid `--space-*` scale), and a COMPUTED (not measured) per-section
  rest-height budget built from those same frozen tokens and each section's
  own minimal/collapsed-state row count, read from its source — now summed
  into a **Design-tab total** for the F2 text fixture.
- **`tests/e2e/inspector-height.e2e.ts`** (Playwright) — WS-14.5, the real
  half: **one budget** — the room the docked panel has at a 900px window,
  read at runtime as `clientHeight` — asserted against the Design tab's own
  `contentHeight` for all four baseline fixtures (F1 rectangle, F2 text,
  F3 flex board, F4 image), plus three structural tests that pin the folds
  that budget depends on (the four Studio-extras sections behind one More
  disclosure; the Module block's Law-3 fold; Layout as one row until a layout
  exists). It writes the MEASURED per-section height table — and the live
  overflow against the 900px target — to
  `docs/audits/penpot-inspector-baseline/05-section-heights.json`.
  Every locator in it is scoped to the ACTIVE Design tab
  (`[data-inspector-tab="design"]:not([hidden])`); see "The 900px budget"
  below for why that matters and what the budget replaced.
- **`tests/e2e/inspector-panel-measurement.e2e.ts`** (Playwright) — the older
  gate, still live and measuring different things: row rhythm, the 260px
  width invariant, and click counts, at its own tall viewport.

### The 900px budget, and the 344px panel-39 gave back

**S5 wrote the gate and never ran it** (`STATE.md` panel-36 says so in as many
words). Its first real execution, during wave-1 integration, found two
different things:

1. **A scoping bug in the spec.** It asked the whole document for
   `[data-section-id="transform"]` and expected 0. `InspectorShell` mounts all
   three tab panels and `hidden`s the inactive two — deliberate since P1, so a
   tab switch keeps each surface's scroll offset and transient state — and
   `transform`/`animations`/`interaction` declare `tabs: ['design',
   'prototype']`, so the Prototype tab's hidden copy satisfied the locator.
   Fixed in the spec, not the shell: an assertion about the Design tab must
   say so. `InspectorShell` carries a `data-inspector-tab` attribute
   (additive, queryable-only, same posture as `data-section-id`) so callers
   scope with `[data-inspector-tab="design"]:not([hidden])` instead of relying
   on which tabs happen to be mounted.

2. **The 900px claim was false.** Measured at 1400×900 on the docked panel,
   the Design tab's scroll container had **626px** of room against
   `scrollHeight`s of 960 / 1190 / 1013 / 1043px — 334–564px over.

#### What panel-39 changed, with the measured number for each

Four changes, no capability removed and nothing more than one click away:

| Change | Where | Measured |
|---|---|---:|
| Layout rests as one row until a layout exists | `LayoutSection.tsx` | **−167px** on F1/F2/F4 |
| `padding-bottom: var(--space-7xl)` de-duplicated off `.surfaceContent`, both container paddings frozen to `--inspector-space-m` | `StyleSurface.module.css` | **−63.6px** everywhere |
| Between-section gap 12px → Figma's/Penpot's measured 8px | `.surfaceContent` gap | **−44px** on F2 |
| `FrameSizePanel` moved to the nothing-selected state; tab strip block padding trimmed | `PropertiesPanelBody.tsx`, `InspectorShell.module.css` | **+92px of room** |

The audit's own chrome table had one band mislabelled, and correcting it is
what made the fourth row possible: the 88px it called "node header (title +
breadcrumb)" is `FrameSizePanel`, the board FRAME's device preset and W/H.
The node title lives inside `PanelHeader`'s own 36px. `FrameSizePanel` was
rendering above every single-node selection, four rows above the unrelated
W/H pair `MeasuresSection` draws for the node itself.

| Band | panel-37 | panel-39 | panel-41 |
|---|---:|---:|---:|
| admin top bar | 36 | 36 | 36 |
| `PanelHeader` (incl. the node title) | 36 | 36 | 36 |
| `InspectorShell` tab strip | 47 | 43 | 43 |
| `FrameSizePanel` | 88 | 0 | 0 |
| `headerClassPicker` | 67 | 67 | **39** |
| **chrome** | **274** | **182** | **154** |
| **room for the Design tab** | **626** | **718** | **746** |

panel-41's 28px is the selector pills moving into the ClassPicker's own input
row — see "One write-target surface" below.

#### Where it landed

| Fixture | `contentHeight` | Room | Over | panel-39 | panel-37 |
|---|---:|---:|---:|---:|---:|
| F1 rectangle | 608 | 746 | **0** (138px spare) | 0 (28 spare) | 334 over |
| F2 text | 782 | 746 | **36** | 198 over | 564 over |
| F3 flex board | 725 | 746 | **0** (21px spare) | 191 over | 387 over |
| F4 image | 603 | 746 | **0** (143px spare) | 55 over | 417 over |

Total overflow across the four fixtures: **1702 → 444 (panel-39) → 36**.

`contentHeight`, not `scrollHeight`: `scrollHeight` is
`max(clientHeight, content)`, so it reports the room itself for a tab that
fits and can show neither headroom nor a fitting fixture creeping back toward
the limit. The gate measures the flow's own box plus the scroll container's
padding instead.

#### What panel-41 changed, with the measured number for each

panel-39 named three levers and took none of them. panel-41 took all three,
then kept going until three of the four fixtures fit.

| Change | Where | Measured |
|---|---|---:|
| **One write-target surface** — `WriteTargetRow` deleted; its lock reasons and its "this is the default target" mark ride `ClassPicker`'s own pills, and those pills share the input's row instead of taking one below it | `ClassPickerParts.tsx`, `ClassPicker.tsx/.module.css`, `StyleSurface.tsx` | **−40px** of content on every selection, **+28px** of room |
| **The Module block obeys Law 3** — props the source does not set fold behind the block header's own `N more` disclosure | `renderModuleTabContent.tsx`, new `ModuleBlock.tsx/.module.css` | **−122px** on F4, **−78px** on F2, **−34px** on F1/F3 |
| **The text content editor is as tall as its text** — `rows` becomes the ceiling, not the height (`field-sizing: content`) | `Input.tsx/.module.css`, `TextareaControl.tsx` | **−36px** on F2 |
| **Layout pairs what Figma pairs** — the 3×3 align pad sits beside the flow + gap fields, and padding beside margin | `LayoutSection.tsx/.module.css` | **−94px** on F3 |
| **A flush section's body no longer pays a second separator** — `.sectionContent`'s bottom padding was stacked on the parent's grid gap, so an open section was 16px from the next divider and a collapsed one 8px | `Section.module.css` | **−8px per open section** (−16 on F2/F3) |

Two of those are not density changes at all and are the better half of the
work. The write-target merge removes the panel's own copy of the ambiguity
**WS-6.2** exists to fix: the element's targets were stated twice, once
interactively and once read-only, 40px apart. The Module fold is Law 3,
which the Module block was the last surface to break.

#### What the residual is, and why it is not closable here

One fixture is left, and every pixel of its overflow is a value the user's
own source sets, rendered once, at the 32px row height Penpot measures
(`04-token-gaps.md`) — plus the section gap the owner asked for (P2-F, below).

**F2 (text), 23px over — 769 against 746** (it was 36 over before P2-F, 26
after it; P2-G's frozen `ControlRow` gaps took 3px off the Module block). Its
Design tab carries:

| Block | px | What it is |
|---|---:|---|
| Text | 177 | Figma's own four typography rows (family; weight+size; line-height+letter-spacing; align), 4px apart |
| Measures | 114 | W/H, the CSS position mode, rotation+radius, 4px apart |
| Module | 92 | a 32px header, the node's own `text` content sized to the text, 8px of padding, a hairline |
| Fill | 65 | the text colour the class sets |
| Layer | 32 | opacity, blend, visibility |
| 5 collapsed one-row sections | 165 | Layout, Stroke, Effects, Export, More |
| gaps + container padding | 124 | 9 × 12px, plus 2 × 8px |

Nothing there is pre-drawn. Closing the last 23px means collapsing a section
that has values in it, or giving back segregation the owner asked for.

#### The gate: one budget, one named exception

`tests/e2e/inspector-height.e2e.ts` asserts **the room the panel actually
has** — `clientHeight`, read at runtime off the same element it is judging,
so reclaiming chrome moves the budget by itself. panel-39's blanket
`POPULATED_SECTION_OVERFLOW_PX` (210) is **deleted**: three fixtures now fit
outright, so a uniform 210px slack would hide a 200px regression on any of
them.

What replaces it is `TEXT_LAYER_OVERFLOW_PX` (47 — the measured 23 plus the
same 24px of machine-to-machine slack panel-41 left; it was 50 against 26
after P2-F, 60 against 36 before), applying to **`f2-text`
and no other fixture**, for the one cause tabulated above. F1, F3, F4 and F5 are
asserted strictly (`contentHeight <= clientHeight`). A second exception means
naming its cause in this section, in the same change.

The folds the budget rests on are pinned as **structure** as well, because a
height number cannot say WHICH fold was deleted when it goes red:

- the four Studio-extras sections are folded behind one More disclosure at
  rest, and one click reaches all four (worth 164px);
- the Module block folds the props the source does not set, and one click
  mounts them under the same `property-control-<key>` ids (worth 122px on
  the image fixture);
- Layout renders no body on a node with no layout, offers "Add auto layout",
  discloses its whole body in one click, and a flex container still renders
  that body at rest (worth 167px).

The per-fixture numbers stay in
`docs/audits/penpot-inspector-baseline/05-section-heights.json` as data,
never as thresholds, alongside a per-`data-section-id` table that includes
the **Module block** — `StyleSurface.tsx` gives it `data-section-id="module"`
precisely because being outside the manifest is why it went unbudgeted until
panel-37 measured it.

#### P2-F — segregation, paid for by the Effects merge

The owner's ask (2026-09-23): *"improve the design pane, add spacing to
segregate a bit, specially in between props and the element below"*. The
panel's proximity hierarchy was flat — a prop row sat 8px from its sibling
prop and 8px from the unrelated opacity row below it, with no line and no
title between them (`docs/audits/2026-09-23-studio-audit/05-design-pane-ux.md`
§0, UX-1…UX-6). What changed, measured at 1400×900:

| Change | Where | Measured |
|---|---|---:|
| **The props block has a real boundary** — its title is `SectionStaticHeader` (the 32px, bold, full-contrast recipe every section title uses, not a ~10px uppercase label), its body ends in 8px of padding, and the block closes on an `--inspector-divider` hairline (UX-1) | `ModuleBlock.tsx/.module.css`, `Section.tsx` | **+7px** on F1/F3, **+15px** on F2/F4 |
| **Between sections is its own token**, `--inspector-section-gap`, at 12px (OD-4; UX-2). It was 8px on the claim that 8 is Penpot's section gap — Penpot's flex gap is 8, but every menu also ends in an 8px `margin-block-end`, so its real boundary is 16 (the Δ16 in `02-measurements.md`) | `globals.css`, `StyleSurface.module.css` | **+32…+36px** |
| **Rows inside one group sit 4px apart** — Module props, Text's four rows (`StackedPropertyGrid rhythm="within-group"`), Measures' size / position / rotation, a component's props (UX-3; Penpot `menus/text.scss`, `menus/measures.scss`, `menus/component.scss`) | `ModuleBlock`, `TextSection`, `StackedPropertyGrid`, `MeasuresSection`, `ComponentSection` CSS | **−12px** Text, **−8px** Measures |
| **Shadow + Blur are one Effects section** (UX-5, OD-4) | `EffectsSection.tsx`, `EffectEditorPopover.tsx`, `sections/index.ts` | **−45px** everywhere |
| **The ClassPicker fade only shows once scrolled** — at rest it dimmed the Module title under it (UX-6) | `StyleSurface.tsx` (`data-scrolled`), `PropertiesPanel.module.css` | 0 |

| Fixture | before | after | room |
|---|---:|---:|---:|
| F1 rectangle | 608 | **598** | 746 |
| F2 text | 782 | **772** (26 over) | 746 |
| F3 flex board | 725 | **715** | 746 |
| F4 image | 603 | **601** | 746 |

Every fixture came out shorter than it went in: the segregation is paid for.

**P2-G — the Component section (UX-4, UX-7, UX-10, UX-14, UX-16).** The gate
gained **F5, a local component instance**, because before P2-G there was no
Component section height to measure: an instance with no writable class drew
the "no writable style" notice in place of every section, its props included.

| Fixture | P2-F | P2-G | room |
|---|---:|---:|---:|
| F1 rectangle | 598 | **598** | 746 |
| F2 text | 772 | **769** (23 over) | 746 |
| F3 flex board | 715 | **715** | 746 |
| F4 image | 601 | **595** | 746 |
| F5 instance | notice only, no props | **276** — Component section 137 | 746 |

The Component section is one 32px title row plus its prop rows, 4px apart
(137px for three props, with the hairline). Drawn the old way — a 32px
"Component" title, a filled name band, a bordered actions row and an 8px
margin above the rows — the same three props compute to about 213px (33 + 31 + 37 + 8 + 104). F2 and F4
lost 3px per stacked prop row: inside the panel `ControlRow`'s gaps now read
the frozen `--inspector-*` scale, not the admin's fluid `--space-*` one
(UX-10). `TEXT_LAYER_OVERFLOW_PX` ratchets 50 → 47.

**P2-H — panel polish.** F1–F4 re-measure unchanged. F5 is **276 → 256**:
the notice under its Component section drops its fluid `--space-4xl` /
`--space-5xl` padding for the frozen `--inspector-space-xl` (UX-27). The
node-level notices above the ClassPicker now sit in a `.nodeNotices` band
that `:empty` collapses, so a selection with no notice pays 0px for it.
The spacing hierarchy is now three named steps — **4px** within a group
(`--inspector-space-2xs`), **8px** between groups inside a section
(`--inspector-space-m`), **12px** between sections
(`--inspector-section-gap`) — documented once, in `globals.css`'s inspector
block.

Two further observations from panel-41's measurement, still open:

- F4's Fill section renders `forceOpen` with a body of zero rows (33px of
  header plus nothing). That is the Law-1 "empty section is not a
  disclosure" case, and fixing it is worth 8px on that fixture.
- `Measures` is 114px on every fixture but F1, where `position: relative`
  adds the TRBL grid and it becomes 191px. F1 has 148px of spare room, so
  that is not currently a problem — but it is the largest single block in the
  panel and the first thing to check if the budget tightens again.

**What S5 bought, and what the old claim was.** The old F28 claim
("a text node's entire inspector… fits in one 900px viewport with no scroll")
was measured against **seven** pre-P3 categories. P3 item 11 (`STATE.md`
`panel-25`, "Studio extras") added six more always-mounted sections nobody
had budgeted for, and `fix/inspector-spacing-audit`'s real between-section
gap grew it further: the F2 text node measured **~1826px** at that spec's own
2100px-tall viewport. S5 did not shrink a single control to fix that. It moved
`transform`/`animations`/`interaction`/`customProperties` behind one collapsed
**More** disclosure and deleted the retired `attributes` code outright —
computed from the frozen tokens and asserted in the static half:

| Design-tab sections, F2 text, at rest | px |
|---|---:|
| 11 inline sections + 4 Studio extras inline (pre-S5) | 920 |
| 10 inline sections + 1 collapsed `More` header (S5) | 756 |
| …at panel-39's 8px section gap | 716 |
| …with Layout collapsed until a layout exists (panel-39) | 612 |
| …P2-F: 12px `--inspector-section-gap`, Shadow + Blur → Effects, no phantom gap for an empty Align | **596** |

The More fold is worth **164px** at the 12px section gap (it was 152 while
panel-39 held the gap at 8px — three fewer gaps × 4px); collapsing Layout is worth a further **104px** in this
computed model and a measured **167px** in a real browser, because the real
body carries a flex/grid block and a settings row a row count does not try to
predict. `docs/audits/penpot-inspector-baseline/05-section-heights.md`
carries the full per-section table, both computed and measured, and explains
why neither replaces the other.

**The panel chrome is not in that number, and one part of it now is.**
ClassPicker's one tag-input row and `.surface`'s own padding have no fixed
row count for a static sum to see — which is exactly why the height assertion
is a Playwright spec measuring the real scroll container rather than an
arithmetic claim. The Module block used to be in that list and is not any
more: it carries `data-section-id="module"`, so it appears in the measured
artefact's per-section table (95px on a text node, 145px on an image) and
can no longer grow unnoticed by both gates at once.

**The width invariant still holds, verbatim in spirit.** Every section
shrinks or truncates rather than overflowing its column — the e2e spec
asserts `scrollWidth <= clientWidth` for every `[data-section-id]` (P6's own
additive attribute on `StyleSurface.tsx`'s mount loop — the pre-P3
`[data-style-section]` selector this section used to cite no longer exists on
the single-node surface) at `SIDEBAR_MIN_WIDTH` (260px), for both the F2 text
node and the F3 flex board. `.surfaceContent`'s `overflow-x: clip` remains
the standing guarantee this stays true even for a section this gate doesn't
directly exercise.

**Row rhythm keeps the four rows the P0 baseline actually measured — no
16-row table was ever fabricated.** `measurements.json`'s
`rowRhythm.measuredRowOriginsYPxDarkTheme` names exactly four rows
(`opacityBlendRow`, `widthHeightRow`, `xyRow`, `rotationRadiusRow`); the e2e
spec asserts those four render in that order, never overlapping, and — a
real, disclosed correction, not a silent weakening — against their OWN
measured deltas (`[38, 74, 77]`px), not Penpot's (`[48, 36, 36]`px). Studio's
`MeasuresSection.tsx` genuinely has two rows Penpot's object model has no
equivalent for between W/H and Rotation/Radius: a CSS `position`-mode picker
(static/relative/absolute/fixed/sticky — meaningless in Penpot, where every
shape is always absolutely positioned) and a two-row TRBL offsets grid
(top+right, then bottom+left) where Penpot has one X/Y row. Both are
documented, evidenced divergences, not defects — see `MeasuresSection.tsx`'s
own "Constraints-vs-Flex-element identity swap" doc comment.

**Click counts, matched or beaten, for the flows the baseline could actually
automate.** `clickCountsToCommonEdit` records 2 clicks for every flow it
captured; the e2e spec drives the real Studio equivalent (select the node,
click the target field) for four of the five and gets 2 real Playwright
interactions for each, matching: `f1_resizeViaWidthField`,
`f1_addStrokeFromEmpty`, `f2_changeFontSize`, `f3_changeGapOnBoard`.
`f1_changeFillColor` is not automated — the P0 baseline's own capture
already failed to automate the equivalent Penpot popover, and this spec does
not re-attempt what that capture couldn't do reliably. (As of `STATE.md`
panel-33 the Fill row's colour editor no longer requires activating the row
first — the row's own text field commits directly, and its swatch opens
`ColorPickerPopover` on the first click — so this line is a candidate for a
future spec update, not a description of a current limitation.)
`f4_downloadSourceImage` is skipped — no F4 image fixture exists in this
project, and Export-section parity was not in this pass's scope.

**Human action needed:** the colour-picker popover flow and the qualitative
"finds every control where they expect it" feel remain genuinely
non-automatable, same posture every P3 section's own dogfood note already
used — neither blocks this gate; both are named here so they are not
silently dropped.

---

## §7. What we deliberately do not copy

Studio writes CSS into someone's repository. Figma writes to a scene graph it
owns. These controls cannot be honestly translated, and shipping a lookalike
would violate the "one honest target" invariant.

| Figma control | Ref | Why not |
|---|---|---|
| Corner smoothing (squircles) | F11 ⚙ | No CSS equivalent. Omit the icon, do not fill it with something else. |
| Width profile / Join / Miter, Dynamic + Brush strokes | F17 | Vector-only. |
| Noise / Texture / Glass / Shader effects | F20 | No CSS equivalent. A menu item that writes something else is worse than a missing menu item. |
| Stroke position Inside/Center/Outside | F16 | Only "inside" is honestly expressible (`box-sizing: border-box`). Ship the values we can write, or omit the dropdown. |
| Canvas stacking, Align text baseline, Auto spacing | F5 | Figma layout-engine concepts with no direct CSS. |

And three things where **we stay better than Figma**, which no change may
regress:

1. **Token autocomplete** in every length field (`TokenAwareInput`). Figma's
   variables are worse than this.
2. **Provenance** — the struck-through "this class loses to that one" strip.
   Figma has no cascade, so it has no equivalent, and it is the single most
   useful thing our panel does that theirs does not.
3. **Honest refusal.** Where a write cannot land in one place, we say so. Figma
   never has to. Every popover carries its refusal copy.

---

## §8. Decisions, and how they were resolved

All four needed a human call. All four are now settled in code — the reasoning is
kept because the alternatives are the part that does not survive in the diff.

1. **The eye toggle's storage model.** F14/F16 hide a fill or stroke without
   deleting it; CSS has no "disabled declaration". Options were (a) write nothing
   and keep the entry in a UI-only list — lost on reload; (b) keep it as a
   commented declaration in the user's CSS — pollutes their source; (c) omit the
   eye. **Resolved as (c)** (`FillSection.tsx`).
2. **Does padding move into Layout (G4.2)?** It is the right model and it is what
   Figma does, but it means the Spacing section holds only margin, which reads as
   odd until people get used to it. **Resolved: yes** (`PaddingCluster.tsx`).
3. **`visibility: hidden` vs the layer-tree hide (G5.4).** Two hides, one word —
   naming, not engineering. **Resolved: both ship**, disambiguated by tooltip
   (`cssPropertyBag.ts`).
4. **§8.4 — vertical align (G9.2):** disabled-with-a-reason, or absent? Disabled
   rows cost height, which is what a density pass is spending. **Resolved:
   disabled-with-a-reason** (`verticalAlignWrite.ts`).

---

## §9. Multi-selection — the Mixed contract

Select two or more layers and the inspector shows the same sections it shows
for one, with **Mixed** wherever the selection disagrees; the first edit writes
one value to all of them.

**S5 made that literally true.** W8-3 shipped the contract on a parallel
surface (`MultiSelectionInspector` → `MultiSelectionStyleArea` →
`MultiInlineStyleComposer`), and by the time P3 finished, that surface could
render exactly *one* editing section — Custom properties — because every other
section had migrated to `INSPECTOR_SECTIONS`, which reads `useSelectionModel()`,
which assumed one node. Selecting two layers therefore **lost** Fill, Stroke,
Text, Measures and the rest. S5 widened the model instead of widening the
parallel surface, and deleted all three files.

### §9.0 One model, no second section tree

`useSelectionModel()` describes N nodes. The widening is shaped so that **no
section file changed**: every section already reads
`selectedNode.inlineStyles` + `assignedClassRules` and builds its bags with
`collapsedStyleBag.ts`, so the model hands it —

| Field | For N nodes |
|---|---|
| `selectedNode` | the anchor, with `inlineStyles` replaced by the selection's collapsed bag (`MIXED` where layers disagree) |
| `selectedNode.codeProps` | only the `style:<prop>` locks present on **every** node — a lock on one of five must not disable a control that works for four |
| `computedValues` | `null`. `useFrameComputedStyleValues` reads ONE mounted element; showing the anchor's as the selection's placeholder would claim agreement nobody measured |
| `assignedClassRules` | `[]` (Element/inline), or the one shared class once the user picks it and clears its gate — see §9.4 |
| `selectedNodes`, `inlineWritableNodeIds`, `inlineUnwritableNodes`, `inlineWriteReach`, `sharedClassRules` | the N-node facts the target bar and its notices state |

`commitApi.ts` is the other half: an inline write for N dispatches to
`setNodesInlineStyles` instead of `setNodeInlineStyles`. A class write needs no
branch — one class write already reaches everything carrying the class.

`PropertiesPanelBody` has no multi-select branch any more. What it still gates
on cardinality is the per-node CHROME above the sections — the
component/slot/source notices and ClassPicker, each of which would otherwise
tell the anchor's story as if it were the selection's, or edit one layer's
`classIds` out of N. The panel header still reads "N layers selected".

**What the deleted action bar took with it.** `MultiSelectionInspector` also
carried Duplicate / Wrap… / Copy / Cut / Paste / Delete buttons and a
removable list of the selected layers. Figma's right panel has no such bar;
those actions live on the canvas context menu and the keyboard, which is where
they stay. `commitProp` also stops at one node: a module prop belongs to one
call site's schema, and fanning one key across N nodes of possibly different
modules is a guess, not a Mixed collapse.

### §9.1 One patch, one undo step

`setNodesInlineStyles(nodeIds, patch)`
(`store/slices/site/nodeActions.ts`) is the write. It runs over
`mutateTreesForNodeIds`, so a selection spanning several board frames writes
each frame's own page tree inside ONE history transaction — an N-node edit is
one Ctrl+Z, the same contract `deleteNodes` / `wrapNodes` already carry. It
shares its merge/clear semantics with the single-node `setNodeInlineStyles`
through `applyInlineStylePatch`, so "clear this property" cannot mean two
things. A node that individually refuses the write — a stale id, or a
`style:<prop>` this node resolved from an expression in source — is skipped
without aborting the rest; `MultiSelectTargetBar` names those properties
above the sections so the refusal is never silent.

### §9.2 Two collapsed bags, no new section tree

Every section is already target-agnostic — it builds its own bags from
whatever `inlineStyles` + `assignedClassRules` the model hands it
(`collapsedStyleBag.ts`). Multi-select therefore adds no second copy of the
section tree, only `buildMultiSelectStyleBags` (`multiSelectStyleBags.ts`),
which collapses N nodes using `collapseValues` from
`@ui/components/MixedValue` and which `useSelectionModel` calls once per
render:

- **`storedStyles`** — the inline editing target. A property is present when at
  least one selected node sets it inline; its value is the shared value when
  every node agrees and `MIXED` otherwise. "Set on one, absent on another" is a
  disagreement, not a value to prefer.
- **`currentStyles`** — the effective/placeholder layer. Per node this is the
  provenance winner across its class chain plus inline
  (`resolvePropertyProvenance`), collapsed the same way.

`hasStyleValue(MIXED)` is true, so a mixed property counts as SET everywhere
the editor asks that question — Law 1's disclosure, the indicator dot, the "N
set" meta. There is no `getComputedStyle` layer here: that hook reads ONE
mounted element, and provenance runs with `computedValue: undefined`, which
means an ambiguous multi-class cascade crowns nobody rather than guessing.

**Since S5 the model uses `storedStyles` only.** It is the bag that becomes
the collapsed anchor's `inlineStyles`, and each section then derives its own
`currentStyles` from that plus the class chain, exactly as it does for one
node. The deliberate loss is the class-sourced placeholder layer for a
multi-selection: a field whose value comes only from a class reads unset
rather than showing that class's value muted. Under-stating is the safe
direction — the alternative, feeding a `MIXED` Symbol through a
`computedValues: Record<string, string>` channel, is exactly the "control that
lies" bug class.

### §9.3 Mixed rendering

The sentinel lives in the bags; the WORD lives in five control surfaces, all
reading one constant (`MIXED_PLACEHOLDER`, next to the sentinel):

| Surface | Mixed rendering |
|---|---|
| `SegmentedControl` | No segment pressed, `data-mixed="true"` (dashed track), and `(mixed)` appended to the group's accessible name — so blank ≠ unset |
| `Select` | "Mixed" in the trigger, no leading icon, no option claimed |
| `Input` | "Mixed" placeholder over an empty field, `data-mixed="true"` |
| `TokenAwareInput` | Empty draft + "Mixed" placeholder; a token pick or typed value commits normally |
| `ColorValueInput` | "Mixed" replaces the colour-format hint |

`ClassPropertyRow` normalizes `MIXED` to `undefined` once and passes the fact
down as the shared `ControlProps.mixed` flag, so no control ever stringifies a
Symbol. `resolveStylePlaceholder` is the single place that turns a `MIXED`
*effective* value into the word, which is why every section that routes its
placeholders through it (including `StackedPropertyGrid`, and therefore the
bespoke sections built on it) gets Mixed placeholders for free.

**The bespoke sections read the sentinel too.** A section that reads a raw
cell through `readString` used to see `undefined` for `MIXED` and render its
ordinary *unset* state — an empty field, an unpressed toggle group — which is
indistinguishable from "nobody set this" and one keystroke from flattening a
disagreement the user was never shown. Three helpers in `styleValueUtils.ts`
close it: `pickMixedString` (the cell read that PRESERVES the sentinel, used
by the corner/side clusters in Appearance and Stroke), `pickMixedCell` (the
same read typed for `ClassPropertyRow`'s `value`, which replaced the
`as string | number` casts that type-laundered a Symbol into a value), and
`isMixedStyleValue` (is this field's stored cell mixed, or its effective one
when nothing is stored — the placeholder layer). Every section is wired:

| Section | Mixed surface |
|---|---|
| Spacing, Layout padding | `SingleSideField` / `LinkedAxisField` / `LinkedSidesField` → `ScrubTokenField`'s new `mixed` |
| Layout | mode row (`data-mode="mixed"`), the reverse toggle (disabled — no single axis to flip), gap, grid tracks |
| Position | the `position` switcher (`data-position-value="mixed"`) and each TRBL offset |
| Size | W/H and every revealed constraint (`AddablePropertyField` already took `MIXED`) |
| Typography | text-align and vertical-align groups; every other row via `StackedPropertyGrid` |
| Appearance | opacity, and all five corner-radius fields |
| Stroke | weight, colour, style, and stroke position |
| Fill · Layer · Shadow · Blur | the four `PropertyList` sections — see the table below |

`String(MIXED)` was the other half of the bug: `hasStyleValue` is true for a
Symbol, so Position and Size would have printed `Symbol(studio-mixed-value)`
into their fields. Both now test `isMixed` before stringifying.

**Deliberately not given a Mixed state:** `AlignGrid`'s 3×3, Clip content's
checkbox, and Layer's CSS-visibility eye. None of those primitives has an
indeterminate affordance, and inventing one for a 9-cell grid is a design
decision, not a wire-up. All three render unset; the eye names the
disagreement in its accessible label instead, and clicking it agrees every
selected layer, which is the Figma contract for a mixed field.

#### The four `PropertyList` sections (`panel-38`)

Fill, Layer, Shadow and Blur are the sections whose body is a **list of rows
derived from a value**, not a fixed grid of fields. They shipped with the
sentinel dropped, and each failed a different way — a row can *disappear*
here, which a grid of fields cannot do:

| Section | What it did before | What it does now |
|---|---|---|
| **Fill** — Text / Solid fill | The row VANISHED (`readString` → `undefined` → not stored → not shown) | The row stays; its `ColorValueInput` reads "Mixed" and its `%` opacity cell is dropped (no single alpha channel to show, and `ColorOpacityField` has no mixed state) |
| **Fill** — Content fit | Trailing value blank | Trailing value reads "Mixed"; the popover's `ClassPropertyRow`s carry the sentinel to their own controls |
| **Fill** — background layers | `parseBackgroundLayers` read the Symbol as "no layers", so the stack silently vanished | ONE row reading "Mixed" replaces the per-layer rows — there is no shared stack, so there is no layer to number, reorder, or blend. Its popover is `BackgroundDeclarationsBody`, which writes `background-image` and each satellite **whole**. The two layer-add buttons disable: "insert at index 0" over a list that does not exist is a replace wearing an add's icon |
| **Fill** — a satellite alone | Read as the CSS initial | A stack the layers AGREE on keeps its per-layer rows; only the disagreeing satellite goes whole-declaration, because splicing index N of a list nobody shares would write the initial into every *other* layer of every selected node |
| **Fill** — `background` shorthand | The row VANISHED | The row stays; its raw field reads "Mixed" |
| **Layer** — opacity | `toPercentString` collapsed the Symbol before `resolveStyleFieldDisplay` (which already knew `MIXED`) could see it, so five opacities read the `100%` fallback | The sentinel passes through untouched and the `ScrubInput` reads "Mixed" |
| **Layer** — blend mode | Trigger read "Blend mode" as if unset; the menu ticked `normal` | Trigger reads "Blend mode: Mixed"; no menu option is claimed |
| **Layer** — CSS visibility | Read "not hidden" | The label names the disagreement (see the deliberate-omission note above) |
| **Shadow** | **Lied.** `String(MIXED)` is a legal expression, so `parseShadowValue` answered `{ kind: 'raw', raw: 'Symbol(studio-mixed-value)' }` — a raw text field showing that string and offering to write it to the user's stylesheet | `parseShadowValue` takes `Mixed` and answers a fourth arm, `{ kind: 'mixed' }`, which the compiler forces every consumer to handle. One row per property reads "Mixed"; its popover writes the whole declaration to all N; the matching add-menu items disable |
| **Blur** | NO row at all, under a `Section` Law 1 had already forced open — a populated section with an empty body, and "Add layer blur" still enabled beside it | One row per property reads "Mixed", with the same whole-declaration popover; the add items disable off the raw cell |

The shared shape across all four: **when a list-valued property disagrees,
collapse the list into one row and edit the whole declaration.** A
multi-selection has no shared layer *index*, so every per-index gesture
(reorder, per-layer blend, "add at 0", "remove layer 2") is refused by
construction rather than silently writing the CSS initial into layers the user
never touched. Removing one of those rows clears the property from every
selected layer, in one history entry (§9.1).

`panel-40` closed the first of the two gaps `panel-38` recorded here.
`node.hidden` / `node.locked` in Layer now fan out over the whole selection
through `setNodesHidden` / `setNodesLocked` — absolute over N ids, one history
entry — and both buttons carry a Mixed state built the same way the CSS
visibility toggle's is: **no indeterminate glyph**, the disagreement named in
the accessible label, the button unpressed, and the first click agreeing the
selection ("any still visible → hide them all"). A per-node toggle could not
do that last part: N independent toggles over a selection that disagrees just
swap which half is hidden. The store action is therefore absolute rather than
a toggle — see `store/slices/site/visibilityActions.ts`.

Still open from that entry: `commitProp` stops at one node (§9.0).

### §9.4 Two targets, and the gate between them

Inline styles carry no ambiguity — `style=""` belongs to exactly one element,
so N inline writes touch exactly the N elements selected. That is the default
target, and when the selection shares no class it is the ONLY one:
`StyleTargetChip` takes `lockedToElementReason` and states *"Bulk edits write
inline styles — a class target needs one class every selected layer carries"*.

When every selected node DOES carry one class, the class is offered as a second
target — because "restyle these five cards" usually means the class, and
refusing it would push the user into five inline overrides that shadow it. The
decision lives in `multiSelectClassTarget.ts` (pure, unit-tested) and has three
outcomes:

| Outcome | What the panel does |
|---|---|
| `no-shared-class` | Element stays pinned, with the reason above |
| `allowed` — the class is carried ONLY by the selected nodes | The class chip becomes a real `Button`; clicking it switches target, no gate |
| `needs-confirmation` — it also lives outside the selection | Clicking raises an inline gate: *".card is used by 3 other elements outside this selection. Editing it changes them too — continue?"* |

The count is the store's O(1) `_classIdToNodeCount` index (never a page walk —
`no-full-site-scan-in-selectors`), and the "which class" tie-break is the LAST
shared class in the anchor's `classIds`, i.e. the one the cascade gives the
final word to. Confirmation is remembered per class id while the surface stays
mounted: re-asking on every keystroke trains the user to click through. The
gate is inline, under the chip that raised the question — never
`window.confirm` (`no-native-browser-dialogs`), and never a modal, because the
question is about the surface already on screen. Once confirmed,
`MultiSelectTargetBar.tsx` sets the class as the write target and the ordinary
`INSPECTOR_SECTIONS` column writes to it; a multi-selection has no separate
composer.

### §9.4a The write lock carries a count, not a boolean

`setNodesInlineStyles` deliberately skips the individual nodes whose source
refuses a property and writes the rest. A boolean lock cannot say that: calling
it unlocked claims a clean write to all five layers, and calling it locked
disables a control that works for three. So `StyleWriteLockContext` has three
states (`StyleWriteLockContext.ts`):

- `null` — every write reaches disk.
- `{ kind: 'blocked', reason }` — nothing does. Controls disabled, remove
  button dropped, reason as `title`. The original lock, unchanged.
- `{ kind: 'partial', reach }` — some do. Controls stay **enabled**, and the
  row states the count: *"Writes to 3 of 5 selected layers — 2 are set from an
  expression in code."*

The reach is per PROPERTY, not per selection (`styleWriteReach.ts`): a node
whose `width` comes from an expression takes a `color` edit perfectly well, and
a selection-wide count would be wrong on every property but one. Each row asks
about its own property in O(1) via `resolveRowWriteLock`, and carries
`data-write-partial="true"` when it has something to disclose.

**Who provides it.** `StyleSurface` is the one provider: it wraps the mounted
sections (and the More group) in `StyleWriteLockContext.Provider` with
`partialStyleWriteLock(model.inlineWriteReach)`. The selection model builds
`inlineWriteReach` with `buildInlineStyleWriteReach` for a multi-selection
aimed at Element, and leaves it `null` for one layer and for a class target
(one write that reaches every carrier). The partial row also underlines its
label, dotted, in `--warning`, so the count is findable without hovering every
row. Only `ClassPropertyRow` reads the context; the bespoke `ScrubInput`
fields (W/H, X/Y, rotation angle) do not, and their counts are stated once
above the sections by `MultiSelectTargetBar.tsx`. Nothing in the app provides
`blocked`: a whole class that cannot be written is the selection model's
`writableClasses[].lockReason` (via `classCssWritability.ts`), which drops it
from the write targets. Pinned by `styleSurfacePartialWrite.test.tsx`.

### §9.4b Selection colors (G6.4)

`SelectionColorsSection` lists the distinct colours the selection is *made of*,
across properties: the same `#111` used as text on one layer and as a border on
another is ONE swatch with "2 uses". Recolouring rewrites every declaration
that held it in a single undo step, through the new store action
`setNodesInlineStylesPerNode` (a DIFFERENT patch per node, one transaction,
coalesced on `selection-color:<old value>`).

Two deliberate limits, both in `selectionColors.ts`: **inline declarations
only** (a class-sourced colour's honest target is the class, and a swatch must
not silently perform a class edit), and **literal text matching** — `#fff` and
`rgb(255,255,255)` are separate swatches, because bucketing them would mean
rewriting text the user never asked us to touch.

**WS-14.4 closed it as a manifest section (S5).** `SelectionColorsSection`
moved to `inspector/sections/` and became the `selectionColors` entry
(`order: 5`, directly under Fill — the per-property answer to the same
question), wearing Fill's own icon and `Section` chrome. It is the only entry
with a multi-only `appliesTo`: for one node, Fill already says everything it
would. Its field is `ColorValueInput`, the same one `ColorFieldRow`
(`STATE.md` `panel-33`) wraps for Fill's rows, so the swatch opens the real
picker on the FIRST click here too. A selection whose colours all come from
classes renders Law 1's empty header rather than an empty list.

### §9.5 A multi-selection needs two members

Both halves of the panel now agree on the bar. `isSelectorMultiSelect`
(`usePropertiesPanelData.ts`) is `> 1`, matching `isMultiSelect`; one ticked
checkbox in the Selectors panel opens the ordinary single-selector inspector,
resolved from the checkbox set because `toggleSelectorMultiSelect` clears
`selectedSelectorClassId`. Before this, one checkbox produced a bulk action bar
offering to delete "1 class" over a one-row list.

---

## §10. Apply variable — binding a field to a project CSS custom property

Figma's inspector puts a small hexagon at the trailing edge of every field;
hovering reveals it, clicking it opens a searchable list of the file's
variables, and picking one binds the field. Studio's version binds to the
thing that is actually real here: **a CSS custom property the open project's
own stylesheets declare** — `--color-primary`, `--space-4`, `--radius-card` —
written into the source as `var(--name)`.

### §10.1 Where the variables come from

`projectVariables.ts` (`src/admin/pages/site/property-controls/`) scans the
raw CSS the client **already has** for the canvas — `studioRawCssStores.ts`'s
`authoredCss` (the project's own `.css`, concatenated in cascade order) and
`vendorCss` (a design system's package stylesheets) — plus a third string it
generates locally with `generateFrameworkRootCss`, the same generator
`canvasClassCss.ts` feeds the canvas. No server change, no second wire
format, and the catalog can never disagree with what the canvas is rendering,
because it *is* what the canvas is rendering.

Each entry carries a name, a **resolved** value (chains of `var(--a)` →
`var(--b)` → `4px` are followed, bounded and cycle-safe), a kind, and the
bundle it came from. Groups in the picker read Project / Package / Framework.
A package re-declaring a name the user's own stylesheet already declares does
**not** relabel it — the user's own value and label win.

`ProjectVariablesProvider` publishes the catalog on the panel's root
`<aside>`, the same altitude as `data-field-skin="inspector"` and for the
same reason: the affordance has to reach ~40 components down without being
threaded through all of them.

### §10.2 The kind filter is the "no control that lies" rule, applied to variables

A field only offers variables **compatible with its property**, and the kind
is inferred from the *resolved value*, never from the name (`--brand-4` is a
colour in one project and a spacing step in another). `classifyVariableValue`
buckets into `color` / `length` / `number` / `other`. A width field that
offered `--color-primary` would let one click write a declaration the browser
drops, leaving a field that reads as bound while rendering nothing.

Corollary: **when nothing compatible exists, no icon is rendered at all.** An
icon that opens an empty list is the same defect in a different costume.

### §10.3 The affordance

One shared piece, `src/ui/components/VariableField/`, consumed by field
primitives through `useVariableAffordance` — a hook, not a wrapper component,
because the affordance is two elements in two places inside a field that
already exists:

| piece | where | reveal |
|---|---|---|
| `trigger` | absolutely positioned at the field's trailing edge, inside the field's own `position: relative` wrapper | `opacity: 0` until `[data-variable-host]:hover`, `:focus-within`, or its own `:focus-visible` |
| `chip` | the field's leading slot (`Input`'s new `leadingSlot`, or inline in `ScrubInput`'s flex row) | only while bound and not editing |

Wrapping each field in a new element instead would have moved every caller's
layout `className` one level away from the box it was written for, across
~40 call sites. **Nothing here adds height**: the trigger is out of flow, and
the chip is a 16px inline item with `align-self: center` inside a 24px row —
which is what keeps `inspectorGeometryBudget.test.tsx` green.

`[data-variable-host]` is a plain attribute each field primitive sets on its
wrapper. It exists because a CSS-module class name cannot cross the module
boundary between the field's stylesheet and `VariableField.module.css`.

### §10.4 The four states, and what each one writes

| state | field shows | commit |
|---|---|---|
| unbound | its own value | trigger → pick → `var(--x)` |
| bound, idle | chip (name only) + empty rest of field | detach × → the **resolved literal** |
| bound, editing | empty input + open picker | a typed literal, **or** `var(--y)` |
| Mixed | the shared "Mixed" placeholder, **no chip** | pick → `var(--x)` to every selected node |

The chip shows the **name only** — `color-primary`, dashes stripped, Figma's
convention — with the resolved value as its `title`. Clicking it focuses the
field's own (now empty) input **and** opens the picker, so one gesture
reaches both "type any literal" and "swap to another variable". Escape closes
the picker and leaves the binding alone, because entering edit mode writes
nothing.

Every write goes through the field's **own** `onChange`/`onCommit`. That is
what makes a variable pick one honest, undoable AST write and what makes
multi-selection fan-out work with no extra code.

**A bound field is not scrubbable, and nothing had to disable it.**
`useScrubDrag`'s documented contract already refuses any baseline that is not
a bare `<number><unit>`; while bound the baseline is the empty display
string.

**An empty commit on a bound field is a no-op.** The input is empty while
bound, so a blur that typed nothing would otherwise read as "the user cleared
this" and silently destroy the binding on every stray focus. The explicit
ways out are typing a literal and the chip's detach ×.

### §10.5 What binds, and what deliberately does not

`parseVarBinding` treats a value as bound only when it is **exactly one**
`var()` reference (a fallback argument is allowed). `calc(var(--x) * 2)` and
`1px solid var(--x)` are literal values that merely *mention* a variable —
showing a detachable chip for either would claim a one-token edit the field
cannot honestly make.

A binding to one of the field's **own framework scale steps** is also not
shown as a chip: `TokenAwareInput` already round-trips `var(--space-md)` back
to the short `md` its autocomplete is built around, and `TokenizedColorField`
already resolves and renders framework colour tokens. The chip is for the
project's own custom properties — the ones with no step shorthand and no
place in those dropdowns.

### §10.6 Reach

`ScrubInput` and `TokenAwareInput` are the two seams; everything downstream
inherits from them — `ScrubTokenField`, `AddablePropertyField`,
`SpacingBoxControl`, `ClassPropertyRow`'s generic rows, and the bespoke
Size / Spacing / Position / Typography / Stroke / Appearance fields.
`TokenizedColorField` (and therefore `ColorValueInput`) carries the trigger
for colour variables.
## §11. What an inspector gesture costs the undo stack

Two defects made Ctrl+Z read as broken from the Properties panel. Both were
bugs about *history cost*, not about the values written.

### §11.1 A prefilled field must not write on a bare focus/blur

Prefill (`styleFieldDisplay.ts`, §5) means an undeclared property DISPLAYS the
value the element actually renders. That is only safe if committing an
unchanged value writes nothing — otherwise clicking into a padding side and
clicking away mints `padding-top: 16px` in the user's source, and pushes an
undo entry that reverts nothing visible. A click-through of the panel then
buries the user's real edits under phantom entries.

`ScrubInput` always compared (`next !== display`). `TokenAwareInput` — the
input behind every `ScrubTokenField` and behind `SpacingBoxControl`'s four
sides — did not. It now compares the RESOLVED value against its own `value`,
so a token round-trip (`var(--space-md)` shown as `md`) reads as unchanged, and
a MIXED field's baseline is empty rather than one member's value.

**Any new field primitive must compare before it commits.** Regression test:
`src/__tests__/panels/prefilledFieldCommitGuard.test.tsx`.

### §11.2 One gesture is one undo entry — `onChangeMany`

A multi-property gesture is one gesture to the user: Width → Fill writes `flex`
AND clears `width`; the align 3×3 sets both axes; a layout mode switch sets
`display` + `flexDirection`; an animation edit rewrites a whole longhand group.
Every one of those was committed through the per-property `onChange` in a loop,
so a single click became 2–8 history entries and one Ctrl+Z left the element
spliced between two states it was never in.

`StyleSectionsEditor`'s `onChangeMany(patch)` is the one multi-property write
channel — `null` clears. All three composers implement it over a store action
that already took a whole patch (`setNodeInlineStyles` /
`setNodesInlineStyles` / `updateClassStyles`), so one call is one
`runHistoricMutation` transaction.

It does **not** replace `onClearProperties`: on a class target that one purges a
property from the base rule AND every context override, which a patch aimed at
the active context cannot express. `LayoutSection`'s mode switch therefore
still costs two entries when the mode change also has to purge dependent
properties — named, not fixed.

Regression tests: `sizeSection.test.tsx` and `layoutSection.test.tsx` assert
ONE `onChangeMany` call per gesture;
`src/__tests__/editor-store/multiPropertyGestureIsOneEntry.test.ts` pins the
store half.

---

## §12. A section that throws takes only itself down

Every mounted `INSPECTOR_SECTIONS` entry is wrapped in a `PanelBoundary`
(`src/admin/pages/site/ui/PanelBoundary/`, `frame="section"`), and each of the
three `InspectorShell` tabs is wrapped in one too (`frame="panel"`).

Before `panel-40` the nearest boundary above the inspector was
`AdminCanvasLayout`'s `LazyChunkBoundary location="site-editor-body"`, which
wraps the canvas and every panel together. `verify-3` case 5 measured what that
meant: one section throwing replaced the whole editor body with "Editor chunk
failed to load" — the canvas and the canvas notch went with it.

What a crashed section looks like now:

- its own `Section` header row, unchanged, so the scroll does not jump;
- one line, *"Fill stopped responding."* (plus the error message in dev);
- a **Reload this panel** `Button` that remounts just that section;
- **no toast** — `ErrorBoundary` is silent by default and nothing here opts
  back in (Z2);
- exactly one console line, `[error-boundary:inspector:fill]`.

Two consequences for work in this area:

1. **Every manifest entry carries a `label`.** The section's own component is
   precisely what is NOT running when the boundary has to name it, so the name
   lives in `sections/index.ts`, not in the component. A new entry without one
   fails `error-boundary-coverage.test.ts`.
2. **A section boundary takes no `resetKeys`.** A section that throws on every
   node must not be cleared silently by the next click on the canvas — that
   would make a permanent crash look like a flicker.

The dev-only `PanelCrashProbe` mounted inside each boundary is how a browser
spec crashes exactly one of them:
`window.dispatchEvent(new CustomEvent('studio:panel-crash-probe', { detail: 'inspector:fill' }))`.
It is erased from a production build at its mount site.

---

## Gates that bite work in this area

`css-token-policy`, `no-css-var-fallbacks`, `button-primitive-usage` (popovers
must use `Button`), `no-third-party-icons` (run `bun run icons:sync` after adding
an icon), `boundary-validation` (the gradient, box-shadow, background-layer and
numeric-expression parsers are boundaries — TypeBox them, no `as`),
`module-size-budgets` (several section files sit near the 700-line ceiling:
extract, don't grow — `FillSection` split into `FillSectionParts.tsx` +
`fillModel.ts` + `backgroundLayers.ts` for exactly this reason, then further
into `FillColorField.tsx` (the colour rows' own chrome — `ColorFieldRow`,
`ColorWriteRefusalBody`, `ColorSwatch`), `buildColorFillEntry.tsx` (the row
object itself), and `colorWriteTargetNote.ts` (the shared note-string
builder, its own file because `react-refresh/only-export-components` forbids
mixing a plain function export with a component export) when G6.2b grew it
again, and once more into `fillRowDescriptors.tsx` (the `FillEntryData`
taxonomy, popover titles and `describeLayer`), `FillEntryPopover.tsx` (the one
switch over row kinds) and `GradientEditor.tsx` when §9.3's Mixed contract
landed — `panel-38`).

`error-boundary-coverage` gained a `panel-40` block: every panel seam mounts a
`PanelBoundary`, `InspectorShell` wraps all three tabs, the component never opts
out of `silentToast`, and every `INSPECTOR_SECTIONS` entry carries a `label`.

`measurement.test.ts`'s P2-H block gates the panel's finish, over every CSS
module under `PropertiesPanel/`, `property-controls/`, `inspector/sections/`
and `Section/`: no fluid `--space-*` step at all (only `--space-px`), no
literal px `border-radius` (a token, `0` or `50%`), no `--text-disabled` on
text outside a disabled/placeholder rule, `--text-subtle` at 4.5:1 on the
docked panel in both themes, and a field hover that sits further from the
panel than the resting field. The node-level notices (shared component, slot
fill, source constraint, branch choice) mount in one `.nodeNotices` band on
the 12px gutter, which `:empty` collapses to nothing. The computed half —
real hover, real `:focus-visible`, real rects — is
`tests/e2e/inspector-panel-polish.e2e.ts`.

Ownership, when routing work: `panel-designer` owns the sections and primitives;
`store-engineer` owns the multi-select surface (§9) and is needed for G8.3
(shadow-layer modelling); `test-engineer` owns the §6 measurement gate.

---

## Related

- [`docs/design.md`](../design.md) → "The inspector" — the same rules in design
  language, plus panel geometry, skins, provenance and placeholders
- [`docs/reference/ui-primitives.md`](../reference/ui-primitives.md) — the
  primitives these goals are built on
- [`ROADMAP.md`](../../ROADMAP.md) §13 — where G6.4 (selection colours) is
  tracked
