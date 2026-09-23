# E2.5 — Surfaces (panel-designer) — handoff

## Bottom line

**One Component section, catalog-driven, for `studio.instance`.** Every prop
the component's own source DECLARES (Track E1's `GET
/admin/api/studio/components`) gets a row, whether or not the call site
passes it. Controls come from `controlForPropKind` (moved out of
`registerProjectModules.ts`, now shared with the package/design-system
path) — a named union alias (`variant?: ButtonVariant`) renders a real
`select`, not a text box. `controlForCallSiteValue` is deleted.

`SlotControl` gained **Add / Add another** (real writes, `insert-slot`,
E2.4), pre-checked so a refusal shows disabled-with-reason. It does **NOT**
offer **Replace/Clear** — see "Why Replace/Clear are not built" below; this
is a deliberate scope cut against the literal work order, not an oversight.

`slotOwners` (new module) resolves node ids without a fresh site scan,
reusing the store's existing `_nodeIdToPageIds`/`lookupCanvasPageById`
indexes (trap #11's precedent) rather than adding a fifth bespoke walk.

## Files touched

**New:**
- `src/admin/pages/site/property-controls/componentPropKind.ts` — the
  shared `PropKind`/`PropSpec`/`LocalComponentSpec` wire schema +
  `controlForPropKind` (moved from `registerProjectModules.ts`'s private
  `controlForKind`, behavior unchanged).
- `src/admin/pages/site/studio/componentCatalog.ts` — client fetcher for
  `GET /admin/api/studio/components`, cached per workspace dir
  (`fetchLocalComponentCatalog`/`invalidateLocalComponentCatalog`), a React
  hook wrapper (`useLocalComponentCatalog`), and `findLocalComponentSpec`
  (best-effort `{componentName, sourceFile}` → catalog entry match).
- `src/admin/pages/site/panels/PropertiesPanel/componentCallSiteRows.ts` —
  pure row-building function (`buildComponentCallSiteRows`): declared props
  first (catalog order), then any call-site prop the catalog didn't declare
  (JS-only fallback / spread), each mapped through `controlForPropKind`.
  Unit-tested without rendering.
- `src/admin/pages/site/panels/PropertiesPanel/slotOwners.ts` — `slotOwners`
  reverse index (`lookupSlotOwner`: slot-fill node id → `{ownerNodeId,
  ownerModuleId, propKey}`) plus `resolveNodeById` (id → `PageNode`,
  composing `_nodeIdToPageIds` + `lookupCanvasPageById`). Both lazily built,
  memoized per `site` object identity — `lookupCanvasPageById`'s own
  precedent, not a new incremental index wired into `nodeIndex.ts`.
- `src/admin/pages/site/panels/PropertiesPanel/SlotFillNotice.tsx` (+
  `.module.css`) — states "Fills the `<prop>` slot of [the component
  below]" when the SELECTED node is itself slot content, using
  `lookupSlotOwner`. Wired into `PropertiesPanelBody.tsx` (2-line addition,
  right after `SharedComponentNotice`).
- `src/admin/pages/site/property-controls/relativeImportSpecifier.ts` — pure
  POSIX relative-import-specifier math (no ts-morph; the picker needs to
  compute `../components/Card` client-side because `insertJsxIntoSlotProp`
  writes whatever specifier string it's given verbatim).
- Tests: `src/__tests__/panels/componentCallSiteRows.test.ts` (6 cases, pure
  row-builder), `src/__tests__/panels/instanceCallSiteView.test.tsx` (2
  cases, real component + mocked catalog fetch — the integration-gap proof),
  `src/__tests__/property-controls/relativeImportSpecifier.test.ts` (5
  cases).

**Edited:**
- `src/admin/pages/site/panels/PropertiesPanel/InstanceCallSiteView.tsx` —
  rewritten: row set now `buildComponentCallSiteRows(spec, callSiteProps)`
  instead of `Object.keys(callSiteProps)`; `controlForCallSiteValue` deleted;
  Swap picker's candidate list now comes from the SAME fetched catalog
  instead of a live board scan (fixes the "board-scoped, not project-wide"
  gap E1's own handoff named — a natural, low-risk consequence of already
  having the catalog in hand, not scope creep).
- `src/admin/pages/site/property-controls/SlotControl.tsx` — Add/Add another
  (see below).
- `src/admin/pages/site/property-controls/shared.ts` — `ControlProps` gained
  optional `ownerNodeId?: string` (only `SlotControl` reads it).
- `src/admin/pages/site/property-controls/PropertyControlRenderer.tsx` —
  threads `ownerNodeId` through to every control (harmless extra prop for
  the other 15).
- `src/admin/pages/site/panels/PropertiesPanel/renderModuleTabContent.tsx` —
  passes `ownerNodeId={selectedNodeId}` in the default (schema-driven)
  branch, so a `pkg.*`/`alm.*` component's OWN `node`-kind prop also gets
  the Add affordance (its owner IS the selected node itself, no call-site
  split).
- `src/admin/pages/site/panels/PropertiesPanel/PropertiesPanelBody.tsx` —
  `SlotFillNotice` wire-in.
- `src/admin/pages/site/studio/studioSaveRequests.ts` — new
  `commitStudioInsertSlot` (posts `kind:'insert-slot'`, returns
  `InstanceCodemodResult`, reloads on success — same shape as
  `detachInstance`/`swapInstance`). **Note:** this file is ALSO being edited
  concurrently by another session (added `reloadStructuralScope`/
  `dispatchCmsSitePagesPatch`/`fetchStudioPagesById` — visible mid-session
  via a system reminder). My addition is isolated and doesn't touch their
  code; `tsc`/tests confirm both coexist. **Not mine**:
  `src/admin/pages/site/studio/__tests__/studioSaveRequests.test.ts` is a
  brand-new, untracked file from that OTHER session — its 4 failures
  (`reload-scope check failed`, duplicate `'post'` entries) are entirely
  about THEIR `reloadStructuralScope` work, not `commitStudioInsertSlot`.
- `src/admin/pages/site/studio/registerProjectModules.ts` — deleted its
  private `PropKindSchema`/`PropSpecSchema`/`controlForKind` (moved to
  `componentPropKind.ts`, imported back). Zero behavior change — same
  switch, same case order, same enum `>= 2` guard.
- `src/admin/pages/site/property-controls/controls.module.css` — new
  `.slotControl`/`.slotPicker`/`.slotPickerEmpty`/`.slotPickerList`/
  `.slotPickerCandidate` rules. All existing tokens (`--space-*`,
  `--bg-surface-2`, `--radius`, `--text-2xs`, `--text-disabled`) — **no new
  tokens added to `globals.css`.**
- `src/__tests__/property-controls/SlotControl.test.tsx` — rewritten for the
  new Add/Add-another behavior (7 cases), plus `invalidateLocalComponentCatalog()`
  in `beforeEach` (see "Landmine" below).

## The unified Component section — what it shows

Select any `studio.instance` node:

1. Header: glyph, component name, Local/Package badge, Detach/Swap (unchanged
   mechanics — still `fsCodemodAdapter`'s standalone one-shot calls).
2. **One row per prop the component's own file declares**, in declaration
   order — `title` (required string), `variant` (named union → dropdown),
   `header` (slot) — REGARDLESS of whether the call site currently passes
   them. A row for a prop the call site never sets is genuinely writable
   (`setJsxProp` adds a brand-new attribute — confirmed via the store's
   pre-existing `updateInstanceCallSiteProp`, which already supported this;
   the row simply didn't exist before).
3. A call-site prop the catalog does NOT declare (untyped JS project, a
   spread prop) still gets a row — classified `'unknown'` through the SAME
   `controlForPropKind` mapping (honest: no declared type), except a slot
   sentinel value, which is a definite structural marker (not a value-type
   guess) and still renders `SlotControl`.

## SlotControl — what's live vs. what's deliberately NOT offered

**Live:**
- **Add** (slot value absent) — opens a picker (project's own components,
  E1's catalog, searchable), on pick posts `insert-slot` targeting the
  CALL SITE's own id (never the slot's locked node — E2.4's "wall #3").
  Pre-checked via `explainStructuralConstraint({kind:'insert', node:
  ownerNode})`; disabled+tooltip when the call site itself can't accept an
  insert (`.map` row, shared component, route chrome, or `node.lockReason`).
- **Add another** (slot already filled) — identical write; the SERVER
  codemod (not this control) decides whether that means wrapping the
  existing value in a fragment or appending to an existing one.
- **Edit contents** (unchanged) — navigates to the slot's own node.

**NOT offered: Replace / Clear.** I evaluated this against the actual
codemod capability rather than building a button that would silently or
loudly fail on every click:
- E2.3's parser locks EVERY slot child with `SLOT_LOCK_REASON` — a
  structural lock. `explainStructuralConstraint({kind:'delete', node:
  slotChild})` refuses `code-placed` unconditionally, for every slot shape
  (single-element AND fragment), always — confirmed by reading
  `refusePlacement` (any `node.lockReason` truthy → refuse, no exception).
- No `insert-slot`-adjacent "clear/empty this attribute" writeback verb
  exists in `studioSlotWriteback.ts` as of this session.
- Composing "delete + insert-slot" myself would mean inventing new
  server-side behavior in `src/core/ast-codemods/**`/
  `studioSlotWriteback.ts` — both explicitly off-limits (E2.2/E2.4 territory,
  E2.2 shown "running now").
- Per the panel's own non-negotiable rule ("never render a control that
  lies") and this task's explicit instruction ("A slot action that would
  refuse must show disabled with the reason... never fail after the
  click"), a Clear/Replace button that refuses 100% of the time isn't a
  "sometimes disabled" control — it's the THIRD honest outcome, "not
  offered." **Real, disclosed gap for a follow-up work order**: a
  `clear-slot`/`remove-slot-child` codemod + `studioSlotWriteback.ts` kind
  would unlock this in one more pass.

## `slotOwners` — the index, precisely

`src/admin/pages/site/panels/PropertiesPanel/slotOwners.ts`:
- `lookupSlotOwner(site, nodeId)` — reverse map (slot-fill node id → owner +
  prop key), built by one full walk of `site.pages` the FIRST time it's
  asked after `site`'s object reference changes (Mutative mints a new one on
  every mutation), cached thereafter. Consumed by `SlotFillNotice.tsx`.
- `resolveNodeById(site, nodeIdToPageIds, nodeId)` — forward lookup (id →
  `PageNode`), composing the store's OWN `_nodeIdToPageIds` (WS-5.2,
  incrementally maintained) with `lookupCanvasPageById` (`store.ts`'s own
  precedent for this exact "lazy, per-`site`-reference cache" pattern).
  Consumed by `SlotControl` to read the owner node's `lockReason` for its
  insert pre-check.

Neither is a new full-site scan wired into a hot render path — both are
O(1) after the first ask per site version, exactly mirroring
`lookupCanvasPageById`'s own mechanism rather than adding a fifth bespoke
scan or a heavier incremental-patch index to `nodeIndex.ts` (a much larger
footprint for a comparatively cold path — this fires per Properties-panel
selection, not per rendered canvas node).

## Canvas — untouched, confirmed

I did not touch `src/admin/pages/site/canvas/**`. No placeholder node is
minted for an empty slot anywhere in my changes — `buildComponentCallSiteRows`
only ever produces PANEL rows from the catalog; nothing calls
`insertNode`/mutates the tree to represent an unfilled slot.

## Integration-gap check (per protocol)

- `commitStudioInsertSlot` — consumer is `SlotControl.tsx`'s `handlePick`,
  verified end-to-end in `SlotControl.test.tsx`'s last test (mocks both
  `/admin/api/studio/components` and `/admin/api/studio/save`, clicks Add →
  picks a candidate → asserts the POSTed edit body is exactly `{kind:
  'insert-slot', nodeId, propName, node: {name, importSpecifier}}`).
- `GET /admin/api/studio/components` (E1, previously unconsumed) — now has
  THREE real callers: `InstanceCallSiteView`'s row set, its Swap picker, and
  `SlotControl`'s Add picker. Verified via `instanceCallSiteView.test.tsx`
  (mocks the route, asserts a fetched `enum` prop renders a real
  `<select>`, and that selecting an option lands in the store's
  `callSiteProps`).
- `controlForPropKind` (moved) — verified BOTH callers still work:
  `registerProjectModules.ts`'s existing package-bundle path (unchanged
  behavior, `tsc` + the module-picker/deps-panel integration tests still
  green) and the new local-instance path (`componentCallSiteRows.test.ts`).

## Landmine for the next agent

**The component catalog fetch is cached at MODULE scope
(`componentCatalog.ts`), which survives across test FILES in the same `bun
test` process**, not just across renders within one test. I hit this
directly: `SlotControl.test.tsx`'s catalog-mock test passed in isolation but
failed when run alongside `instanceCallSiteView.test.tsx` (whichever file's
`beforeEach` ran first "won" the cache, so the second file's fetch mock was
never actually called). Fixed by calling `invalidateLocalComponentCatalog()`
in `beforeEach` in both test files — **any future test that renders
`InstanceCallSiteView`/`SlotControl`/anything calling
`fetchLocalComponentCatalog`/`useLocalComponentCatalog` needs the same
reset**, or it will silently see a stale/wrong-project catalog from whatever
test ran first in the process.

## Verification run

```
./node_modules/.bin/tsc --noEmit -p tsconfig.json                    → clean
./node_modules/.bin/eslint <every file in Scope above>               → clean, 0 errors/warnings
bun test src/__tests__/panels/componentCallSiteRows.test.ts          → 6 pass
bun test src/__tests__/panels/instanceCallSiteView.test.tsx          → 2 pass
bun test src/__tests__/property-controls/SlotControl.test.tsx        → 7 pass
bun test src/__tests__/property-controls/relativeImportSpecifier.test.ts → 5 pass
bun test src/__tests__/property-controls src/__tests__/panels        → 601 pass / 2 fail
  (both pre-existing, unrelated — AgentPanel image-picker flake,
  notifyClassAssignmentUnsaved stale wording vs B2's own rewrite — zero
  diff on either file, confirmed via git status)
bun test src/__tests__/architecture/css-token-policy.test.ts
bun test src/__tests__/architecture/no-css-var-fallbacks.test.ts
bun test src/__tests__/architecture/button-primitive-usage.test.ts
bun test src/__tests__/architecture/module-size-budgets.test.ts
bun test src/__tests__/architecture/no-full-site-scan-in-selectors.test.ts
bun test src/__tests__/architecture/no-core-barrel-deep-imports.test.ts
bun test src/__tests__/architecture/no-circular-dependencies.test.ts
bun test src/__tests__/store/selectorStability.test.ts               → all pass
  (module-size-budgets' only failure: server/handlers/studioWriteback.ts
  at 701/700 lines — confirmed via `git diff --stat` NOT touched by me,
  a concurrent session's edit)
bun test src/__tests__ src/admin/pages/site/studio/__tests__         → 6563 pass / 21 fail
  (full 21-failure list checked one by one against `git status --porcelain`:
  every failing file is under src/admin/pages/site/canvas/** (concurrently
  owned, off-limits), server/ai plugin-runtime/mcp files, or the untracked
  studioSaveRequests.test.ts from the other session — zero overlap with my
  diff)
```

Did **not** run `bun run lint`/`bun run build` (many concurrent sessions
mid-edit across the repo; per instructions, targeted `tsc`+`eslint` only).
Did not run browser/e2e tests.

## Not committed

Working tree only — no `git add`, no commit. `STATE.md` untouched by me.

## Human action needed — what to dogfood

1. **The unified Component section.** Open a Studio project, select a local
   component call site (`studio.instance`) whose component declares MORE
   props than the call site currently passes (e.g. an optional `variant`
   the call site never sets). Confirm the Properties panel shows a row for
   it anyway, and that a string-union prop (`variant?: 'primary' | 'ghost'`)
   renders a real dropdown, not a text box. Set it and confirm the
   attribute is written into the call site's JSX on save/reload.
2. **Slot Add.** Select a `studio.instance` whose component declares a
   `ReactNode`/JSX-typed prop (a slot) the call site doesn't fill. Click
   "Add", search for a real component in the project, pick one, confirm the
   board reloads with the new element filling the slot and the source file
   now has `header={<Icon/>}` (or similar) written in.
3. **Slot Add another.** Repeat on an ALREADY-filled slot — confirm the
   button reads "Add another" and, after picking, both elements appear
   (wrapped in a fragment in source).
4. **The disabled-with-reason case.** Select a `studio.instance` that sits
   inside a `.map()`-generated row (or any structurally locked instance).
   Confirm its slot's Add button is visibly disabled with a hover tooltip
   naming the real reason (e.g. "a row of a list…"), not just greyed out
   silently.
5. **SlotFillNotice.** Click directly on the materialized element filling a
   slot (e.g. select the `<Icon/>` inside `header={<Icon/>}` from the layer
   tree). Confirm a small info notice appears at the top of ITS OWN
   Properties panel reading "Fills the `header` slot of [the component
   below]", and clicking the link selects the owning `studio.instance` node.
6. **Swap picker, project-wide.** Open Swap on a `studio.instance` and
   confirm candidates now include local components NOT currently placed
   anywhere on the visible board (previously board-scoped only).
