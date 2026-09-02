# Audit: refusal states (panel-designer)

## Refusal taxonomy (complete)

| # | Refusal reason | Computed at | User sees today | Accurate? | Way forward today |
|---|---|---|---|---|---|
| 1 | Prop backed by a resolved expression (`codeProps` entry) | `isPropWritableToSource` — `src/core/page-tree/sourceWritability.ts:56-59` | `CodeValueControl` disabled row, hint = `propLockReason` (node's `lockReason` or `'set in code'`) — `PropertyControlRenderer.tsx:158-168` | Mostly. Hint is the NODE's structural lockReason, not the prop's own resolution source — see Finding R2 | None. No "jump to source" / no binding explanation of *which* variable |
| 2 | Prop holds a structured (array/object) value | `isStructuredValue` — `PropertyControlRenderer.tsx:116-118` | Same `CodeValueControl`, hint defaults to `'set in code'` (no `sourceLockReason` passed) | Accurate (shape only, "2 items · set in code") | None |
| 3 | `.map` row — no writable source location at all | `hasWritableSourceLocation` false → `codeProps` effectively covers everything except resolved text | `SourceConstraintNotice` variant `list-row` — `PropertiesPanel/SourceConstraintNotice.tsx:107,124-129` | Accurate | "edit the array it maps over" is *said* (structural refusal message) but not *actionable* — no jump-to-source, no jump-to-array |
| 4 | Node structurally locked but has a source location (ternary/`&&`/spread/svg) | `node.lockReason` present + `hasWritableSourceLocation` true | `SourceConstraintNotice` variant `structure-locked` | Accurate ("can't be moved/deleted... but values are editable") | None needed — values remain editable, which is the point |
| 5 | Inline-style property resolved from expression (`style:<prop>` in `codeProps`) | `isStyleWritableToSource`/`isStylePatchWritableToSource` — `sourceWritability.ts:62-64,81-85`, consulted only in `nodeActions.ts:459` (store guard) | **NOTHING.** `InlineStyleComposer.tsx` never reads `codeProps`/`isStyleWritableToSource`; the field is a normal editable row that silently no-ops on write | **False documentation** — see R1 (severity: high) | None — this is the worst case: no advance disable, no toast, no revert explanation |
| 6 | Whole node has no writable source location for inline styles at all (`.map` row) | `hasWritableSourceLocation` false → `PropertiesPanelBody.tsx:245-247` passes `sourceLockReason` | `StyleSurface.tsx:213-219` hides the inline composer entirely, shows "assign a class instead" | Accurate | Class assignment offered as the escape hatch — good |
| 7 | Structural: `.map` row (`list-row`) | `refusePlacement` — `sourceStructure.ts:233-238` | Toast on attempted move/delete/insert (`toastStructuralRefusal`, `structuralSourceEdits.ts:264-278`) — reactive, after gesture | Accurate | "edit the array it maps over" — no jump-to-source |
| 8 | Structural: inlined/shared component (`shared-component`) | `refusePlacement` — `sourceStructure.ts:239-244` | Toast, same path | Accurate, states blast radius indirectly ("every instance") | None from the refusal toast itself — but `SharedComponentNotice`/`InstanceCallSiteView`'s Detach/Swap/Duplicate *do* exist as a real escape hatch, just not linked from the refusal toast |
| 9 | Structural: Next `layout`/`template` chrome (`route-chrome`) | `refusePlacement` — `sourceStructure.ts:245-249` | Toast | Accurate | None (correctly, since editing chrome affects every route) |
| 10 | Structural: code-placed (parser recorded a structural lock — spread/dynamic child) | `refusePlacement` — `sourceStructure.ts:251-256` | Toast, quoting `node.lockReason` verbatim | Accurate | None |
| 11 | Structural: `reparent` | `refuseStructuralEdit` case `'reparent'` — `sourceStructure.ts:145-150` | Toast ("Move refused") | Accurate | "Move it in the file instead" — no jump-to-source |
| 12 | Structural: `duplicate` | `refuseStructuralEdit` case `'duplicate'` — `sourceStructure.ts:163-168` | Toast ("Duplicate refused") | Accurate, but blanket — **except** `studio.instance` nodes, where `extractInstanceCopy` (`InstanceCallSiteView.tsx:132-151`) *does* implement a real duplicate-as-new-file. That escape hatch is not surfaced from the generic duplicate-refusal toast at all — it only appears after a **detach** refusal, gated by `EXTRACT_OFFER_REASONS` | Ordinary elements: none. Instances: real hatch exists but is not discoverable from the duplicate gesture |
| 13 | Structural: `wrap` | `refuseStructuralEdit` case `'wrap'` — `sourceStructure.ts:169-174` | Toast ("Wrap refused") | Accurate | None |
| 14 | Structural: `multi-select` reorder | `refuseStructuralEdit` — `sourceStructure.ts:185-190` | Toast | Accurate | "Drag them one by one" — actionable as stated |
| 15 | Structural: `no-sibling-anchor` | `refuseStructuralEdit` — `sourceStructure.ts:201-207,208-213` | Toast | Accurate | None |
| 16 | Structural: `cross-file` | `refuseStructuralEdit` — `sourceStructure.ts:217-222` | Toast | Accurate | None |
| 17 | Structural: `insert` into a `.map`/inlined/chrome/code-placed container | `refuseStructuralEdit` case `'insert'` via `refusePlacement` — `sourceStructure.ts:151-162,192-198` | Toast (`STRUCTURAL_REFUSAL_TITLE.insert` = "Cannot add this to imported code") | Accurate | "Select the container you want it in" for the multi-root page case (`structuralSourceEdits.ts:216-221`) |
| 18 | Insert: minted/canvas-only node dragged into a source-backed parent | `refuseMintedNodeInsert` — `sourceStructure.ts:284-294`, `refuseCanvasOnlyNodeIntoSource` — `structuralSourceEdits.ts:294-305` | Toast, points at the picker | Accurate and actionable | "Add the component from the picker instead" — real, working hatch |
| 19 | Detach: `not-a-component` / `unresolvable` / `package-component` | `detachComponent.ts` (`DetachRefusalReason`) | `InstanceCallSiteView.tsx` refusal card (`role="alert"`), inline, persists until dismissed by next action | Accurate | None — correctly, since Extract is offered only when it would actually work (`EXTRACT_OFFER_REASONS` excludes these three) |
| 20 | Detach: `uses-hooks` / `maps-over-props` / `unsupported-params` / `no-renderable-jsx` | same | Same refusal card | Accurate | **"Duplicate it as a new file and edit that instead?" button** — real, working hatch (`handleExtract`) |
| 21 | Detach: `name-collision` | same | Same refusal card | Accurate | None (rename in file) |
| 22 | Swap refusal (component shape mismatch etc.) | `swapComponentInstance.ts` (not read in depth) | Toast (`InstanceCallSiteView.tsx:187`) | Assumed accurate | None beyond retrying with a different candidate |
| 23 | Save-time: prop/text edit reached no writable source location (`skipped` with no `refusals` entry) | Server-computed, surfaced via `unexplainedSkips` — `fsCodemodAdapter.ts:516-533` | Toast, **after the fact**, batched count only ("3 edits had no writable location") — no per-node identification | Accurate but **imprecise**: doesn't say *which* 3 nodes, user must guess | "edit it where the value is defined" — generic, no jump-to-source |
| 24 | Save-time: detach/swap/css edit refused server-side | Server `StudioEditRefusal` | Toast, `REFUSAL_TITLES` map — `fsCodemodAdapter.ts:500-514` | Accurate, carries real message | Depends on message content |
| 25 | CSS class has no hand-editable source file (generated utility / compiled) | `classifyStylesheetEditability` via `collectStyleRuleEdits` | Toast "Style not saved to source" — `fsCodemodAdapter.ts:460-470` | Accurate | "Style the element instead" (inline) — real, stated hatch |
| 26 | Breakpoint/condition override with no CSS writeback support | same area | Toast "Breakpoint override not saved to source" — `fsCodemodAdapter.ts:472-481` | Accurate | None — stays canvas-only, will be lost on reload (told, not fixed) |
| 27 | Inline text (double-click) on a code-valued text prop | `isPropWritableToSource(node, spec.prop)` — `inlineEditSlice.ts:155-163` | Toast **before** any edit starts (blocks entering edit mode) | Accurate, timing = before | "Edit it in the source file — the Properties panel shows where it comes from" — directionally right but not a deep link |
| 28 | `htmlAttributes` bag locked as a whole | `isPropWritableToSource(selectedNode, 'htmlAttributes')` — `PropertiesPanelBody.tsx:257-260` | Whole Attributes tab disabled (`HtmlAttributesPanel readOnly`) | Accurate (it's genuinely one JSX prop/object) but coarse — a partially-literal `htmlAttributes` object still locks the whole tab if the object itself is an expression | Correct behavior per prop granularity — not a bug, just coarse by design |
| 29 | Branch not shown (`branchAlternatives`) | `parser-06` selection, `parsedPageToSitePage.ts:233-234` | `BranchChoiceNotice` — view-only text naming alternates + `file:line` | Accurate | **No switcher** — explicitly out of scope per the file's own doc comment. See R6 |
| 30 | Detach/swap/duplicate on a `package` source instance | `source === 'package'` check | Button `disabled`, `tooltip` explains — `InstanceCallSiteView.tsx:228-229` | Accurate, before-interaction | None (package components aren't detachable yet) |

---

## Findings

### R1 — Inline-style per-property refusal has **no UI at all**; a doc comment claims otherwise
**Severity:** High
**Evidence:**
- `src/admin/pages/site/panels/PropertiesPanel/SourceConstraintNotice.tsx:70-76` states: *"Inline-style entries (`style:color`) are refused per-property by the style controls themselves, which say so where the user is already looking."*
- `src/admin/pages/site/panels/PropertiesPanel/InlineStyleComposer.tsx` (full file) never imports `isStyleWritableToSource`, `styleValueKey`, or `codeProps`. Every property row is rendered unconditionally editable.
- The only enforcement is the store guard: `src/admin/pages/site/store/slices/site/nodeActions.ts:452-459` — `if (!isStylePatchWritableToSource(node, patch)) return false`. This returns *before* `node.inlineStyles` is updated, and no toast is raised (unlike `updateNodeProps`'s twin, whose "silent, panel tells the user" comment is *false* for styles specifically — the panel tells the user nothing).
**Root cause:** `styleValueKey`-namespaced `codeProps` entries (e.g. `style:width` for a template-literal width) are produced by the parser (`parsedPageToSitePage.ts`) and consulted by the store guard, but the property-level UI (`InlineStyleComposer` → `StyleSectionsEditor` → `ClassPropertyRow`) was never wired to ask the question per row. `StyleSurface`'s `sourceLockReason` prop only covers the *whole-node* `.map`-row case (`hasWritableSourceLocation` false), not per-property `codeProps`.
**User-visible symptom:** user opens e.g. a hero element whose `style={{ width: \`${pct}%\` }}` is on an ordinary (non-`.map`) node, types a new width in the panel, the input either snaps back or silently fails to persist — with zero explanation. This is functionally identical to the exact bug class trap #4/#5 exist to prevent, just unaddressed for the style surface.
**Proposed fix:** Thread `codeProps` (filtered/mapped through `styleValueKey`) into `InlineStyleComposer` → `StyleSectionsEditor` → `ClassPropertyRow`, disable the specific row, and render the same lock-glyph-with-hover affordance proposed in the REFUSAL UX SPEC below. Also correct or delete the now-false claim in `SourceConstraintNotice.tsx`'s doc comment.
**Effort:** M (touches 3-4 files: `StyleSurface.tsx`, `InlineStyleComposer.tsx`, `StyleSectionsEditor.tsx`, `ClassPropertyRow.tsx`; no new engine logic — `isStyleWritableToSource` already exists).

### R2 — The reason shown for a code-valued prop is the NODE's structural lock, not the PROP's own resolution
**Severity:** Medium
**Evidence:**
- `src/admin/pages/site/panels/PropertiesPanel/propLockReason.ts:29-32`: `return node.lockReason ?? 'set in code'`. Its own doc comment (lines 10-16) admits: *"gets the generic fallback rather than the node's first resolution, which may well have been a different prop's (`ParsedNode.resolution` keeps only the first)."*
- `src/core/page-parser/nodeResolution.ts:161-171` (`withResolution`): `const primary = resolutions[0]` — only the first resolved value's `source`/`note` survives onto the node at all. A node with two code-valued props (e.g. `title={c.heading}` and `subtitle={c.tagline}`) only ever shows `heading`'s resolution as the node-level explanation; `subtitle`'s `CodeValueControl` hint falls back to the generic `'set in code'` even though the engine *did* compute a specific source string for it and simply discarded it.
**Root cause:** `Resolution` is stored per-node (`ParsedNode.resolution`, singular) rather than per-prop. The per-prop fact that *does* survive (`codeProps: string[]`) is a bare name with no attached "came from `c.tagline`" string.
**Proposed fix:** Either (a) make `ParsedNode.resolution` a `Record<string, Resolution>` keyed by prop name (breaking change to `parsedPageToSitePage.ts`'s shape, acceptable per this repo's no-back-compat stance), or (b) at minimum thread the specific resolution source down to `CodeValueControl`'s `hint` per prop instead of `propLockReason`'s single fallback string. Option (a) is the honest fix — this is exactly the kind of information loss the REFUSAL UX SPEC's typed `EditConstraint` should make impossible by construction (one `EditConstraint` per prop, not one shared per node).
**Effort:** M — parser-side type change (`nodeResolution.ts`, `types.ts`, `parsePageFile.ts` callers) + `parsedPageToSitePage.ts` + panel plumbing. No AST/writeback change needed (read-only surfacing).

### R3 — `unexplainedSkips` toast never names which nodes were skipped
**Severity:** Medium
**Evidence:** `src/admin/pages/site/studio/fsCodemodAdapter.ts:516-533` — toast body is `"${unexplainedSkips} edit(s) had no writable location in the code..."`, no node id, no selection jump.
**Root cause:** `StudioSaveResponseSchema` (`studioSaveRequests.ts:34-69`) carries `refusals` (with `nodeId`) only for `detach`/`swap`/`css` kinds — the ordinary `prop`/`text`/`style` skip path just increments a `skipped` counter server-side with no per-node reason returned. This is a real asymmetry: three edit kinds get a rich, addressable refusal; the most common kinds (prop/text/style) get an aggregate count.
**Root cause detail:** the server's `applyStudioEdit` (per `studio-pipeline.md`) presumably has the specific node/reason at write time but the response schema for the plain-edit path was never extended to carry it, unlike the newer detach/swap/css path.
**Proposed fix:** Extend the server's per-edit refusal reporting to prop/text/style edits too (same `{ nodeId, kind, reason, message }` shape already defined for detach/swap/css), and have the client either (a) select/highlight the affected node(s) on the canvas, or (b) list them in the toast body. This is the single highest-leverage fix for "the tool feels broken" because it is the most common refusal path (per the `studio-pipeline.md` corpus stats: props/text dominate edits) and currently gives the least specific feedback.
**Effort:** M/L — needs a server-side change (`server/handlers/studio.ts` / wherever `applyStudioEdit` is dispatched) plus client wiring. Depends on the server-engineer's area.

### R4 — Structural refusal toasts are reactive-only; no control is disabled in advance for drag/delete/duplicate/wrap
**Severity:** Medium
**Evidence:** `toastStructuralRefusal` (`structuralSourceEdits.ts:273-278`) fires only after the user has already dragged a layer row, pressed Delete, or clicked Duplicate — there is no `refuseStructuralEdit`-derived `disabled` state feeding into the layers tree, the context menu, or the Delete keybinding. Compare to prop editing (R2/finding above), which mostly disables *before* interaction.
**Root cause:** `refuseStructuralEdit` is pure and cheap to call, but nothing in the layers-tree row renderer or context-menu builder pre-computes it per node to grey out "Delete"/"Duplicate"/"Wrap" menu items or show a drag-not-allowed cursor.
**Proposed fix:** Precompute `refuseStructuralEdit({ kind: 'delete', node })` / `'duplicate'` / `'wrap'` once per selected node (cheap — pure function on id + lockReason) and use it to grey the context-menu entries and change the drag cursor, with the existing toast kept as the reorder-specific case (reorder's refusal genuinely depends on the drop target, which isn't known until drop). This is a Figma-grade parity item: Figma disables "duplicate" for a locked component instance rather than letting you try.
**Effort:** M — context menu + layers tree + Delete-key handler, three call sites, no new engine logic.

### R5 — Duplicate's real escape hatch (extract-as-new-file) is invisible from the generic Duplicate refusal
**Severity:** Low/Medium
**Evidence:** `refuseStructuralEdit` case `'duplicate'` (`sourceStructure.ts:163-168`) returns a flat "cannot duplicate... copy the JSX in the file instead" message for **every** node, including `studio.instance` nodes — even though `extractInstanceCopy` (`InstanceCallSiteView.tsx:132-151`, wired to `extractInstanceCopy` in `studioSaveRequests.ts`) is a real, working duplicate-as-new-component-file operation. It is currently reachable only via the Detach button's failure state (`EXTRACT_OFFER_REASONS`), not via an attempted Duplicate gesture on the canvas/layers tree.
**Root cause:** The generic `duplicate` structural-edit path (`structuralSourceEdits.ts:planSourceCopy`) and the instance-specific extract flow are two independent code paths that never cross-reference each other.
**Proposed fix:** When a canvas/layers-tree Duplicate is attempted on a `studio.instance` node, route through the same offer as Detach's refusal card (or at minimum mention it in the toast body: "This is a component instance — use Duplicate (as new file) in the Properties panel instead").
**Effort:** S — wording/wiring only, in `structuralSourceEdits.ts`'s `planSourceCopy` caller or the toast body construction.

### R6 — `branchAlternatives` is view-only; no switcher exists despite being addressable data
**Severity:** Medium (explicitly flagged as a gap by the code's own author)
**Evidence:** `BranchChoiceNotice.tsx:14-20` doc comment: *"actually swapping which branch renders on the canvas is editor state that would need a store-level 'preview branch' action this pass does not add."* Confirmed no store action exists (grep for `branchAlternatives` found only read sites).
**Root cause:** `PageNode.branchAlternatives` carries `{ label, loc: { file, line, col } }[]` — everything a switcher needs except a store slot to hold "which branch is currently previewed" and a parse-time mechanism to actually render the alternate branch instead of the parser's chosen one.
**Proposed fix (design, not implementation — flagged for store-engineer/parser-surgeon collaboration):** Add a per-node "preview branch" selection to the editor store (ephemeral, not persisted — this is a *canvas preview* choice, not a document edit), and a re-parse/re-render path that asks the parser to select branch N instead of the default when previewing. `BranchChoiceNotice` becomes a real switcher: each alternative gets a "Preview" action.
**Effort:** L — spans parser (branch selection needs a parameter), store (preview state), and canvas (render the alternate). Cross-cutting; not a panel-designer-only fix. Flag for architect triage.

### R7 — `SourceConstraintNotice` and `SharedComponentNotice`/`BranchChoiceNotice` stack unconditionally at the top of every node inspector, even though most nodes show none of them
**Severity:** Low (UX polish, not a bug)
**Evidence:** `PropertiesPanelBody.tsx:164-187` renders up to three notices back-to-back before the Styles/Attributes switcher. `SourceConstraintNotice` already returns `null` when it has nothing to say (`SourceConstraintNotice.tsx:88`), so an ordinary CMS-authored node shows none of this — good. But on a real imported board, a majority of nodes carry *some* `resolution`/`codeProps` (measured 54% structurally flagged per `nodeResolution.ts`'s comment), so the "values-only" variant (`SourceConstraintNotice` heading "value from ...") fires on the majority case and occupies permanent vertical space above the controls, for a fact that is otherwise fully explained per-field by `CodeValueControl`.
**Root cause:** Design predates the per-field `CodeValueControl` affordance (`SourceConstraintNotice`'s own doc comment traces its own history through `lock-01`). It is likely now partially redundant with the disabled-row-plus-hint pattern once R1 is fixed for styles too.
**Proposed fix:** See REFUSAL UX SPEC below — collapse `SourceConstraintNotice`'s "values-only" (non-structural) variant into per-field affordances entirely (delete the node-level banner for that case), keep only the two truly whole-node facts (`structure-locked`/`list-row`) as a panel-level banner. `SharedComponentNotice` (blast radius) and `BranchChoiceNotice` (alternate states) are legitimately whole-node and should stay as compact banners, but consider a single collapsible "Source info" strip that expands to show all three rather than three separate `role="note"` blocks always full height.
**Effort:** M — mostly deletion/consolidation in `PropertiesPanelBody.tsx` + `SourceConstraintNotice.tsx`, contingent on R1 landing first (styles need the per-field affordance before the node-level notice can be safely narrowed).

### R8 — No jump-to-source affordance anywhere in the refusal surfaces
**Severity:** Medium
**Evidence:** Every refusal message (`SourceConstraintNotice`, structural toasts, `BranchChoiceNotice`) states a `file:line` (`textOrigin`, `branchAlternatives[].loc`, `lockReason` text) but none of it is a clickable/actionable link — it's plain text (`<strong>{textOrigin.rel}</strong> (line {textOrigin.line})` in `SourceConstraintNotice.tsx:139-140`; `({alt.loc.file}:{alt.loc.line})` in `BranchChoiceNotice.tsx:40`).
**Root cause:** No "open in code editor" action exists in this panel family at all (not checked whether Studio has a code-view/CodeMirror surface reachable from here — worth a follow-up scout task, since CLAUDE.md confirms CodeMirror is in the stack for "code-editing UI").
**Proposed fix:** If Studio has any code-panel/CodeMirror surface, wire these `file:line` mentions to open it at that location. If not, this is out of scope for panel-designer alone (needs a code-view surface to jump to) — flag for architect.
**Effort:** S if a code surface exists and just needs a click handler; L if a code surface must be built.

---

## REFUSAL UX SPEC

### 1. One typed shape, engine → UI, no lossy hops

```ts
// src/core/page-tree/editConstraint.ts (new — sibling of sourceWritability.ts / sourceStructure.ts)

/** What kind of thing is being refused. */
type ConstraintScope = 'prop' | 'style' | 'text' | 'node-structure' | 'node-shared' | 'container'

/** A single, nameable reason — union of StructuralRefusalReason plus the value-level ones. */
type ConstraintReason =
  | 'resolved-expression'   // codeProps entry, prop kind
  | 'structured-value'      // array/object, no scalar source form
  | 'list-row'              // .map row — matches StructuralRefusalReason
  | 'shared-component'
  | 'route-chrome'
  | 'code-placed'
  | 'reparent' | 'insert' | 'duplicate' | 'wrap' | 'multi-select' | 'cross-file' | 'no-sibling-anchor'

interface EditConstraintAction {
  label: string                 // "Duplicate as new file", "Edit the array", "Open in code"
  kind: 'extract' | 'jump-to-source' | 'select-container' | 'detach' | 'reword'
  run: () => void | Promise<void>
}

export interface EditConstraint {
  reason: ConstraintReason
  scope: ConstraintScope
  /** The one sentence a person reads. Always concrete — names the file/line/component when known. */
  explanation: string
  /** Where in source this traces to, when there is one — powers "way forward" actions and future jump-to-source (R8). */
  origin?: { rel: string; line: number; col: number }
  /** Zero or more legitimate ways forward. Empty is honest for some reasons (route-chrome, wrap). */
  actions: EditConstraintAction[]
}
```

`isPropWritableToSource`/`isStyleWritableToSource`/`refuseStructuralEdit` keep their existing boolean/refusal-object return shapes for the store guards (cheap, allocation-free hot path) — but each gets a *new* sibling that returns `EditConstraint | null` for UI consumption only (`explainPropConstraint(node, prop)`, `explainStyleConstraint(node, prop)`, `explainStructuralConstraint(...)` wrapping `refuseStructuralEdit`). This keeps the store's per-keystroke guard cheap while giving the panel one real object to render, closing the R2/R3 lossy hops by construction: the resolution source and the specific prop name are captured in `explanation` at the point the fact is known, not re-derived three files later from a fallback string.

### 2. Per-field affordance (the R1/R2 fix, generalized)

Every editable-looking control — prop OR style property — renders a trailing glyph when `EditConstraint` is non-null, replacing the current all-or-nothing swap to `CodeValueControl`:

- **Lock glyph** (`LockSolidIcon`, 12px, achromatic `--editor-text-secondary`) for `scope: 'prop' | 'style' | 'text'` refusals with no action.
- **Link glyph** (a "goes to source" indicator) when `origin` is present — hover shows a tooltip with `explanation` + `rel:line`, click performs `jump-to-source` when available (R8), otherwise just informs.
- Hovering/focusing the glyph shows the full `explanation` in the existing tooltip primitive (no new primitive — reuse whatever `Button`'s `tooltip` prop already renders, or the pattern `InstanceCallSiteView`'s `tooltip="Package components cannot be detached yet"` already uses).
- The control itself stays disabled (current `CodeValueControl` behavior is right for structured/resolved values) — the glyph is the AFFORDANCE, `CodeValueControl`/disabled-input is the CONTROL. This is additive to current behavior, not a replacement: `CodeValueControl` keeps rendering the value; it gains the glyph+tooltip instead of the current bare `· set in code` inline hint text, which becomes the tooltip body instead of permanent inline text (recovers vertical density — this is the WS-6 "Figma-grade" ask).

### 3. Panel-level banner — reserved for genuinely whole-node facts only

Keep exactly three whole-node banners, collapse everything else into per-field glyphs:
1. **Structural** (`node-structure`/`node-shared` scope) — merges today's `SourceConstraintNotice` structural variants + `SharedComponentNotice` into one banner (structure lock OR shared-component OR route-chrome — mutually exclusive per node), because they answer the same question ("can I move/delete this") differently.
2. **Branch alternatives** — `BranchChoiceNotice`, upgraded to a real switcher per R6 (each alternative gets a `select-branch` action, once the store/parser work lands).
3. Nothing else. The current "values-only" `SourceConstraintNotice` variant (R7) is deleted; its information moves entirely into per-field glyphs, which is strictly more precise (it currently shows one prop's resolution as if it were the node's).

### 4. "Way forward" action catalog — audit of existing vs. missing

| Action | Exists? | Where |
|---|---|---|
| Jump to the binding's source | **Missing** (R8) | — |
| Edit the `.map` array instead | Stated in text only, not actionable | `sourceStructure.ts:236` message |
| Detach a shared component instance | **Exists** | `InstanceCallSiteView.tsx` → `detachInstance` |
| Duplicate/extract a component to edit standalone | **Exists**, but only reachable from Detach's failure state (R5) | `InstanceCallSiteView.tsx` → `extractInstanceCopy` |
| Swap a component instance | **Exists** | `InstanceCallSiteView.tsx` → `swapInstance` |
| Add a design-system component via picker (writes import + element) | **Exists** | `refuseMintedNodeInsert` message, `insertJsxElement` |
| Style inline instead of via a locked/generated class | **Exists**, stated in toast | `fsCodemodAdapter.ts:468` |
| Preview an alternate branch | **Missing** (R6) | — |
| Select which top-level container an insert targets (multi-root page) | **Exists**, stated as instruction, no picker UI | `structuralSourceEdits.ts:216-221` |
| Per-node identification of a batched "skipped" save | **Missing** (R3) | — |

### 5. Migration note

This spec is additive: `EditConstraint` wraps the existing pure predicates rather than replacing them, so `nodeActions.ts`'s store guards, `applyTreeOperation`, and the server codemods need zero changes. Only the panel-designer-owned rendering layer (`PropertyControlRenderer`, `CodeValueControl`, `InlineStyleComposer`/`ClassPropertyRow`, `PropertiesPanelBody`) and a small new engine module (`editConstraint.ts`) are in scope for implementation, except where a finding above explicitly calls for server/parser/store changes (R2, R3, R6 — flagged, not panel-designer-only).
