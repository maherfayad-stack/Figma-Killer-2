# Editor Undo/Redo History

How the visual editor captures, stores, and applies undo/redo history using Mutative patch pairs.

Every undoable mutation captures a `HistoryEntry` — a pair of Mutative patch arrays scoped to the `SiteDocument`. Undo applies the `inverse` patches; redo applies the `forward` patches. Cost is O(change): only the paths the recipe touches are drafted and copied.

---

## TL;DR

- History is `_historyPast: HistoryEntry[]` and `_historyFuture: HistoryEntry[]` on the editor store. Max depth: `MAX_HISTORY` (50).
- Each `HistoryEntry` holds `{ inverse, forward, coalesceKey }` — patch arrays, not full-site clones — plus an optional `structural` tag for a gesture that also wrote MARKUP to the user's source.
- `runHistoricMutation` is the single entry point. All seven `mutate*` helpers delegate to it.
- Continuous-input bursts (per-keystroke text/number edits) fold into one entry via `commitHistory` coalescing.
- Patches are scoped to `site` (`state.site.*`) — editor-local state (selection, zoom, panel visibility) is not undoable.
- History is in-memory session state — never serialized.
- A **structural** entry (a move/delete written to the `.tsx`) is undone by RE-ISSUING the gesture, never by replaying its patches. See "Structural undo" below.
- A reparse that renumbers `rel:line:col` node ids **re-addresses** the stack (`historyNodeIdRemap.ts`); wiping is the fallback, not the default.

---

## Performance

Per-mutation wall time is flat at ~0.25–0.4 ms regardless of site size:

| Nodes  | Patch-based | structuredClone (old) | Speedup |
|--------|-------------|----------------------|---------|
| 500    | 0.25 ms     | 0.76 ms              | 3×      |
| 5,000  | 0.28 ms     | 8.8 ms               | 31×     |
| 20,000 | 0.32 ms     | 34 ms                | 106×    |
| 50,000 | 0.40 ms     | 98 ms                | ~245×   |

A full 50-deep history stores ~240 small patches (KB total) instead of 50 whole-site clones (hundreds of MB).

---

## Data model

`src/admin/pages/site/store/slices/site/types.ts`:

```ts
import type { Patches } from 'mutative'

export interface HistoryEntry {
  /** Patches that revert this transaction. Applied on undo. */
  inverse: Patches
  /** Patches that re-apply this transaction. Applied on redo. */
  forward: Patches
  /** Coalescing burst identity, or null. */
  coalesceKey: string | null
  /** Set when this transaction also wrote STRUCTURE to the user's source. */
  structural?: StructuralHistory
}

export type StructuralHistory =
  | { gesture: 'move'; undo: StructuralHistoryMove; redo: StructuralHistoryMove }
  | { gesture: 'delete' }

export interface StructuralHistoryMove {
  nodeId: string
  parentId: string
  /** Index in the destination parent's children AFTER detach — matches `moveNode`. */
  index: number
}
```

The store holds:

```ts
_historyPast:       HistoryEntry[]  // stack — most recent last
_historyFuture:     HistoryEntry[]  // entries available for redo
canUndo:            boolean
canRedo:            boolean
_historyCoalesceKey: string | null  // identity of the in-progress burst
```

---

## How patches are captured

`runHistoricMutation` in `helpers.ts` is the core engine:

```ts
function runHistoricMutation(recipe, coalesceKey) {
  const [next, patches, inverse] = create(cur, (draft) => {
    result = recipe(draft)
    if (result !== false) draft.site.updatedAt = Date.now()
  }, { enablePatches: true })

  // History stores patches relative to `site` (strip the leading path segment)
  const siteForward = patches .filter(p => p.path[0] === 'site').map(p => ({ ...p, path: p.path.slice(1) }))
  const siteInverse = inverse.filter(p => p.path[0] === 'site').map(p => ({ ...p, path: p.path.slice(1) }))

  set(state => {
    // Apply all changed fields to the live store (site + any editor fields)
    for (const key of touched) live[key] = produced[key]
    if (siteForward.length > 0) commitHistory(state, { inverse: siteInverse, forward: siteForward, coalesceKey })
    state.hasUnsavedChanges = true
  })
}
```

`create(cur, recipe, { enablePatches: true })` returns `[next, forwardPatches, inversePatches]`. Only `site`-prefixed patches go into the history entry. Editor-only fields (selection, zoom) are applied live but never recorded.

---

## The seven `mutate*` helpers

All seven helpers in `SiteSliceHelpers` delegate to `runHistoricMutation`:

| Helper | Recipe receives | Coalescing |
|---|---|---|
| `mutateSite(fn, opts?)` | `SiteDocument` draft | `opts.coalesceKey` |
| `mutateSiteWithExplorerReconcile(fn)` | `SiteDocument` draft; calls `reconcileSiteExplorerInPlace` after | none |
| `mutateSiteState(fn)` | Full `EditorStore` draft + `SiteDocument` draft — for a site mutation that must also update editor-local state (e.g. `activeDocument`, selection) in one undoable transaction | none |
| `mutateActiveTree(fn, opts?)` | Active `NodeTree<PageNode>` draft; routes page vs. VC | `opts.coalesceKey` |
| `mutateActiveTreeAndSite(fn)` | Active `NodeTree<PageNode>` + `SiteDocument` drafts | none |
| `mutateAllPagesAndSite(fn)` | `SiteDocument` + `SiteImportTransaction` | none |
| `mutateTreesForNodeIds(nodeIds, fn)` | Once per distinct page containing one of `nodeIds`, that page's `NodeTree<PageNode>` + its own matching ids; falls back to `mutateActiveTree` when every id resolves to one page | none |

`mutateActiveTree` is the only place that branches on page-mode vs. VC-mode. Gated by `no-vc-mode-branches-in-mutations.test.ts`.

---

## Coalescing

Per-keystroke mutations (text edits, number sliders) pass a stable `coalesceKey` such as `props:<nodeId>:<prop>`. While the incoming key matches `_historyCoalesceKey`, `commitHistory` folds the new entry into the existing top entry **per patch path** (`foldIntoCoalescedEntry` in `helpers.ts`):

- **inverse**: the OLDEST patch per path wins (undo restores the pre-burst value); new paths append.
- **forward**: the NEWEST patch's value per path wins (redo replays the final value), preserving the oldest patch's op (an `add` stays an `add` so redo works from the post-undo state where the prop is absent).

A whole typing burst becomes one undo step holding at most one inverse + one forward patch per touched path — a 2,000-keystroke burst retains 2 paths' worth of patches, not 4,000 progressively-longer string snapshots.

Any non-coalescing mutation, `undo`, `redo`, or a site (re)load resets `_historyCoalesceKey` to `null`.

---

## Who owns Ctrl/⌘+Z

The keystroke is owned by `UndoRedoButtons.tsx` (a native `document` keydown
listener), not by the spotlight dispatcher — `editor.undo` / `editor.redo` are
listed in `shortcutDispatch.ts`'s `COMPONENT_OWNED_SHORTCUTS` so they are not
also fired there. A keystroke made inside a canvas iframe reaches it as a clone
re-dispatched on the parent `document` (`useIframeEventForwarding.ts`).

The routing rule is **whoever has an edit in progress owns the keystroke**:

| Focus | ⌘Z goes to |
|---|---|
| Anywhere outside a text field | editor undo |
| A text field with an uncommitted draft | native text undo |
| A text field with no uncommitted draft | editor undo |

"Uncommitted draft" is tracked from real DOM events in
`canvas/pendingTextEdit.ts` — an `input` event marks its target pending; a
focus change, Escape, or Enter on a single-line `<input>` clears it (Enter in a
`<textarea>` is a newline, not a commit). This replaced a blanket "any editable
target wins", which made the editor's history unreachable from the keyboard for
as long as the caret sat in a Properties-panel field — and since every style
row is now prefilled and both field primitives keep focus after their commit,
that was most of the time. Regression test:
`src/__tests__/canvas/undoShortcutRouting.test.tsx`.

---

## One gesture, one entry

A mutation's history cost is decided by its CALLER, not by the store: every
`mutate*` helper takes a whole patch and records one entry, so committing a
multi-property gesture one property at a time is what turns one click into N
undo steps. The Properties panel routes those through a single
`onChangeMany(patch)` — see
[`docs/features/inspector-disclosure.md`](../features/inspector-disclosure.md)
§11.2.

---

## Undo / redo apply

`undoRedoActions.ts` uses `apply` from Mutative:

```ts
// undo
const restored = apply(site, entry.inverse)
const packageJson = clonePackageJson(restored.packageJson)
const siteRuntime = cloneSiteRuntimeConfig(restored.runtime)
set(state => {
  state._historyPast.pop()
  state._historyFuture.push(entry)
  state._historyCoalesceKey = null
  state.site = { ...restored, packageJson, runtime: siteRuntime }
  state.packageJson = packageJson
  state.siteRuntime = siteRuntime
  // re-derive mirrors; keep activePageId valid
})
```

`redo` is symmetric: pops from `_historyFuture`, applies `entry.forward`, pushes back onto `_historyPast`.

---

## Structural undo — the document is the `.tsx`, so undo must be a write

`store-08`. Patch replay is a complete undo for a VALUE edit, because `saveSite`
diffs node values and writes the reverted value back out. It is **not** a
complete undo for a MOVE or a DELETE: `saveSite` has no notion of parent, order
or child list at all — that is why `struct-01` gave structural gestures their
own one-shot source commits (`studioStructuralCommits.ts`). Replaying a move's
inverse patch moves the element on the canvas, leaves the file saying the
opposite, and the next reparse silently wins.

So a gesture that issued a source write tags its entry (`structuralHistory.ts`
→ `tagStructuralGesture`), and `undo`/`redo` branch on that tag before touching
patches:

| gesture | undo | redo |
|---|---|---|
| `move` (canvas body drag, layers-panel drag, reorder + reparent) | re-issues `moveNodes` back to the captured pre-move `(parentId, index)` — re-planned against the live tree, so it rides every refusal gate and writes to source once | re-issues the original move |
| `delete` | **refuses, with a toast.** No `StudioEdit` kind carries a subtree's source text, so there is nothing honest to write; re-adding the nodes in memory would be a canvas that disagrees with the file | — |

The re-issued gesture is an ordinary mutation: it pushes its own history entry
and clears the redo stack. `runStructuralStep` undoes both, so one Ctrl+Z
consumes exactly one entry and a pending redo chain survives.

A structural gesture never coalesces — the tag also clears
`_historyCoalesceKey`, so a drag can never fold into a typing burst.

**On a CMS or Visual Component tree nothing is tagged**: there is no file to
disagree with, and plain patch replay stays correct there.

---

## Surviving a reparse — re-address, don't wipe

A studio-imported node's id IS its source location (`rel:line:col`), so every
structural write shifts the ids of everything below it in the file. Two modules
decide what happens to the stack when the board re-reads from disk
(`loadSite` and `patchPages`, in that order):

1. **`historyNodeIdRemap.ts` — `buildReparseNodeIdRemap(before, after)`.** The
   reparse is a re-read of a tree the store already holds in its post-gesture
   shape (the optimistic mutation and the source write describe the same
   result), so the two trees are isomorphic. A parallel walk from each page's
   root yields an exact old-id → new-id map, and `remapHistoryEntries` rewrites
   every patch path and structural node id through it. Strict by design — same
   page SET, same `moduleId` and same child count at every node, no conflicting
   mapping for a shared `layout.tsx` id — because a wrong remap is worse than a
   wipe.
2. **`historyPreservation.ts` — `historySurvivesReload`.** Unchanged fallback,
   applied to the re-addressed stack: if any referenced node id still doesn't
   resolve, wipe.

Without (1), a single drag cost the undo history of every unrelated edit before
it — and when the shift *permuted* line numbers rather than vacating them (three
same-size siblings reordered), every old id still "existed" and undo replayed
the patch against whichever element had inherited that address.

Complexity: O(nodes) per reparse, and only when the stack is non-empty.

---

## Auto-freeze

The Zustand store is created with `mutative({ enableAutoFreeze: true })`. That keeps a dev guard against accidental external mutation, and existing code already tolerates frozen state. `apply()` and `create()` handle frozen bases correctly.

---

## What is NOT undoable

- Selection, hover, zoom, pan — editor-local UI state, not in the `site` document.
- **Everything in `boardSlice.ts`** — frame position/size (`setFramePosition`,
  `setFrameSize`, `setFrameRect`), board create/rename/delete, guides,
  annotations, and the prototype links in `prototypeSlice.ts`. All of it lives
  outside `site` (in `boards`/`prototype` state persisted to `.studio/`), and
  `runHistoricMutation` records only `site`-scoped patches. Undoing a board
  frame move would need a second history domain; there is no partial version of
  that worth shipping.
- **Undo of a source `delete`, `duplicate`, `wrap` or `insert`.** `duplicate`,
  `wrap` and `insert` do not mutate the tree at all on a studio-imported board
  (the source grows and the board re-reads), so they never produce a history
  entry; `delete` produces one but refuses to replay it. See "Structural undo".
- `mutateSiteState` — the recipe may write editor fields (e.g. `activeDocument`) alongside a `site` mutation; the editor fields go live but only the `site` patches enter history (parity with the prior snapshot model).
- History stacks themselves — resetting to `[]` on `clearSite` is a lifecycle operation, not a mutation.

---

## Forbidden patterns

- `structuredClone(site)` for history — the old snapshot model is gone. Never re-introduce it.
- Calling `set(state => { state.site = ... })` directly on a mutation — go through a `mutate*` helper so patches are captured.
- Returning a value from a `create` recipe — Mutative treats it as a full replacement. Capture no-op signals in a closure variable and return `false`.

---

## Related

- `src/admin/pages/site/store/slices/site/helpers.ts` — `runHistoricMutation`, `commitHistory`, all six `mutate*` helpers
- `src/admin/pages/site/store/slices/site/undoRedoActions.ts` — `undo`, `redo`, `runStructuralStep`
- `src/admin/pages/site/store/slices/site/structuralHistory.ts` — `tagStructuralGesture`, `captureMoveOrigin`, `reissueStructuralMove`
- `src/admin/pages/site/store/slices/site/historyNodeIdRemap.ts` — `buildReparseNodeIdRemap`, `remapHistoryEntries`
- `src/admin/pages/site/store/slices/site/historyPreservation.ts` — `historySurvivesReload`
- `src/admin/pages/site/store/slices/site/types.ts` — `HistoryEntry`, `SiteSliceHelpers`
- `src/admin/pages/site/store/slices/site/defaults.ts` — `MAX_HISTORY`
- `docs/editor.md` — editor store overview
- `docs/reference/page-tree.md` — the `NodeTree` primitive mutations operate on
- Gate tests:
  - `src/__tests__/architecture/centralized-site-mutation-history.test.ts`
  - `src/__tests__/architecture/no-vc-mode-branches-in-mutations.test.ts`
  - `src/__tests__/editor-store/undo-redo.test.ts`
  - `src/__tests__/editor-store/structuralMoveUndo.test.ts`
  - `src/__tests__/editor-store/structuralReloadHistoryPreservation.test.ts`
