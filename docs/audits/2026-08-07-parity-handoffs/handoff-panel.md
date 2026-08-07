# Phase 0 handoff — panel-designer (items 0.4, 0.5, 0.6, 0.7)

All four items landed. Nothing committed/staged/pushed — everything is in the
working tree, as instructed. Ran targeted `bun test` per item plus the four
architecture gates named in the brief; did NOT run `bun run build` / `bun run
lint` / browser tests, per instructions.

---

## 0.4 — CRITICAL: Componentize destroys work in Studio mode

**File:** `src/admin/pages/site/componentization/componentizeEligibility.ts:17-28`

**Mechanism:** added `!isStudioMode()` (imported from `@site/studio/studioMode`)
to the `&&` chain in `canComponentizeNode`. One predicate, both entry points
(`LayerNodeContextMenu.tsx:186`, `PropertiesPanelBody.tsx:159`) already read
it, so both the layer-tree context menu and the properties-panel button are
closed by this one change — confirmed both call sites via grep before/after.
Did not attempt to make Componentize work in Studio (per instructions —
that's Track E2 / promote-to-component, different substrate).

**Tested:** new `src/admin/pages/site/componentization/componentizeEligibility.test.ts`
(5 cases: refuses in Studio mode via URL param, refuses via sticky
localStorage flag, allows outside Studio mode, still refuses `base.body`/
`base.visual-component-ref` regardless of mode, still refuses inside a
Visual Component canvas outside Studio mode). `bun test
src/admin/pages/site/componentization/componentizeEligibility.test.ts` — 5
pass.

**Human dogfood:** open a Studio project (`?studio`), select any ordinary
element, open its context menu in the DOM/layers panel and check the
Properties panel — **"Componentize" must not appear at all** in either
place. Then load the SAME project without `?studio` (or `?studio=0`) against
the CMS editor and confirm Componentize is still offered there (regression
check — this must not have broken the CMS half).

---

## 0.5 — MAJOR: inline-style edits dropped silently, panel claims otherwise

Two parts, both landed, plus a third gap closed that the audit's evidence
section named but didn't put in the "Fix" list (S4, the whole-module case) —
I judged it in scope since the task text explicitly called it out as
"Additionally... dropped silently."

### (a) `SourceConstraintNotice.tsx` no longer lies

**File:** `src/admin/pages/site/panels/PropertiesPanel/SourceConstraintNotice.tsx:70-82`

Replaced the false doc comment ("refused per-property by the style controls
themselves, which say so") with an accurate one explaining `InlineStyleComposer`
now owns that fact and why it's correctly excluded from THIS notice (prop vs.
style scope, and redundancy once the composer says it).

### (b) Per-property lock: `InlineStyleComposer` now says so, before interaction

**Files:**
- `src/core/page-tree/sourceWritability.ts:88-101` — new `canWriteInlineStyleForModule(moduleId)`,
  exported via `src/core/page-tree/index.ts:37`. Pure: `moduleId.startsWith('base.')`.
  This is the SAME predicate `fsCodemodAdapter.ts`'s writeback loop already
  gates on (`node.moduleId.startsWith('base.')`), named and testable instead
  of implicit.
- `src/admin/pages/site/panels/PropertiesPanel/StyleSurface.tsx` — new
  `nodeModuleId?: string` and `codeProps?: string[]` props; new
  `inlineModuleUnwritable` branch (before the existing `sourceLockReason`
  branch) renders the same `EmptyState`-in-`.lockedContent` pattern already
  used for the `.map`-row case, but for "this element's style="" is owned by
  its own component's source, not this page's" (S4 — closes the fact that a
  `pkg.*`/`alm.*`/`studio.instance` node's inline styles were offered as a
  fully-live editor and silently discarded on save). `canReachElementTarget`
  also now factors this in, so the `StyleTargetChip`'s Element chip isn't
  offered as a switch target either.
- `src/admin/pages/site/panels/PropertiesPanel/InlineStyleComposer.tsx` —
  new `codeProps?: string[]` prop; filters it for `style:<prop>` entries
  (via `styleValueKey('')` as the prefix, not a hardcoded string), renders a
  persistent notice above the property sections naming the locked
  property/properties, BEFORE any interaction — not a toast. Also guards
  `handleChange`/`handleRemove`/`handleClearProperties` to no-op for a locked
  property (defense in depth alongside the store guard in `nodeActions.ts`,
  which I did not touch).
- `src/admin/pages/site/panels/PropertiesPanel/PropertiesPanelBody.tsx:236-249` —
  threads `nodeModuleId={selectedNode.moduleId}` and
  `codeProps={selectedNode.codeProps}` into `StyleSurface`; corrected the
  stale/misleading comment there too (it previously implied per-property
  refusals were "handled" with no UI, which was the R1 bug restated).

**Known gap, disclosed, not hidden:** this does NOT yet visually disable each
bespoke section's own leaf control (SpacingBoxControl/LayoutSection/
PositionSection/SizeSection/TypographySection/BackgroundSection/BorderControl
each own their own inputs — ScrubInput/ColorControl/SelectControl DO already
support a `disabled` prop, so that's mechanically feasible, but wiring a
`disabledProperties` map through all ~8 of those files is a real M-effort
follow-up, not S). What IS real: every locked property is named, in a
persistent notice, before the user touches anything, and the write is
refused client-side too (not just the pre-existing silent store guard) — the
"input snaps back with zero explanation" bug from finding R1 is gone. Full
per-row disabling is the natural next slice of Track F.

**Tested:** new `src/__tests__/panels/inlineStyleComposer.test.tsx` (5 cases:
names the locked property + doesn't claim it'll save; no notice when nothing
is code-valued; value stays unchanged after the lock; whole-module lock shows
the new notice instead of the editor; an ordinary `base.*` node shows the
live editor as before). Also re-ran `src/__tests__/panels/sourceConstraintNotice.test.tsx`
(8 cases, unaffected — comment-only change there) and the full
`propertiesPanel-redesign.test.tsx` (125 cases). All green.

**Cross-agent note (informational only, not a blocker):** `nodeActions.ts:452-459`
(store-owned, not touched) is still the ultimate enforcement point and is
correct as-is — I did not need anything changed there. If store-engineer's
work this wave touches that guard, the contract it must keep is:
`isStylePatchWritableToSource(node, patch)` returning `false` for any key in
the patch → the whole patch is refused, unchanged.

**Human dogfood:**
1. Select a `pkg.*`/`alm.*`/`studio.instance` node (a design-system component
   instance) that has no class assigned yet, and confirm the CSS area shows
   "Inline styles come from this component's own source" instead of a live
   editor.
2. Find (or fabricate via a template-literal `style={{ width: \`${x}%\` }}`
   on a `base.*` node) a node whose `codeProps` includes a `style:` entry, and
   confirm a persistent lock notice appears above the style sections, naming
   the property, BEFORE any typing.
3. Confirm an ordinary `base.*` node's inline styles still edit normally end
   to end (type a value, see it land on the canvas and survive a save).

---

## 0.6 — MAJOR: class assignment vanishes with no message

**Phase 0 scope, exactly as specced: honesty only, no codemod.**

**New file:** `src/admin/pages/site/panels/classAssignmentUnsavedNotice.ts` —
`notifyClassAssignmentUnsaved(nodeLabel, className, change: 'added'|'removed'|'reordered')`.
No-ops outside Studio mode (`isStudioMode()` gate — outside Studio, `classIds`
genuinely does persist, as a `data_rows` CMS record, so this must not warn
there). In Studio mode, pushes a `kind: 'warning'` toast: *"Applying a class
to an element can't be written to your source yet — "\<class\>" on \<node\>
will revert the next time this page loads."* (verb adapts for
removed/reordered).

**Wired at all three real mutation entry points** (grepped
`addNodeClass|removeNodeClass|reorderNodeClass|addNodeClasses` across
`panels/` to confirm these are the only three):
- `src/admin/pages/site/panels/PropertiesPanel/ClassPicker.tsx` — add
  (existing + newly-created class), remove, reorder (via the pill context
  menu's Move).
- `src/admin/pages/site/panels/SelectorsPanel/SelectorsPanel.tsx` —
  `handleApplyToSelected` / `handleRemoveFromSelected`.
- `src/admin/pages/site/panels/PropertiesPanel/MultiSelectorInspector.tsx` —
  `handleApplyToNode` (bulk-apply from a multi-selector selection), with an
  honest count label (`"card"` vs `"3 classes"`).

**Ambient-selector assignment (`setActiveClass` on a raw-selector rule) is
correctly NOT covered** — an ambient rule (`a:hover`, `.hero em`) matches by
selector text, not `node.classIds`, and DOES write back today (confirmed via
`docs/audits/2026-08-06/10-classes-vs-inline-styles.md` row 7 / `studioCss.ts:287-291`).

**This is a real, deliberate deviation from the literal "detect the delta at
save time" instruction — disclosed, not silent:**

I could not do the save-time version because it needs a `classIds` baseline
snapshot to diff against, and the two places that would live —
`fsCodemodAdapter.saveSite` and `loadedValuesBaseline.ts` — are both
explicitly store-engineer-owned this wave (and the former is on my absolute
do-not-touch list). What I built instead: an immediate, per-action toast at
every UI entry point I own. This is STRICTLY LESS good than a save-time diff
in three ways I want the next agent to know about, so they don't assume this
closes the loop entirely:

1. It only covers user-driven UI paths in `panels/`, not
   `src/admin/pages/site/agent/executor.ts` (AI-agent-driven class edits) or
   any future programmatic path.
2. It fires once per click, not once per save — a rapid multi-class session
   produces several toasts instead of one summary.
3. It cannot distinguish "this class was already in the source when the file
   loaded, unchanged" from "this class was just added" — but that
   distinction doesn't actually matter for THIS mechanism, because it only
   ever fires at the moment of an actual add/remove/reorder call, so it's
   never wrong, just narrower in scope than a load-vs-current diff would be.

**Exact seam for the real fix, if store-engineer wants to close it fully:**
add a per-node `classIds` snapshot to `loadedValuesBaseline.ts` (mirrors the
existing prop/style/text snapshot shape), diff it against `site.pages[].nodes[].classIds`
in `fsCodemodAdapter.saveSite` (same place `collectStyleRuleEdits` already
diffs `styleRules`), and for any node with a delta, call
`pushToast({ kind: 'warning', title: "Class change won't be saved", body: ... })`
— or better, delete my per-action toasts entirely and call this repo's new
`notifyClassAssignmentUnsaved` (already built, already tested, already
Studio-mode-gated) from that one save-time site instead, passing every
changed node/class pair. That single swap would upgrade this from "per-click"
to "per-save, complete coverage including agent edits" for free.

**Tested:** new `src/__tests__/panels/classAssignmentUnsavedNotice.test.tsx`
(5 cases: no-op outside Studio mode; warns with node+class named in Studio
mode; wording adapts per change kind; a real `ClassPicker` add-class
interaction toasts in Studio mode; the same interaction does NOT toast
outside Studio mode). Re-ran `classPicker.test.tsx` / `selectorsPanel.test.tsx`
/ `propertiesPanel-redesign.test.tsx` / `propertiesPanel.test.tsx` — 195 pass,
0 fail (all pre-existing behavior intact).

**Human dogfood:** in a Studio project (`?studio`), select an element, add a
new class via the class picker input (type a name, press Enter) — a warning
toast should appear immediately naming the class and the element, saying it
won't survive a reload. Remove the class via its pill's × — same warning,
"Removing" wording. Open the same project WITHOUT `?studio` (CMS mode) and
confirm adding/removing a class there produces NO warning toast (classes
really do persist there).

---

## 0.7 — MAJOR: save-skip toast never says which node

**Server (not off-limits — `fsCodemodAdapter.ts` was the only forbidden file
in this area; `studioWriteback.ts`/`studio.ts` are separate files, unclaimed
this wave, and the actual per-node data only exists there):**

- `server/handlers/studioWriteback.ts` — new exported type
  `StudioEditUnexplainedSkip { nodeId: string; kind: StudioEdit['kind'] }`;
  new `unexplainedSkips: StudioEditUnexplainedSkip[]` field on
  `StudioEditBatchResult`, populated in `applyStudioEditBatch`'s loop at both
  places `skipped` is currently incremented with no matching `refusals` entry
  (the `!outcome.applied` branch — "no writable source location" — and the
  catch block's non-refusing-kind branch, which today is `console.error`-only
  and invisible to the client). `unexplainedSkips.length` is always exactly
  `skipped - refusals.length`, so it's a drop-in upgrade, not a parallel
  count that can drift.
- `server/handlers/studio.ts` — `/admin/api/studio/save` now returns
  `unexplainedSkips` alongside the existing fields.
- `src/admin/pages/site/studio/studioSaveRequests.ts` —
  `StudioSaveResponseSchema` gains `unexplainedSkips: Type.Optional(Type.Array(...))`,
  same tolerant-rollout `Type.Optional` pattern as `refusals`/`swapDetails`
  right above it.

**Rendering half (mine, fully built and tested, NOT yet wired into the toast
call site because that call site is inside `fsCodemodAdapter.ts`):**

New `src/admin/pages/site/panels/unexplainedSkipsNotice.ts` —
`notifyUnexplainedSkips(skips: {nodeId, kind}[])`:
- resolves each `nodeId` against the CURRENT `site.pages[].nodes` (via
  `getNodeDisplayName` + `registry.get`), so the toast names real labels
  ("Heading", "Footer text"), not ids;
- lists up to 3 names, folds the rest into "and N more", and separately
  reports any id the current tree couldn't resolve (e.g. a node deleted in
  the same session before the response came back) as a bare count so nothing
  is silently dropped from the total;
- attaches a real `action` (`pushToast`'s existing single-action slot) that
  selects the affected node(s) on canvas — switching `activePageId` first if
  needed, and doing a REAL multi-select (`selectMany`) when every resolved
  skip shares one page. The button's label is honest about exactly how many
  it will select (`"Select node"` vs `"Select N nodes"`) — when skips span
  two pages, only the first page's nodes are selected in one gesture (no
  cross-page multi-select primitive exists), and the label says "Select
  node" (singular), not an inflated count.

**Cross-agent seam — the one line store-engineer (or whoever next touches
`fsCodemodAdapter.ts`) needs to change**, at `fsCodemodAdapter.ts:547-556`
(current):

```ts
const unexplainedSkips = result.skipped - refusals.length
if (unexplainedSkips > 0) {
  pushToast({
    kind: 'error',
    title: 'Some changes were not saved to source',
    body: `${unexplainedSkips} edit${unexplainedSkips === 1 ? '' : 's'} had no writable location in the code. ...`,
  })
}
```

replace with:

```ts
import { notifyUnexplainedSkips } from '@site/panels/unexplainedSkipsNotice'
// ...
notifyUnexplainedSkips(result.unexplainedSkips ?? [])
```

(keep computing `unexplainedSkips` — the NUMBER — for the existing
`if (unexplainedSkips === 0) commitNodeValuesBaseline(bumps)` gate a few
lines below; that logic is unrelated to the toast and untouched by this
swap). `result.unexplainedSkips` may be `undefined` against an older/dev
server that hasn't picked up this change yet — the `?? []` handles that, and
`notifyUnexplainedSkips([])` is a documented no-op.

**Tested:**
- `src/__tests__/panels/unexplainedSkipsNotice.test.ts` (7 cases: empty
  no-op; single node named with "Select node" action; 3-name-cap with "+N
  more"; unresolvable id falls back to a count; the Select action really
  switches page + selects; honest singular label when skips span two pages;
  real multi-select when they share one page). All pass.
- `server/handlers/__tests__/studioWriteback.test.ts` — 3 new cases under
  `applyStudioEditBatch — unexplainedSkips`: a synthetic-node skip is named
  with nodeId+kind; a NAMED refusal (e.g. an `insert` binding conflict) is
  NOT double-counted into `unexplainedSkips`; a successful write contributes
  nothing. Full file: 57 pass, 0 fail (was 54 before my additions).
- Re-ran `server/handlers/__tests__/studio.test.ts` (131 pass) and
  `server/ai/mcp/tools/studio/editTools.test.ts` (11 pass, read-only check —
  that MCP tool also calls `applyStudioEditBatch` and spreads its result;
  confirmed the additive field doesn't break it, though I did not modify
  anything under `server/ai/**`).

**Human dogfood:** this one is hard to trigger by hand (it needs a
prop/text/style edit that lands on a node with genuinely no writable source
location — e.g. `{c.someProp}` on a `.map` row, or a prop resolved from a
non-literal expression) AND needs the `fsCodemodAdapter.ts` call-site swap
above, which I deliberately left undone. Once that swap lands: edit a
code-valued prop that's known to be silently skipped, save, and confirm the
toast names the real node and offers a working "Select node" button.
Until then, the human should just confirm the SERVER change didn't regress
anything by dogfooding an ordinary save (edit a plain literal prop, confirm
it still writes and the "Saved" state still clears correctly) — item 0.7's
own visible payoff is blocked on that one-line swap in a file I couldn't
touch.

---

## Files touched (full list)

**Modified:**
- `src/admin/pages/site/componentization/componentizeEligibility.ts` (0.4)
- `src/core/page-tree/sourceWritability.ts` (0.5 — new `canWriteInlineStyleForModule`)
- `src/core/page-tree/index.ts` (0.5 — export it)
- `src/admin/pages/site/panels/PropertiesPanel/InlineStyleComposer.tsx` (0.5)
- `src/admin/pages/site/panels/PropertiesPanel/PropertiesPanelBody.tsx` (0.5)
- `src/admin/pages/site/panels/PropertiesPanel/SourceConstraintNotice.tsx` (0.5)
- `src/admin/pages/site/panels/PropertiesPanel/StyleSurface.tsx` (0.5)
- `src/admin/pages/site/panels/PropertiesPanel/ClassPicker.tsx` (0.6)
- `src/admin/pages/site/panels/PropertiesPanel/MultiSelectorInspector.tsx` (0.6)
- `src/admin/pages/site/panels/SelectorsPanel/SelectorsPanel.tsx` (0.6)
- `src/admin/pages/site/studio/studioSaveRequests.ts` (0.7 — schema)
- `server/handlers/studioWriteback.ts` (0.7 — server computation)
- `server/handlers/studio.ts` (0.7 — response wiring)
- `server/handlers/__tests__/studioWriteback.test.ts` (0.7 — new test cases)

**New:**
- `src/admin/pages/site/componentization/componentizeEligibility.test.ts`
- `src/core/page-tree/__tests__/sourceWritability.test.ts`
- `src/__tests__/panels/inlineStyleComposer.test.tsx`
- `src/admin/pages/site/panels/classAssignmentUnsavedNotice.ts`
- `src/__tests__/panels/classAssignmentUnsavedNotice.test.tsx`
- `src/admin/pages/site/panels/unexplainedSkipsNotice.ts`
- `src/__tests__/panels/unexplainedSkipsNotice.test.ts`

**Not touched (confirmed via `git diff --stat`, zero overlap):**
`store/**`, `fsCodemodAdapter.ts`, `canvas/**`, `server/ai/**`, `STATE.md`.

**Shared-file note:** `src/admin/pages/site/studio/studioSaveRequests.ts` is
ALSO being edited concurrently by the store-engineer this wave (their item
0.2 fix — the `flushEditorSave`/"reload only when a write landed" changes to
`commitStructural`, visible in `git diff` for that file alongside my small
`unexplainedSkips` schema addition). Not a conflict — different regions of
the same file, both changes coexist cleanly, `bun test
src/admin/pages/site/studio/__tests__/studioSaveRequests.test.ts` passes (7/7)
with both sets of edits present. Flagging only so nobody is surprised by a
larger-than-expected diff on that file.

## Tokens added to globals.css

None. No new CSS was needed for any of the four items — the two new notice
surfaces (`InlineStyleComposer`'s lock banner, `StyleSurface`'s new locked-
content branch) both reuse existing classes (`SharedComponentNotice.module.css`'s
`.notice`/`.icon`/`.text`, and `StyleSurface.module.css`'s `.lockedContent` +
the shared `EmptyState` primitive) rather than authoring new ones.

## Verification run

```
bun test src/admin/pages/site/componentization/componentizeEligibility.test.ts   # 5 pass
bun test src/core/page-tree/__tests__/sourceWritability.test.ts                  # 5 pass
bun test src/__tests__/panels/inlineStyleComposer.test.tsx                       # 5 pass
bun test src/__tests__/panels/classAssignmentUnsavedNotice.test.tsx              # 5 pass
bun test src/__tests__/panels/unexplainedSkipsNotice.test.ts                     # 7 pass
bun test server/handlers/__tests__/studioWriteback.test.ts                       # 57 pass
bun test server/handlers/__tests__/studio.test.ts                                # 131 pass
bun test src/__tests__/panels/                                                   # 431/432 pass — 1 pre-existing failure, NOT mine (agentPanel.test.tsx "attaches multiple local images"; confirmed via `git stash` that it fails identically on unmodified main)
bun test src/core/page-tree/                                                     # 27 pass
bun test src/__tests__/architecture/css-token-policy.test.ts                     # pass
bun test src/__tests__/architecture/no-css-var-fallbacks.test.ts                 # 1 pre-existing failure in canvas-engineer's in-progress rulerPaint.ts — confirmed zero diff from me on that file, not mine
bun test src/__tests__/architecture/button-primitive-usage.test.ts               # pass
bun test src/__tests__/architecture/ui-primitives-location.test.ts               # pass
bun test server/ai/mcp/tools/studio/editTools.test.ts                            # 11 pass (read-only check — spreads applyStudioEditBatch's result; confirmed additive field is harmless; did not modify anything under server/ai/**)
```

Did NOT run `bun run build` / `bun run lint` (parallel-agent `dist`/`.tsbuildinfo`
collision risk, per instructions) or any browser/e2e test.

## Human action needed

1. Dogfood 0.4 exactly as described above — this was the data-loss bug, verify
   it first.
2. Dogfood 0.5's three scenarios above (pkg/alm node, a `style:`-locked
   `base.*` node if one can be found/fabricated, ordinary node still works).
3. Dogfood 0.6 — add/remove a class in Studio mode, confirm the warning toast;
   confirm CMS mode (no `?studio`) stays silent (no regression).
4. 0.7's user-visible half needs the one-line `fsCodemodAdapter.ts` swap
   documented above before it's dogfoodable end-to-end — flag this to
   whichever agent picks up `fsCodemodAdapter.ts` next so the toast actually
   starts naming nodes.
