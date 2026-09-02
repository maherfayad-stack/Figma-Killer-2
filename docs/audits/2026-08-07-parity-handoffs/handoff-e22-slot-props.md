# E2.2 — Typed slot props — handoff

## Scope (files touched, all under my ownership)

New:
- `src/core/ast-codemods/subtreeSlotChildren.ts` — read-only candidate
  listing + naming suggestions (`collectSlotChildCandidates`,
  `listSlotChildCandidates`, `suggestSlotNames`, `SOLE_SLOT_DEFAULT_NAME`).
- `src/core/ast-codemods/addSlotPropToComponent.ts` — the second operation
  (add a slot to an EXISTING component).
- `src/core/ast-codemods/componentCallSites.ts` — `findComponentCallSites`,
  the blast-radius scan `addSlotPropToComponent` needs.
- `src/core/ast-codemods/__tests__/subtreeSlotChildren.test.ts` (14 tests).
- `src/core/ast-codemods/__tests__/componentCallSites.test.ts` (8 tests).
- `src/core/ast-codemods/__tests__/addSlotPropToComponent.test.ts` (16 tests).

Edited:
- `src/core/ast-codemods/extractSubtreeToComponent.ts` — E2.1's codemod now
  accepts `params.slotChildren?: SlotChildDecision[]`, the promote-time
  keep/slot toggle. New refusal reason `slot-name-conflict`. Success result
  gained `slots: { slotName: string }[]`.
- `src/core/ast-codemods/subtreeFreeVariables.ts` — `analyzeFreeVariables`
  gained an optional third param `excluded: readonly Node[]` (default `[]`,
  every existing caller/test unaffected) so a slotted child's own references
  are left out of free-variable analysis.
- `src/core/ast-codemods/locateJsxElement.ts` — added shared
  `resolveJsxWholeElement(opening)`, factoring out the self-closing/wrapper
  resolution `extractSubtreeToComponent.ts` had inline and
  `addSlotPropToComponent.ts`/`subtreeSlotChildren.ts` now also need.
  `extractSubtreeToComponent.ts` refactored to use it (net simplification —
  its own call-site rewrite collapsed from a 3-branch if/else to one
  `root.replaceWithText(...)`; verified byte-identical by test).
- `src/core/ast-codemods/index.ts` — barrel exports for all of the above.
- `src/core/ast-codemods/__tests__/extractSubtreeToComponent.test.ts` —
  added a `describe('extractSubtreeToComponent — E2.2 keep/slot toggle')`
  block, 12 new tests (byte-identical regression, single/multi slot success,
  prop+slot together, slotted-child free-variable exclusion, spread-props
  exclusion for slotted content, both `slot-name-conflict` shapes, three
  caller-contract throws).
- `server/handlers/studioSlotWriteback.ts` — `PromoteComponentEditSchema`
  gained optional `slotChildren` (same shape as the codemod's own field),
  threaded through `applySlotEdit`'s `promote-component` case.
  `StudioPromoteComponentDetail` gained `slots: { slotName: string }[]`,
  populated from the codemod's own result.

**Not touched, deliberately**: `server/handlers/studioWriteback.ts` (692/700
lines, not in my ownership grant — see "Why `add-slot-prop` isn't wired as a
`StudioEdit` kind yet" below) and `server/handlers/studioEditSchemas.ts` (no
change needed — `PromoteComponentEditSchema`'s new field flows through
automatically via the existing `...SlotEditSchemas` spread).

## The API E2.5 must call — specified precisely

### 1. Promote-time keep/slot toggle (extends E2.1/E2.4, already wired)

```ts
// @core/ast-codemods
listSlotChildCandidates(params: { file, line, col, project? }): SlotChildCandidate[]
// SlotChildCandidate = { index, kind: 'element'|'fragment', tagName?, preview, suggestedName }

suggestSlotNames(
  candidates: readonly SlotChildCandidate[],
  selectedIndices: readonly number[],
): Map<number, string>
// selectedIndices.length === 1 -> the literal 'children' for that one index
// selectedIndices.length  >  1 -> each candidate's own tag-derived
//   `suggestedName`, disambiguated (icon, icon2, …) against the OTHER
//   selected candidates

extractSubtreeToComponent(params: {
  file, line, col, workspaceRoot, componentName,
  nodeId?, lockReason?, existingComponentNames?, project?,
  slotChildren?: { childIndex: number; slotName: string }[],  // NEW
}): ExtractSubtreeToComponentResult
// success.slots: { slotName: string }[] — every slot actually created
```

**Call `listSlotChildCandidates` when the user opens the promote dialog.**
Render each candidate as a keep/slot toggle row (`preview` for the label).
As the user toggles slots on, call `suggestSlotNames` with the CURRENT full
selection to refresh every selected row's suggested name (recompute on every
toggle — it's pure and cheap). Let the user edit the suggested name before
submitting. Submit `slotChildren` built from `{childIndex, slotName}` pairs
using the (possibly-edited) names. **`childIndex` must come from
`listSlotChildCandidates`'s own output** — a hand-rolled or stale index
throws (contract violation, not a refusal).

**Wire format** (already live, via `promote-component`'s existing
`StudioEdit` kind — no new HTTP surface needed):

```ts
{ kind: 'promote-component', nodeId, componentName, existingComponentNames?,
  slotChildren?: { childIndex: number; slotName: string }[] }
```

Reachable today through `POST /admin/api/studio/save` and, for free, through
MCP's `studio_apply_edits` (same mechanism B2/E2.4 already proved for
`class`/`insert-slot`).

### 2. Add a slot to an EXISTING component (new codemod, NOT yet wired as a `StudioEdit`)

```ts
// @core/ast-codemods
findComponentCallSites(project, workspaceRoot, componentFile, exportName): ComponentCallSite[]
// ComponentCallSite = { file, line, col, localName }

addSlotPropToComponent(params: {
  file, exportName, line, col, workspaceRoot, slotName, project?,
}): AddSlotPropToComponentResult
// success: { ok: true, slotName, callSites: ComponentCallSite[] }
// failure: { ok: false, refusal: { reason, message } }
```

**Call `findComponentCallSites` FIRST, before offering to commit at all** —
this is the "state its blast radius up front" requirement, literal: show the
count and the file list, THEN let the user pick a slot target and name, THEN
call `addSlotPropToComponent`. Its own success result repeats the identical
`callSites` list afterward for a confirmation summary — that is NOT the
first time the user should see it.

`exportName` comes from Track E1's `LocalComponentSpec.exportName` (`GET
/admin/api/studio/components`) — this is the "use E1's catalog" the work
order asked for: E1's catalog is how the panel knows which components exist
and what to pass as `exportName`/`file`; `findComponentCallSites` is the
(new, this task) reverse lookup from a component back to its call sites,
which E1's catalog does not itself provide (it lists declarations, not
usages).

**`(line, col)` names a JSX child SOMEWHERE inside that component's own
returned JSX** — reuse `listSlotChildCandidates`/`collectSlotChildCandidates`
against the COMPONENT FILE (not a page file) to enumerate candidates inside
the component's own render, the identical mechanism, since both operations
share the same "which direct child becomes a slot" question — I did not
duplicate that logic. A location outside the named export's own subtree
throws.

## Why `add-slot-prop` isn't wired as a `StudioEdit` kind yet — SUPERSEDED

**This section is now historical.** The coordinator granted ownership of
`server/handlers/studioWriteback.ts` and `server/handlers/studioEditSchemas.ts`
after reading this handoff specifically to close this gap, and it is closed —
see "UPDATE — `add-slot-prop` is now a live, wired `StudioEdit` kind" at the
bottom of this file for the full account. Left in place, unedited otherwise,
as the accurate record of the state at the time this handoff was first
written — do not treat anything below this notice as still true.

I own `src/core/ast-codemods/**` and `server/handlers/studioSlotWriteback.ts`
— **not** `server/handlers/studioWriteback.ts`, which is where a NEW
discriminated `StudioEdit` kind's dispatch `case` would have to be added
(`applyStudioEdit`'s `switch (edit.kind)`, currently `case 'insert-slot':
case 'promote-component': { … }`). That file is at **692/700 lines**
(E2.4's own measurement) and explicitly not mine to touch. Extending
`SlotEditSchema`'s discriminated union with a third kind WITHOUT also adding
a matching `case` there would break `studioWriteback.ts`'s own
`applyStudioEdit` switch at compile time (not exhaustive) — a change I have
no permission to make and no line budget to safely make it in even if I did.

**What exists today**: `addSlotPropToComponent` is a complete, tested,
barrel-exported codemod — callable directly by any server handler or MCP
tool that wants it, exactly the same state `extractSubtreeToComponent` was
in after E2.1 ("nothing calls it yet — this wave's task was the
foundation"). E2.4 later closed that exact gap for `promote-component`
without needing my involvement, because `promoteDetail`/dispatch already
existed as a slot-kind switch case; the next agent who wires
`add-slot-prop` needs to touch `studioWriteback.ts` itself (add the case,
the schema import from `studioSlotWriteback.ts`'s `SlotEditSchemas` array —
which I've left ready to receive a third schema — and a
`StudioEditRefusal['kind']`/`isRefusingEditKind` entry), and should budget
for `studioWriteback.ts`'s line ceiling being nearly full.

**Not a schema gap** — `SlotEditSchemas` in `studioSlotWriteback.ts` is a
plain array (`[InsertSlotEditSchema, PromoteComponentEditSchema]`); adding a
third `AddSlotPropEditSchema` there requires zero changes to
`studioEditSchemas.ts` (it spreads the array). I left this documented in
`studioSlotWriteback.ts`'s own file for whoever does the wiring next.

## Slot-naming rule (precise)

- `subtreeSlotChildren.ts`'s `SlotChildCandidate.suggestedName` is a
  TAG-DERIVED default, always computed per-candidate independent of
  selection: `Header` → `header` (component reference, lowerFirst); a
  landmark intrinsic tag (`nav`, `footer`, `header`, …) → itself; a generic
  intrinsic (`div`, `span`, `p`, `a`, `img`, `ul`, `ol`, `li`, `button`, `i`,
  `b`, `svg`, `path`, `g`) or a fragment → a positional fallback
  (`slot<1-based-position>`).
- `suggestSlotNames(candidates, selectedIndices)` applies the OTHER half of
  the rule, which depends on the FULL selection, not one candidate alone:
  exactly one selected → the literal `'children'`; two or more → each
  candidate's own `suggestedName`, disambiguated (`icon`, `icon2`, …)
  against the rest of the CURRENT selection.
- Neither function ever assigns a name silently — both are meant to be
  called live as the panel's selection state changes, and the RESULT is
  always shown in an editable field before the user submits.
- `addSlotPropToComponent`'s `slotName` param uses the identical convention
  (mirrors `extractSubtreeToComponent`'s `SlotChildDecision.slotName`) — the
  panel is expected to reuse `suggestSlotNames` for it too (a single
  existing-component slot add is the `selectedIndices.length === 1` case,
  so it'll default to `'children'` unless the user picks a real name).

## Refusal vocabulary

`extractSubtreeToComponent`'s vocabulary is now 7 reasons (was 6): the
existing `list-row` / `shared-component` / `route-chrome` / `code-placed`
(via `refusePlacement`) / `spread-props` / `name-taken`, plus **NEW:
`slot-name-conflict`** — fires when (a) two `slotChildren` decisions name
the same slot, or (b) a slot name collides with a forwarded free-variable
prop of the same name. Both checked BEFORE any write. A `slotChildren` entry
with an out-of-range `childIndex`, a duplicate `childIndex`, or an invalid
identifier `slotName` **throws** (caller-contract violation, same trust
level as `componentName`'s PascalCase check) rather than refusing — the
picker UI is responsible for only ever sending indices `listSlotChildCandidates`
actually returned and names already shown for correction.

`addSlotPropToComponent`'s vocabulary is 5 reasons, all new to this module:
- `not-found` — `exportName` doesn't resolve in `file` any more (stale
  catalog entry — "reload and try again", same tone as `insertJsxIntoSlotProp`'s
  identical case).
- `no-jsx-parent` — the target IS the component's entire returned markup
  (no JSX parent to insert `{slotName}` alongside) — writing `{slotName}`
  there would be invalid syntax, so this refuses rather than producing
  broken output. Reuses the naming, not the type, of
  `sourceStructure.ts`'s `no-jsx-parent` reason for the identical shape.
- `unsupported-params` — an undestructured `props` parameter. Reuses
  `detachComponent.ts`'s exact reason STRING for the identical shape
  (`buildParamBindings`'s `hasUndestructuredParam`, imported and reused
  directly rather than re-derived).
- `unsupported-props-type` — the first parameter's type is neither an
  inline type literal nor a resolvable `interface`/type-alias-to-object-literal
  reference (e.g. a union). No type checker, no guess.
- `prop-name-taken` — the component already has a prop (or a `children`
  binding) under that exact name.
- **Invalid `slotName` throws**, same trust level as `extractSubtreeToComponent`'s.
- **A location outside the named export's own returned JSX throws** —
  caller-contract violation (wrong `exportName`/`(line,col)` pairing), not a
  refusal.

## Decisions (per CLAUDE.md's "when you add a resolution" checklist)

Neither operation is a value RESOLUTION (no `Resolution`/`origin`/`codeProps`
question in §7's sense) — both are writeback verbs, like `move`/`insert`/
`detach`/`promote-component` before them. Answering the analogous questions
anyway:

- **`extractSubtreeToComponent`'s slots**: does not touch `locked`/
  `lockReason` on any existing node (the new component's markup is ordinary,
  unlocked content the parser re-reads fresh). Adds nothing to `codeProps`.
  No `origin` — nothing here is a literal being READ, it's markup being
  relocated. **Required, not optional** (`slotName: ReactNode`, no `?`) —
  this codemod always rewrites its own single call site to pass every slot
  it creates, so there is no untouched call site a required prop could
  break.
- **`addSlotPropToComponent`**: same three answers (no lock, no codeProps,
  no origin). **Optional** (`slotName?: ReactNode`) — the load-bearing
  difference from the above: N existing call sites this codemod never
  touches must stay valid, so a required prop would turn one edit into N
  broken files. **No fallback markup is injected** — the content that was
  inline simply stops rendering wherever the new prop isn't passed; this is
  why the blast-radius report must be shown BEFORE committing, not just
  logged after.
- Panel surfaces (the keep/slot toggle UI, `SlotControl`'s Replace/Clear/Add,
  the blast-radius confirmation dialog): not mine — E2.5.

## Landmines found, not already in the 578-line doc — tell `studio-scribe`

1. **`ObjectBindingPattern` has no `addElement`/`addElements` API** —
   confirmed via ts-morph's own `.d.ts`: only `getElements()`. I initially
   wrote `pattern.addElement(name)` by analogy with
   `InterfaceDeclaration`/`TypeLiteralNode`'s real `addProperty`; caught
   first by a failing test (Bun runs untyped at test time), and — checked
   afterward, isolated repro — `tsc` DOES correctly reject it
   (`TS2339: Property 'addElement' does not exist on type
   'ObjectBindingPattern'`), so this is not a tooling gap, just a reminder
   that `bun test` alone doesn't typecheck and a plausible-looking method
   name on a sibling ts-morph node class doesn't mean it exists on this one.
   The fix: rebuild the pattern's own text (`pattern.replaceWithText(...)`)
   from its existing elements' own `.getText()` plus the new plain
   identifier — `addSlotPropToComponent.ts`'s `addSlotToExistingPattern`.
   Worth a line in whatever doc collects ts-morph API landmines (E2.1's
   handoff already started one: raw-text `ParameterDeclarationStructure.name`,
   `addImportDeclaration`'s semicolon default).
2. **A regex like `/<Card[^>]*\/>/` is NOT a safe way to assert "this JSX
   tag is self-closing" once the tag carries an attribute whose OWN value
   contains a literal `>`** (`header={<header>...</header>}` — the
   attribute value's closing tag `>` terminates the character class before
   the tag's real end). Caught only by a failing test, not by reasoning
   about it up front — worth remembering for any future test asserting
   self-closing-ness against a call site that forwards JSX-valued props.
3. **`buildParamBindings` (`detachComponent.ts`) returns
   `hasUndestructuredParam: false` for BOTH "no parameters at all" and "has
   a destructured object pattern"** — the two cases are NOT distinguished by
   that flag alone; a caller that needs to tell them apart (I did, for
   `addSlotPropToComponent`'s "fresh parameter" vs "existing pattern" fork)
   has to re-ask `fn.getParameters()[0]` itself. Not a bug in that
   function — it's answering a narrower question (`hasUndestructuredParam`)
   correctly — just a sharp edge worth flagging for the next caller.

## Verification run

```
bun test src/core/ast-codemods/__tests__/extractSubtreeToComponent.test.ts \
         src/core/ast-codemods/__tests__/subtreeSlotChildren.test.ts \
         src/core/ast-codemods/__tests__/componentCallSites.test.ts \
         src/core/ast-codemods/__tests__/addSlotPropToComponent.test.ts
  → 68 pass / 0 fail (194 expect() calls)

bun test src/core/page-parser src/core/ast-codemods src/__tests__/studio
  → 544 pass / 0 fail

bun test server/handlers/__tests__/studioWriteback.test.ts
  → 67 pass / 0 fail (unchanged — my PromoteComponentEditSchema/
    StudioPromoteComponentDetail additions are both new OPTIONAL fields;
    nothing existing broke)

bun test server/ai/mcp/tools/studio
  → 165 pass / 0 fail (confirms the schema addition doesn't break MCP)

bun test src/__tests__/architecture/module-size-budgets.test.ts \
         src/__tests__/architecture/no-core-barrel-deep-imports.test.ts
  → 6 pass / 0 fail — every file I touched/added is 118–508 lines, well
    under the 700-line ceiling (extractSubtreeToComponent.ts 508,
    addSlotPropToComponent.ts 273, subtreeFreeVariables.ts 261,
    subtreeSlotChildren.ts 187, componentCallSites.ts 128,
    locateJsxElement.ts 118, studioSlotWriteback.ts 212)

./node_modules/.bin/tsc --noEmit -p tsconfig.json
  → clean, no output (whole project)

./node_modules/.bin/eslint <every file in Scope above>
  → clean, no errors/warnings
```

Pre-existing failures confirmed NOT MINE via `git status -sb` (untouched by
my diff): `server/handlers/studio/projectGuide.test.ts` (×2, Windows path
separator), `server/handlers/studio/projectSeed.test.ts` (Windows path),
`server/handlers/studio/projectMcpApprovals.test.ts` (missing module from
another in-flight session), `server/handlers/studio/remoteAssetFetch.test.ts`
(×2, network mock plumbing), `server/handlers/studio/turnDesignReferences.test.ts`
(SVG-vs-raster assertion) — same baseline other agents this wave already
reported.

Did not run `bun run build`/`bun run lint` per instructions (concurrent
siblings editing panels/canvas/mutations/framework/architecture-gates —
`dist`/`.tsbuildinfo` collision risk).

## Not committed

Working tree only — no `git add`, no commit, `STATE.md` untouched by me.

---

## UPDATE — `add-slot-prop` is now a live, wired `StudioEdit` kind

The coordinator granted ownership of `server/handlers/studioWriteback.ts` and
`server/handlers/studioEditSchemas.ts` (E2.4 had finished; no other agent in
them) specifically to close the gap the section above described. Closed.
**`addSlotPropToComponent` now has a live caller** — confirmed, not assumed
(see "Confirmed reachable" below) — through both
`POST /admin/api/studio/save` and MCP's `studio_apply_edits`.

### Scope added this pass

Edited (both now also mine, per the coordinator's explicit grant):
- `server/handlers/studioWriteback.ts` — new `case 'add-slot-prop':` folded
  into the existing `case 'insert-slot': case 'promote-component':` dispatch
  block; `isSharedSourceNodeId`'s doc comment updated; the RESPONSE-shape
  types (`StudioEditSwapDetail`, `StudioEditApplyOutcome`,
  `StudioEditRefusal`, `isRefusingEditKind`, `StudioEditUnexplainedSkip`,
  `StudioEditBatchResult`) **moved OUT** to `studioEditSchemas.ts` (see "How
  the 700-line ceiling was actually respected" below) and are now imported
  back and re-exported verbatim, so no external import path changed.
  `applyStudioEditBatch`'s loop gained the one new branch a preview needs:
  neither `written` nor `skipped` moves for it. **622/700 lines** — the
  addition (add-slot-prop's case + the preview-aware loop branch +
  `addSlotPropDetails` bookkeeping) fit with room to spare specifically
  *because* the type-definition extraction happened first.
- `server/handlers/studioEditSchemas.ts` — now owns BOTH halves of the wire
  contract (request union AND the `/save` response shape — see its own
  updated module doc for the reasoning), not just the request union. **354
  lines.**
- `server/handlers/studioSlotWriteback.ts` — `AddSlotPropEditSchema`
  (`kind`/`nodeId`/`exportName`/`slotName`/`preview`), folded into
  `SlotEditSchemas` (now three schemas); `isSlotEditKind` extended;
  `isSlotPreviewOutcome` (new, exported — the one piece of "how to fold this
  outcome into the batch counters" logic that lives here rather than in
  `studioWriteback.ts`, since it's answering a question only this module's
  own `committed` field can answer); `StudioAddSlotPropDetail`; `SlotEditOutcome`
  widened to carry `applied`/`addSlotPropDetail` explicitly;
  `applySlotEdit`'s switch gained the `add-slot-prop` case. **319 lines.**
- `server/handlers/__tests__/studioWriteback.test.ts` — new
  `describe('applyStudioEdit — the add-slot-prop kind (E2.2)')`, 5 tests:
  live-caller proof, preview-doesn't-write-or-count-as-skipped, a genuine
  two-call preview→commit sequence proving the SAME blast radius both times,
  a refusal surfaced through the batch (`no-jsx-parent`), and
  `isSharedSourceNodeId`.
- `src/core/ast-codemods/addSlotPropToComponent.ts` — `params.preview?: boolean`
  and `success.committed: boolean`, the enforced preview mechanism (see
  below). `src/core/ast-codemods/__tests__/addSlotPropToComponent.test.ts` —
  3 new tests for it.

**Not touched**: `src/admin/pages/site/panels/**` (E2.5's), any
`server/handlers/studio/**` new route file, `studioPageLoad.ts`,
`studioSaveRequests.ts`, `fsCodemodAdapter.ts`, `store/slices/site/**` (C5's).
`studioWriteback.ts` had already been touched by C5 mid-session (a private
`isWritableSourceRel` was made exported for `studio/reloadScope.ts`, unrelated
to my change) — confirmed via a stale-file warning from my own edit tool,
re-read the live file, and built my change on top of the current state rather
than a cached one.

### The "blast radius up front" mechanism — enforced, not just documented

My original design left `findComponentCallSites` as a standalone,
independently-callable function and trusted the eventual caller to invoke it
before ever constructing an `add-slot-prop` edit. The coordinator's message
correctly identified that this was a promise with no actual mechanism behind
it at the wire level — nothing stopped a caller from skipping straight to the
write. Fixed by making the wire-level kind itself two-phase:

- `addSlotPropToComponent.ts` gained `params.preview?: boolean`. When set,
  the codemod runs its **entire** validation and mutation pipeline —
  everything up to and including `root.replaceWithText(...)` and the
  interface/destructuring rewrite — against the in-memory `sourceFile`, and
  the ONE thing it skips is the final `sourceFile.saveSync()`. `callSites`
  (`findComponentCallSites`) is computed either way. `success.committed`
  says which happened.
- This means a preview that reports `ok: true` is not a weaker guess at
  whether the commit will succeed — it is a REAL run of the same
  deterministic logic that just chose not to persist. The one caveat
  (documented loudly in the module's own doc comment): don't share one
  `Project` instance across a preview call and a later commit call for the
  same target — every real caller gets a fresh `Project` per request (two
  separate HTTP calls never share one), so this never arises in practice.
- `studioSlotWriteback.ts`'s `AddSlotPropEditSchema` carries `preview?:
  boolean` on the wire. The intended client sequence: submit
  `{ preview: true }` → server returns `ok: true` with `applied: false` and
  `addSlotPropDetail.committed: false`, disk untouched → client shows
  `callSites` to the user → on confirmation, resubmit the identical edit
  with `preview` omitted → server commits (or refuses for the SAME reason
  the preview would have surfaced, since nothing about the target changed).
- `applyStudioEditBatch`'s counting loop treats a preview as neither
  `written` nor `skipped` — both would misreport what happened (`skipped`
  reads as "this failed"; the deliberate no-op is neither). It's still fully
  visible: `addSlotPropDetails` (a new field on `StudioEditBatchResult`,
  same join-key convention as `swapDetails`/`promoteDetails`) carries every
  `add-slot-prop` outcome, preview or commit, so the client always has
  something to render.
- `shifted`/`sharedComponents` need no special preview-awareness: `shifted`
  is computed from the actual before/after line count ON DISK, so a preview
  (which never writes) naturally reports `shifted: false` regardless of
  kind-level bookkeeping. `sharedComponents` can over-report `true` for a
  preview-only batch (it's a pure function of `(nodeId, kind)`, blind to the
  `preview` flag) — a real but minor inefficiency, harmless because the
  CLIENT's own reload is gated on `written > 0` (`docs/features/studio-import.md`'s
  "A save only reloads when a write actually landed"), which a preview-only
  batch never satisfies. Documented as accepted, not silently ignored.

### The client-side structural gate E2.5/C5 need to wire

Per the coordinator's correction (E2.4's own precedent): the SERVER cannot
gate `add-slot-prop` against the loaded page tree (no tree available
server-side, same stateless posture `detach`/`swap`/`promote-component`
already have — see `studioSlotWriteback.ts`'s own "WHY... STAY
SERVER-SIDE-STATELESS" doc section, now updated). The real gate is
client-side, before the edit is ever constructed:

```ts
refuseStructuralEdit({ kind: 'delete', node: targetChildNode })
```

asked against **the JSX child becoming the slot** — never the component's
own root, never a call site elsewhere on the board. This reuses
`list-row`/`shared-component`/`route-chrome`/`code-placed` for the identical
reason a real delete would refuse: the target's own markup is being removed
from the component's inline render (which is, structurally, exactly what
`add-slot-prop` does to it — the only difference from an actual delete is
that the content becomes an omittable prop instead of vanishing outright).
`no-jsx-parent`/`unsupported-params`/`unsupported-props-type`/`prop-name-taken`
have no `refuseStructuralEdit` vocabulary and stay codemod-only refusals,
surfaced through the SAME `{ok, refusal}` → `StudioEditRefusalError` →
`StudioEditBatchResult.refusals` channel every other kind uses — nothing new
invented there.

### How the 700-line ceiling was actually respected

Not by shaving or `GRANDFATHERED`. `studioWriteback.ts` was already at
702 lines (baseline, before any of my additions) once a concurrent C5 edit
landed. Rather than cram `add-slot-prop`'s dispatch/counting logic in on top
of that, the RESPONSE half of the wire contract — `StudioEditApplyOutcome`,
`StudioEditRefusal`, `isRefusingEditKind`, `StudioEditUnexplainedSkip`,
`StudioEditBatchResult` (previously defined in `studioWriteback.ts`, ~120
lines including doc comments) — moved to `studioEditSchemas.ts`, which
already owned the REQUEST half (`StudioEditSchema`) and whose own module doc
already drew the "wire shape here, dispatch behaviour there" line — these
types are the `/save` response's own shape, which is wire shape by that same
rule, just the other direction. `studioWriteback.ts` re-exports every one of
them unchanged, so no consumer's import path moved. This is the SAME kind of
move B1 made when it originally split `studioEditSchemas.ts` out at all, one
level further. `isSlotPreviewOutcome` (the "does this outcome count as a
preview" question) was ALSO deliberately NOT inlined into
`studioWriteback.ts`'s counting loop — it lives in `studioSlotWriteback.ts`,
next to the `committed` field it reads, and `studioWriteback.ts`'s loop just
calls it. Final sizes: `studioWriteback.ts` 622, `studioEditSchemas.ts` 354,
`studioSlotWriteback.ts` 319 — all comfortably under 700, with real headroom
left in the two files most likely to grow next.

### Confirmed reachable — not assumed

- `POST /admin/api/studio/save` → `applyStudioEditBatch` → `applyStudioEdit`'s
  `case 'add-slot-prop':` → `applySlotEdit` → `addSlotPropToComponent`.
  Proven by direct test (`studioWriteback.test.ts`'s new describe block),
  the SAME function chain the route itself calls (`applyStudioEditBatch` is
  literally "what `/save` does" per its own doc comment) — not a mock, not
  an isolated codemod-level test.
- MCP's `studio_apply_edits` (`server/ai/mcp/tools/studio/editTools.ts`, NOT
  touched — off-limits) takes `Type.Array(StudioEditSchema, ...)` and calls
  `applyStudioEditBatch(dir, edits)` directly, generically, with no
  kind-specific code — confirmed by reading the file (line ~64-84), the
  identical "ride the union for free" mechanism B2 (`class`) and E2.4
  (`insert-slot`/`promote-component`) already proved. Ran
  `bun test server/ai/mcp/tools/studio` (165 pass / 0 fail, unchanged) to
  confirm the schema widening didn't break anything there. Did **not** add a
  test inside `server/ai/**` (off-limits) — the reachability claim rests on
  reading the actual call chain plus my own tests exercising the exact
  functions that chain calls.
- **Known, pre-existing, unfixed gap** (not introduced by me, already
  flagged by E2.4 for `class`/`insert-slot`/`promote-component`):
  `editTools.ts`'s hand-written tool description string still lists only
  `kind: prop|text|style|class|literal|tag|asset|detach|swap|insert|delete|
  move|css` — doesn't mention `insert-slot`/`promote-component` and now
  `add-slot-prop` either. An agent reading the tool description alone won't
  know these three verbs exist. `server/ai/**` is off-limits to me; flagging
  for whoever next touches that file.

### Verification run (this pass)

```
./node_modules/.bin/tsc --noEmit -p tsconfig.json
  → clean, no output (whole project)

bun test server/handlers/__tests__/studioWriteback.test.ts
  → 72 pass / 0 fail (67 pre-existing + 5 new add-slot-prop tests)

bun test src/core/ast-codemods/__tests__/addSlotPropToComponent.test.ts
  → 19 pass / 0 fail (16 pre-existing + 3 new preview tests)

bun test src/core/page-parser src/core/ast-codemods src/__tests__/studio \
         server/handlers/__tests__/studioWriteback.test.ts
  → 619 pass / 0 fail

bun test server/ai/mcp/tools/studio
  → 165 pass / 0 fail (confirms StudioEditSchema's widened union doesn't
    break MCP; the transport-abort stack trace in liveReloadPush.test.ts is
    that test's own already-passing assertion logging, unrelated)

bun test src/__tests__/architecture/module-size-budgets.test.ts \
         src/__tests__/architecture/no-core-barrel-deep-imports.test.ts
  → 6 pass / 0 fail — studioWriteback.ts 622/700, studioEditSchemas.ts
    354/700, studioSlotWriteback.ts 319/700

./node_modules/.bin/eslint server/handlers/studioWriteback.ts \
  server/handlers/studioEditSchemas.ts server/handlers/studioSlotWriteback.ts \
  server/handlers/__tests__/studioWriteback.test.ts \
  src/core/ast-codemods/addSlotPropToComponent.ts \
  src/core/ast-codemods/__tests__/addSlotPropToComponent.test.ts
  → clean, no errors/warnings

bun test server/handlers/studio
  → 883 pass / 7 fail / 1 error — the 7 fail + 1 error are the SAME
    pre-existing baseline (`projectGuide.test.ts` Windows path separator ×5,
    `projectSeed.test.ts` Windows path, `projectMcpApprovals.test.ts` missing
    module from another in-flight session, `remoteAssetFetch.test.ts` ×2
    network-mock plumbing, `turnDesignReferences.test.ts` SVG-vs-raster) —
    confirmed via `git status -s` that none of those files are in my diff
```

Did not run `bun run build`/`bun run lint` (same concurrent-sibling
collision risk as before). Never `npx tsc`.

### Landmine found this pass, not already in the 578-line doc

**A shared working tree across concurrent agent sessions means a file you
already read can change under you between tool calls.** Mid-edit,
`studioWriteback.ts` was reported as "modified on disk since you last read
it" — C5 had exported a previously-private `isWritableSourceRel` for their
own `studio/reloadScope.ts`, unrelated to anything I was doing. Re-read the
live file before continuing rather than trusting the cached version, and the
rest of the edit applied cleanly on top. Worth stating explicitly for
whoever reads this next: **when an edit tool warns a file changed since your
last read, always re-read before your next edit to that file** — don't
assume the warning is spurious or that your in-memory model is still
accurate, especially for a file three-plus agents this wave are all
converging on.

### Not committed

Working tree only, this pass too — no `git add`, no commit, `STATE.md`
untouched.
