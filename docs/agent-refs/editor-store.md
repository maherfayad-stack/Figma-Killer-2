# Editor store

Zustand + Mutative, composed from slices. Source:
`src/admin/pages/site/store/`.

---

## Non-negotiables

1. **Draft-mutation style.** `set((s) => { s.x = … })`. A recipe that returns a
   partial object must wrap it in `rawReturn(...)` or Mutative emits a perf
   warning. `immer` is banned.
2. **All tree mutations go through `mutateActiveTree`.** Never mutate
   `page.nodes` directly from a component or another slice.
3. **Never scan every node of every page inside a selector.** Selectors run on
   every store change. Precompute an index in the slice instead.
4. **Selectors must return stable references** or a primitive. Returning a fresh
   object/array literal re-renders on every store change.

---

## Slices

| Slice | Owns |
|---|---|
| `siteSlice.ts` | The site document, `loadSite`, `saveSite`, `patchPages`, the 11 named tree actions |
| `site/helpers.ts` | `resolveActiveTreeTarget`, `mutateActiveTree` — **the only place that knows which tree is active** |
| `boardSlice.ts` | Boards, frames, `addFrame`, `setFramePosition`, `setFrameSize`, `seedFramesForActiveBoard`, `selectedFrameIds` (WS-7.1 frame multi-select, implementation in `boardFrameSelectionActions.ts`), `frameDefaults` + bulk frame actions (WS-7.2), `boardsPendingExplicitRemoval` (autosave hazard guard, see below) |
| `selectionSlice.ts` | `selectedNodeId`, `selectedNodeIds`, multi-select, focus target — WS-7.3: on a studio board, a multi-selection may span any of the board's own curated frames, not just the active page (`resolveSelectableNode`) |
| `canvasSlice.ts` | `canvasView` ('design' \| 'live'), zoom/pan, `activeBreakpointId`, `runScripts` |
| `inlineEditSlice.ts` | `activeInlineEdit` — one session globally |
| `styleRuleSlice.ts` | The CSS class registry |
| `uiSlice.ts` | `activeDocument`, panel open/closed, right sidebar expanded |
| `sitePanelSlice.ts` | Panel-specific UI state |
| `clipboardSlice.ts` | Copy/paste of subtrees |
| `filesSlice.ts` | Site files / code assets |
| `saveTrackingSlice.ts` | Dirty tracking, autosave cadence |
| `visualComponentsSlice.ts`, `vcTreeOps.ts`, `vcSlotReconcile.ts` | Visual Components |
| `layoutsSlice.ts`, `settingsSlice.ts` | Layouts, editor settings |

---

## The mutation API

Every mutation in `src/core/page-tree/mutations.ts` takes a `NodeTree<TNode>` and
is **tree-agnostic** — it knows nothing about pages vs Visual Components.

The 11 named store actions are one-liners over `mutateActiveTree`:

```
insertNode · deleteNode · updateNodeProps · setBreakpointOverride ·
clearBreakpointOverride · renameNode · toggleNodeLocked · toggleNodeHidden ·
moveNode · duplicateNode · wrapNode
```

**They must not contain a `kind === 'visualComponent'` branch.**
Gate: `no-vc-mode-branches-in-mutations.test.ts`.

Plugins reach the same engine via `applyTreeOperation(tree, op)` from
`@core/page-tree` (`treeOperations.ts` — the dispatcher, split from the
primitives in `struct-01`), dispatched on `op.kind`. Its structural branches
run the same source gate the store actions do and throw `SourceStructureError`
rather than mutating a studio-imported tree in a way nothing can write back.

---

## Studio-specific store behaviour

**Structural actions refuse before they mutate (`struct-01`).** `insertNode`,
`deleteNode(s)`, `moveNode(s)`, `duplicateNode(s)` and `wrapNode(s)` ask
`structuralSourceEdits.ts` first. On a studio-imported tree they either commit a
`move`/`delete`/`insert` edit to the user's `.tsx` (`commitStudioMove` /
`commitStudioDelete` / `commitStudioInsert`) or toast a reason and do nothing —
never both nothing and nothing said, which is what they used to do.

**`insertNode` does not mutate a studio tree at all.** It plans the write
(`planSourceInsert` — which resolves the synthetic page root to the page's
returned root element, and downgrades an unaddressable anchor to "append"),
commits it, and returns `''`. The new node arrives via the reload, with a real
source id. The success toast is therefore pushed by `commitStudioInsert`, not by
the inserter: until the write lands there is nothing to report. Announced, not silent: unlike a
value refusal, the gesture is always a deliberate one a person just made.

**`updateNodeProps` and `setNodeInlineStyles` refuse a patch if *any* key is
code-valued** — all-or-nothing, because a half-applied patch is a canvas that
disagrees with the file it mirrors. Both refuse **silently**: they are also
called by agents and plugins, where a toast would be noise. The one announced
refusal is canvas double-click on a code-valued text prop, because the user just
double-clicked real copy and nothing happened.

**`loadSite` keeps the currently-open page** when the incoming site still
contains its id. Resetting to home is right when opening a different project and
wrong when re-syncing the open one.

**`patchPages(input)`** merges a freshly-re-parsed SUBSET of pages into
`site.pages` — the agent-write live-reload path (a `execution: 'server'` tool
wrote `.tsx` to disk; only the touched files get re-parsed and patched here,
`loadSite`'s full-reload is for a whole-workspace re-parse). `input.pages`
upserts by id (appends an unrecognised id — how `studio_create_page` lands);
`input.removedPageIds` drops a page confirmed gone, its board frame(s), and
any dangling `selectedFrameIds`/selection entry. **Deliberately bypasses
`mutateSite`/`runHistoricMutation`**: it never flips `hasUnsavedChanges` and
never pushes undo history, because this content came FROM disk — recording it
as a "change" would queue an autosave that writes what was just read straight
back out (the write → reload → re-dirty → autosave → write loop
`fsCodemodAdapter.test.ts`'s header names). A selected/edited node id survives
the patch iff it still resolves through `_nodeIdToPageIds` afterward — an
insert/delete shifts every `relFile:line:col` id below it (see
`server/ai/tools/studio/staleness.ts`'s "shifted" contract), so a shifted id
simply isn't a key in the fresh page anymore and the selection drops cleanly.
A page that had local (unsaved) edits and also got overwritten toasts
`'Local edits overwritten'` — the "merge: reload only touched pages" policy's
one explicit data-loss case.

`input.styleRules`/`input.conditions` carry the PROJECT-WIDE registries the
same reload recomputed, and are replaced wholesale (never merged — the server
recomputes them from disk, so a merge would resurrect a rule the edit
deleted). They are not optional-because-nice-to-have: a re-parsed page's
`classIds` name rules from the registry computed WITH it, and rendering it
against the previous one resolves those nodes to no class name at all
(`NodeRenderer`'s `getCanvasNodeClassName`), so the page draws unstyled and
collapsed — bare containers falling back to the "Empty container" placeholder
— until a manual refresh. Omit them only when the caller genuinely has nothing
fresher (a test, or a patch that never re-read the project). `?pageIds=`
callers get them from `fetchStudioPagesById`, which also applies the meta
line's store-free halves (`authoredCss`, `vendorCss`, `styleRuleSources`,
`trust`) itself.

**`saveSite`** collects dirty nodes into a `StudioEdit[]` batch:
- `tag`/`customTag` collapse into one `effectiveTag`, diffed against the load
  baseline, emitted as `kind: 'tag'`;
- resolved text with a `textOrigin` is emitted as `kind: 'literal'` with the
  **origin's** `rel:line:col` as its `nodeId` — and that path runs **before** the
  `hasWritableSourceLocation` guard, because that guard is about JSX locations
  and a literal edit has nothing to do with the node's own id.

---

## Undo / redo

Patch-based, via Mutative `create({ enablePatches })`. Details:
[`docs/reference/editor-history.md`](../reference/editor-history.md).

**Coalescing:** single-field patches coalesce under a key like
`props:<nodeId>:<prop>`, so a burst of keystrokes is ONE undo entry.
`startInlineEdit`/`endInlineEdit` reset `_historyCoalesceKey` so an inline-edit
burst never folds into a Properties-panel burst for the same prop.

If you add a mutation, decide its coalesce key deliberately. Wrong key = either
one undo wipes unrelated work, or every keystroke is its own entry.

---

## Boards autosave — the overwrite hazard, and its guard

`boardsDirty` → an 800ms debounce → a whole-file `POST /admin/api/studio/boards`
overwrite is a standing pattern risk: anything that marks `boardsDirty` from
in-memory state that does not reflect the real on-disk file reproduces
`STATE.md` → `store-02`'s incident (`.studio/boards.json` rewritten with a
reduced frame set). Two hardenings live in `AdminCanvasLayout.tsx` /
`boardsSaveGuard.ts` / `boardSlice.ts`:

- **A stale-load race guard.** `useStudioBoardsPersistence`'s `load()` can run
  again (project switch) while a previous fetch is still in flight; a
  monotonic token discards a late-resolving, now-superseded response instead
  of letting it overwrite newer (or a different project's) state.
- **A content-level save refusal (`boardsSaveGuard.ts`).** Before every
  autosave, the outgoing frame-id set is compared against the last
  known-good (load- or save-confirmed) baseline. Missing a baseline id
  refuses the write UNLESS `boardSlice.boardsPendingExplicitRemoval` is true
  — set by `removeFrame`/`removeFrameById`/`removeBoard` (only when something
  was actually removed) and by `patchPages`'s own frame cleanup for a
  confirmed-deleted page, cleared by `markBoardsClean`. A refusal never
  writes, toasts once, and keeps retrying on the debounce tick rather than
  going permanently quiet.

---

## Frame multi-select and bulk actions (WS-7)

**A board frame is not a node.** `boardSlice.selectedFrameIds` is a wholly
separate selection domain from `selectionSlice.selectedNodeIds` — selecting a
frame clears the node selection and vice versa (mutual exclusivity), so
`PropertiesPanel` always shows exactly one of the frame inspector
(`FrameBulkInspector`) or the node inspector.

- **Selection entry points:** frame header click (replace) / Shift-click
  (toggle) in `BoardFramesLayer.tsx`; `⌘/Ctrl+A` on empty canvas
  (`selectAllFrames`, wired through the keybindings registry as the virtual
  command `board.selectAllFrames`); marquee-drag on empty canvas
  (`useMarqueeSelection.ts` + `framesInMarquee.ts`). The marquee hit-tests each
  frame's **rendered** box, measured once at pointerdown — not the board-space
  rect `frameVirtualization.ts` derives from `board.frames[].height`, which is a
  fiction for every auto-height frame (`canvas-04`), i.e. every frame on a
  freshly seeded board.
- **Bulk frame actions** (`setSelectedFramesSize`, `applyWidthToAllFrames`,
  `setFrameHeights`, `alignSelectedFrames`, `distributeSelectedFrames`,
  `tidySelectedFrames`) all resolve their target set from `selectedFrameIds`
  against the active board and go through the same `upsertFrame`/`resizeFrame`
  pure transforms as the single-frame actions, so every write still
  round-trips through `parseBoardsFile` — no parallel validator.
- **`frameDefaults`** mirrors `.studio/meta.json`'s `frameDefaults`
  (server-owned, `mergeProjectFrameDefaults` in `studioProjects.ts`,
  `/admin/api/studio/frame-defaults`). The store never calls that endpoint
  itself — `applyWidthToAllFrames` only updates local state + every frame's
  width; the calling UI (`FrameBulkInspector`) persists the default via
  `frameDefaultsApi.ts` afterward. `addFrame`/`seedFramesForActiveBoard`
  consult the local mirror so a page added later inherits it.
- **Cross-frame node multi-select (WS-7.3):** on a studio board,
  `selectionSlice`'s `sameTree`/`filterMultiSelectableIds` widen their scope
  from "the single active page" to "any page curated as a frame on the active
  board" (`resolveSelectableNode`). Outside board mode this is unchanged
  (same-page-only). `deleteNodes`/`wrapNodes` route through
  `site/helpers.ts`'s `mutateTreesForNodeIds`, which groups selected ids by
  page (`site/nodeTreeGrouping.ts`'s `groupNodeIdsByPage`, built on the
  WS-5.2 `_nodeIdToPageIds` index) and runs one `runHistoricMutation`
  transaction across every touched page — a cross-frame bulk action is still
  ONE undo step. A shared/composed node id (Next.js route chrome) is mutated
  on every page copy it appears on, matching the save route's own dedup.

## Adding state — checklist

- [ ] Does it belong in an existing slice? Prefer that over a new one.
- [ ] Is it derivable? Derive it in a selector instead of storing it.
- [ ] Does it need to survive a reload? If so it belongs in `.studio/` on disk
      (project data) or in editor preferences — not in transient store state.
- [ ] Is the selector O(1)? If it walks the tree, precompute an index.
- [ ] Does a tree mutation need a history entry and a coalesce key?
- [ ] Does a new action need to consult `isPropWritableToSource`?
