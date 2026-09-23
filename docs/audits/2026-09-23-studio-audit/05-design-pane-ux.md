# 05 — Design pane + editor-chrome UX audit (read-only)

Auditor: panel-designer · 2026-09-23 · no repo files modified.
Ground truth: Penpot source at `../penpot/frontend/src/app/main/ui/**` plus Studio's own measured
baseline `docs/audits/penpot-inspector-baseline/02-measurements.md` / `05-section-heights.md`.

---

## 0. The owner's complaint, diagnosed ("add spacing … especially between props and the element below")

**What sits there today (single node, Design tab, top to bottom):**

```
ClassPicker (chrome, outside scroll)      PropertiesPanel.module.css:102-119
└ 16px ::after fade overlapping the top of the scroll area
.surface padding-top 8px                   StyleSurface.module.css:25
[module]  ModuleBlock header   4px pad, ~10px uppercase --text-subtle title   ModuleBlock.module.css:13-26
          prop rows, 8px apart (--inspector-group-gap)                        Section.module.css:204-206
  ── 8px grid gap, NO hairline, NO header ──                                  StyleSurface.module.css:66
[layer]   opacity / blend / eye row (headerless, no divider)                   LayerSection.module.css:9-15
  ── 8px ──
[align]   (usually :empty → display:none)
  ── 8px ──
[measures] W/H · X/Y · rotation, groups 8px apart, headerless, no divider      MeasuresSection.module.css:16-22
  ── 8px + first hairline in the panel ──
[layout]  first real <Section> (border-top hairline)                          Section.module.css:10-13
```

**Root cause: the proximity hierarchy is flat, and at the props→Layer boundary it is inverted.**

| Boundary | Studio today | Penpot (source) |
|---|---|---|
| Between two prop rows in a props list | **8px** (`.sectionBody` gap = `--inspector-group-gap`, `Section.module.css:206`; `ComponentSection.module.css:160`) | **4px** — `.variant-property-list { gap: var(--sp-xs) }` `menus/component.scss:620-624` |
| Props list → the next section | **8px**, no line, no header (Layer is headerless) | **16px** — `.component-content { padding-block: sp-xs sp-s }` (`component.scss:497-503`) + `.element-options { gap: sp-s }` (`sidebar/options.scss:27-31`) |
| Between any two sections | **8px** (`StyleSurface.module.css:66`) | **16px** — every menu ends `margin-block-end: var(--sp-s)` (`menus/layer.scss:20`, `menus/measures.scss:19`) + the 8px flex gap. Studio's own measurement agrees: "W/H row y=180 (**Δ16** from the row above's bottom)" (`02-measurements.md` → Row rhythm) |
| Rows inside one section | **8px** (`TextSection.module.css:15`, `MeasuresSection.module.css:19`) | **4px** — `menus/text.scss:27`, `menus/measures.scss:18` |

So a prop row is exactly as far from its sibling prop as it is from the unrelated opacity row
below it, and nothing (no line, no title) marks the change. That is the "cramped / not
segregated" feel. Note the comment at `StyleSurface.module.css:48-54` and `globals.css:262-270`
claims "8px is Figma's and Penpot's measured section gap" — that contradicts the baseline's own
Δ16 measurement and Penpot's scss; it conflated the flex `gap` (8) with the full boundary
(`margin-block-end` 8 + gap 8).

---

## 1. Area 1 — Design pane findings

Budget note for every spacing change: `src/__tests__/inspector/measurement.test.ts:193,428,489,501`
and `tests/e2e/inspector-height.e2e.ts` (+ `05-section-heights.json`) freeze the 8px gap and the
612/152px sums. Any PR below must update those gates in the same change (per CLAUDE.md
"architecture tests are first-class"). A budget ledger is in §1.9.

### 1.1 Spacing / segregation (the owner's ask)

**UX-1 · P0 · Give the props block a real boundary (hairline + header + bottom padding)** · S · panel-designer
- `ModuleBlock.module.css:13-19` `.header { padding: var(--inspector-space-2xs) var(--inspector-pad-x) }`
  → add `min-height: var(--inspector-header-h)` (32px, same as every `<Section>` header,
  `Section.module.css:36`; Penpot `title_bar.scss:10-19` 32px).
- `ModuleBlock.module.css:21-26` `.title` `--text-2xs / 700 / uppercase / --text-subtle`
  → `font-size: var(--text-xs); font-weight: 700; color: var(--text); text-transform: none` — the
  exact `.sectionTitle` recipe (`Section.module.css:118-126`). Today the selected element's own
  identity header is the *weakest* header in the panel (≈10px, subtle, uppercase) while "Stroke"
  gets 11px bright bold — a hierarchy inversion.
- `ModuleBlock.module.css:51-53` `.body { padding-inline: var(--inspector-pad-x) }`
  → `padding: 0 var(--inspector-pad-x) var(--inspector-space-m)` (Penpot `component-content`
  `padding-block-end: sp-s` = 8px).
- `StyleSurface.tsx:149` module wrapper `<div data-section-id="module">` → give it a class
  `styles.moduleBlock { border-bottom: 1px solid var(--inspector-divider) }` in
  `StyleSurface.module.css`. Result: props → [8px pad] → hairline → [gap] → Layer row
  = **≥17px + a line** (vs 8px, no line today).
- Better long-term (same PR if cheap): render ModuleBlock *through* `<Section forceOpen flush
  title={definition.name} icon={definition.icon} actions={foldToggle}>` so it inherits header,
  hairline and typography instead of re-implementing them (the ModuleBlock file header already
  admits it is a "hand-rolled mini-section"). Then the divider sits on top of the Module block
  and a matching hairline must be added *above Layer* instead:
  `.surfaceContent > [data-section-id='module'] + [data-section-id='layer'] { border-top: 1px solid var(--inspector-divider); padding-top: var(--inspector-space-2xs) }`.
- Coverage: none. panel-41 (`STATE.md:5299`) shrank this block but did not separate it.

**UX-2 · P0 · Between-section gap 8 → 12 (one named token)** · S · panel-designer
- `StyleSurface.module.css:66` `gap: var(--inspector-space-m)` →
  `gap: var(--inspector-section-gap)`; add to `globals.css` (inspector block, ~line 245):
  `--inspector-section-gap: 12px;` with a comment citing Penpot's 16px
  (`layer.scss:20` + `options.scss:29`) and why Studio takes 12 (900px budget).
  12 = today's `--inspector-space-xl` value, but a *named* role token is what lets the height
  gate read it (`measurement.test.ts:428` `BETWEEN_SECTION_GAP`).
- Rewrite the false claim in `globals.css:262-270` and `StyleSurface.module.css:48-54`.
- Cost: +4px × 10 gaps = **+40px** on F2. Paid for by UX-3/UX-5/UX-6 (see §1.9).
- Coverage: contradicts panel-39's 12→8 change; needs owner acknowledgement that segregation
  beats the last 40px (the owner has now asked for exactly that).

**UX-3 · P1 · Tighten *within*-group rows to Penpot's 4px** · S · panel-designer
- Props lists: `Section.module.css:206` `.sectionBody { gap: var(--inspector-group-gap) }`
  is shared with non-inspector panels, so do NOT change it globally. Instead
  `ModuleBlock.module.css:51` `.body` → add `gap: var(--inspector-space-2xs)` (override, same
  specificity, composed after `sectionStyles.sectionBody` via `cn`), and
  `ComponentSection.module.css:160` `.propsList gap: var(--inspector-space-m)` → `var(--inspector-space-2xs)`.
  Penpot: `component.scss:623` 4px. Caveat: a `stacked`/`caption` row (textarea, image) keeps its
  own internal caption gap; 4px applies between rows only.
- `TextSection.module.css:15` `.section gap: var(--inspector-group-gap)` → `var(--inspector-space-2xs)`
  (Penpot `text.scss:27`). −12px on F2.
- `MeasuresSection.module.css:19` `.measures gap: var(--inspector-space-m)` → `var(--inspector-space-2xs)`
  (Penpot `measures.scss:18`; baseline Δ4 for W/H↔X/Y and X/Y↔rotation). −8px.
- Coverage: panel-29 (`STATE.md:1104`) established "4 within / 8 between"; this moves the
  *measured* pairs onto the 4 step it already defined.

**UX-4 · P1 · ComponentSection (studio.instance props): one title, no band, Penpot rhythm** · M · panel-designer
- `ComponentSection.tsx:230` renders `<Section title="Component">` **and then** a second title
  strip (`:232-240`, `.header` with `--bg-surface-3` band + `border-bottom: var(--border)`,
  `ComponentSection.module.css:17-24`) **and** an actions row with its own border (`:56-61`).
  Three stacked bars, two full-strength `--border` lines (not `--inspector-divider`), a filled band
  whose text sits flush to the band's left edge (padding-inline 0). Violates the Section
  doctrine "hairline and nothing else" (`Section.module.css:3-9`).
- Proposed: `<Section title={componentName} icon={BoxStackSolidIcon} meta={source==='package'?'Package':'Local'} forceOpen flush actions={<Detach/><Swap/> as ghost icon Buttons}>`;
  delete `.header`, `.actionsRow` band/borders; `.propsList` → `gap: var(--inspector-space-2xs);
  margin-top: var(--inspector-space-2xs); padding-bottom: var(--inspector-space-m)`
  (Penpot `.component-title`/`.component-title-actions` `component.scss:447-495`, `.component-content`
  `:497-503`). Saves ≈66px per instance selection AND removes the double title.
- `ComponentSection.module.css:138-144` `.noParams { padding: var(--space-4xl) 0; color: var(--text-disabled) }`
  → one 32px row, `color: var(--text-subtle)`, `padding-block: var(--inspector-space-2xs)` — fluid
  `--space-4xl` inside the frozen inspector, and 2.7:1 contrast (see UX-15).
- Coverage: none (panel-29 fixed its inset only).

**UX-5 · P1 · Merge Shadow + Blur into "Effects"** · M · panel-designer
- Already named: `05-section-heights.md` "What is left", `STUDIO-FIGMA-FEEL-PLAN.md` §9 open item,
  WS-6.1 diagram. −41px on every selection; this is what pays for UX-2.
- Penpot keeps them separate (`frame.cljs:161-162`); Figma merges. Owner goal is Figma — merge.

**UX-6 · P2 · ClassPicker fade dims the Module header at rest** · S · panel-designer
- `PropertiesPanel.module.css:111-119` `::after` 16px gradient hangs over the top of the scroll
  area permanently; with `.surface` padding-top 8 + module header padding 4, the first title
  (≈y 12px) sits inside the fade even when nothing is scrolled.
  Proposed: show it only when scrolled — `StyleSurface` sets `data-scrolled` on scroll>0 (one
  passive listener) and the rule becomes `.headerClassPicker[data-scrolled='true']::after`.
  Or drop to 8px. Coverage: none.

### 1.2 Section order / defaults

**UX-7 · P1 · Component section is mounted AFTER Export** · S · panel-designer
- `inspector/sections/index.ts:173` `order: 11` (Export is 10). Penpot frame order:
  layer → measures → **component** → layout → … → exports (`shapes/frame.cljs:101-168`); Figma puts
  instance props directly under the frame/position block; even Studio's own WS-6.1 diagram puts it
  above Export. Proposed: `order: 2.5` (after `measures`), or renumber. An instance's props are
  the most-edited thing on an instance; today they are below six collapsed headers.
- Coverage: `STUDIO-FIGMA-FEEL-PLAN.md` P9 says "the section order already matches" — false for
  this entry.

**UX-8 · P2 · Collapsed-with-content sections hide their chevron at rest** · S · panel-designer
- `Section.module.css:95-102` chevron `opacity: 0` until hover/focus. A collapsed Layout (has a body,
  shows "+") and an empty Stroke (no body, shows "+") look identical at rest. Penpot always shows
  the arrow on collapsable title bars (`components/title_bar.cljs:22-28`). Proposed: keep the icon
  cross-fade for *expanded* sections, but render the chevron at rest (`opacity: 1`, `--text-subtle`)
  when `!expanded && !empty`. Coverage: panel-15 chose hide-at-rest; revisit.

**UX-9 · P2 · Nothing-selected state is a sentence** · M · panel-designer
- `PropertiesPanelBody.tsx:146-149` "Select an element on the canvas to view its properties."
  Figma/Penpot show page/board properties (background, grid, export). Studio already has
  `FrameSizePanel` there; add the board background swatch + "Export board" row so the empty
  panel is useful. Coverage: none.

### 1.3 Label / control alignment

**UX-10 · P1 · Prop label column 68px truncates real prop names** · S · panel-designer
- `globals.css:298` `--inspector-label-w: 68px` → `ControlRow.module.css:14`. At ~11px, 68px fits
  ~10 chars: `fetchPriority`, `placeholder`, `ariaLabel`, `aspectRatio`, any `onSomething`
  ellipsise. `04-token-gaps.md` already flagged 68px as "un-examined, wrong". Penpot's variant prop
  row: name `span 3` of the 8×32px grid = **104px**, value `span 5`
  (`component.scss:658-666`, `sidebar/common/sidebar.scss` grid). Proposed
  `--inspector-label-w: 96px` (panel content width at the 290px default is 266px, so the field keeps
  ~166px). Only consumer is the `--control-label-w` rebind (`PropertiesPanel.module.css:16`), i.e.
  module/component prop rows — exactly the rows with long names.
- Also `ControlRow.module.css:15,28,71` use fluid `--space-3xs/-xs/-s` inside the frozen inspector →
  `--inspector-space-2xs`, `--inspector-caption-gap`, `--inspector-space-m`. (ControlRow is shared
  with the data admin; scope the override under `[data-field-skin='inspector']` or rebind tokens
  on `.panel` the way `--control-label-w` already is.)

### 1.4 Field chrome / dark-theme correctness

**UX-11 · P1 · Field hover is DARKER than rest in the dark theme** · S · panel-designer
- `globals.css:311-312` `--inspector-field-bg: #212426; --inspector-field-bg-hover: var(--overlay-10)`;
  `Input.module.css:321-325` replaces (not layers) the background on hover. The docked panel sits on
  `--bg-body: #000000` (`RightSidebar.module.css:14`), so hover renders ≈`#1a1a1a` — darker and
  lower-contrast than the rest state `#212426`. Hover recedes instead of lifting.
  Proposed: `--inspector-field-bg-hover: #2a2e31` (dark) / light-theme value ≈`#e9ebef` in the
  `:root[data-theme=light]` block near `globals.css:768`. Penpot hover lifts to
  `--color-background-quaternary`.

**UX-12 · P2 · Literal radii / sizes in inspector modules** · S · panel-designer
- `StyleSurface.module.css:192` `border-radius: 12px` → `var(--panel-radius)`; `:234` `999px` →
  `var(--input-radius)`; `controls.module.css:123-125` `left: 5px; border-radius: 8px` →
  `var(--inspector-space-xs)`, `var(--inspector-field-radius)`; `PropertyControlChrome.module.css:45,56,89,227`
  `10px/8px/6px/6px` → `--inspector-field-radius`/`--radius`; `:263` `min-height: 30px` literal.
  (That file's header comment says "LayoutSection" — misnamed/mis-documented; rename or fix header.)

**UX-13 · P2 · Dead tokens** · S · panel-designer
- `globals.css:322-327` `--inspector-accent-dark`, `--inspector-accent-light`,
  `--inspector-section-label-color` (+ light override `:769`) have **0** `var()` consumers
  (grep). Studio's section titles follow Figma (bright bold), not Penpot's muted uppercase — delete
  the three rather than apply them.

### 1.5 Mixed values (multi-select)

**UX-14 · P1 · ComponentSection lies under multi-select** · S · panel-designer (+ store-engineer if fan-out wanted)
- `index.ts:173` `appliesTo: m.selectedNode?.moduleId === 'studio.instance'`; under multi-select
  `selectedNode` is the anchor (`selectionModel.ts:51,335`). `ComponentSection.tsx:112-117` then
  renders the anchor's call-site values and writes `updateCallSiteProp(nodeId, …)` for the anchor
  only; Detach/Swap act on the anchor only. `StyleSurface.tsx:133-140` explicitly refuses to mount
  the Module block for a multi-selection for this exact reason — the Component section escaped it.
  Proposed now: `appliesTo: (m) => !m.isMultiSelect && …`. Later: N-instance Mixed rows when every
  selected node is the same component (Figma behaviour).
- Other Mixed gaps: `InteractionSection.tsx`, `CustomPropertiesSection.tsx`, `ExportSection.tsx`,
  `AlignSection.tsx` carry no `mixed` handling (grep); Interaction/Custom props are in More, lower
  priority. Layer hidden/locked fan-out is tracked (`STUDIO-FIGMA-FEEL-PLAN.md` §9, panel-40).

### 1.6 Keyboard in inputs / scrubbing / units

- **Good:** one nudge ladder (±1 / Shift ±10 / Alt ±0.1) for keys *and* scrub
  (`numericNudge.ts`, `ScrubInput`), Enter commits + keeps focus + reselects
  (`ScrubInput.tsx:256-264`, `TokenAwareInput.tsx:391-398`), Escape reverts (`:266-273`, `:400-406`),
  inline arithmetic. Matches Figma (Penpot does not revert on Esc — Figma does; keep Studio's).

**UX-16 · P2 · Plain-text prop fields: no Escape revert, no Enter-blur** · S · panel-designer
- `TextControl.tsx:93-110` attaches `onKeyDown` only when `numericUnit !== undefined`; a text prop
  (`label`, `alt`, `href`) writes on every keystroke (history is coalesced — `nodeActions.ts:369`)
  and Escape does nothing. Proposed: draft-and-commit like `TokenAwareInput` for all TextControl
  instances (commit on blur/Enter, Esc restores the pre-focus value), which also stops a
  keystroke-per-source-write on shared component props.

- Units: numeric fields keep typed units and bare numbers get the field unit on commit
  (`resolveCommitValue`); there is no Figma-style unit switcher, which is fine for CSS — no action.

### 1.7 Color / typography / layout controls
- Color: `ColorPickerPopover` has eyedropper, "On this page" recents, token binding — at parity.
  Only the swatch-trigger literals (UX-12).
- Typography: F2 text section is 189px (4 rows) — UX-3 brings it to ≈177.
- Layout: align-pad + gap on one row (panel-39/41) — at parity with Figma's auto-layout block.

### 1.8 Contrast (dark theme, computed WCAG)

**UX-15 · P1 · `--text-disabled` used for informative copy (≈2.7:1 on the panel)** · S · panel-designer
- `--text-disabled: #52525b` on `--bg-body #000` ≈ 2.7:1; on `--bg-surface-2` ≈ 1.9:1.
  Used for text the user must read: `ComponentSection.module.css:47` (source badge, on
  `--bg-surface-2`), `:114` (swap empty state), `:140` ("This component takes no props."),
  `ControlRow.module.css:90,103` (unit + **prop description caption**). Proposed:
  `--text-subtle` (#787878 ≈ 4.8:1 on black) for all five; keep `--text-disabled` for disabled
  controls only.
- `--text-subtle` captions on the *floating* panel (`--bg-surface #1b1b1b`) ≈ 3.9:1 — below AA at
  10px. Low priority (docked is default).

### 1.9 Budget ledger (F2 text fixture, today 782 vs 746 room, 36 over)

| Change | Δpx |
|---|---:|
| UX-1 module header 20→32, +8 bottom pad, +1 hairline | +21 |
| UX-2 section gap 8→12 × 10 | +40 |
| UX-3 Text rows 8→4 × 3, Measures groups 8→4 × 2 | −20 |
| UX-5 Shadow+Blur → Effects (header + gap) | −41 |
| **Net** | **0** (F2 stays 36 over, the existing 60px exception still holds) |

F1/F3/F4 have 138/21/143px headroom; F3's 21px must be re-measured after UX-2 (+44 there with 11
gaps) — it will likely need the Effects merge to land in the same PR.

---

## 2. Area 2 — editor chrome

**UX-20 · P1 · Layers tree keyboard focus is invisible** · S · panel-designer
- `ui/Tree/TreeRow.module.css:23` `outline: none`; `:48-51` `:focus-visible` sets
  `--tree-row-focus: var(--overlay-20)` and `:52-54` selected sets `--tree-row-accent` — **neither
  variable is read anywhere** (grep: only the four defining lines). Keyboard users get no focus ring
  in Layers/Selectors. Proposed: `.row:focus-visible { box-shadow: inset 0 0 0 1px var(--overlay-50) }`
  and delete the two dead vars (or actually consume them).

**UX-21 · P1 · Selected layer row looks identical to hovered row** · S · panel-designer
- `TreeRow.module.css:42-46` hover `--overlay-10`; `:52-57` selected `--overlay-10` + text colour.
  Penpot: hover `background-secondary`, selected `background-quaternary`, descendants of the
  selection `background-tertiary` (`sidebar/layer_item.scss:28,40,49-50`). Proposed: selected
  `--overlay-20`, children-of-selected `--overlay-5` band (a `rowInSelection` class the tree already
  can derive), hover stays `--overlay-10`. Achromatic — state by tone, per the colour rules.

**UX-22 · P1 · Context menu has no shortcut hints and misses core verbs** · M · panel-designer (+ store-engineer for missing verbs)
- `panels/DomPanel/LayerNodeContextMenu.tsx:405-553`: Duplicate/Copy/Cut/Paste/Delete/Rename/Hide
  carry no right-aligned shortcut, although the registry has them
  (`spotlight/keybindings.ts:133-169,320-350`, `getKeybindingForCommand` `:576`). Missing entirely
  though bound: **Group / Ungroup** (`:523,532`), **Lock** (`:350`). Missing vs Penpot's menu
  (`workspace/context_menu.cljs`): bring forward/back, add flex layout, copy/paste properties,
  select layer (stack). Proposed: `ContextMenuItem` gains `shortcut?: CommandId` rendering `<Kbd>`
  from `formatShortcut(getKeybindingForCommand(id).shortcut)` (primitive change in
  `src/ui/components/ContextMenu/ContextMenuItem.tsx:21-47` — it cannot import admin, so pass the
  formatted string, `shortcut?: string`). Penpot styling ref: `context_menu.scss:54-67`.

**UX-23 · P1 · Tooltips have no shortcut slot; hints are ad-hoc strings** · M · panel-designer
- `ui/components/Tooltip/Tooltip.tsx:46-61` has no `shortcut`; call sites concatenate
  (`ShortcutsHelpButton.tsx:35` "(?)", `ZoomControls.tsx:140,239` "(−)/(+)") or omit
  (`CanvasNotch.tsx:456` "Add Text" — `T` exists at `keybindings.ts:369-371`; `SelectionToolbar.tsx:124,136`
  Duplicate/Delete without Ctrl+D / Del). Proposed: `Tooltip`/`Button` `shortcut?: string` rendered as
  a dim `<Kbd>` after the label (Figma "Text  T").

**UX-24 · P1 · Lazy panels flash blank (`Suspense fallback={null}`)** · S · panel-designer
- `ExplorerPanel.tsx:37` (Layers — the most-opened panel), `LeftSidebar.tsx:173` (Content),
  `:245` (Agent), `LazyStudioCanvasChrome.tsx:26`, `CanvasTransformLayer.tsx:82`. First open shows an
  empty panel for the chunk-load time. `Skeleton` exists (`src/ui/components/Skeleton`) and
  `CodeEditorPanel.tsx:224` already does it right. Proposed: a `TreeSkeleton` (8 × 28px rows) for
  Explorer, a message-list skeleton for Agent. Canvas chrome `null` is correct (overlay).

**UX-25 · P2 · Notice stack has no inset and sits outside the scroll** · S · panel-designer (verify in browser)
- `SharedComponentNotice.module.css:3-11` (shared by `SourceConstraintNotice.tsx:157`) and
  `SlotFillNotice.module.css:9-11` set padding/radius but no `margin`; mounted directly in
  `.nodeArea` (`PropertiesPanelBody.tsx:218-241`) with no `--inspector-pad-x` ancestor, so a
  rounded tinted card may run edge-to-edge while ClassPicker below is inset 12px. Also all four
  notices are *chrome* above the scroll container — each one comes straight out of the 746px room.
  Proposed: `margin: var(--inspector-space-m) var(--inspector-pad-x) 0` and consider moving them
  inside `.surfaceContent` as the first grid item.
- `color-mix(in srgb, var(--info-text) 12%, transparent)` is repeated in 2 modules → promote to a
  `--info-10` token beside `--warning-10` (`globals.css:165`).

**UX-26 · P2 · Section toggle focus uses the UA outline** · S · panel-designer
- `Section.module.css:40-60` `.sectionToggle` (bare `<button>`) has no `:focus-visible` style;
  browsers draw their default ring, inconsistent with the inspector's `--overlay-50` field focus.
  Add `.sectionToggle:focus-visible { outline: 1px solid var(--overlay-50); outline-offset: -1px }`.

**UX-27 · P2 · Fluid `--space-*` leaks into frozen inspector geometry** · S · panel-designer
- 16 hits: `ComponentSection.module.css:139`, `ComponentRefView.module.css:45,55`,
  `StyleSurface.module.css:166`, `StyleRuleComposer.module.css:8`, `controls.module.css:77,135`,
  `ControlRow.module.css:15,28,71`, … → `--inspector-space-*`. (`--space-px` hairlines are fine.)

---

## 3. What is already good (don't churn)
- One numeric engine with Figma keyboard/scrub semantics; Enter keeps focus; Esc reverts.
- Law 1 (empty section = header + `+`), Law 3 (unset props folded behind "N more").
- Section = failure domain (`PanelBoundary`), More disclosure, 900px gate with measured artefact.
- `CodeValueControl` read-only summaries + remedy popovers — the "never lie" rule holds everywhere
  except UX-14.

## 4. Suggested PR slicing
1. `fix(inspector): separate the props block from the style sections` — UX-1, UX-2, UX-3, UX-5-free
   ledger check, UX-6; gates: measurement.test.ts + inspector-height e2e numbers.
2. `feat(inspector): Effects section (shadow + blur)` — UX-5 (existing open item).
3. `fix(inspector): component section — order, single title, multi-select honesty` — UX-4, UX-7, UX-14.
4. `fix(inspector): field hover, label column, contrast, literals` — UX-10, UX-11, UX-12, UX-13, UX-15, UX-27.
5. `feat(chrome): shortcut hints in tooltips and context menu` — UX-22, UX-23.
6. `fix(layers): visible focus, distinct selection tone, skeleton on first open` — UX-20, UX-21, UX-24.

## 5. Human dogfood targets (per standing-02)
- Select a `<p>` text node (F2): props block should end in a hairline with clear air before the
  opacity row; section gaps visibly larger than row gaps.
- Select a local component instance: props directly under Measures, one "Button · Local" header
  with Detach/Swap icons, 4px between prop rows.
- Shift-select two instances of the same component: Component section must not show one
  instance's values as if they were the selection's.
- Hover an inspector field in the dark theme: it must get lighter, not darker.
- Tab into the Layers tree: a ring must be visible on the focused row.
