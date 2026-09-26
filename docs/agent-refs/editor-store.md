# Editor store
> **Purpose:** the Zustand editor store: slices, tree mutations, undo history, selection · **Read when:** touching store state, mutations or undo · **Trust:** current · **Owner:** store-engineer · **Verified:** not yet

Zustand + Mutative, composed from slices. Source:
`src/admin/pages/site/store/`.

---

## Non-negotiables

1. **Draft-mutation style.** `set((s) => { s.x = … })`. A recipe that returns a
   partial object must wrap it in `rawReturn(...)` or Mutative emits a perf
   warning. `immer` is banned.
2. **All tree mutations go through `mutateActiveTree`.** Never mutate
   `page.nodes` directly from a component or another slice.
3. **Never scan every node of every page inside a selector** — *or in anything
   a selector or render body calls.* Selectors run on every store change.
   Precompute an index in the slice instead.
4. **Selectors must return stable references** or a primitive. Returning a fresh
   object/array literal re-renders on every store change.
5. **Not everything the editor knows is store state.** Every `set()` runs every
   mounted selector — ~3,600 `NodeRenderer` instances on a 40 × 300 board with
   12 frames mounted. State that changes on every pointer move and that no
   mutation, save or undo reads does not belong here: hover lives in
   `canvas/canvasHover.ts` (P2-I). A per-node fact the store must own (the
   selection) is read KEYED (`canvas/canvasNodeSelection.ts`), not with a
   per-node selector.

---

## The node indexes (WS-5.2, extended in `store-01b`)

`store/slices/site/nodeIndex.ts` holds five Maps on the site slice, built whole
by `loadSite`/`createSite` and patched incrementally by every mutation,
`undo`, and `redo` from the SAME `DirtyMarks` autosave uses:

| Field | Answers |
|---|---|
| `_nodeIdToPageIds` | which page(s) a node id is on — **many-valued** (`meta-05`) |
| `_textOriginKeyToCount` | how many nodes share one source literal |
| `_inlineTailToCount` | how many nodes came from one inlined call site |
| `_classIdToNodeCount` | how many nodes carry a style-rule id ("Used N times") |
| `_slotOwnerBindings` | which node + prop fills its slot with a given node id |

Adding a facet: extend `NodeIndexes` and the `indexNode`/`unindexNode` pair,
and use `nodeIndexesOf(state)` / `emptyNodeIndexes()` rather than hand-rolling
the object literal.

**Know which kind of facet you are adding.** A facet derived from a node's
**id** (or from parse-time-only metadata like `textOrigin`) is fully covered by
`applyNodeIndexPatch`'s per-page id-set diff. A facet derived from mutable node
state (`classIds`, `props`) is **not** — the node keeps its id, so the id-set
diff sees nothing. Those are handled by the surviving-id pass in the same
function, guarded by a reference compare; put your facet there too.

**A cache keyed on `site` object identity is not an index.** Mutative replaces
`site` on every mutation, so such a cache rebuilds on every keystroke. Two
shipped defects (`buildSelectorUsageMap`, `buildSlotOwners`) were exactly this.

**Gate:** `no-full-site-scan-in-selectors.test.ts` — checks every file that
calls `useEditorStore(` **and every module it value-imports, one hop out**,
for a `for (const page of X.pages)` loop.

**The page LIST is not the pages array (P2-I, PERF-12).** Chrome that lists
pages (Explorer, document switcher, template picker, add-page picker, the
live-path hook) reads `selectPageDirectory` (`slices/pageDirectory.ts`): id,
title, slug, root id and template flag, recomputed once per `pages` change and
handed back with the SAME identity while those facts are unchanged, so a
keystroke re-renders none of it. `selectTemplatePages` does the same for the
composed tree's template wrappers. That single-slot memo is fine because the
work is O(pages) and shared by every subscriber — it is not a licence to cache
a walk of every NODE on `site` identity (above). The same gate now also fails a
selector that filters/maps `site.pages`, and an always-mounted file that
subscribes to the whole array or to bare `s.site`.

---

## Slices

| Slice | Owns |
|---|---|
| `siteSlice.ts` | The site document, `loadSite`, `saveSite`, `patchPages`, the 11 named tree actions |
| `site/helpers.ts` (+ the rest of `site/`: `structuralSourceEdits.ts`, `nodeIndex.ts`, `nodeTreeGrouping.ts`, `undoRedoActions.ts`, `pageActions.ts`, …) | `resolveActiveTreeTarget`, `mutateActiveTree` — **the only place that knows which tree is active** — plus the site slice's own supporting modules, split out to stay under the module-size ceiling |
| `boardSlice.ts` | Boards, frames, `addFrame`, `setFramePosition`, `setFrameSize`, `seedFramesForActiveBoard`, `selectedFrameIds` (WS-7.1 frame multi-select, implementation in `boardFrameSelectionActions.ts`), `frameDefaults` + bulk frame actions (WS-7.2, `boardBulkFrameActions.ts`/`boardBulkFrameSliceActions.ts`), `boardsPendingExplicitRemoval` (autosave hazard guard, see below). Sibling modules split out of the same slice for the module-size ceiling: `boardAnnotationActions.ts`/`boardAnnotationSliceActions.ts` (sticky notes + doc blocks), `boardGuideActions.ts` (D1 persisted ruler guides), `boardSelectors.ts` (the read side) |
| `selectionSlice.ts` (+ `selectionResolve.ts`, `selectionTraversalActions.ts`) | `selectedNodeId`, `selectedNodeIds`, multi-select, focus target — WS-7.3: on a studio board, a multi-selection may span any of the board's own curated frames, not just the active page (`resolveSelectableNode`, in `selectionResolve.ts` to avoid an import cycle with `selectionTraversalActions.ts`'s Enter/⇧Enter tree walk) |
| `canvasSlice.ts` | `canvasView` ('design' \| 'live'), zoom/pan, `activeBreakpointId`, `runScripts` |
| `inlineEditSlice.ts` | `activeInlineEdit` — one session globally, now keyed by `frameId` and (for a locale variant) `localeOverride` — see `canvas-internals.md`'s Locale section |
| `styleRuleSlice.ts` (+ `styleRule/`: `crudActions.ts`, `propertyActions.ts`, `assignmentActions.ts`, `conditionActions.ts`, `registryActions.ts`, `uiStateActions.ts`, `helpers.ts`) | The CSS class registry, split the same way `boardSlice.ts` and `site/` are |
| `uiSlice.ts` | `activeDocument`, panel open/closed, right sidebar expanded |
| `sitePanelSlice.ts` | Panel-specific UI state |
| `clipboardSlice.ts` | Copy/paste of subtrees |
| `filesSlice.ts` | Site files / code assets |
| `saveTrackingSlice.ts` | Dirty tracking, autosave cadence |
| `commentsSlice.ts` (+ `commentSelectors.ts`) | The editor's view of `<workspace>/.studio/comments.json` and the transient UI state around it (armed tool, open thread, uncommitted pin) — no HTTP here, the round trip lives in `@site/studio/commentActions.ts` |
| `localizedPageSlice.ts` | WS-10 §4.4 (Phase 4): the `(pageId, locale)` parallel map a board frame reads from when its own `axes.locale` differs from the board default — see `canvas-internals.md`'s Locale section |
| `visualComponentsSlice.ts`, `vcTreeOps.ts`, `vcSlotReconcile.ts` | Visual Components |
| `layoutsSlice.ts`, `settingsSlice.ts` | Layouts, editor settings |
| `prototypeSlice.ts` | A project's flows (prototype mode) — out of scope for this page; see `docs/features/studio-prototype.md` |

---

## The mutation API

Every mutation in `src/core/page-tree/mutations.ts` takes a `NodeTree<TNode>` and
is **tree-agnostic** — it knows nothing about pages vs Visual Components.

The 13 named store actions are one-liners over `mutateActiveTree`:

```
insertNode · deleteNode · updateNodeProps · setBreakpointOverride ·
clearBreakpointOverride · renameNode · setNodesLocked · setNodesHidden ·
moveNode · duplicateNode · wrapNode · groupNodes · ungroupNode
```

`setNodesLocked`/`setNodesHidden` (`site/visibilityActions.ts`) take an
ABSOLUTE value over N ids, not a toggle: a selection that disagrees has no
honest toggle, and a caller that loops one pushes N history entries for one
gesture (`panel-40`).

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
`move`/`delete`/`insert` edit to the user's `.tsx` (`commitStudioMove` / `commitStudioSequence` /
`commitStudioDelete` / `commitStudioInsert`) or toast a reason and do nothing —
never both nothing and nothing said, which is what they used to do.

A refused plan carries the full `EditConstraint`, not the rule's bare
`{reason, message}` — plus, since `store-10` (R2), the plan's own `nodeId`
(optional: `planSourceInsert`'s container-resolution failure genuinely has no
node yet). Only the planner still holds the NODE, and the node is where the
refusal's `origin`/`nodeId` come from. `presentStructuralRefusal` (renamed
from `toastStructuralRefusal`) renders ONE of two things depending on whether
`constraint.actions` is empty:

- **empty** (the 6 R1 reasons with no remedy — `reparent`, plain `insert`,
  `duplicate`, `wrap`, `multi-select`, `no-sibling-anchor`) → the same
  **persistent** toast as before (`durationMs: null` — a refusal explains why
  the canvas did not change, and a 6-second window was not enough to read
  one), **deduped** by gesture + reason + sentence so a repeated attempt
  counts up on the card already showing instead of stacking, and carrying the
  constraint's first runnable action (or a jump to its source) as the toast
  button.
- **non-empty** (`shared-component`, `list-row`, `route-chrome`,
  `code-placed`, `cross-file`) → a modal `RefusalDialog`, via a new
  `structuralRefusalDialog` field on `uiSlice`, with real buttons for every
  action `ConstraintActionButtons` can resolve. `detach`/`extract` — the two
  remedies whose codemod triggers a full board reload that re-mints the
  refused node's own id — additionally carry a `retry: (newNodeId) => void`
  closure, built at each of the 9 structural-commit call sites
  (`nodeActions.ts`, `deleteNodesAction.ts`, `studioSourceWrites.ts`), so a
  successful Detach/Extract silently re-issues the ORIGINAL gesture against
  whatever node now occupies the same call-site position
  (`callSitePosition`/`matchesCallSitePosition`, `@core/page-tree`) once the
  reload lands — the user's delete/move/duplicate/wrap actually happens, not
  just the detach alone.

A **second** closure now rides that field: `duplicateIntoFrame`, for D2 G3's
`duplicate-into-frame` remedy. It takes no arguments, because there is no
argument that would name the gesture — a cross-frame drop is a destination
(page, container, index) the drag session no longer holds once `pointerup` has
run, so `transplantActions.ts` closes over it and hands the closure to the
dialog. `RefusalDialog` passes it down to `ConstraintActionButtons`, which
supplies it to `resolveConstraintAction` exactly the way it supplies
`makeParentRelative`. Pressing the button calls the SAME `transplantNodes` the
drag called, with `copy: true` — same gate, same concurrency guard, one toast.
`planSourceTransplant` only attaches the action when re-asking
`previewStructuralTransplant` with `copy: true` comes back `ok`, so the remedy
cannot bounce back to the refusal it was offered under.

See `studio-pipeline.md` → "A refusal reaches the user as an `EditConstraint`".

**`insertNode` does not mutate a studio tree at all.** It plans the write
(`planSourceInsert` — which resolves the synthetic page root to the page's
returned root element, and downgrades an unaddressable anchor to "append"),
commits it, and returns `''`. The new node arrives via the reload, with a real
source id. **No structural commit toasts a success (P3-A).** The optimistic
preview paints the gesture at once and the resync selects what it made; a
"Duplicated" / "Placed" / "Undone" card on top of that said the same thing
twice. A refusal is one `warning`; a write that outlives its retry ladder is one
`warning` too — it was taken back, so board and disk agree again.

**A structural write reports what it created, and the board selects it
(`store-13`).** `insert`, `duplicate`, `wrap` and `group` create markup that has
no node id until the board re-reads the file, which is why `keys-01`'s K7 could
select a duplicate only on the in-memory path — on a source-backed project ⌘D
left the ORIGINAL selected. Now each of the four codemods returns the created
element's own tag-name `line:col` (`createdJsxLocation.ts`, verified against the
re-parsed file — an unconfirmable position reports `null`, never a guess),
`applyStudioEditBatch` turns them into `StudioEditBatchResult.createdNodeIds`
(the plain `rel:line:col` ids the parser will mint for the same elements), and
`commitStructural` hands them to the resync that reads the write back
(`pendingStructuralOutcome.ts`). `siteReloadApply.ts` applies them on BOTH
re-read paths — the narrow `patchPages` and the full `loadSite` — and selects
them, checking every id against the O(1) `_nodeIdToPageIds` index first. A
write whose elements did not all come back selects nothing rather than part of
itself.

**And what it MOVED (`store-14`).** `StudioEditBatchResult` gains
`relocatedNodeIds`, the counterpart `store-13` left open. `moveJsxElement` and
`unwrapJsxElement` now report where they put what they moved (an ungroup reports
several — its children all move at once), and a `transplant` that MOVES reports
through `relocated` while a COPY still reports `created`, because their undos
differ. The board selects created ∪ relocated, so a reorder, a reparent and an
ungroup all end pointing at what the user just moved instead of dropping the
selection. **One wire fix went with it:** `POST /admin/api/studio/save` had never
actually forwarded `createdNodeIds`, so `store-13`'s selection worked in its unit
test and nowhere else.

*Two details worth knowing.* The outcome is not a callback because
`studioStructuralCommits.ts` sits inside the store's own build graph, where
importing `useEditorStore` closes the cycle `adminEvents.ts` exists to break.
Since ERR-10 it is not a global box either: it rides the exact re-read its write
triggers — `CmsSitePagesPatchDetail.structuralOutcome` on the narrow path,
`requestCmsSiteReload({ structuralOutcome })` on the full one — so an unrelated
re-read landing first (an agent's live-reload patch) cannot claim it against a
tree that does not contain the write yet, and a later commit cannot overwrite it
before its own reload lands. And the batch pins each created element to its distance from
the END of its file, not to an absolute line: a batch applies bottom-to-top, so
a later edit sits above an element an earlier one created and pushes it down —
recording the line is stale for every created element but the last, which a
multi-selection ⌘D reaches immediately.

**⌘V is a source write too (`store-13`).** `pasteNode` used to be the one
structural gesture that never asked: it restored the clipboard SNAPSHOT as
nanoid nodes, `saveSite` diffs values only, and the next parse deleted them
without a word. On a studio-imported tree a paste is now committed as a
`duplicate` of the clipboard's own roots into the destination container
(`writePasteToSource`, `studioSourceWrites.ts`), so the pasted element arrives
as an ordinary parsed node and is selected by the same created-id path above. A
clipboard whose roots are no longer elements in this file — copied from another
project, another page, or a session before the file changed — refuses by name
instead of minting an orphan.

**An HTML import refuses on a studio tree (`mcp-21`).** `insertImportedNodes`
had the same defect and a worse blast radius: `site_insert_html` /
`site_replace_node_html` reach it through the editor bridge, so an external MCP
client with `ai.tools.write` could merge nanoid nodes into a real repository's
board. It now refuses the whole fragment (`refuseImportedNodesInto`). There is
no source write to route to instead: the importer's rule table maps HTML onto
~15 base modules and exactly two — `base.container` and `base.text` — can spell
themselves in a user's repo (`ModuleDefinition.sourceIntrinsic`); the `<style>`
half of the payload belongs in a stylesheet rather than the markup; and the
tool's own answer (the ids it created, so the caller can address them) cannot be
produced by a write whose ids do not exist until the resync. The action returns
`ImportedNodesResult` so the reason travels to the modal and to the tool
instead of an invented sentence about containers. `refuseImportedNodesInto` is
also exposed as a store action, for the one caller that must destroy before it
inserts — `site_replace_node_html` deletes the target's children first, so a
refusal discovered at insert time emptied the node and wrote nothing.

**`updateNodeProps` and `setNodeInlineStyles` refuse a patch if *any* key is
code-valued** — all-or-nothing, because a half-applied patch is a canvas that
disagrees with the file it mirrors. Both refuse **silently**: they are also
called by agents and plugins, where a toast would be noise. The one announced
refusal is canvas double-click on a code-valued text prop, because the user just
double-clicked real copy and nothing happened.

**`loadSite` keeps the currently-open page** when the incoming site still
contains its id. Resetting to home is right when opening a different project and
wrong when re-syncing the open one.

**Held ids follow the ELEMENT across a reparse, on both reload paths (ERR-5).**
An insert or delete shifts every `relFile:line:col` id below it (see
`server/ai/tools/studio/staleness.ts`'s "shifted" contract). The old rule — an
id survives iff it still resolves — was right when a shift vacated an address
and silently wrong when it PERMUTED one: an agent inserts a banner on line 4,
the selected "Body" moves to line 5, `a.tsx:4:5` still resolves, and the ring,
the inspector and the next Delete all land on the banner. `loadSite` did not
touch held ids at all. Now `loadSite` and `patchPages` both build a follower
(`site/reparseNodeFollow.ts`) and map `selectedNodeIds`/`selectedNodeId`,
the hover (`followCanvasHover` — hover is off the store since P2-I), `activeInlineEdit.nodeId` and `enteredInstanceIds` through it
(`followCanvasStateThroughReparse`, `lifecycleActions.ts`). The follower aligns
each touched page's old tree against its new one by CONTENT — a deep subtree
fingerprint, then the node's own module/tag/label/text, then position only when
every unmatched pair agrees on module and tag — and falls back to
`buildReparseNodeIdRemap`'s strict walk only when the node at the new address
still has the same module/tag/label/text. An id with no honest counterpart is
DROPPED — including one of a run of identical siblings, which the tree alone
cannot tell apart — never re-pointed. A reload that changed the page SET (a
project switch, a page create/delete) keeps an id only at the same address with
the same fingerprint. Cost: O(nodes) of the pages holding a followed id, lazy,
never the whole site. The live drag session is outside the store, so both paths
also `publishReparseFollow(follow)` after writing the store;
`useCanvasReorderDrag` re-addresses its session from it
(`followDragSessionThroughReparse`) or ends the gesture when the dragged element
is gone (ERR-23).

**A full reload is awaitable and ordered (ERR-10).** `requestCmsSiteReload()`
returns a promise that settles once a mounted editor has loaded a document
fetched AFTER the request and applied its `structuralOutcome` — so
`resyncBoardAfterWrite`'s full-reload fallback holds `structuralCommitQueue.ts`
until the board has caught up, and a parked gesture re-plans against post-write
ids. `usePersistence`'s `reload()` takes a monotonic token when it starts and
drops its response if a newer reload started since; the newer one covers every
request the older one did (`latestCmsSiteReloadRequest` /
`claimCmsSiteReloadRequests` in `adminEvents.ts`). With no editor mounted a
request resolves at once, and unmounting the last editor settles whatever is
still waiting, so a structural commit can never hang on a board that is gone.

**A read that gets no answer retries, then says so in place (P3-A, ERR-18).**
The initial load runs through `@core/http`'s `retryWhileUnreachable` on
`LOAD_RETRY_BACKOFF_MS` (`hooks/persistenceStatus.ts`), reporting `retrying`
meanwhile; `retryLoad` runs it again by hand. A background re-read (after a
write, an agent push or an outside edit) that still fails sets `boardStale`,
which the save chip shows as "Out of date — reload", never as a toast; the
next successful read clears it.

**`patchPages(input)`** merges a freshly-re-parsed SUBSET of pages into
`site.pages` — the targeted-reload path for **every** write, the agent's and
the user's alike. Four callers reach it: the MCP live-reload push, a file
changed outside Studio (the same push with `diskChanged`, P1-D), a
structural commit, and `fsCodemodAdapter.saveSite` when the response reports
`shifted`/`sharedComponents`. All four go through
`studioBoardResync.ts`'s `resyncBoardAfterWrite`, which asks
`POST /admin/api/studio/reload-scope` which pages the touched files actually
feed (`pageParseCache.ts`'s recorded per-route dependency sets, inverted) and
widens to `loadSite` whenever it cannot prove the scope. `loadSite`'s full
reload is now reserved for the cases that change the board's global SHAPE —
page create/delete, a new component file, a project switch, project-wide
settings — enumerated in `studioBoardResync.ts`'s own doc. `input.pages`
upserts by id (appends an unrecognised id — how `studio_create_page` lands);
`input.removedPageIds` drops a page confirmed gone, its board frame(s), and
any dangling `selectedFrameIds`/selection entry. **Deliberately bypasses
`mutateSite`/`runHistoricMutation`**: it never pushes undo history, and it
flips `hasUnsavedChanges` only for edits the user made (below) — this content
came FROM disk, and recording it as a "change" would queue an autosave that
writes what was just read straight back out (the write → reload → re-dirty →
autosave → write loop `fsCodemodAdapter.test.ts`'s header names).

**A re-read never throws the user's unsaved edits away (ERR-9, P3-E).** It
used to: a page with local edits was replaced wholesale and toasted `'Local
edits overwritten … a change an agent just wrote'` — even when the write was
the user's own ⌘D, and `loadSite` dropped them silently. Now both
`patchPages` and `loadSite` REBASE (`site/unsavedEditRebase.ts`):

- **What is unsaved** is decided by the save diff's own baseline, as it stood
  BEFORE this read advanced it. Both re-read entry points in
  `loadedValuesBaseline.ts` (`mergeLoadedValuesBaseline` for a narrow read,
  `resetLoadedValues(pages, { sameProject: true })` for a whole-project read of
  the open project) file what they replaced under the very `pages` array they
  were handed; the store looks it up with `baselineBeforeRead(pages)`. A page
  list no Studio read produced (a test's, a project switch) has none, and is
  simply adopted.
- **Where it goes**: the old page with those values put back is aligned with
  the fresh one by `reparseNodeFollow.ts`'s `alignPageTrees`; an element it
  cannot place is re-found by its P1-A source identity (one match only).
- **Local wins**, per node all-or-nothing, unless the element is gone, the
  value is now code on the fresh node (`isPropWritableToSource`), or it is an
  origin-backed value whose literal moved to another file or changed there too.
  Those are reported in ONE warning that names the cause, never who wrote the
  file (`reportLostUnsavedEdits`).
- A rebased page keeps its `_dirtySave` mark and `hasUnsavedChanges` stays
  true, so autosave writes exactly the carried edits against the fresh
  baseline. `usePersistence` no longer clears the flag after a full reload —
  `loadSite` owns it. No loop: after that save the values equal the baseline,
  and the next re-read finds nothing to carry.

Cost: the same per-node diff the save makes, over the replaced pages only, plus
one alignment per page that holds an unsaved edit.

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
`trust`) itself. `?pageIds=` narrows the server's COMPUTE too — the per-page
convert is skipped for every unrequested route — but never the meta: the style
registry is built from every route's stylesheets together, so it stays a full,
fresh recompute (`studioPageLoad.ts`'s `options.pageIds` doc).

**A re-read is applied by VALUE, not by object (PERF-6, P6-A).** Everything
off the wire is a brand-new object graph, and the canvas compares by identity:
every `NodeRenderer` selects its node, every mounted frame's
`ClassStyleInjector` regenerates its `<style>` on a new `styleRules` object.
So `patchPages` puts each re-read page, `styleRules` and `conditions` in
through `replaceEqualDeep` (`@core/utils/replaceEqualDeep`): a node, rule or
condition deep-equal to the one the store held keeps its old object, and the
page or registry itself keeps its identity when all of it is unchanged. A prop
write therefore re-renders the one node it changed and restyles no frame
("wholesale" above is about which rules EXIST — a deleted rule is gone — not
about object identity).

**A renumbered node keeps its React key.** A structural write renumbers every
`rel:line:col` id below it, and `NodeRenderer` used to key each child by its
id, so every one of those elements remounted. `site/rereadRenderKeys.ts`
aligns each re-read page against the page the store held (`alignPageTrees`,
the alignment the selection follower then reuses via `alignments`) and hands
it to `canvas/nodeRenderKeys.ts`, an off-store per-page map from node id to
the key it renders under. `NodeRenderer` and `CanvasComposedTree` key children
by `nodeRenderKey(pageId, id)`; a moved element re-renders in place (its id
changed), it does not remount. Rules: keys stay unique among siblings (an
unaligned node whose id a moved node carries gets a minted key); a node object
shared from the previous page whose CHILD keys changed is copied, because a
shared parent would not re-render and would keep the old keys (a move among
same-size siblings permutes the addresses without changing the parent's
`children` ids); `loadSite`/`createSite`/`clearSite` clear the map. Only board
frames (which provide `CanvasPageContext`) carry keys; a frame without a page
context keys by id, as before. Measured by `bench:editor-store`'s post-write
re-sync scenario (`scripts/bench/lib/postWriteResync.ts`), whose counts are a
budget.

A resync triggered by `saveSite` runs as the **last** thing that function does,
after every diff baseline has advanced, and carries the save's `refusedRuleIds`
so the reload's own `commitBaseline` does not adopt a value the server refused.
Both are load-bearing and both have a regression test
(`studio/__tests__/saveNarrowResync.test.ts`).

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

**A gesture's history cost is the caller's decision.** Every `mutate*` helper
takes a whole patch and records ONE entry, so a UI that commits a
multi-property gesture one property at a time turns one click into N undo
steps. The Properties panel's single multi-property write channel is
`onChangeMany(patch)` (`StyleSectionsEditor`). A HELD key is one gesture too:
the canvas arrow nudge (P2-C) previews every auto-repeat through
`setPreviewNodeStyles` (one bag per layer for a multi-selection) and commits ONE `setNodesInlineStylesPerNode` on the keyup, so
a hold is one entry and — with `flushAutosave` — one source write
(`canvas/useCanvasNodeArrowKeys.ts`). And a field must compare before
it commits — a prefilled field that writes its own displayed value on blur
pushes an entry that reverts nothing visible. Both rules:
[`docs/features/inspector.md`](../features/inspector.md)
§10. Who owns the ⌘Z keystroke:
[`docs/reference/editor-history.md`](../reference/editor-history.md) → "Who
owns Ctrl/⌘+Z".

**A structural gesture is undone by re-issuing it, not by replaying patches**
(`store-08`). `saveSite` diffs node VALUES and knows nothing about parent or
order, so a patch-only undo of a move changes the canvas and leaves the `.tsx`
saying the opposite. `moveNodes` tags its entry with the pre-move
`(parentId, index)` (`structuralHistory.ts`) and `undo` re-issues `moveNodes`
back to it — on the page that OWNS the element, found through
`_nodeIdToPageIds` and activated silently, not the active page (ERR-3);
`deleteNodes` tags its entry as a `source` gesture whose undo is a
`reinsert-source` write (`store-15`). Tagging happens only when a source write
was actually issued — a CMS or Visual Component tree keeps plain patch replay.
Several elements moved as ONE gesture — an arrow step of a selection
(`stepSiblings`, P2-C2) or a multi-selection drag (`moveNodes` with several
ids, P3-D) — go through `moveNodesInSequence` (`moveSequenceActions.ts`):
single-element moves applied IN ORDER, each planned against the scratch tree
the previous one leaves (`@core/page-tree`'s `moveSequence.ts`), all or
nothing, posted as ONE `/save` **sequence** (`commitStudioSequence` → the
server's `studioEditSequence.ts`, which re-addresses every step by document
order and restores every file if any step refuses). The entry is tagged
`moves`; its undo is `invertMoveSequence` re-issued through the same action.
A sequence of one is an ordinary `move` entry.

**P3-D — what used to refuse and now writes.** ⌥-drag and ⌘V of several
elements (`planSourceDuplicateTo` returns the copies in WRITE order; several
are one sequence); a wrap of several elements (it is a group); a move or copy
into a container in ANOTHER file (a `transplant`, `crossFile` on the plan); a
paste of something copied in another frame, or before an edit renumbered its
file (`studioPasteWrites.ts` finds it on the board, by id or by unique
fingerprint). **OD-7** — a gesture refused `shared-component` is taken over
by `instanceOnlyGesture.ts`: it detaches THIS call site
(`commitStudioDetachForInstance`), follows every id the gesture named into
the detached markup by child-index path, replays it (`retry(mapId)` — every
`retry` closure now takes an id MAP), and marks the detach entry
`linkedToNext`, so one ⌘Z undoes both (`undoRedoActions.ts` cascades). A
detach that refuses shows the refusal dialog, as before.

**Undo never jams, and never lies (P1-F).** A structural step that can never
happen as recorded (an `unsupported` inverse, an element gone from the board, a
file changed under the entry by an agent or an editor) is SKIPPED: undo drops
it with one warning toast and carries on to the step below; redo drops the
redo chain. No modal (ERR-2 stop-gap, ERR-28). And a move or delete whose write
does not land is taken back: `trackStructuralTreeCommit`
(`structuralCommitRollback.ts`) holds the mutation's inverse patches and marks
the entry `pendingCommit`; `commitStructural` settles it when the write lands
and rolls it back — patches replayed unless a re-read replaced the page since
(`pageReadEpoch.ts`), entry removed — when it is refused or still unreachable
after `structuralWriteRetry.ts`'s ladder (ERR-6). An undo/redo's re-issued write
carries the same handle for its entry: refused → skipped, unreachable → put
back. The rollback reverts the store's tree only: a Tier 2 bridge frame that
already painted the move or delete through `optimisticStructuralBroadcast.ts`
keeps that paint: no runtime message undoes an optimistic DOM op, and a write
that did not land sends no HMR update. Full contract: `editor-history.md` → "A write that does
not land is taken back".

**Two gestures write SOMEONE ELSE'S page, named explicitly.** `transplantNodes`
(D2 G3 — a drag that crossed a board frame) and the image-drop actions
(`dropImagesIntoPage`/`replaceImageInPage`/`setBackgroundImageInPage`, D2 G15
+ P5-B — image files dropped from the OS; since P5-B3 any `ImageDropSource`:
a file, a URL dragged from another tab, or a project file from the Assets
panel, each landed through `landImageSource` and nothing else) take their page id as an argument
instead of trusting `activePageId`, and none goes through `mutateActiveTree`.
A cross-frame drag ACTIVATES the destination frame on the way
(`openPageInCanvas` fires from `onPointerDownCapture`), so by commit time the
active page is the wrong end of the gesture; a dropped file was never preceded
by a pointerdown at all, so the frame under it was never activated. They are
therefore NOT among the named tree-mutation actions the
`no-vc-mode-branches-in-mutations` gate walks — they mutate no tree.

The transplant still shows **nothing optimistically** — the node that appears
afterwards is a freshly parsed one in the OTHER file, and previewing it locally
would need a tree on the other end of the gesture. The image drop (P5-B) does
the opposite of guessing an id: it ACTIVATES the dropped-on page first
(`openPageInCanvas`, a drop is a user gesture on that frame), then previews one
ghost `<img>` per file through `previewOptimisticInsertRun` (N siblings, one
preview mutation, ids in the same order as the write's `createdNodeIds`). It
holds `structuralCommitQueue.ts` from BEFORE the upload (`beginStructuralCommit`)
until the commit's own end, so the page cannot be resynced under the ghost
while the bytes go up; a drop whose every file fails rolls the ghost back and
releases the queue itself. N images are ONE `insert` edit (`siblings`) — one
write, one undo step whose `delete-created` inverse deletes them all. A replace
of a LITERAL `src` is an ordinary `updateNodeProps` (ordinary undo); a replace
of an IMPORT-BOUND one posts `kind: 'asset'` through `commitStudioAssetReplace`
with the undo template `known` (its inverse is fixed at gesture time: point the
import back). A ⇧-drop background is one `setNodeInlineStyles`.

**`insert`/`duplicate`/`wrap`/`group` DO paint optimistically now (`perf-10`).**
`structuralOptimism.ts`'s `previewOptimisticInsert`/`Duplicate`/`Wrap`/`Group`
mutate the active tree the instant the gesture fires — using the exact tree
primitives (`createNode`+`insertNode`, `duplicateNodeWithScopedClasses`,
`wrapNode`/`wrapNodes`) an ordinary in-memory CMS-tree edit would — via a new
`SiteSliceHelpers.previewActiveTreeMutation`, which applies the patches and
keeps the WS-5.2 indexes in sync but deliberately skips history/dirty
tracking: a preview is not the gesture's real edit, and must not become a
second undo step or something autosave tries to persist. Safe to leave
un-rolled-back on a landed write because the resync that follows always
replaces the touched PAGE object wholesale, erasing the preview regardless of
whether its guessed id matches the real one; `commitStructuralBody` explicitly
rolls it back only on the two paths where no resync follows (a full refusal,
or the POST never reaching disk). `ungroup`/paste/K2 Alt-drag-duplicate/
transplant are unchanged — still nothing shown until the resync. The image drop
previews through the same module (`previewOptimisticInsertRun`, above).
A Delete on a pending preview id is QUEUED behind the write that made it and
then aimed at the element that write created (ERR-22, `resolvePreviewTargets`,
fed by `settle(createdNodeIds)` — wired into `deleteNode`/`deleteNodes`); it
used to be refused with "Still writing your last change". Everything else that
could target a preview goes through `structuralCommitQueue.ts` and simply
re-plans once the id is gone.

**The whole family is undoable (`store-14`).** It used to record nothing at all,
so ⌘Z after a ⌘D, a ⌘G, a cross-frame drag or a file drop undid whatever came
before it. Each gesture now records a patch-free history entry carrying its
inverse, expressed in edit kinds that already exist — `delete` for
insert/duplicate/paste/image-drop, `ungroup` for wrap/group, `group` for
ungroup, `transplant` back for a cross-frame move — and ⌘Z posts it through the
same `/save` route the gesture used. Full contract, including the two refusals
that are deliberate and the LIFO property absolute ids rest on:
`docs/reference/editor-history.md` → "The `source` gesture".

**A gesture fired mid-commit QUEUES (`store-14`).** `store-11`'s guard refused
it ("Still writing your last change") and `verify-3` measured the result: five
⌘D presses inside 300 ms wrote ONE copy. The serialization — which is what
closes the original double-write race — stays; the refusal is gone.
`structuralCommitQueue.ts` parks the gesture as a THUNK and re-runs it the
moment the wire is clear, so it re-reads the tree the previous resync left
behind and re-plans from scratch rather than posting a plan built against
stale ids. Five presses are five writes, no toast, the last copy selected,
five undo steps. The queue holds 20; the overflow — only reachable by a held
key auto-repeating — is dropped without a toast (ERR-25), logged for devtools.

**Every structural writer is in that queue, and its ids are re-found, not
re-read (P1-A, ERR-4).** `moveNodes`, `deleteNode`, `deleteNodes` and a
structural ⌘Z/⌘⇧Z step (`undoRedoActions.ts`'s `runStructuralStep` parks the
whole step, so it reads the stack as the in-flight write's resync left it)
queue like the rest — they used to post at once, and a Delete pressed while a
drag's move was on the wire deleted whatever the move put at the old line.
Re-running a thunk with its ORIGINAL ids was not enough either: the commit
ahead renumbered the file. `deferWhileStructuralCommitInFlight(gesture,
nodeIds)` captures who each id names when the gesture is made
(`sourceIdentity.ts`) and hands the thunk a `relocate(id)` that re-finds each
element by that identity in the re-read board; one that cannot be found exactly
once drops the gesture with one warning. A new structural writer passes its ids
or it is back to guessing. Full contract: `studio-pipeline.md` → "Element
identity".

**A reparse renumbers `rel:line:col` ids; the stack is re-addressed, not
wiped.** `buildReparseNodeIdRemap` (`historyNodeIdRemap.ts`) walks the
pre-reload tree against the reparse in parallel and rewrites every patch path
and structural node id. `historySurvivesReload` is still the fallback for
anything the walk can't match. Both run in `loadSite` AND `patchPages`. Do not
add a third reload path without them.

**Board state is undoable, on the SAME stack (`store-09`).** Frame
move/resize/membership, board CRUD, guides and annotations (sticky notes, doc
cards) live outside `site`, so they record a board STATE PAIR
(`HistoryEntry.board`) instead of Mutative patches — `boardHistory.ts`'s
`commitBoardChange` is the board-side counterpart to `runHistoricMutation`.
Continuous gestures coalesce per entity (`boardCoalesceKey`) and close on
pointer-up via `endBoardGesture`, so one drag is one ⌘Z. A `.tsx` reparse that
invalidates the site stack KEEPS board entries; a fresh `.studio/boards.json`
read DROPS them. Still not undoable: `prototypeSlice` links (each op is a
server round trip). See
[`docs/reference/editor-history.md`](../reference/editor-history.md) → "Board
history".

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
  command `canvas.selectAll`, which with a node selected means its siblings instead — P2-B); marquee-drag on empty canvas
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
- **Bulk inline-style edit (W8-3 phase 1):** `setNodesInlineStyles(nodeIds,
  patch)` is the third rider on `mutateTreesForNodeIds`, and the write behind
  the multi-selection inspector's style sections. It shares
  `applyInlineStylePatch` with the single-node `setNodeInlineStyles`, so
  merge/clear semantics (a `null`/`''` value clears; an emptied bag drops
  `inlineStyles` entirely) cannot drift between the two. Unlike the
  single-node action it does NOT throw on a missing id and does not abort the
  whole patch when one node's `isStylePatchWritableToSource` says no: a bulk
  edit skips the refusing node and still lands on the rest, because leaving
  N-1 nodes half-written is worse than skipping one. The panel names the
  skipped properties instead of leaving the refusal silent
  (`MultiSelectTargetBar`). Each `ClassPropertyRow` also states its own
  count ("writes to 3 of 5"): `StyleSurface` provides the three-state
  `StyleWriteLockContext` from `SelectionModel.inlineWriteReach`
  (`inspector.md` §9.4a). A class target is reachable too, once the user
  clears the "used by N other elements" gate — but a class edit is an
  ordinary `updateClassStyles`, not a bulk write, because the class IS the one
  honest target. See
  [`docs/features/inspector.md`](../features/inspector.md)
  §9.
- **Per-node bulk inline-style edit (W8-3 phase 3, G6.4):**
  `setNodesInlineStylesPerNode(patches, { coalesceKey })` takes a DIFFERENT
  patch per node and still writes them in ONE history transaction. Selection
  colours needs it: recolouring one swatch rewrites `color` on one layer and
  `borderTopColor` on another, and those must undo together. Same per-node
  skip rules as `setNodesInlineStyles`, same all-or-nothing-per-node
  `isStylePatchWritableToSource` gate. Its coalesce key is
  `selection-color:<the colour being replaced>` — a burst on one swatch is one
  undo entry; a second swatch starts a new one. `mutateTreesForNodeIds` grew
  an optional `{ coalesceKey }` for it, forwarded to `runHistoricMutation` on
  both its single-tree and cross-page paths.

## Adding state — checklist

- [ ] Does it belong in an existing slice? Prefer that over a new one.
- [ ] Is it derivable? Derive it in a selector instead of storing it.
- [ ] Does it need to survive a reload? If so it belongs in `.studio/` on disk
      (project data) or in editor preferences — not in transient store state.
- [ ] Is the selector O(1)? If it walks the tree, precompute an index.
- [ ] Does it change on every pointer move (hover-like)? Then it is not store state — see Non-negotiable 5.
- [ ] Does a tree mutation need a history entry and a coalesce key?
- [ ] Does a new action need to consult `isPropWritableToSource`?
