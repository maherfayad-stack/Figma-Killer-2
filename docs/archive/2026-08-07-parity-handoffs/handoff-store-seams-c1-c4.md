# store-engineer — resume handoff (0.6/0.7 flake fix, C1, C4)

Continuation of `handoff-store.md` (0.1/0.2/0.3, already delivered). This
covers the work the coordinator flagged as open after the session-limit
restart: the failing 0.6-seam test, C1, and C4. Nothing committed/staged.

## Starting state (what I found, not what I did)

Before touching anything I re-verified what a prior instance of this same
session had already landed (working tree only, never lost):

- **0.6 seam** (class-assignment-vanishes-silently honesty fix) was
  **already fully wired**: `loadedValuesBaseline.ts` has `collectClassIdsDrift`
  / `commitClassIdsBaseline`; `classAssignmentUnsavedNotice.ts` exists and is
  called from `fsCodemodAdapter.ts`'s `saveSite` exactly once per tick. The
  interim per-action toast call sites (`ClassPicker`/`SelectorsPanel`/
  `MultiSelectorInspector`) were **already deleted** — I grepped the whole
  `panels/` tree for `notifyClassAssignmentUnsaved`/the toast title string and
  found only the one call site in `fsCodemodAdapter.ts`. **Nothing left to
  delete for item 0.6** — it was done before the restart.
- **0.7 seam** (unexplained-skips toast names the node) was **already fully
  wired** too: `unexplainedSkipsNotice.ts` exists and `fsCodemodAdapter.ts`
  already calls `notifyUnexplainedSkips(result.unexplainedSkips ?? [])` in
  place of the old bare-count toast. Nothing left to wire.

So both "seam" items were functionally complete; what was actually broken was
**test flakiness in three test files**, which is what I fixed.

## Root cause of all three failing tests: the toast bus doesn't auto-reset WITHIN a test

`src/ui/components/Toast/toastBus.ts`'s `toasts` array is a true module
singleton. `src/__tests__/setup.ts` registers a global `afterEach` that calls
`__resetToastBusForTests()` — so toasts never leak ACROSS tests. But nothing
resets it BETWEEN two `pushToast`-triggering actions inside the SAME test. All
three failures were tests that fire a toast-producing action TWICE in one
`it()` block and read `collectToasts()` (a snapshot subscribe helper) after
each — the second read still included the first toast, since nothing had
removed it.

**Fixed by importing `__resetToastBusForTests` and draining the bus between
the two actions**, in three files:

1. `src/admin/pages/site/studio/__tests__/fsCodemodAdapter.test.ts` —
   `class assignment drift is warned at save time... > does NOT re-toast on
   the next save tick when nothing further changed`. Added
   `__resetToastBusForTests()` between the two `saveSite` calls.
2. `src/__tests__/panels/classAssignmentUnsavedNotice.test.tsx` —
   `describes a removal and a reorder distinctly from an addition`. Same fix
   between the two `notifyClassAssignmentUnsaved` calls.
3. `src/__tests__/panels/unexplainedSkipsNotice.test.ts` — **different root
   cause**, see below.

### `unexplainedSkipsNotice.test.ts`'s failure was a DIFFERENT, real isolation bug

`selects a real multi-selection when all resolved skips share one page` calls
`toast.action.onSelect()` → `selectSkippedNodes` → `useEditorStore.getState()
.selectMany(ids)` → `filterMultiSelectableIds` → `resolveSelectableNode`,
which branches on `selectActiveBoard(state)`. This test file's `resetStore()`
never reset `activeBoardId`, so if ANY earlier test in the same `bun test`
process left a board active, `resolveSelectableNode` takes the board-mode
branch and resolves via `state._nodeIdToPageIds` — an index this test's
`loadTwoPageSite()` never populates (it bypasses the `loadSite` action, so
there's no `rebuildNodeIndexes` call). Every id then resolves to nothing and
the multi-select silently comes back empty.

**Fixed** by adding `activeBoardId: null` to `resetStore()` — the same
convention `bulkFrameSize.test.ts`/`crossFrameNodeActions.test.ts`/
`multiSelect.test.ts` already use to neutralize `selectActiveBoard`. Verified
this actually was the cause by running the file alone (passed) vs. combined
with `src/__tests__/editor-store` + `src/__tests__/canvas` (failed before the
fix, passes after).

All three files verified individually and in combination
(`bun test src/__tests__/editor-store src/__tests__/canvas src/__tests__/panels`
→ 1439 pass / 1 fail, the 1 being `agentPanel.test.tsx`, unrelated — see
below).

## C1 — `selectCanvasPageFor` sweep-scoped memo

`src/admin/pages/site/store/store.ts` — added a **sweep-scoped `Map` memo**,
distinct in shape from `selectActivePage`'s single-slot memo (that selector
only ever sees ONE `(site, activePageId)` pair per sweep; `selectCanvasPageFor`
is called with a DIFFERENT `pageId` per board frame, so a single slot would
thrash and never actually cache anything across frames in the same commit).

```ts
let _canvasPageForCache: { site: object; byPageId: Map<string, Page | null> } | null = null
function lookupCanvasPageById(site: SiteDocument, pageId: string): Page | null { ... }
```

`selectCanvasPageFor`'s final `s.site?.pages.find(...)` fallback now calls
`lookupCanvasPageById(s.site, pageId)`. The `frameId`/locale branch above it
(`selectActiveBoard(s)?.frames.find(...)`, O(frames) not O(pages)) is
**untouched** — it's cheap and not what C1's evidence names.

**New test:** `src/__tests__/store/selectCanvasPageFor.test.ts` (5 tests,
mirrors `selectActivePage.test.ts`'s existing pattern): scans once per
`(site, pageId)`; does NOT thrash across different pageIds in the same sweep
(the case a single-slot memo would get wrong); re-scans on site identity
change; caches a missing-page `null`; short-circuits with no site.

## C4 — two independent fixes

### (a) `findSelectableNode` — O(pages) scan → `_nodeIdToPageIds` index (E10)

`src/admin/pages/site/store/slices/selectionSlice.ts` — rewrote the
`for (const page of state.site.pages) { if (page.nodes[nodeId]) return ... }`
scan to read `state._nodeIdToPageIds` first, mirroring
`canvas/InPlaceInspector/findNodeById.ts`'s exact idiom (documented reasoning:
a node id shared across pages — a composed Next.js `layout.tsx` — prefers the
id's copy on the ACTIVE page). I did **not** import `findNodeById.ts` directly
(that file lives under `canvas/`, and a store-slice file importing FROM
`canvas/` would invert this codebase's dependency direction) — I inlined the
identical logic instead, with a doc comment cross-referencing it so the two
don't silently drift apart (which is exactly what had already happened once).

This is a genuine behavior improvement, not just a perf-neutral rewrite: the
OLD code returned "whichever page happened to be first in `site.pages`" for a
shared id; the NEW code prefers the active page, matching
`resolveSelectableNode`/`findNodeById.ts`'s already-established convention.

**New test:** `src/__tests__/editor-store/selectionSlice.test.ts` — added
`prefers the active page copy over the first-in-array-order page when a node
id is shared`: two pages share one node id with DIFFERENT `classIds` on each;
selecting it on page B (the active page) must resolve page B's copy
(`class-b`), not page A's (`class-a`, which is first in `site.pages`).

### (b) `saveSite`'s dirty-hint filtering — the bigger, riskier change

`src/admin/pages/site/studio/fsCodemodAdapter.ts` — `saveSite`'s main
prop/text/style/tag/callSiteProps loop now scans `dirtyPages` instead of
`site.pages`, where:

```ts
const dirty = opts.dirty
const dirtyPages = !dirty || dirty.all ? site.pages : site.pages.filter((page) => dirty.pageIds.has(page.id))
```

Falls back to a full scan when `opts.dirty` is absent or `.all` — matching
`SaveSiteOptions`'s own documented contract ("Absent → replace-mode full
save"). Renamed the parameter from `_opts` to `opts` since it's now read.

**Deliberate scope boundary, stated in-code and here:** only this ONE loop is
filtered. `collectClassIdsDrift(site.pages)` (0.6 seam), `commitClassIdsBaseline
(site.pages)`, and `collectStyleRuleEdits(site.styleRules)` are **left
scanning everything, unfiltered**. Reasoning: `collectStyleRuleEdits` iterates
`site.styleRules` (a flat map), not `site.pages` — genuinely unrelated cost,
untouched either way. `collectClassIdsDrift`/`commitClassIdsBaseline` DO share
the O(pages×nodes) shape, but their per-node work is far cheaper (an array
equality check vs. per-property `isPropWritableToSource` diffing), and I
judged the extra correctness risk of touching the JUST-landed, just-tested 0.6
seam not worth the residual perf win. If a human wants the full elimination,
extending the same `dirtyPages` filter to those two calls is straightforward
follow-up — I left it out to keep this change's blast radius matched to what
C4 actually asks for.

**Why this is safe (the reasoning behind not weakening 0.1), verified by
tracing the actual code, not assumed:**

- `opts.dirty` (`SaveDirtyHints`, via `usePersistence.ts`'s
  `takeDirtySaveSnapshot()`) is fed by `_dirtySave`, which
  `helpers.ts`'s `runHistoricMutation` populates via
  `collectDirtyFromSitePatches` on **every** `mutateSite`/`mutateActiveTree`
  call with `touched.size > 0` — i.e. every node prop/text/style/classIds/tag
  edit, from ANY origin (Properties panel, agent, plugin RPC), since those are
  the ONLY paths that mutate page node content per the architecture's own "one
  mutation contract" rule. `undo()`/`redo()` mark dirty the same way. A page
  NOT in `dirty.pageIds` therefore has produced zero site-relative patches
  since the last save snapshot was taken — it cannot hold an edit this loop
  would have found.
- `patchPages` (the agent-write live-reload merge) explicitly **clears**
  dirty marks for the pages it just overwrote with fresh-from-disk content —
  correct, since there's nothing pending to re-save for a page that was just
  reloaded to match disk.

**CRITICAL test, required by the work order and written explicitly:**
`fsCodemodAdapter.test.ts`'s new `describe('dirty-hint save diff (C4) —
filters the scan, does not weaken 0.1')`, 5 tests:
1. Ships only the dirty page's edit; a changed value on a non-dirty page is
   never scanned/shipped.
2. `opts.dirty` absent → full scan (both pages' edits ship).
3. `dirty.all === true` (with an unrelated `pageIds` set) → full scan.
4. **The 0.1 interaction test**: "Hell" → "Hello" (autosave, home-only dirty
   hint) → undo to "Hell" (autosave again, home-only dirty hint, matching how
   the undo itself would re-mark `home` dirty in the real store) → asserts a
   **second POST still fires** carrying the reverting edit. This is the exact
   E1 repro, run again with dirty-hint filtering active, proving the
   filtering didn't reintroduce the 0.1 bug.
5. A page that's NEVER dirty across two ticks: proves its baseline is left
   exactly as loaded (not silently adopted from a filtered-out, unshipped
   value) — the filtered-out save must not corrupt the baseline for a LATER
   tick where that page finally does become dirty.

All 5 pass; full `fsCodemodAdapter.test.ts` is 28/28 (23 pre-existing + 5 new).

## A gate I broke and fixed: module-size-budgets

My C4 doc comment initially pushed `fsCodemodAdapter.ts` to 701 lines,
tripping the 700-line ceiling gate (`module-size-budgets.test.ts`) — this is
the SAME file the coordinator flagged as one of the two currently-frozen ones
(no — re-read: the two frozen ones are `server/handlers/studioWriteback.ts`
and `server/handlers/studio.ts`, NOT this file; but the gate is real and
applies here too). Trimmed the new comment block from ~20 lines to ~9 while
keeping every load-bearing fact (why absent/`.all` fall back to full scan, and
the explicit scope boundary). File is now 690 lines.
`module-size-budgets.test.ts` passes.

## Verification

```
./node_modules/.bin/tsc --noEmit -p tsconfig.json     # clean, zero errors

bun test src/admin/pages/site/studio src/__tests__/editor-store \
  src/__tests__/editor src/__tests__/store src/__tests__/panels \
  src/__tests__/architecture/centralized-site-mutation-history.test.ts \
  src/__tests__/architecture/no-vc-mode-branches-in-mutations.test.ts \
  src/__tests__/architecture/no-full-site-scan-in-selectors.test.ts \
  src/__tests__/architecture/canvas-aware-selectors.test.ts \
  src/__tests__/architecture/module-size-budgets.test.ts
# => 1057 pass / 2 fail (stable across repeated runs)
```

The 2 failures, confirmed NOT mine (checked `git diff` on each file — neither
touched by me — and confirmed by content-grep that neither imports anything I
edited):
- `AgentPanel > attaches multiple local images through the picker beside Send`
  — `src/__tests__/panels/agentPanel.test.tsx`, an `AgentPanel`/
  `ModelEffortPicker`/`server/ai/*` concern, actively being edited by another
  agent this wave per `git status`.
- `Zustand selector stability > ... do not use inline unstable fallback
  references` — flags `src/admin/pages/site/panels/PropertiesPanel/
  InstanceCallSiteView.tsx:115`, a file I never touched, currently unmodified
  in the working tree relative to HEAD (`git diff --stat` shows nothing) —
  this is a **pre-existing** violation the gate happens to catch, not
  something my changes introduced or could fix without touching
  panel-designer's file.

Did NOT run `bun run build`/`bun run lint` per instructions — the orchestrator
runs the full gate at the end.

## Files touched this round (on top of the earlier 0.1/0.2/0.3 handoff's list)

- `src/admin/pages/site/store/store.ts` — C1 memo (`_canvasPageForCache`,
  `lookupCanvasPageById`)
- `src/admin/pages/site/store/slices/selectionSlice.ts` — `findSelectableNode`
  index-based rewrite (C4/E10)
- `src/admin/pages/site/studio/fsCodemodAdapter.ts` — `saveSite` dirty-hint
  page filtering (C4)
- `src/admin/pages/site/studio/__tests__/fsCodemodAdapter.test.ts` — toast-bus
  drain fix (0.6 seam test) + new C4 describe block (5 tests)
- `src/__tests__/panels/classAssignmentUnsavedNotice.test.tsx` — toast-bus
  drain fix
- `src/__tests__/panels/unexplainedSkipsNotice.test.ts` — `activeBoardId: null`
  isolation fix
- `src/__tests__/editor-store/selectionSlice.test.ts` — new C4/E10 regression
  test
- New: `src/__tests__/store/selectCanvasPageFor.test.ts` — C1 regression tests

## What remains (nothing outstanding from my three assigned follow-ups)

0.6, 0.7, C1, and C4 are all complete and verified. I did not reach C2/C3/C5
(BoardFramesLayer O(frames×pages), CSS-in-render-body, reload-surgery
targeted reparse) — these were never in my assigned scope for this resume
(the coordinator's list was explicitly "C1 ... and C4 if you had not reached
them"), and C2/C3 touch `canvas/` files that historically belonged to
canvas-engineer even though the coordinator says no other agents are running
now. Flagging rather than assuming — a human should confirm whether C2/C3/C5
are wanted from me or a fresh dispatch.

## For the human to dogfood

- Open a multi-page Studio project, edit a text field on page A, wait for
  autosave, edit a DIFFERENT field on page A again, undo twice — confirm both
  reverts land on disk (0.1 + C4 interaction, now covered by an explicit
  automated test but worth a real-browser sanity check since C4 changes a
  code path every autosave tick runs through).
- Assign/remove a class on an element in Studio mode, wait for autosave —
  confirm the "Class change won't be saved" toast still fires exactly once
  (not per click), and does NOT re-fire on the next unrelated autosave tick.
