# 05 — Studio's own per-section heights, and the 900px Design-tab budget
> **Trust:** historical, dated 2026-09-09; the tables were re-measured on
> 2026-09-23 by P2-F (the design pane's spacing), which is what the "P2-F"
> columns and sections below record. Paths may still be wrong elsewhere.

Unlike `00`–`04`, this file measures **Studio**, not Penpot. It exists because
`docs/features/inspector.md` §6's oldest claim — *a text node's entire
inspector fits in one 900px viewport with no scroll* — went unenforced for the
whole of P3, and by the time anyone measured it the panel was ~1826px tall.
WS-14.5 turns it into a gate; this file is the number that gate moves.

> **The claim was false, the number is now measured three times, and the gap
> is all but closed.** panel-37's first real run: **626px** of room at a 900px
> viewport against **960 / 1190 / 1013 / 1043px** for F1–F4 — 334–564px over.
> panel-39's density pass: **718px** of room against **690 / 916 / 909 /
> 773px** — 0 / 198 / 191 / 55 over. panel-41's second: **746px** of room
> against **608 / 782 / 725 / 603px** — **0 / 36 / 0 / 0**. P2-F then
> SPENT height on segregation (a 12px section gap, a real header and a
> hairline on the props block) and paid for it with the Shadow + Blur merge
> and 4px rows inside a group: **598 / 772 / 715 / 601px** — **0 / 26 / 0 /
> 0**. Three of the four fixtures fit outright, with 148 / 31 / 145px of
> headroom, and the gate is asserted strictly against the room for those
> three. The one that does not is F2, a text layer, and all 26px of it is
> populated section content named with numbers under "What is left" below.

## Two tables, and why neither replaces the other

| | Where | What it is |
|---|---|---|
| **Computed** | `src/__tests__/inspector/measurement.test.ts` | `headerHeightPx + rows * rowHeightPx + gaps`, per section, from the frozen `--inspector-*` tokens and each section's own rest-state row count read from its source. No browser. |
| **Measured** | `05-section-heights.json`, written by `tests/e2e/inspector-height.e2e.ts` | Real `getBoundingClientRect().height` per `[data-section-id]`, at a real 900×1400 viewport, for all four baseline fixtures. |

The computed table is what `bun test` can enforce — happy-dom builds a DOM but
does not lay it out, so `scrollHeight`/`clientHeight` are identically `0`
there. The measured table is the one that answered "does it fit" and the one
that keeps the answer from getting worse. Neither is redundant: the computed
one catches a section growing rows without anyone running a browser, the
measured one catches the panel *chrome* that no static sum can see.

## The computed Design-tab table — F2 (text)

Rest state, `--inspector-header-h` / `--inspector-row-h` = 32px,
within-group gap 4px, between-section gap `--inspector-section-gap` = 12px
(P2-F; it was `--inspector-space-m`, 8px).

| Section | Header | Rest rows | Height |
|---|---|---:|---:|
| `layer` | – | 1 | 32 |
| `align` | – | 0 | 0 |
| `measures` | – | 3 | 104 |
| `layout` | ✓ | 0 (collapsed until a layout exists) | 32 |
| `fill` | ✓ | 0 (empty state) | 32 |
| `stroke` | ✓ | 0 | 32 |
| `effects` | ✓ | 0 | 32 |
| `text` | ✓ | 4 | 172 |
| `export` | ✓ | 0 | 32 |
| **`more`** (collapsed) | ✓ | 0 | **32** |
| between-section gaps | | 8 × 12 | 96 |
| **Design-tab sections total** | | | **596** |

`align` renders `null` for this fixture (no flex/grid parent), and its empty
`[data-section-id]` wrapper is `display: none` (`StyleSurface.module.css`'s
`[data-section-id]:empty`), so it is not a grid item and costs no gap. This
table used to count one for it, which the measured table never agreed with.

### How 756 became 612

| | px |
|---|---:|
| S5's total, at a 12px section gap and a `forceOpen` Layout | 756 |
| section gap 12 → 8 (Figma's and Penpot's own measured step), ten gaps | −40 |
| Layout's rest state: 3 rows + header → header only | −104 |
| **panel-39** | **612** |
| P2-F: section gap 8 → 12 (`--inspector-section-gap`), eight gaps | +32 |
| P2-F: Shadow + Blur → one Effects section (a header and a gap) | −40 |
| P2-F: `align`'s phantom gap no longer counted | −8 |
| **P2-F** | **596** |

### What the More disclosure buys

Before S5 the four Studio-extras sections mounted inline in the same scroll:
`transform` 32, `animations` 32, `interaction` 32, `customProperties` 64,
each with its own between-section gap. Folding all four behind one collapsed
`More` header removes **164px** of always-mounted Design-tab height at the
12px section gap (152 while panel-39 held it at 8px) without deleting a
single control. Expanding `More` renders all four exactly as before, in
manifest order. Three of them (`transform`, `animations`, `interaction`) also
mount **expanded** on the Prototype tab, which is their real home.

Both numbers are asserted in `src/__tests__/inspector/measurement.test.ts`, so
a section that quietly grows a resident row fails `bun test`.

## The measured table — `05-section-heights.json`

Regenerated by:

```sh
npx playwright test tests/e2e/inspector-height.e2e.ts
```

Shape:

```jsonc
{
  "viewport": { "width": 1400, "height": 900 },
  "budget": { "source": "clientHeight of the Design tab scroll container at 900px" },
  // ONE exception to an otherwise strict budget, for ONE fixture. panel-39's
  // blanket `populatedSectionOverflowAllowancePx: 210` is gone — three of the
  // four fixtures fit outright now, so a uniform slack would hide a 200px
  // regression on any of them.
  "overflowException": { "fixture": "f2-text", "allowancePx": 50 },
  "fixtures": {
    "f1-rectangle": {
      "contentHeight": 598,       // what the tab renders
      "clientHeight": 746,        // THE BUDGET — the room it has at this viewport
      "scrollHeight": 746,        // clamps to the room; recorded, never asserted
      "overflowPx": 0,
      "headroomPx": 148,
      "sections": { "module": 33 } // per [data-section-id], rendered px
    }
    // f2-text, f3-flex-board, f4-image
  }
}
```

**`contentHeight`, not `scrollHeight`.** `scrollHeight` is
`max(clientHeight, content)`, so for a tab that fits it reports the room
itself — it can show neither headroom nor a fitting fixture creeping back
toward the limit. The gate measures `.surfaceContent`'s own box plus the
scroll container's padding instead, and asserts THAT against the room.

The spec writes the file only after every assertion passes, so a red run never
overwrites a good baseline.

Every locator behind this table is scoped to the **active Design tab**
(`[data-inspector-tab="design"]:not([hidden])`). `InspectorShell` mounts all
three tab panels and hides the inactive two, and `transform` / `animations` /
`interaction` declare `tabs: ['design','prototype']` — so an unscoped read
folds the Prototype tab's hidden copies into the table as bogus 0px rows, and
an unscoped `toHaveCount(0)` fails against a shell behaving exactly as
designed. That was the panel-37 defect.

### Measured, at 1400×900 — the whole panel

| Fixture | P2-F `contentHeight` | Room | Over by | panel-41 | panel-39 | panel-37 |
|---|---:|---:|---:|---:|---:|---:|
| F1 rectangle | 598 | 746 | **0** (148 spare) | 608, 0 (138 spare) | 0 (28 spare) | 334 over |
| F2 text | 772 | 746 | **26** | 782, 36 over | 198 over | 564 over |
| F3 flex board | 715 | 746 | **0** (31 spare) | 725, 0 (21 spare) | 191 over | 387 over |
| F4 image | 601 | 746 | **0** (145 spare) | 603, 0 (143 spare) | 55 over | 417 over |

Total overflow across the four: **1702 → 444 → 36 → 26**.

### Where the room comes from

Measured on the docked panel at a 900px viewport, top to bottom. The scroll
container's own box ends exactly at the window's bottom edge, so this is the
honest "900px minus chrome" figure.

| Band | panel-37 | panel-39 | panel-41 |
|---|---:|---:|---:|
| admin top bar | 36 | 36 | 36 |
| `PanelHeader` (the node title lives here) | 36 | 36 | 36 |
| `InspectorShell` tab strip | 47 | 43 | 43 |
| `FrameSizePanel` | 88 | **0** | 0 |
| `headerClassPicker` | 67 | 67 | **39** |
| **chrome total** | **274** | **182** | **154** |
| **`.surface` (the Design tab's scroll container)** | **626** | **718** | **746** |

**panel-41's 28px** is `ClassPicker` becoming one row. The selector pills sat
on a row of their own below the add-a-selector input; they are now the leading
items of that same wrapping row, which is what every other tag input in the
world does. The row still wraps — for an element with eight classes it grows,
proportionally to real content — but for one or two it does not, which is
every fixture in this baseline. A second, smaller correction came with it:
the input's flex floor was large enough that `.image-layer` wrapped where
`.board` did not, so F4's room read 723 against F3's 746. The budget must not
move with the length of a class name.

**One correction to panel-37's table.** The 88px band was recorded there as
"node header (title + breadcrumb)". It is not — the node title is inside
`PanelHeader`'s own 36px. The 88px is `FrameSizePanel`, the board FRAME's
device preset and W/H, which rendered above every single-node selection: a
second, unrelated W/H pair four rows above the one `MeasuresSection` draws
for the selected node. It now renders only in the nothing-selected state it
describes, which is where Figma shows a frame's size; a frame *selection*
already gets the same controls from `FrameBulkInspector`.

### Where F2's height goes, before and after

Per-child height of `.surfaceContent`, so the two blocks the computed table
cannot see (`WriteTargetRow`, the Module block) are visible here. The Module
block now carries `data-section-id="module"`, so it is in the measured table
proper rather than invisible to both gates.

| Child | panel-37 | panel-39 | panel-41 | P2-F |
|---|---:|---:|---:|---:|
| `WriteTargetRow` | 32 | 32 | **gone** | – |
| Module block (`base.text` props) | 158 | 158 | **80** | **95** |
| `layer` | 32 | 32 | 32 | 32 |
| `align` | 0 | 0 | 0 | 0 |
| `measures` | 122 | 122 | 122 | **114** |
| `layout` | 199 | **33** | 33 | 33 |
| `fill` | 73 | 73 | **65** | 65 |
| `stroke` | 33 | 33 | 33 | 33 |
| `shadow` | 33 | 33 | 33 | – |
| `blur` | 33 | 33 | 33 | – |
| `effects` | – | – | – | **33** |
| `text` | 197 | 197 | **189** | **177** |
| `export` | 33 | 33 | 33 | 33 |
| `more` (collapsed) | 33 | 33 | 33 | 33 |
| **sum of children** | **978** | **812** | **686** | **648** |
| grid gaps (11 × 12 → 11 × 8 → 10 × 8 → 9 × 12) | 132 | 88 | 80 | **108** |
| `.surface` + `.surfaceContent` padding | 80 | **16** | 16 | 16 |
| **total** | **1190** | **916** | **782** | **772** |

P2-F's F2 lines, each with its cause (the owner's ask: *"add spacing to
segregate a bit, specially in between props and the element below"*):

- **The Module block 80 → 95** (+15). Its title is now `SectionStaticHeader`
  — the 32px recipe every section title uses (+6 over the old 26px label
  row) — its body ends in 8px of padding, and the block closes on a 1px
  hairline. Props → 8px → hairline → 12px gap → Layer, where it was props →
  8px → Layer with nothing between.
- **Grid gaps 80 → 108** (+28). `--inspector-section-gap` is 12px, one step
  above the 8px between-group step, so a section boundary finally reads as
  wider than a group boundary; one gap fewer because of the merge below.
- **`shadow` + `blur` → `effects`** (−33, and a gap). Figma's one Effects
  section.
- **`text` 189 → 177, `measures` 122 → 114** (−20). Rows inside one group sit
  4px apart, Penpot's `menus/text.scss` and `menus/measures.scss` step.

panel-41's three F2 lines, each with its cause:

- **`WriteTargetRow` is gone** (−32, plus its gap = −40). Its two facts — a
  target's lock reason, and which target a brand-new property lands in — now
  ride `ClassPicker`'s own pills, which listed the same selectors 40px above
  it. Two surfaces stating one fact about one element is the panel's own copy
  of the write-target ambiguity WS-6.2 exists to fix.
- **The Module block 158 → 80** (−78). Its `tag` row is a schema default this
  `<p>`'s source never wrote, so Law 3 folds it behind the block header's
  `1 more` disclosure (−36 with its gap); and the `text` content editor sizes
  to the text instead of reserving four rows (90 → 54, −36). `rows` became
  the ceiling, not the height.
- **`fill` 73 → 65 and `text` 197 → 189** (−16 together). A flush section's
  `.sectionContent` carried 8px of bottom padding *on top of* the parent grid
  gap, so an open section sat 16px from the next divider while a collapsed one
  sat 8px from it — two boundaries, two sizes, for no stated reason. 8px is
  was then (wrongly) held to be the between-section step `02-measurements.md`
  measures — its Δ16 is Penpot's 8px flex gap plus each menu's 8px
  `margin-block-end`, which is why P2-F moved the section gap to 12.

The three contributors panel-37 named, and what happened to each:

1. **`layout` cost 199px on a node with no layout at all.** It rests at 33px
   now: one row, an "Add auto layout" `+`, and a chevron that discloses the
   entire unchanged body in one click. A flex/grid container still renders it
   open at rest — F3's `layout` is 329px and always was. **−167px** on F1, F2
   and F4.
2. **The Module block was unbudgeted and large** — 158px for a text node,
   252px for an image, 60px otherwise. It is budgeted now: `StyleSurface.tsx`
   gives it `data-section-id="module"`, so it appears in this table and in the
   artefact. Its height is unchanged; see "What is left", lever 2.
3. **`.surface` and `.surfaceContent` both carried `padding-bottom:
   var(--space-7xl)`.** Gone: the duplicate is deleted and both container
   paddings are frozen to `--inspector-space-m`, since `--space-*` is the
   admin's fluid `clamp()` scale that the inspector's own frozen-geometry rule
   exists to keep out of this panel. 80px → 16px, on every fixture.

### Where F3's and F4's height went

- **F3 (flex board), 191 over → fits with 21px spare.** Its `layout` section
  went 329 → 227. Figma draws an auto-layout block as the 3×3 align pad on
  the left with the flow and spacing fields stacked to its right; Studio
  stacked all three, so the pad — a fixed 48×48 box — had 48px of dead column
  beside it on a row of its own (−94px, including padding beside margin). The
  rest is the `.sectionContent` padding fix above.
- **F4 (image), 55 over → fits with 143px spare.** Its Module block went
  252 → 130. `<img className src alt />` sets `src`; `loading`,
  `fetchPriority` and `decoding` are schema defaults the JSX never wrote, so
  Law 3 folds all three (−122px: three rows, two gaps, and the row a separate
  "More properties" disclosure would itself have cost — the fold lives on the
  block header, which already exists).

### What is left, and why it is not closable as density

One fixture, and every pixel of it is a **populated** section — a value the
user's own source sets, drawn once, at the 32px row height `04-token-gaps.md`
measures off Penpot — or the section gap the owner asked for.

**F2 (text), 26 over — 772 against 746:**

| Block | px |
|---|---:|
| `text` — family; weight+size; line-height+letter-spacing; align (Figma's own four rows) | 177 |
| `measures` — W/H, CSS position mode, rotation+radius | 114 |
| Module block — header, the node's own `text` content, padding, hairline | 95 |
| `fill` — the text colour the class sets | 65 |
| `layer` — opacity, blend, visibility | 32 |
| five collapsed one-row sections (layout, stroke, effects, export, more) | 165 |
| gaps (9 × 12) + container padding (2 × 8) | 124 |

Nothing there is pre-drawn. The Shadow + Blur merge this section used to name
as "the one lever" is done (P2-F, −45px on every fixture), and it paid for the
segregation rather than closing the gap: closing the last 26px now means
collapsing a section that has values in it, or giving back spacing the owner
asked for. `TEXT_LAYER_OVERFLOW_PX` is 50 — the measured 26 plus the same 24px
of machine-to-machine slack it carried before.

Two smaller observations, still open:

- F4's `fill` renders `forceOpen` with a body of zero rows — 33px of header
  and nothing behind it. That is Law 1's "an empty section is not a
  disclosure" case; panel-41 measured fixing it as worth 8px on that fixture.
- `measures` is 114px everywhere except F1, where `position: relative` adds
  the TRBL grid and it becomes 191px. F1 has 148px of headroom, so it is not
  a problem today — but it is the largest single block in the panel.

### The fixtures

The same F1/F2/F3 shapes as `01-fixtures.md`, plus the F4 image that the
existing `tests/e2e/inspector-panel-measurement.e2e.ts` never had (which is
why its `f4_downloadSourceImage` click count is skipped there). They live in a
throwaway project created inside `studio-workspace/` under a `ws145-e2e-`
prefix and removed afterwards — **never** an existing project, which is real
user data.

## Related

- [`docs/features/inspector.md`](../../features/inspector.md) §6 — the budget
  and the three-file gate.
- `src/__tests__/inspector/measurement.test.ts` — the static half.
- `tests/e2e/inspector-height.e2e.ts` — this file's producer.
- `tests/e2e/inspector-panel-measurement.e2e.ts` — the older, tall-viewport
  gate (row rhythm, 260px width invariant, click counts). Still live; it
  measures different things.
