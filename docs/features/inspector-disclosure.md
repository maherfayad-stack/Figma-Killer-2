# Inspector progressive disclosure

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

> **History.** This content was the delivery plan `STUDIO-INSPECTOR-DISCLOSURE-PLAN.md`,
> retired once its work orders shipped. The plan's own progress bookkeeping is
> gone (git remembers it); the design rules, which the code still cites, live
> here. Per-track status for the wider parity effort is
> [`STUDIO-FIGMA-PARITY-PLAN.md`](../../STUDIO-FIGMA-PARITY-PLAN.md) **§0a** —
> the single status ledger. The narrative summary of these laws, in design
> language, is [`docs/design.md`](../design.md) → "The inspector".

---

## Status

G1–G10 shipped, G9 completed in W8-1. Two pieces did not, and are tracked as
open workstreams in
[`STUDIO-NEXT-WORKSTREAMS.md`](../../STUDIO-NEXT-WORKSTREAMS.md):

| Open | What is missing |
|---|---|
| **G6.4 — Selection colours** | Listing every distinct colour across a multi-node selection and rewriting all of them from one edit. Deferred at `FillSection.tsx`. Its blocker — store-side multi-select style editing — is gone as of W8-3 phase 1 (`setNodesInlineStyles`, §9); what remains is the aggregation UI and the class-target half, which is W8-3 phase 3. |
| **§6 — The measurement gate** | No `scrollHeight <= clientHeight` test exists, and no height baseline was ever recorded in `docs/audits/`. The budgets in §6 are therefore unenforced. |

One goal was superseded rather than shipped as written: **G8.4** moved
`transform`/`transition`/`animation` out of Effects, but into a full
**Animations** section (`AnimationsSection.tsx`, `AnimationEditorPopover.tsx`,
`AnimationScrubRow.tsx`) rather than into a `⚙` popover.

---

## §1. The five laws

Everything in §4 is an application of one of these. When a decision is not
covered by a work order, decide it with these.

### Law 1 — An unused section costs one line (F13)

Figma's Fill, Stroke and Effects sections are *lists*. Empty list ⇒ a title and a
`+`.

**Rule:** a section with zero set properties and no mandatory control renders as
`▸ Title  [+]` and nothing more.

Implemented as `collapsedWhenEmpty` on `ClassStyleSectionDefinition`
(`classStyleSections.ts`), applied by `StyleSectionGroup` in
`StyleSectionsEditor.tsx`, gated by `__tests__/emptySectionLaw.test.tsx`.
Emptiness is judged **across every context**, not just the active breakpoint — a
value living on another tab is still the user's own work and must never be
hidden behind a `+`. Search must not defeat the law either
(`StyleRuleComposer.tsx`).

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

A frame with no auto-layout shows W/H and Clip content. Turn on vertical
auto-layout and the align pad, gap and padding appear. Switch to grid and the
track cell replaces the align pad. Nothing is disabled-but-visible; it is absent.

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

### §3.2 `PropertyList` — used by G6, G7, G8

The Fill / Stroke / Effects list shape (F13, F14, F16, F20). One component,
three consumers.

- Empty ⇒ renders **nothing but its header's `+`** (Law 1). The header is the
  existing `Section` with `actions`.
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

## §4. The ten goals (G1–G10)

### G1 — The empty-section law

> **Figma:** F13. Fill, Stroke and Effects on a plain frame are three lines total.

A section marked `collapsedWhenEmpty` with nothing set renders as `▸ Title [+]`
and nothing more; `+` reveals the body for that selection only. The flag is set
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

### G3 — Layout: the settings popover (F3–F8)

A `⚙` opens a mode-filtered *Layout settings* popover holding `alignSelf` /
`justifySelf` / `flex` — which describe how *this* element behaves in its
**parent**, not how it lays out its children, the conceptual bug behind half the
section's height — plus split-axis `rowGap`/`columnGap` and
`gridColumn`/`gridRow`. `overflow` is promoted to a *Clip content* checkbox (a UI
rename only; the CSS written stays `overflow`), and the wrap toggle moves to the
cluster header.

*Shipped correction:* the `⚙` is **resident on the Clip-content row**, not
anchored to the gap field, so `alignSelf`/`justifySelf`/`flex`/`gridColumn`/
`gridRow` stay reachable on a node that is not a container
(`LayoutSettingsButton.tsx`).

### G3.3 — `AlignGrid`, the 3×3 pad (F4/F6/F7)

Two captioned linear alignment rows (~56px) become one uncaptioned 3×3 pad
(~48px) that writes `alignItems` + `justifyContent` in one gesture — one click
instead of two — keeping the linear controls as its keyboard model. Grid mode
maps to `alignItems` + `justifyItems`.

### G4 — Spacing: padding as two fields (F4/F9)

Padding collapses to horizontal/vertical fields with an expand toggle to four,
and **moves into the Layout section**: padding is a layout property of a
container, margin is a relationship with siblings. The `SpacingBoxControl`
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

### G6 — Fill: a real colour picker and a fill list (F13–F15)

Background is renamed **Fill** and rebuilt on `PropertyList`: empty ⇒ one line,
`backgroundColor` and `backgroundImage` as entries, and `backgroundSize` /
`Repeat` / `Position` / `objectFit` / `objectPosition` moved into the *entry's
own popover* — drawing five of them for an element with no image is the exact
defect this page exists to prevent.

- **G6.2** — `ColorPickerPopover`: SV square + hue rail + **alpha rail**, model
  select (HSL/RGB/HEX), the **eyedropper** (feature-detected on
  `window.EyeDropper`), the contrast readout, and an "On this page" recents strip
  that for us is the project's own colour tokens — strictly better than Figma's,
  so `TokenizedColorField`'s token integration stays as the **first** tab.
- **G6.3** — gradients round-trip or refuse: parse the user's existing gradient
  into stops, and if it does not round-trip losslessly, **refuse to open the
  visual editor and say why** (`gradientValue.ts`).
- **G6.4** — *(open)* Selection colours: with 2+ nodes selected, list every
  distinct colour in the selection and let one edit rewrite all of them.

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
mode — they choose *which* of left/right and top/bottom the offsets are written
to, a real and frequently-wanted choice previously expressible only by which of
four fields the user typed in. `rotate` is now **resident** on the section's
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
| `ScrubInput` | `src/ui/components/ScrubInput/` | Drag-the-label numerics: W/H, rotation, shadow offsets, stroke weight |
| `TokenAwareInput` | `src/admin/pages/site/property-controls/` | Length fields with token autocomplete (padding, margin, `fontSize`) |
| `TextControl` / the frame W-H inputs | `property-controls/`, `FrameSizePanel.tsx` | The generic property row, and a board frame's own size |

### §5.1 Commit coerces; it never writes what CSS rejects

A typed value goes through one coercion on commit (blur / Enter / Tab):
`resolveCommitValue` (`scrubMath.ts`) for scrub fields, `resolveTokenValue`
(`tokenUtils.ts`) for token-aware ones. Both do the same three things in the
same order: a recognised keyword (`auto`/`fill`/`hug`) passes through; a number
or an arithmetic expression is evaluated and given **the field's own unit**
when it carries none; anything else is kept as the user's literal text.

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
are held (the more specific request wins). `numericNudge.ts` owns the numbers;
`nudgeStepFor` is the only resolver. Drag-scrub uses the same three magnitudes
as its per-pixel scale.

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
Escape's revert needs care: the blur it triggers fires *before* React has
re-rendered the reverted draft, so both `ScrubInput` and `TokenAwareInput` set
a flag that makes that one blur discard instead of commit — otherwise Escape
writes the very value it was pressed to abandon.

---

## §6. The measurement gate

> **Not implemented.** No baseline was ever recorded and no test asserts these
> budgets. Tracked as open work.

Do not start a density change without a baseline, and do not close one without a
re-measure. Fabricated height numbers are how a density plan drifts.

Capture the rendered height of every section for three fixtures — a plain
`<div>`, a styled card, a text node — at panel width 300, and record them in
`docs/audits/`. The parity plan's numbers (Effects 398→257px, Border 404→373px,
`SpacingBoxControl` ~253px, measured 2026-08-30) are the last known values;
verify rather than trust them.

**The one number that matters — F28:** a text node's entire inspector, with
Position, Layout, Appearance, Typography, Fill, Stroke and Effects all present,
fits in **one 900px viewport with no scroll**. Write it as a real test: render
the panel for the text fixture, assert `scrollHeight <= clientHeight`.

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
one value to all of them. Phase 1 of W8-3 shipped this for the **Element
(inline)** target only.

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
without aborting the rest; `MultiInlineStyleComposer` names those properties
above the sections so the refusal is never silent.

### §9.2 Two collapsed bags, no new section tree

`StyleSectionsEditor` is already target-agnostic — it renders whatever
`storedStyles` / `currentStyles` pair it is handed. Multi-select therefore adds
no second copy of the section tree, only `buildMultiSelectStyleBags`
(`multiSelectStyleBags.ts`), which collapses N nodes into that same pair using
`collapseValues` from `@ui/components/MixedValue`:

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

**Known phase-1 gap:** a bespoke section that reads a raw cell through
`readString` sees `undefined` for `MIXED` and renders its ordinary *unset*
state — an empty field or an unpressed toggle group, which is visually right
but does not say the word. The primitives above already accept `mixed`, so
wiring each section is a one-line change per field; it is deliberately not done
here because five of those sections were being rewritten in parallel.

### §9.4 The target is pinned to Element, and says so

A class edit from a multi-selection has a blast radius the panel cannot state
honestly yet: the N nodes rarely share one class, the classes they do share are
usually also on elements *outside* the selection, and several are
compiled/unmapped so the write would not reach disk at all. That is the "one
honest target" invariant, so phase 1 pins the write target to Element and shows
why: `StyleTargetChip` takes `lockedToElementReason`, renders Element as the
active non-switchable target, and states *"Bulk edits write inline styles —
class edits need a single selection"* on the Element, Class and Assign rows.
Inline styles carry no such ambiguity — `style=""` belongs to exactly one
element, so N inline writes touch exactly the N elements selected.

Phase 2 (`StyleWriteLockContext` carrying a COUNT — "writes to 3 of 5, 2 are
compiled" — instead of a boolean) and phase 3 (class-target bulk behind an
explicit "this class is used by N other elements — continue?" gate, plus G6.4's
Selection colours) are not in this pass.

### §9.5 A multi-selection needs two members

Both halves of the panel now agree on the bar. `isSelectorMultiSelect`
(`usePropertiesPanelData.ts`) is `> 1`, matching `isMultiSelect`; one ticked
checkbox in the Selectors panel opens the ordinary single-selector inspector,
resolved from the checkbox set because `toggleSelectorMultiSelect` clears
`selectedSelectorClassId`. Before this, one checkbox produced a bulk action bar
offering to delete "1 class" over a one-row list.

---

## Gates that bite work in this area

`css-token-policy`, `no-css-var-fallbacks`, `button-primitive-usage` (popovers
must use `Button`), `no-third-party-icons` (run `bun run icons:sync` after adding
an icon), `boundary-validation` (the gradient, box-shadow and numeric-expression
parsers are boundaries — TypeBox them, no `as`), `module-size-budgets` (several
section files sit near the 700-line ceiling: extract, don't grow — `FillSection`
split into `FillSectionParts.tsx` + `fillModel.ts` for exactly this reason).

Ownership, when routing work: `panel-designer` owns the sections and primitives;
`store-engineer` is needed for G6.4 (multi-select) and G8.3 (shadow-layer
modelling); `test-engineer` owns the §6 measurement gate.

---

## Related

- [`docs/design.md`](../design.md) → "The inspector" — the same rules in design
  language, plus panel geometry, skins, provenance and placeholders
- [`docs/reference/ui-primitives.md`](../reference/ui-primitives.md) — the
  primitives these goals are built on
- [`STUDIO-FIGMA-PARITY-PLAN.md`](../../STUDIO-FIGMA-PARITY-PLAN.md) **§0a** —
  the single per-track status ledger
- [`STUDIO-NEXT-WORKSTREAMS.md`](../../STUDIO-NEXT-WORKSTREAMS.md) — where G6.4
  and the §6 gate are tracked
