# server-engineer — Track C5 handoff (reload surgery)

Working tree only — nothing committed/staged, per instructions.

## What landed

A targeted per-file reload for structural commits (`move`/`delete`/`insert`
via `commitStructural` in `studioSaveRequests.ts`). Every OTHER reload path
(`saveSite`'s `shifted`/`sharedComponents` autosave-diff reload, `detach`/
`swap`/asset-replace one-shot commits) is **unchanged** — still a full
`requestCmsSiteReload()` — see "Scope boundary" below for why.

## The route

**`POST /admin/api/studio/reload-scope`** — new file
`server/handlers/studio/reloadScope.ts`, registered in `STUDIO_SUB_ROUTERS`.

- Request: `{ dir?: string, files: string[] }` — `files` are workspace-
  ROOT-relative POSIX paths (the same convention a node id's decoded `rel`
  uses).
- Response: `{ ok: true, narrow: true, pageIds: string[] }` (call the
  EXISTING `GET /load?pageIds=` with exactly these ids) or `{ ok: true,
  narrow: false }` (fall back to a full, unfiltered reload).

It does **not** duplicate `GET /load?pageIds=` — that route already existed
(WS-5.5, built for the MCP live-reload bridge) and already does "reparse
cheaply via `pageParseCache.ts`, hand back only the requested pages." This
route answers the one question that route couldn't ask itself: *is it safe
to ask for only these pages?*

I also added `touchedFiles` (workspace-relative) to `POST /save`'s response
(`StudioEditBatchResult.touchedFiles` already existed server-side but was
never put on the wire) — the client's `reloadStructuralScope` feeds it
straight into `/reload-scope`, so the server doesn't have to be asked to
re-derive what it already knew when it wrote the file.

## When a single-file reload is sufficient vs. when it widens

A touched file is narrow-safe only when **both** hold:

1. **It IS a page's own top-level route file** — found verbatim in
   `discoverPageFiles(pagesDir)`, mapped through the same `assignPageIds`
   every full load uses. A locally-inlined component file, or (App Router) a
   `layout.tsx`, never appears in that list — automatic widen. This is the
   common shape of "editing a shared component changes another page's
   output": component files live outside `pages/` in every real corpus this
   codebase has seen.
2. **No OTHER route's last-known parse depends on the same file** — the
   pathological case case 1 can't catch: a page file that's ALSO imported as
   a local component by some other page. `pageParseCache.ts` already records
   this per route (own file + resolved local-component sources); I added
   `anyOtherRouteDependsOnFile(dir, absFile, excludeCacheKeys)` to query it —
   `true` (found a sharer) or `null` (cache holds no entries at all for this
   dir — cold, nothing to honestly consult) both widen. Only `false` (checked
   every cached route for this dir, none depend on it) keeps the narrow path.

App Router projects always widen (never optimized for): `discoverPageFiles`/
`assignPageIds` has nothing to do with App Router's route-derived id scheme.
Correct and safe, matching the same documented scope boundary
`server/ai/mcp/tools/studio/touchedPageIds.ts` already accepts for the MCP
live-reload push. I deliberately **inlined** the same file→pageId mapping
logic rather than importing that module (it lives under mcp-tooling's owned
surface and only imports FROM `server/handlers/` today — importing it back
would reverse that layering) — cross-referenced in a comment so the two
don't silently drift, the same call store-engineer made for
`selectionSlice.ts`/`findNodeById.ts` this session.

Every incoming `files` entry is re-validated with the exact same adversarial-
path guard `studioWriteback.ts` applies to a decoded node-id location
(`isWritableSourceRel`, now exported for this reuse) before it's ever joined
onto `dir` — a malformed/adversarial entry is treated as unmappable (widen),
never trusted into a filesystem path.

## The client side

- `studioSaveRequests.ts` — `reloadStructuralScope(touchedFiles)`: asks
  `/reload-scope`; on `narrow: true`, fetches exactly those pages through
  `fetchStudioPagesById` (the SAME store-agnostic helper the MCP live-reload
  bridge already uses — it also advances `loadedValuesBaseline.ts`'s
  save-diff baseline for the reloaded pages) and dispatches them; on
  `narrow: false` or ANY failure at any step, falls back to the existing
  `requestCmsSiteReload()`. `commitStructural`'s `if (willReload) …` line is
  the only call-site change; every other gate (flush-first, `written > 0`)
  is untouched.
- New event `CMS_SITE_PAGES_PATCH_EVENT` (`@admin/state/adminEvents`,
  `dispatchCmsSitePagesPatch`) carries the already-fetched `{ pages,
  removedPageIds }` — `usePersistence.ts` is the one listener with store
  access, and turns it into `patchPages(...)`. Needed because
  `studioSaveRequests.ts` is reachable from `store/slices/site/nodeActions.ts`
  (part of the store's own build graph) — importing `useEditorStore` there
  directly would close a `store.ts -> nodeActions.ts -> studioSaveRequests.ts
  -> store.ts` cycle, the same reason `studioLiveReloadFetch.ts` stays
  store-agnostic and hands off to `agent/studioLiveReload.ts` instead.

## History preservation — reused, not duplicated

`patchPages` (`lifecycleActions.ts`) previously left `_historyPast`/
`_historyFuture` completely untouched on every call — correct for the
MCP live-reload bridge's ordinary case (an agent write to a page the user
wasn't mid-editing), but NOT safe once `patchPages` is also the landing spot
for the user's OWN structural edit: a move/delete/insert shifts every
`line:col` id below it, and the optimistic history entry pushed BEFORE the
POST can end up pointing at ids that no longer exist in the freshly-patched
page.

Fix: `patchPages` now computes `historySafe` against the SAME predicate
`loadSite` uses (`historySurvivesReload`/`collectAllNodeIds`, both from
`historyPreservation.ts` — no second predicate written), scoped over the
site AFTER the patch (a stored patch can reference any page's node, not just
the one(s) being patched). Safe (the common case — a patch that doesn't
touch a node any history entry references) leaves both arrays untouched,
same array reference; unsafe wipes them, exactly like `loadSite` would.
`_historyCoalesceKey` is always reset (a patch is a reload boundary too).
This is an incidental correctness improvement to the pre-existing MCP path
as well — not a regression, since the common case is unaffected and the
previously-silent-desync case now behaves like every other reload boundary.

Tests: `src/__tests__/editor-store/patchPages.test.ts`, new
`describe('patchPages — history (Track C5)')` (4 tests) — survives on an
untouched-page patch, wipes when the patch removes a referenced node id,
always ends an open coalescing burst, safe no-op on empty history.

## Refused-edit self-correction — NOT restored, and why

The documented Phase 0.2 regression (a refused move/delete stays visually
diverged until an unrelated later reload) is **unchanged by this work**.
`commitStructural`'s reload is still gated on `written > 0` — a pure
refusal never reaches `reloadStructuralScope` at all, narrow or full. I
deliberately did not build a targeted "revert just this transaction"
mechanism here: that's a genuinely different, harder problem (the plan's own
audit finding **E3**, explicitly deferred) — reviving it inside a task
scoped to reload SCOPE, not reload TRIGGERING, risks exactly the
Ctrl+Z-vs-in-flight-POST race E3 already catalogs as needing its own guard.
**A human/future task should treat E3 as still open.**

## Scope boundary — why only `commitStructural`

The plan's C5 text says "use it for structural commits" specifically.
`saveSite`'s own `shifted`/`sharedComponents` reload (the autosave diff loop
for prop/text/style/tag/class/css edits) and the one-shot `detach`/`swap`/
asset-replace commits are untouched — all still full reloads. Two reasons:

1. `isSharedSourceNodeId` reports `sharedComponents: true` UNCONDITIONALLY
   for `asset`/`detach`/`swap` edits (not just when they're genuinely
   shared) — there's no narrow-safe signal to extract from that boolean for
   those kinds without separately reworking what `sharedComponents` means,
   which is out of scope here.
2. Matching the session's own precedent (store-engineer scoped C4's
   dirty-hint filtering to exactly the one loop C4 named, leaving two
   adjacent, cheaper loops unfiltered) — matching the task's stated ask
   exactly, not expanding the blast radius to loops nobody asked to touch
   this round.

Extending `reloadStructuralScope`'s exact mechanism (it's generic — `files
in, pageIds/narrow out`, no edit-kind awareness) to `saveSite`'s reload
branch is a natural, low-risk follow-up: `saveSite` already computes
`result.touchedFiles`-equivalent data implicitly (every edit decodes a
location), it would just need the same field wired onto its own response.

## Measured before/after

**Server: response payload size**, 40-page synthetic board, one file edited
(`bun run` against real `loadStudioPages`/`tryServeStudioReloadScope`):

```
BEFORE (full reload):  40 pages,  38,637 bytes
AFTER  (C5 targeted):   1 page,    1,174 bytes   (97.0% smaller)
```

Server-side WALL TIME for `loadStudioPages` itself was NOT meaningfully
different (~37ms either way) — `pageParseCache.ts` already made every
untouched route's re-parse near-free before this change (a cache hit is a
handful of `stat()` calls). **That pre-existing cache is why this task's win
is real but doesn't show up as a parse-time number** — the actual defect
this track fixes is downstream of parsing entirely: transfer size, and (the
one that produces the visible "blink") how much of the CLIENT's `site.pages`
array gets replaced.

**Client: page-object reference churn** — the direct driver of "does this
board frame re-render" (measured via a real `useEditorStore` on the same
40-page board, one page's content changed):

```
OLD (loadSite, full reload):     40/40 page references changed
NEW (patchPages, C5 targeted):    1/40 page references changed
```

Proved BOTH ways (ran the "OLD" case as `loadSite` still does today, and the
"NEW" case as `commitStructural` now drives via `patchPages`) — not just
asserted. On a real board every one of those 39 untouched-but-formerly-
replaced Page references is exactly what makes `BoardFramesLayer`/board
frames whose props are that Page object re-render (React reference-equality
props). This is the "full blink" the task named, and it is now gone for the
common case (a plain structural edit that only touches its own page's file).

## Files touched

New:
- `server/handlers/studio/reloadScope.ts`
- `server/handlers/__tests__/reloadScope.test.ts`

Edited:
- `server/handlers/studio.ts` — `touchedFiles` in `/save`'s response
  (workspace-relative), `reload-scope` doc entry + sub-router registration.
  Line count: 586 (well under the 700 gate).
- `server/handlers/studio/pageParseCache.ts` — `anyOtherRouteDependsOnFile`
  export (additive; existing exports/behavior untouched).
- `server/handlers/studio/__tests__/pageParseCache.test.ts` — 5 new tests for
  the above.
- `server/handlers/studioWriteback.ts` — exported the pre-existing private
  `isWritableSourceRel` (one-line change: added `export`; a concurrent
  sibling — E2.2, `add-slot-prop` — landed unrelated changes to this same
  file in parallel; verified post-merge my export and doc comment are
  intact and their `add-slot-prop` work is untouched by me).
- `src/admin/pages/site/studio/studioSaveRequests.ts` — `touchedFiles` on
  `StudioSaveResponseSchema`; new `StudioReloadScopeResponseSchema` +
  `reloadStructuralScope`; `commitStructural`'s reload line now calls it.
- `src/admin/pages/site/studio/__tests__/studioSaveRequests.test.ts` —
  rewrote the fetch stub to route by URL (needed since `commitStructural`
  now makes a conditional SECOND request); all pre-existing assertions
  preserved with the extra `reload-scope` call accounted for; 6 new tests
  for the narrow/widen/failure/equivalence behavior.
- `src/admin/pages/site/store/slices/site/lifecycleActions.ts` —
  `patchPages` history-safety check (see above).
- `src/__tests__/editor-store/patchPages.test.ts` — doc comment correction
  + 4 new history tests.
- `src/admin/pages/site/hooks/usePersistence.ts` — new listener for
  `CMS_SITE_PAGES_PATCH_EVENT` -> `patchPages`.
- `src/admin/state/adminEvents.ts` — `CMS_SITE_PAGES_PATCH_EVENT` +
  `dispatchCmsSitePagesPatch` + `CmsSitePagesPatchDetail` (type-only `Page`
  import from `@core/page-tree` — erased at compile time, does not
  reintroduce the "heavy module" bundling concern this file's own header
  warns about).

## Verification run

```
./node_modules/.bin/tsc --noEmit -p tsconfig.json   → clean, zero errors
./node_modules/.bin/eslint <every file above>       → clean

bun test server/handlers/studio/__tests__/pageParseCache.test.ts \
         server/handlers/__tests__/reloadScope.test.ts
  → 28 pass / 0 fail

bun test src/admin/pages/site/studio/__tests__/studioSaveRequests.test.ts \
         src/__tests__/editor-store/patchPages.test.ts \
         src/__tests__/editor-store/structuralReloadHistoryPreservation.test.ts
  → 38 pass / 0 fail

bun test src/admin/pages/site/studio src/__tests__/editor-store src/__tests__/editor \
         src/__tests__/architecture/module-size-budgets.test.ts \
         src/__tests__/architecture/boundary-validation.test.ts \
         src/__tests__/architecture/no-full-site-scan-in-selectors.test.ts \
         server/handlers/__tests__ server/handlers/studio/__tests__
  → 1354 pass / 0 fail

bun test src/__tests__/canvas src/__tests__/panels src/__tests__/store \
         src/__tests__/persistence src/__tests__/site-explorer
  → 1338 pass / 8 fail — all 8 confirmed NOT mine (git status shows none of
    their source/test files touched by me; none reference anything I
    changed — `patchPages`/`usePersistence`/`CMS_SITE_*`/`reload-scope` grep
    empty across all 8 failing files). Concurrent canvas/panel work in
    progress this session (BoardFramesLayer, ModuleInserterDialog, AgentPanel
    — matches what prior handoffs in this same wave already flagged as
    "not mine").

Full bun test (whole repo):
  → 9377 pass / 36 fail / 1 error / 1 skip, across 913 files
    (documented baseline: ≈9114 pass / 38 fail — my slice contributes 0 of
    the 36; every one of my new/touched test files appears with 0 failures
    in the full run's own output; the 36 failing test NAMES were cross-
    checked against `git status --porcelain` — none touch a file this track
    edited).
```

## For the human to dogfood

- Drag-reorder a layer, delete an element, or insert a design-system
  component on a multi-page Studio board (several pages open as board
  frames) — confirm the OTHER frames do not visibly re-render/flash. Confirm
  the edited frame updates correctly and immediately.
- Make a text edit on Page A (let it autosave), then move a node on a
  DIFFERENT page B — confirm Ctrl+Z still reverts the Page A text edit
  afterward (history-preservation regression check, now exercised for the
  narrow path too).
- Edit a locally-shared component used by two pages (e.g. detach it, or — if
  reachable via the UI — move/delete/insert inside its own file) — confirm
  BOTH pages visibly update (this is the widen path; it should look/behave
  exactly like today's full reload, just correctly slower than the common
  case rather than silently wrong).
