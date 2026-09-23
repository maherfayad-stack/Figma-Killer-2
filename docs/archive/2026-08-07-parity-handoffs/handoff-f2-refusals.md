# F2 — The refusal model — handoff

## Scope (files touched, all under my ownership)

New:
- `src/core/page-tree/editConstraint.ts` — the `EditConstraint` engine (511 lines).
- `src/core/page-tree/__tests__/editConstraint.test.ts` — 37 tests, exhaustive over the union.
- `src/admin/pages/site/panels/PropertiesPanel/jumpToSource.ts` — R8's click handler.
- `src/admin/pages/site/panels/PropertiesPanel/BranchChoiceNotice.module.css` — new CSS for the R6 switcher.
- `src/__tests__/panels/branchChoiceNotice.test.tsx` — 5 tests.

Edited:
- `src/core/page-parser/nodeResolution.ts` — added `ResolutionMap` + `shortenResolutionMap` (R2).
- `src/core/page-parser/jsxAttributeReaders.ts` — `extractProps`/`extractInlineStyles` now also return a `resolutionsByKey: ResolutionMap` alongside the existing `resolutions: Resolution[]` array (additive — the array/`withResolution`/`ParsedNode.resolution` path is byte-for-byte unchanged).
- `src/core/page-parser/parsePageFile.ts` — builds and attaches `ParsedNode.resolvedProps` at all 3 node-construction sites (svg/rawSvg/main), from the same per-key maps.
- `src/core/page-parser/types.ts` — added `ParsedNode.resolvedProps?: Record<string, {source,note?}>`.
- `src/core/studio-sync/parsedPageToSitePage.ts` — propagates `resolvedProps` → `PageNode.resolvedProps`, remapped exactly like `codeProps` (drops `className`, remaps to `callSiteProps:<name>` for `studio.instance`, remaps `'text'` → the module's own text-prop name).
- `src/core/page-tree/pageNode.ts` — `PageNode.resolvedProps` schema field + tolerant parser (`parseResolvedProps`).
- `src/core/page-tree/cloneNode.ts` — deep-copies `resolvedProps` on clone (mirrors `resolution`).
- `src/core/page-tree/index.ts` — barrel exports for `editConstraint.ts`'s public API.
- `src/admin/pages/site/panels/PropertiesPanel/propLockReason.ts` — now consults `node.resolvedProps?.[propKey]` before falling back to `node.lockReason ?? 'set in code'`. **Signature unchanged** (`(node, propKey): string | undefined`) — this function is consumed by two off-limits files (`InPlaceInspector.tsx`, D2/canvas; `InstanceCallSiteView.tsx`, E2.5) that I could not touch, so I fixed R2 at the SOURCE of the string rather than changing the contract.
- `src/admin/pages/site/panels/PropertiesPanel/SourceConstraintNotice.tsx` — R7: deleted the "values-only" variant entirely (used to fire on the majority of a real board's nodes — 149/276 on the eSIM corpus — repeating what `CodeValueControl`/`propLockReason` now say per field). What's left: the structural banner (unchanged reasoning, minus the now-redundant per-prop "N values come from an expression…" prose) and a standalone `textOrigin`-only banner (genuinely whole-node — a writable node has no per-field control to attach this to). R8: `textOrigin`'s `file:line` is now a real button (`jumpToSource`), not text.
- `src/admin/pages/site/panels/PropertiesPanel/PropertiesPanelBody.tsx` — updated the `SourceConstraintNotice` call site to the new prop shape; removed the `!selectedNode.lockReason &&` guard on `BranchChoiceNotice` (it existed only to avoid double-showing a "resolution.note" that no longer exists in the structural banner — a node can legitimately be both structurally locked AND have branch alternatives, and both facts are now independent).
- `src/admin/pages/site/panels/PropertiesPanel/BranchChoiceNotice.tsx` — R6: each alternative is now an expandable row (local `useState`, never written to the store) with a real jump-to-source action. **Does not** swap which branch renders on the canvas — see "R6 — what's deferred" below.
- `src/admin/pages/site/panels/PropertiesPanel/SharedComponentNotice.module.css` — added `.jumpToSourceButton` (shared by `SourceConstraintNotice`).
- `src/admin/pages/site/property-controls/CodeValueControl.tsx` — R1/R2 "per-field design": the permanent inline `· {hint}` text is now a lock glyph (`Button` icon-only + `tooltip`), so the row keeps its width and the WHY is one hover away.
- `src/admin/pages/site/property-controls/controls.module.css` — `.codeValueText`/`.codeValueGlyph` added; `.codeValueHint` **kept** (still used by `SlotControl.tsx`, E2.5-owned, not touched).
- `src/admin/pages/site/panels/DomPanel/LayerNodeContextMenu.tsx` — R4: Duplicate, Wrap (both submenu items), and Delete are pre-disabled via `explainStructuralConstraint`, with the explanation wired as the `Button` `tooltip`. All-or-nothing across the selection, matching `planSourceCopy`/`deleteNodes`'s own semantics. R5: a single `studio.instance`'s Duplicate gets `explainInstanceDuplicateConstraint`'s truer wording instead of the generic "cannot duplicate imported code yet" message.
- `src/__tests__/fixtures/index.ts` — `makeNode` was silently dropping `lockReason`/`codeProps` (explicit field list, no `...overrides` spread) — added those plus `resolvedProps`. Needed for my own tests; also a real, disclosed gap for anyone else testing `refuseStructuralEdit`/`isPropWritableToSource` against a fixture node.
- `src/__tests__/panels/sourceConstraintNotice.test.tsx` — rewritten for the new (narrower) contract.
- `src/__tests__/dom-panel/layerNodeContextMenu.test.tsx` — appended a `describe` block, 5 new tests for R4/R5.

## The full `EditConstraint` union — what's live vs. reserved

```ts
export interface EditConstraint {
  reason: ConstraintReason
  scope: 'prop' | 'style-property' | 'node' | 'gesture'
  explanation: string
  origin?: { rel: string; line: number; col: number }
  actions: EditConstraintAction[]
}
```

| Taxonomy row(s) | `ConstraintReason` | Produced by | Status |
|---|---|---|---|
| 1 | `resolved-expression` | `explainPropConstraint` | **Live** — R2: names the prop's own `resolvedProps` source |
| 2 | `structured-value` | `explainPropConstraint` | **Live** |
| 3 | `list-row` (via prop) | `explainPropConstraint` | **Live** — best-effort jump action (see below) |
| 4 | (same fact as row 10, `code-placed`) | `explainStructuralConstraint` | **Live** |
| 5 | `resolved-style-expression` | `explainStyleConstraint` | **Live** (function), **not wired** into `InlineStyleComposer.tsx` — see "F1 seam" below |
| 6 | `no-inline-style-target` | `explainStyleConstraint` | **Live** (function), not wired — same seam |
| 7-18 | `StructuralRefusalReason` (absorbed verbatim) | `explainStructuralConstraint`, `explainMintedInsertConstraint`, `explainGestureConstraint` | **Live**, wired into `LayerNodeContextMenu.tsx` (R4) |
| 19-21 | `not-a-component`/`package-component`/`unresolvable`/`uses-hooks`/`maps-over-props`/`unsupported-params`/`no-renderable-jsx`/`name-collision` | `explainDetachConstraint` | **Live** (function), not wired into `InstanceCallSiteView.tsx` (E2.5-owned) |
| 12 (instance escape hatch) | `duplicate` | `explainInstanceDuplicateConstraint` | **Live**, wired into `LayerNodeContextMenu.tsx` (R5) |
| 22 | `swap-refused` | `explainSwapConstraint` | **Live** (function), not wired anywhere (no caller identified this pass) |
| 23 | `unexplained-skip` | `explainUnexplainedSkip` | **Live** (function), stays informational-only — see "R3 — deferred" below |
| 25-26 | `no-editable-stylesheet`/`ambiguous-stylesheet`/`stylesheet-import-shape-mismatch`/`breakpoint-override-unsupported` | `explainCssRuleConstraint` | **Live** (function); the actual save-time toast (`fsCodemodAdapter.ts`) already carries equivalent wording independently — not touched |
| 27 | `inline-text-locked` | — | **Reserved, unused.** Text is an ordinary prop key to `explainPropConstraint` (keyed `'text'`, remapped by `parsedPageToSitePage`) — a caller wiring the real site (`inlineEditSlice.ts`, store-owned) gets `resolved-expression`/`list-row` from that function, not a bespoke reason |
| 28 | `html-attributes-locked` | — | **Reserved, unused** — same reasoning; today's real gate (`isPropWritableToSource(node,'htmlAttributes')` in `PropertiesPanelBody.tsx`) is untouched and correct |
| 29 | `branch-not-shown` | — | **Reserved, unused** — not a refusal (nothing is blocked); handled directly by `BranchChoiceNotice` (R6), not routed through `EditConstraint` |
| 30 | `package-component-locked` | — | **Reserved, unused** — already correctly handled, before interaction, by `InstanceCallSiteView.tsx`'s own gate (E2.5-owned) |
| B2's className vocabulary | `css-module-binding`/`template-dynamic`/`unsupported-call`/`unsupported-expression`/`spread-attribute` | `explainClassNameConstraint` | **Live** (function), not wired anywhere (no per-className-edit UI surface exists yet to wire it into) |

Every `explain*` function is tested to either return `null` (writable) or a **well-formed** `EditConstraint` — non-empty `explanation`, `actions` present (possibly `[]`, asserted as a deliberate choice per branch, not a missing field). See `editConstraint.test.ts`'s `assertWellFormed` helper and its per-row coverage.

## R2 — proven directly, per the work order

`editConstraint.test.ts`'s first `describe` block: a node with two code-valued props (`title`/`c.heading`, `subtitle`/`c.tagline`) — `explainPropConstraint` gives each its own `explanation` naming its own source; the second no longer falls back to a shared/generic string. The fix is in the parser (`ParsedNode.resolvedProps`, additive alongside the existing singular `resolution`, which is **left untouched** — it's read by `server/ai/mcp/tools/studio/fidelityReport.ts`, off-limits, and by ~15 existing parser tests I did not want to force through an unrelated rename).

`propLockReason.ts` (the string-returning function two off-limits files depend on) now surfaces the SAME fix without a contract change — confirmed no regression across `resolvedTextEditing.test.ts`'s existing fixtures (they hand-construct `lockReason` directly, so `resolvedProps` being absent falls through to identical old behavior).

## R4 — layer-tree pre-disable

`LayerNodeContextMenu.tsx`: Duplicate/Wrap/Delete are computed via `explainStructuralConstraint` **as a plain derived value in the render body**, not a `useEditorStore(s => {...})` selector — I initially wrote it as a selector and it caused `Maximum update depth exceeded` (confirmed against this file's own 28-test suite, all failing) because the selector built a fresh `{duplicate,wrap,delete}` object (and fresh `EditConstraint`s inside it) every notification, and `useSyncExternalStore` treats an ever-changing snapshot as a tearing loop. Fixed by deriving from the already-selected, referentially-stable `activePage` (`useEditorStore(selectActiveCanvasPage)`) in plain JS after the hook call. **Landmine for whoever builds the next derived-object selector in this codebase**: return primitives, or wrap in `useShallow`, or (as here) derive outside the selector from an already-stable slice — a selector returning a fresh object every call is a real, easy-to-hit infinite-loop trap, not just a perf nit.

Reorder has no equivalent pre-disable here — its refusal genuinely depends on the drop target, which isn't known until the pointer moves. That's `explainGestureConstraint`, consuming D2's `previewStructuralMove` (published, unedited by me).

## R5 — Duplicate's real hatch, from the Duplicate gesture

`explainInstanceDuplicateConstraint()` — a single `studio.instance` node's Duplicate item shows "This is a component instance — Studio cannot duplicate the call site itself, but it can duplicate the COMPONENT as a new file…" instead of the generic message. **Still disabled** — I did not wire a new entry point to `extractInstanceCopy`/the extract flow (that lives in `InstanceCallSiteView.tsx`, E2.5-owned). This is the "wording/wiring only" scope the audit itself specced for R5 (effort S).

## R6 — the branch switcher, scoped honestly

`BranchChoiceNotice.tsx`: each alternative is now a real expandable row (`useState`, local, never written to the store or persisted) with a jump-to-source action. **What this is NOT**: it does not swap which branch renders on the canvas. That remains the audit's own L-effort, cross-cutting conclusion (parser branch-selection parameter + store "preview branch" slot + canvas re-render), spanning three tracks this one doesn't own. I did not attempt it and did not leave a stub claiming otherwise — the component's doc comment says exactly this.

## R7 — notice collapse

Reduced from 3 possible whole-node banners (`SharedComponentNotice`, `SourceConstraintNotice` in 3 variants, `BranchChoiceNotice`) to 2 conceptually distinct facts in `SourceConstraintNotice` (structural, or text-origin) plus the two untouched siblings. I did **not** merge `SharedComponentNotice` into `SourceConstraintNotice` — the audit presents that merge as optional ("consider a single collapsible strip"), and doing it risked touching a component whose blast-radius-count logic I'd rather not blindly re-derive under this session's time pressure. **On a real board the common case (majority, non-structural, non-shared, non-branching node) now shows zero banners** instead of one permanent paragraph — that's the actual R7 win.

## R8 — clickable file:line

`jumpToSource.ts`: resolves an origin's `rel` against `site.files` and calls `openInEditor(fileId)` (existing store action). **Opens the FILE, not the exact line** — `CodeMirrorEditor` has no line-scroll API today, and adding one was out of scope (that component isn't mine and F1's neighbors are actively mid-change nearby). Wired into `SourceConstraintNotice`'s `textOrigin` and `BranchChoiceNotice`'s per-alternative location. **Not wired** into `CodeValueControl`'s per-field glyph — a resolved PROP's `Resolution` (`{source, note}`) carries no file/line at all (the parser records the expression's TEXT, e.g. `"c.heading"`, never its position) — this is a real, disclosed gap the taxonomy itself calls out for row 1 ("None. No jump to source"), not something I could wire without extending the parser's `Resolution` shape to also capture a location, which I judged out of scope for this pass (would touch `staticEval.ts`'s evaluator, a much larger surface).

`list-row`'s "jump" (rows 3, 7, 17) is deliberately **best-effort**, not a real `origin`: `decodeSourceNodeId` refuses to match a `.map`-row id by design (that non-match IS what "no writable location" means), so there is no single honest truth to claim. `bestEffortRowLocation` (local helper in `editConstraint.ts`) strips the loop suffix to recover the row's own rendered position — close to, not exactly, the `.map()` call — and is used ONLY for the action's `target`, never for `EditConstraint.origin`. Tests assert `origin` stays `undefined` for this family while the action still carries a real, clickable location.

## The D2 seam — already consumed, not left as a stub

`explainGestureConstraint(preview: StructuralMovePreview, node)` consumes D2's published `previewStructuralMove` (`@core/page-tree`, unedited by me) directly — it had already landed by the time I built this (confirmed via `git diff` on `sourceStructure.ts` showing the full function before I started, and again via the coordinator's mid-task note). Tested against both `ok:true` and `ok:false` previews. **Not yet called from anywhere** — D2's own handoff says `previewStructuralMove` is wired into the canvas/DOM-panel drop resolvers already (for the boolean allow/refuse decision); threading the richer `EditConstraint` (with actions) into whatever renders the drop-refusal UI is a follow-up integration, not this pass's file to touch (`src/admin/pages/site/canvas/**` is D2's).

## Absorbed vocabularies — confirmed against the real source, not guessed

- B2's `className`: `css-module-binding`/`template-dynamic`/`unsupported-call`/`unsupported-expression`/`spread-attribute` — confirmed exact string values in `src/core/ast-codemods/setJsxClassName.ts`.
- B1/B1b's CSS: `no-editable-stylesheet`/`ambiguous-stylesheet` confirmed in `src/admin/pages/site/studio/styleRuleWriteback.ts`; `stylesheet-import-shape-mismatch` confirmed in `server/handlers/studioCssWriteback.ts`.
- Detach: `DetachRefusalReason`'s 8 members confirmed in `src/core/ast-codemods/detachComponent.ts`, exported from `@core/ast-codemods`'s barrel.

All absorbed by **string value**, never type-imported — `@core/page-tree` importing from `@core/ast-codemods`/`@core/css-codemods` would create a real cycle (`ast-codemods` already imports `page-tree` for `refusePlacement`/`LOOP_ID_SEPARATOR`, confirmed via `extractSubtreeToComponent.ts`). Documented in `editConstraint.ts`'s own `ConstraintReason` doc comment so nobody "fixes" this into a type import later without re-discovering the cycle.

## Explicitly deferred / not this pass's job

- **R3** (`unexplainedSkips` never names which node) — `explainUnexplainedSkip` stays an aggregate-count-only informational constraint, per the audit's own conclusion that fixing this needs a SERVER change (`StudioSaveResponseSchema` extended to carry `{nodeId,kind,reason}` for the prop/text/style skip path, same shape `detach`/`swap`/`css` already have) — `server/handlers/studioWriteback.ts` is E2.4's this wave.
- **F1 seam** — `explainStyleConstraint` is built and tested but not wired into `InlineStyleComposer.tsx`. F1 independently landed R1's core fix (the lock, disabled-before-interaction) directly off `codeProps`/`styleValueKey` in parallel with this track, so the "silent no-op" bug is already closed — what's still missing is the PER-SOURCE message (R2 for styles), now available as `PageNode.resolvedProps['style:<prop>']` as of this track's parser change. A future pass threading it into `InlineStyleComposer`'s row renderer gets the richer message `CodeValueControl` now shows for props, for free — no new engine work needed.
- **Reserved reason members** (rows 27-30, `inline-text-locked`/`html-attributes-locked`/`branch-not-shown`/`package-component-locked`) — named in the union for taxonomy completeness, not currently produced by any `explain*` function, because each row's real mechanism already works correctly today via a generic path or an off-limits file's own gate. Listed explicitly (not silently absent) in both the union's own comments and this handoff's table above.

## Verification run

- `bun test src/core/page-tree/__tests__/editConstraint.test.ts` — 37/37.
- `bun test src/core/page-tree src/core/page-parser src/core/studio-sync src/__tests__/panels src/__tests__/dom-panel src/__tests__/property-controls src/__tests__/fixtures src/__tests__/studio/resolvedTextEditing.test.ts server/handlers/__tests__/studioWriteback.test.ts server/handlers/__tests__/studioPageLoad.test.ts` — **1072 pass, 2 fail**. Both fails confirmed NOT mine via `git diff --stat` (zero diff on either file): `AgentPanel` image-picker test (unrelated), `classAssignmentUnsavedNotice.test.tsx` (expects B2's OLD toast wording; B2's landed message doesn't match its own test — pre-existing on this baseline, not touched by me).
- `./node_modules/.bin/tsc --noEmit -p tsconfig.json` — clean, project-wide, before and after every batch of edits.
- `./node_modules/.bin/eslint` on every file in Scope above — clean, 0 errors/warnings.
- Did **not** run `bun run lint`/`bun run build`, per instructions.
- Did **not** touch `sourceStructure.ts`, `dnd.ts`, `mutations.ts`, `keybindings.ts` (D2/D3), `StyleSectionsEditor.tsx`, `usePropertiesPanelData.ts`, `cssControlTypes.ts`, `InspectPanel/**`, `uiStateActions.ts`, `InlineStyleComposer.tsx`, `StyleSurface.tsx` (F1), `SlotControl.tsx`, `InstanceCallSiteView.tsx` (E2.5), `ast-codemods/**`, `studioEditSchemas.ts`, `studioWriteback.ts` (E2.4), `css-codemods/**`, `styleRuleWriteback.ts`, `studioCss*.ts` (B1b), `framework/**`, `tokenExtract*`, `TokenizedColorField.tsx` (H), `STATE.md`, `src/__tests__/architecture/**`, `server/ai/**`, `docs/**`.
- Confirmed via `bun test src/__tests__/architecture/{css-token-policy,no-css-var-fallbacks,button-primitive-usage,direct-icon-imports,no-third-party-icons,ui-primitives-location,no-native-title-tooltips,no-circular-dependencies,no-core-barrel-deep-imports,module-size-budgets}.test.ts` — the only failures are the ~10 pre-existing violations the coordinator flagged (all in files I never touched: `CmsBundleAnalyzeStep.tsx`, `ModuleInserterDialog.tsx`, `FrameworkHome.tsx`, `ExportDialog.tsx`, `MediaSidebar.tsx`, `AddCustomFontDialog.tsx`, `TokenizedColorField.tsx`).

## Human action needed

Dogfood the panel in Studio mode (`/admin/site?studio`) on an imported project with real `.map` rows, resolved expressions, and a `studio.instance` call site:

1. **R2/per-field glyph**: select a node with **two** code-valued props (e.g. a card with both a resolved `title` and a resolved `subtitle`) — each `CodeValueControl` row should show its own lock glyph; hover each and confirm the tooltip names ITS OWN source (`c.heading` vs `c.tagline`), not the same generic "set in code" on both.
2. **R7**: select an ordinary node whose only code-valued fact is one resolved prop, no structural lock — confirm the properties panel shows **no** paragraph-length banner above the Styles/Attributes switcher (only the per-field glyph on that one row).
3. **R8**: select a node whose text resolved to a known literal (`textOrigin` present) — confirm the "Its text comes from `<file>` (line N)" sentence is a clickable button that opens the Code Editor panel on that file.
4. **R6**: select a node with `branchAlternatives` (a multi-return component, or a resolvable ternary) — click an alternative's row to expand it, confirm a "Open `<file>` (line N)" button appears and opens the right file. Confirm clicking a SECOND alternative collapses the first (only one open at a time) — and confirm nothing on the CANVAS changes (this is intentionally view-only).
5. **R4/R5**: right-click a plain imported element (literal-positioned, no structural lock) in the DOM/layers panel — Delete should be clickable, **Duplicate and "Wrap in" should be greyed out** with a tooltip on hover explaining why. Right-click a `studio.instance` node (a local-component call site) — Duplicate should be greyed out with wording specifically mentioning "duplicate the COMPONENT as a new file", not the generic message. Right-click a node inside a `.map` row — Delete, Duplicate, AND Wrap should all be greyed out.
