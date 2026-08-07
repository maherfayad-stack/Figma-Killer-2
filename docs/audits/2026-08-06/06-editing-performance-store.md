# Audit 06 — Editing performance and correctness (store, mutations, save/undo)

Scope: `src/admin/pages/site/store/**`, `src/core/page-tree/{mutations,treeOperations,sourceWritability,sourceStructure}.ts`,
`src/admin/pages/site/studio/{fsCodemodAdapter,localizedPageWriteback,styleRuleWriteback,studioSaveRequests,loadedValuesBaseline}.ts`,
`inlineEditSlice.ts`, `styleRuleSlice.ts` (+ `styleRule/*`), `siteSlice.ts` (+ `site/*`), undo/redo.

Read in full; findings below are grounded in code actually read, with file:line evidence.

---

## Answers to the audit questions (pointers into the findings below)

1. **Keystroke path.** A Properties-panel keystroke → `updateNodeProps`/`setNodeInlineStyles`
   (`nodeActions.ts`) → `mutateActiveTree(fn, coalesceKeyForPatch(...))` → `runHistoricMutation`
   (`helpers.ts`) → one Mutative `create({enablePatches:true})` pass over the WHOLE store (cost is
   O(change), not O(site) — see `docs/reference/editor-history.md`'s own benchmark, confirmed by
   reading `runHistoricMutation`). History coalesces correctly for node props/breakpoint overrides
   (single-field patch ⇒ `props:<nodeId>:<prop>` key) but **does not** coalesce for style/class
   property edits — see **E4**. Only components with a live selector over the touched node/page
   re-render; components subscribed to the whole `site` object (**E9**) re-render regardless of what
   changed.
2. **Save path.** See **E1** (O(site) diff scan every autosave tick, dirty-tracking infra unused)
   and **E7**/**E8** (structural edits bypass the diff entirely and force a full workspace reparse).
   Trap #5 ("reload only when a write landed") is respected for the *ordinary* `saveSite` path
   (`fsCodemodAdapter.ts:553`, gated on `result.written > 0`) but **is not** respected by the
   structural one-shot commits, which reload unconditionally — see **E2**.
3. **Undo/redo.** The central, most severe finding of this audit: **E1** — undo of an
   already-autosaved prop/text/inline-style edit is never written back to disk, so the in-memory
   tree and the on-disk `.tsx` permanently disagree with no future save able to fix it. **E2**/**E3**
   cover the structural (move/delete/insert) side of the same disk-vs-undo problem.
4. **Selection state.** `selectedNodeIds`/`selectedNodeId`, primitive/array fields, cheap to update.
   Survives a reparse via `_nodeIdToPageIds` (WS-5.2) — `patchPages` and `undo`/`redo` both prune
   dead ids correctly (`lifecycleActions.ts:290-301`, `selectionSlice.ts`'s `pruneCanvasSelectionDraft`).
   One inconsistency: `findSelectableNode` doesn't use the index — **E10**.
5. **Reparse churn.** A structural edit's forced reload (**E2**) is the biggest churn source: it
   clears `_historyPast`/`_historyFuture` wholesale, resets `_historyCoalesceKey`, and (via
   `loadSite`) resets `activeDocument`. Selection and scroll survive via `_nodeIdToPageIds`
   filtering, but undo history and any co-pending unsaved edit do not.
6. **Mutative usage.** No misuse found — draft-mutation style throughout, the one `rawReturn` use
   (`settingsSlice.ts:136`) is correct, no `structuredClone`/full-state copies found in the mutation
   path itself. Structural sharing is respected (`runHistoricMutation` copies only touched top-level
   keys, `helpers.ts:288-294`).
7. **Store shape.** `_dirtySave` (save-dirty accumulator) is fully built and correctly maintained
   (`dirtyTracking.ts`, `saveTrackingSlice.ts`) but **not consumed** by Studio's own adapter — see
   **E5**. `loadedValues`/`loadedValuesBaseline.ts` is a second, parallel "what's saved" tracker for
   the same node data, with different (and in this case buggy) advance-on-save semantics than
   `_dirtySave` — a duplicated-source-of-truth risk in its own right.
8. **Optimistic UI.** Node prop/text/style edits are always optimistic (mutate in-memory, no wait for
   the 2s-debounced network write). Structural edits (move/delete) are *also* optimistic but then
   forcibly reconciled against disk via an unconditional reload — see **E2**/**E3** for why that
   reconciliation is unsafe with respect to undo and unrelated pending edits. Insert has no
   optimistic step at all (by design, documented in `editor-store.md`).

---

## CORRECTNESS findings

### E1 — Undo of an already-autosaved node edit never reaches disk; tree and disk diverge permanently
**Severity: CRITICAL**

**Evidence:**
- `src/admin/pages/site/studio/loadedValuesBaseline.ts:84-86` — `resetLoadedValues(pages)` (the
  ONLY writer that replaces the whole baseline) is called exactly once per full `loadSite()`
  (`fsCodemodAdapter.ts:274`). `mergeLoadedValuesBaseline` (targeted-reload counterpart) is the
  only other writer.
- `src/admin/pages/site/studio/fsCodemodAdapter.ts:335-448` — `saveSite`'s diff loop compares
  `node.props[prop]` against `getLoadedNodeValues(node.id)` (the AS-LOADED baseline) and does
  `if (baseline && Object.is(baseline[prop], value)) continue` (line 396) — **it never advances
  the baseline after a successful, non-reloading save.** Contrast with the sibling CSS path
  (`fsCodemodAdapter.ts:573-575`, `commitStyleRuleBaseline(site.styleRules)`) and the localized-text
  path (`fsCodemodAdapter.ts:564-566`, `commitLocalizedTextBaseline(...)`), both of which DO advance
  their own baseline after every save — this is a real asymmetry, not an intentional design.
- `src/admin/pages/site/store/slices/site/undoRedoActions.ts:22-67` — `undo()` applies
  `entry.inverse` and, for a single coalesced burst (`docs/reference/editor-history.md`'s "oldest
  patch per path wins"), restores the value to exactly the PRE-BURST value — which for a single
  edit-then-undo is the ORIGINAL as-loaded value.
- `src/admin/pages/site/studio/fsCodemodAdapter.ts:553` — a non-shifting, non-shared-component
  write (the overwhelming common case: typing a heading, changing a color) never calls
  `requestCmsSiteReload()`, so nothing ever re-syncs `loadedValues` to the just-written value.

**Root cause:** the save-diff baseline is a "what did we load" snapshot, refreshed only on a full
project reload — never on "what did we just successfully write." Reproduction: open a page (baseline
`title="Hell"`), type `"Hello"` (one coalesced undo entry), wait 2s — autosave writes `"Hello"` to
the `.tsx` (baseline still `"Hell"`, never advanced). Press **Ctrl+Z once** — the in-memory tree
reverts to `"Hell"`, `hasUnsavedChanges` flips true, autosave fires again 2s later. That diff now
compares current `"Hell"` against baseline `"Hell"` → `Object.is` is true → the edit is skipped →
`edits.length === 0` → the `POST /admin/api/studio/save` call never even fires
(`fsCodemodAdapter.ts:493`) → `saveSite()` resolves cleanly → `usePersistence.ts:171`
`setHasUnsavedChanges(false)` → the toolbar shows **"Saved."** The `.tsx` file on disk still reads
`"Hello"` forever, until the next full reparse (which will then read `"Hello"` back into the tree
and silently re-diverge the canvas from what the user thinks they undid to). This is exactly the
"disk is truth, undo is in-memory" divergence the audit asked about, and it is silent — no toast, no
"unsaved" indicator survives past the empty save.

**Proposed fix:** advance `loadedValues` after every successful `saveSite()` round trip, the same
way `styleRuleWriteback.ts`/`localizedPageWriteback.ts` already do — call
`mergeLoadedValuesBaseline(site.pages)` (or a props-only equivalent) in
`fsCodemodAdapter.ts` right after `apiRequest('/admin/api/studio/save', …)` resolves, gated on
`result.written > 0`, mirroring the CSS/localized-text pattern already in the same file.

**Effort:** S. One function call added in one file; needs a regression test asserting
"edit → autosave → undo → autosave → disk reflects the undo" (add to
`fsCodemodAdapter.test.ts`, which already tests write-loop safety).

---

### E2 — Every structural edit unconditionally wipes the ENTIRE undo/redo stack and clears the unsaved flag
**Severity: CRITICAL**

**Evidence:**
- `src/admin/pages/site/studio/studioSaveRequests.ts:240-277` — `commitStructural` (the shared body
  of `commitStudioMove`/`commitStudioDelete`/`commitStudioInsert`, and used the same way by
  `detachInstance`/`swapInstance`/`saveStudioAssetEdit`) calls `requestCmsSiteReload()` in a
  `finally` block — **on every outcome**, success or refusal.
- `src/admin/pages/site/hooks/usePersistence.ts:328-360` — the `CMS_SITE_RELOAD_EVENT` handler calls
  `adapterRef.current.loadSite(idToTry)` then `loadSite(site)` (store) then
  **unconditionally `setHasUnsavedChanges(false)`** — with no check of whether other, unrelated
  edits were pending.
- `src/admin/pages/site/store/slices/site/lifecycleActions.ts:119-124` — `loadSite`'s recipe:
  `state._historyPast = []; state._historyFuture = []; state._historyCoalesceKey = null;
  state.canUndo = false; state.canRedo = false; state.hasUnsavedChanges = false`.

**Root cause:** a structural write (drag-reorder in the layers tree, Delete key, inserting a
design-system component, detach, swap, image replace) is a one-shot commit outside
`usePersistence`'s single-flight save queue (`nodeActions.ts` calls
`void commitStudioMove(...)` directly). Its `finally`-block reload was designed to keep the board
honest against a line-shifted or shared-component write (a legitimate need — see the module's own
doc comment), but the mechanism used (`loadSite()`) is the SAME one used for a full project switch,
so it carries that function's "reset everything" semantics: full history wipe, unconditional
dirty-flag clear.

**Consequence:** (a) any edit made before a structural gesture becomes permanently un-undoable — a
user who types five headings, then drags one layer in the tree, loses Ctrl+Z for all five headings;
(b) any edit still inside its 2-second autosave debounce window at the moment of the structural
gesture is discarded outright: `hasUnsavedChanges` goes to `false` and the in-memory value is
replaced by the freshly-reparsed (pre-edit) disk content, with **no toast, no warning** — unlike the
"Local edits overwritten" toast `patchPages` fires for the analogous agent-write case
(`lifecycleActions.ts:325-333`), which this path has no equivalent of.

**Proposed fix:** two independent changes:
1. Give the structural-commit reload a NARROWER re-sync than full `loadSite()` — reuse
   `patchPages`'s targeted-page-merge shape (`lifecycleActions.ts:184-334`), which already prunes
   selection safely and does not touch `_historyPast`/`_historyFuture`/`hasUnsavedChanges` for
   untouched pages.
2. Before firing the structural commit, flush any in-flight autosave-eligible edit through the
   existing save queue (`registerEditorSave`/`requestEditorSave` in `adminEvents.ts`) so a pending
   prop/text edit is durably written (and its baseline advanced, once **E1** is fixed) before the
   reload can discard it.

**Effort:** M. Touches `studioSaveRequests.ts`, `lifecycleActions.ts` (a new "targeted structural
resync" path distinct from `patchPages`), and `nodeActions.ts`'s call sites. Needs new tests
alongside `fsCodemodAdapter.test.ts` / `src/__tests__/persistence/writeLoopSafety.test.tsx`.

---

### E3 — A user's Ctrl+Z of a move/delete can be silently overwritten by the forced reload, because the disk write already landed
**Severity: HIGH**

**Evidence:** `nodeActions.ts:376-396` (`deleteNode`) and `:548-565` (`moveNodes`) mutate the
in-memory tree optimistically and push a real undo entry SYNCHRONOUSLY, then fire
`void commitStudioMove(...)`/`void commitStudioDelete(...)` (`studioSaveRequests.ts:174-193`)
which POSTs to the server; the server applies the AST codemod and writes the file as part of
handling that HTTP request — unconditionally, with no knowledge of anything the client does
afterward. `commitStructural`'s `finally` (`studioSaveRequests.ts:274-276`) then reloads
regardless of outcome (see **E2**).

**Root cause / consequence:** if the user presses Ctrl+Z while the structural POST is still in
flight (a real, easily-hit window — same-machine round trip is "tens of milliseconds" per the
codebase's own comment, but a slow disk/large file can extend it), `undo()` reverts the in-memory
tree and pops the history entry. The server-side write already happened (or will regardless), and
when the response lands, the forced reload re-parses the moved/deleted state straight from disk
and **overwrites the user's undo** with no explanation — the element that was just "un-deleted" or
"moved back" snaps to the post-move/deleted state a moment later. There is no cancellation path for
a disk write already issued, and the client never checks whether the tree changed (via undo) between
issuing the commit and the reload landing.

**Proposed fix:** at minimum, detect this race (compare a monotonic "structural commit in flight"
token against a subsequent `undo()`/`redo()` call, similar to the stale-load race guard boards
autosave already has in `boardsSaveGuard.ts`) and either block the reload from clobbering a newer
undo, or surface a toast ("this change was already saved before it could be undone — redo it
manually") instead of silence. A full fix (make the structural write itself cancellable) is out of
scope for a store-level change alone.

**Effort:** M (detection + toast) / L (true cancellation, needs server cooperation).
Depends on **E2**'s narrower-reload work landing first, since that changes the surface this race
happens against.

---

### E4 — Style/class property edits are not history-coalesced; a drag gesture floods the undo stack
**Severity: MEDIUM**

**Evidence:**
- `src/admin/pages/site/store/slices/styleRule/crudActions.ts:356-380` (`updateClassStyles`) and
  `:382-417` (`setClassContextStyles`) both call `mutateSite((site) => {...})` with **no second
  argument** — contrast with `nodeActions.ts:398-420`'s `updateNodeProps`, which passes
  `coalesceKeyForPatch('props', nodeId, patch)`.
- `src/admin/pages/site/panels/PropertiesPanel/StyleRuleComposer.tsx:48-99` dispatches
  `updateClassStyles`/`setClassContextStyles` directly from `handleChange`, per control interaction,
  with no client-side debounce found in that file.
- `src/admin/pages/site/store/slices/site/helpers.ts:200-238` — `mutateSite`'s `opts?.coalesceKey`
  defaults to `null`, so every call is its own `_historyPast` push (`commitHistory`,
  `helpers.ts:217-238`).

**Root cause:** the coalescing convention (`coalesceKeyForPatch`) was applied to the node-prop path
(`nodeActions.ts`) but never carried over to the style/class path when it was implemented.

**Consequence:** dragging a spacing/opacity/radius slider, or repeatedly nudging a color picker,
produces one undo entry PER onChange tick. `MAX_HISTORY` is 50
(`src/admin/pages/site/store/slices/site/defaults.ts`) — a single drag gesture can evict every
earlier edit from history, and Ctrl+Z after a drag reverts one tick at a time instead of the whole
gesture (contradicts the doc's own stated intent in `docs/reference/editor-history.md`: "a burst of
keystrokes is ONE undo entry" — true for props, false for styles).

**Proposed fix:** pass a stable `{ coalesceKey: `style:${classId}:${contextId ?? 'base'}` }`
(single-property changes) from `updateClassStyles`/`setClassContextStyles` into `mutateSite`, mirroring
`coalesceKeyForPatch`. For multi-property patches (e.g. a shorthand expansion), fall back to no
coalescing exactly as `coalesceKeyForPatch` already does for `updateNodeProps`.

**Effort:** S. Two functions in `crudActions.ts`; add a coverage test alongside
`src/__tests__/editor-store/undo-redo.test.ts`.

---

### E5 — Studio's save path ignores the dirty-tracking infrastructure built for it
**Severity: MEDIUM (architectural correctness risk, not yet observed data loss)**

**Evidence:**
- `src/admin/pages/site/studio/fsCodemodAdapter.ts:335` — `saveSite(site: SiteDocument, _opts:
  SaveSiteOptions = {})` — the parameter is prefixed `_opts` (unused) and the whole function body
  (`:340-448`) loops `for (const page of site.pages) { for (const node of Object.values(page.nodes))
  {...} }` with no filtering by `_opts.dirty`.
- `src/core/persistence/types.ts:25-41` — `SaveSiteOptions.dirty` (`SaveDirtyHints`) exists
  precisely so an adapter can ship an incremental save; `src/admin/pages/site/hooks/
  usePersistence.ts:162-164` already computes and passes it (`takeDirtySaveSnapshot()`) to every
  adapter uniformly.
- `src/admin/pages/site/store/slices/saveTrackingSlice.ts` and `site/dirtyTracking.ts` maintain
  `_dirtySave` correctly and incrementally (confirmed by reading both in full) — but Studio's own
  adapter is the one caller in the codebase that receives these hints and does nothing with them.

**Root cause:** `fsCodemodAdapter.saveSite` was written as a from-scratch full diff before (or
independent of) the dirty-tracking work landing for the CMS adapter, and never wired up.

**Consequence:** not itself a correctness bug (the full-tree diff is still semantically correct —
**E1**'s bug is orthogonal), but it is a duplicated/unused source of truth: two different "what
changed" mechanisms exist (`_dirtySave` and the per-node baseline diff), only one of which is
consulted, and any future change to `_dirtySave`'s contract (e.g. tightening `all` semantics) will
have zero effect on Studio's actual save behavior — a maintenance trap.

**Proposed fix:** either (a) filter the `saveSite` loop to `_opts.dirty.pageIds`/`.all` before
scanning (turns **E7**'s O(site) scan into O(dirty) too — see PERF section), or (b) if the full scan
is intentionally kept for its idempotent-write-anything-changed simplicity, delete the unused
`_opts` parameter and the `dirty` plumbing specifically for the Studio adapter to stop implying a
contract that isn't honored, and document why in `fsCodemodAdapter.ts`'s module doc.

**Effort:** M (option a, and the one worth doing — also fixes **E7**) / S (option b, doc-only).

---

### E6 — Agent-write live reload can discard local edits with a toast as the only recovery signal
**Severity: LOW (announced, but no recovery path)**

**Evidence:** `src/admin/pages/site/store/slices/site/lifecycleActions.ts:184-334` (`patchPages`) —
a page with local unsaved edits that an agent also touched is overwritten
(`overwrittenDirtyTitles`, toasted at `:325-333`: `"Local edits overwritten"`). This is a documented,
deliberate policy (`editor-store.md`'s "merge: reload only touched pages") and, unlike **E2**, it
DOES announce the loss — but the discarded edit is not recoverable (it was never a history entry
distinguishable from "the page as it now is," and `patchPages` deliberately bypasses
`mutateSite`/`runHistoricMutation`, so there is no undo entry to fall back to).

**Proposed fix:** none required for correctness (the policy is intentional and announced) — noted
here only because it's adjacent to **E1**/**E2** and worth the same "can the user get their edit
back" scrutiny. If desired, `patchPages` could snapshot the overwritten page's node values into a
short-lived "last discarded" buffer surfaced from the toast body as an "undo" action, but this is a
product decision, not a bug fix.

**Effort:** N/A (documentation-only) / M if a recovery affordance is wanted.

---

## PERF findings

### E7 — `saveSite` scans and diffs every node of every page on every autosave tick
**Severity: MEDIUM/HIGH (scales with project size, fires every ~2s while dirty)**

**Evidence:** `src/admin/pages/site/studio/fsCodemodAdapter.ts:335-448` —
`for (const page of site.pages) { for (const node of Object.values(page.nodes)) { ... } }`, run
unconditionally on every call, regardless of which single node actually changed. No use of
`_opts.dirty` (see **E5**) or of `_dirtySave`/`_nodeIdToPageIds` to scope the scan to touched pages.

**Root cause:** same as **E5** — the dirty-tracking infra exists elsewhere in the store but this
adapter was never wired to it.

**Consequence:** on the "40-page board / ~1000 nodes-per-page" scale the codebase's own docs use as
the perf reference point (`editor-store.md`, `path-index.md`'s trap #11), every autosave tick after
a single keystroke walks the whole ~40,000-node document client-side (prop iteration, baseline
lookups, `isPropWritableToSource` calls) before it even reaches the network. `STUDIO_AUTOSAVE_DELAY_MS`
(`fsCodemodAdapter.ts:200`) budgets the *server* round trip as "tens of milliseconds" but does not
account for this client-side scan, which grows linearly with project size and runs on the main
thread inside a `Promise` chain that ultimately gates the "Saved" indicator.

**Proposed fix:** filter the outer loop to `site.pages.filter(p => dirty.all || dirty.pageIds.has(p.id))`
using the `_opts.dirty` hints already threaded through by `usePersistence.ts` — the same fix as
**E5**(a).

**Effort:** M. Shared with **E5**; needs `fsCodemodAdapter.test.ts` coverage for "only dirty pages
are scanned/sent."

---

### E8 — Every structural edit forces a full-workspace re-parse, not a targeted one
**Severity: MEDIUM**

**Evidence:** `src/admin/pages/site/studio/studioSaveRequests.ts:274-276` — `requestCmsSiteReload()`
in `commitStructural`'s `finally`; `usePersistence.ts:328-360`'s handler calls
`adapterRef.current.loadSite(idToTry)`, i.e. `fsCodemodAdapter.loadSite()`
(`fsCodemodAdapter.ts:232-333`), which re-parses **every page file in the project** via the
`/admin/api/studio/load` NDJSON stream (ts-morph walk, static evaluation, `.map` expansion, CSS
collection — the full pipeline `docs/features/studio-import.md` describes) — not just the one file
the structural codemod touched.

**Root cause:** the reload exists to re-derive `line:col` node ids after a write that may have
shifted them (a real need — see **E2**'s discussion) but is implemented as "reload the whole site"
rather than "reload the touched file(s)," even though the server already knows exactly which
file(s) it wrote (`server/handlers/studioWriteback.ts`'s `applyStudioEdit`).

**Consequence:** a single drag-reorder or Delete keystroke on a large, multi-page project pays the
full project parse cost synchronously before the board is interactive again — and, per **E2**/**E3**,
this window is also when history and any pending unrelated edit are at risk.

**Proposed fix:** have the structural-edit server route return the list of files it actually wrote
(it already has this), and use the existing targeted reload primitive
(`loadStudioPageInLocale`/`patchPages`'s pattern — `server/handlers/studioPageLoad.ts`'s
per-route loader, `lifecycleActions.ts:184-334`'s merge shape) to re-parse and patch only those
pages, falling back to a full reload only when a file outside the currently-loaded page set could
be affected (e.g. a shared/inlined component's own file).

**Effort:** L. Needs server-side changes (report touched files) and a new client merge path; overlaps
significantly with **E2**'s fix, should be designed together.

---

### E9 — Canvas components subscribing to the whole `site` object re-render on every keystroke, everywhere on the board
**Severity: LOW/MEDIUM**

**Evidence:** `src/admin/pages/site/canvas/CanvasComposedTree.tsx:49` —
`const site = useEditorStore((s) => s.site)`, one instance mounted per rendered board frame (one per
page). Also present in `UserStylesheetInjector.tsx:60`, `useRuntimeScriptBuild.ts:128`,
`useAutoResolveDependencies.ts:45`, and others (grep found 21 call sites across the editor). Each
mutation anywhere in the document produces a new `site` object reference
(`docs/reference/editor-history.md`'s "Mutative mints a new root object per mutation" — confirmed by
reading `runHistoricMutation`'s `live[key] = produced[key]` assignment).

**Root cause:** `site` is a convenient single selector for "give me the document," but its identity
changes on literally every mutation anywhere in it, so any component selecting it directly loses the
page-scoping the rest of the store (`_nodeIdToPageIds`, per-node selectors in `NodeRenderer.tsx`)
was built to provide.

**Consequence:** on an N-frame board, a single keystroke on frame 1 re-invokes `CanvasComposedTree`
(and re-runs `resolveEditorWrapperTemplates(site, page)`, a template-matching pass) for all N
mounted frames, not just the one being edited — proportional to board size, not edit size. Likely
subsumed by React Compiler memoization for the CHEAP branch (`wrappers.length === 0` → plain
`NodeRenderer`), but the component still re-executes its body and re-derives `wrappers` every time.

**Proposed fix:** scope these selectors to the specific page each component instance owns —
`useEditorStore((s) => s.site?.pages.find(p => p.id === page.id))` or, better, a page-keyed lookup
through the existing `_nodeIdToPageIds`-adjacent machinery, so an edit to page A does not invalidate
the mounted component for page B.

**Effort:** M. Touches several files; needs care since some of these legitimately need `site` for
cross-page state (templates, style rules) — a per-file audit is warranted before changing each one.

---

### E10 — `findSelectableNode` bypasses the `_nodeIdToPageIds` index the rest of the store uses
**Severity: LOW**

**Evidence:** `src/admin/pages/site/store/slices/selectionSlice.ts:622-640` —
`findSelectableNode` does `for (const page of state.site.pages) { const node = page.nodes[nodeId];
if (node) return node }` — an O(pages) linear scan — instead of consulting
`state._nodeIdToPageIds` (built exactly for this purpose per `nodeIndex.ts`'s module doc, and
already used correctly by `resolveSelectableNode` a few lines above it in the same file, and by
`findNodeById.ts` in the canvas). Called from `getSelectionActiveClassId`/`nodeHasInlineStyles`,
which run on every `applySelection` (every click).

**Root cause:** inconsistent application of the WS-5.2 index — `resolveSelectableNode` (board-aware)
was updated to use it; `findSelectableNode` (the older, non-board-aware helper still used for VC
canvas mode) was not.

**Consequence:** minor — O(pages), not O(nodes), and only on selection change (not per-keystroke),
so real-world impact is small even on a 40-page board. Flagged for consistency with the rest of the
codebase's WS-5.2 discipline, and because a future change to `resolveSelectableNode` that this
function doesn't mirror is an easy place for the two to silently drift.

**Proposed fix:** route `findSelectableNode` through `_nodeIdToPageIds` the same way
`findNodeById.ts` does, or delete it in favor of a shared helper if its VC-mode-specific behavior
can be folded into `resolveSelectableNode`.

**Effort:** S.

---

## TOP 5 EDIT-LATENCY WINS

1. **E7 — Wire `_opts.dirty` into `fsCodemodAdapter.saveSite`** so autosave diffs only the pages
   that actually changed instead of the whole project on every tick. Biggest win on large boards;
   the infrastructure (`_dirtySave`) already exists and is unused.
2. **E8 — Replace the full-workspace reparse after a structural edit with a targeted, per-file
   reload.** Turns every drag-reorder/delete/insert's latency from O(whole project) to O(touched
   file), and shrinks the correctness-risk window in E2/E3 as a side effect.
3. **E9 — Scope `useEditorStore((s) => s.site)` subscriptions in canvas components to their own
   page** so an edit on one board frame doesn't re-render every other mounted frame.
4. **E10 — Route `findSelectableNode` through `_nodeIdToPageIds`** for consistency and to close off
   the one remaining O(pages) scan in the selection path.
5. **E4 (perf side-effect) — Coalesce style/class edits.** Beyond the undo-correctness fix, this cuts
   the number of Mutative `create()` passes (and history-array pushes/shifts) during a drag gesture
   from one-per-tick to one-per-gesture.

## TOP 5 EDIT-CORRECTNESS RISKS

1. **E1 — Undo of an autosaved prop/text/inline-style edit is never written back to disk.** The
   single most severe finding: silent, permanent tree/disk divergence with no error, no toast, and
   a "Saved" indicator that is lying. Fix first — it is also the smallest fix (S effort).
2. **E2 — Every structural edit wipes the entire undo/redo stack and unconditionally clears
   `hasUnsavedChanges`,** discarding any other pending (not-yet-autosaved) edit with zero warning.
3. **E3 — A user's undo of a move/delete can be silently overridden by the always-fires reload,**
   because the disk write already landed before the client could react — there is no cancellation
   path and no detection of the race.
4. **E4 — Style/class edits aren't history-coalesced,** so a single drag gesture can fill and evict
   the entire 50-entry undo stack, and Ctrl+Z after a drag does not revert the whole gesture.
5. **E5/E6 — Two more "what changed" mechanisms than the store needs** (`_dirtySave` unused by the
   actual save path; `patchPages`'s undo-exempt overwrite has no recovery path beyond a toast) —
   lower severity individually, but both are exactly the kind of duplicated/partial source-of-truth
   that produced E1 in the first place, and are worth closing before they cause their own incident.

