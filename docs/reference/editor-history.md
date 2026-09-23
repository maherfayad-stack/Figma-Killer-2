# Editor Undo/Redo History
> **Purpose:** patch-based undo/redo: HistoryEntry, the mutate helpers, coalescing · **Read when:** touching undo, redo or history coalescing · **Trust:** current · **Owner:** store-engineer · **Verified:** not yet

How the visual editor captures, stores, and applies undo/redo history using Mutative patch pairs.

Every undoable mutation captures a `HistoryEntry` — a pair of Mutative patch arrays scoped to the `SiteDocument`. Undo applies the `inverse` patches; redo applies the `forward` patches. Cost is O(change): only the paths the recipe touches are drafted and copied.

---

## TL;DR

- History is `_historyPast: HistoryEntry[]` and `_historyFuture: HistoryEntry[]` on the editor store. Max depth: `MAX_HISTORY` (50).
- Each `HistoryEntry` holds `{ inverse, forward, coalesceKey }` — patch arrays, not full-site clones — plus an optional `structural` tag for a gesture that also wrote MARKUP to the user's source, and an optional `board` state pair for a gesture in the BOARD domain.
- `runHistoricMutation` is the single entry point for `site`; `commitBoardChange` is its board-domain counterpart. Both push through `commitHistoryEntry` (`historyStack.ts`), the sole writer of the stacks.
- Continuous-input bursts (per-keystroke text/number edits) fold into one entry via `commitHistoryEntry` coalescing.
- Patches are scoped to `site` (`state.site.*`) — editor-local state (selection, zoom, panel visibility) is not undoable.
- **One stack, two domains** (`store-09`). Board state (`boards` / `activeBoardId`, persisted to `.studio/boards.json`) records a before/after SNAPSHOT PAIR on the same stack instead of patches — `boardHistory.ts`. ⌘Z gives back the last thing the user did, whether it was a style value, a structural move, a frame drag or a sticky-note move.
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
  /** Set when this transaction changed BOARD state (`store-09`). */
  board?: BoardHistory
}

/**
 * Board state before/after. Snapshots, not patches: every board mutation is a
 * pure transform republished through `upsertBoard`, so a pair is two
 * references over a persistent structure — O(1) to store and to restore, with
 * no patch path that goes stale when a board or frame index shifts.
 */
export interface BoardHistorySnapshot {
  boards: BoardsFile
  activeBoardId: string | null
}

export interface BoardHistory {
  before: BoardHistorySnapshot
  after: BoardHistorySnapshot
}

export type StructuralHistory =
  | { gesture: 'move'; undo: StructuralHistoryMove; redo: StructuralHistoryMove }
  | { gesture: 'source'; source: StructuralSourceGesture } // insert/duplicate/wrap/group/ungroup/paste/transplant/image-drop/delete

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
    if (siteForward.length > 0) commitHistoryEntry(state, { inverse: siteInverse, forward: siteForward, coalesceKey })
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

Per-keystroke mutations (text edits, number sliders) pass a stable `coalesceKey` such as `props:<nodeId>:<prop>`. While the incoming key matches `_historyCoalesceKey`, `commitHistoryEntry` folds the new entry into the existing top entry **per patch path** (`foldIntoCoalescedEntry` in `historyStack.ts`):

- **inverse**: the OLDEST patch per path wins (undo restores the pre-burst value); new paths append.
- **forward**: the NEWEST patch's value per path wins (redo replays the final value), preserving the oldest patch's op (an `add` stays an `add` so redo works from the post-undo state where the prop is absent).

A whole typing burst becomes one undo step holding at most one inverse + one forward patch per touched path — a 2,000-keystroke burst retains 2 paths' worth of patches, not 4,000 progressively-longer string snapshots.

Any non-coalescing mutation, `undo`, `redo`, or a site (re)load resets `_historyCoalesceKey` to `null`.

A board entry folds the same way, by domain: the burst keeps its ORIGINAL
`board.before` and takes the newest `board.after`. That is what makes one
pointer drag exactly one undo entry — see "Board history" below.

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
[`docs/features/inspector.md`](../features/inspector.md)
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

A board-only entry (`isBoardOnlyEntry`) takes `runBoardStep` instead, which
needs no `site` at all — hence the `site` guard sits BELOW the board branch. An
entry carrying both domains restores both halves in the same `set`.

---

## Board history — the second domain

`store-09`. User report, verbatim: *"when moving sticky notes, and elements in
the canvas and click ctrl + z it doesn't get back to that position"*, against
the standing rule *"it should work on every action"*.

**What is recorded.** Everything in `boardSlice.ts` +
`boardFrameSliceActions.ts` + `boardAnnotationSliceActions.ts` +
`boardBulkFrameSliceActions.ts` + `boardFrameSelectionActions.ts` that changes
`boards`: frame move / resize / rect / membership / axes / "duplicate as
variant", board create / rename / delete, ruler guides, sticky notes and doc
cards (add, move, resize, text, color, delete, duplicate, paste, nudge,
reorder), and every bulk frame action.

**How.** `commitBoardChange(set, get, coalesceKey, nextBoards, extras)` in
`boardHistory.ts`. The pure `@core/studio-board` transforms are untouched; this
only owns the store write, and it applies the mutation AND records the entry in
one `set`. `extras.also` writes editor-local fields (selection, clipboard,
frame defaults) live WITHOUT recording them — the same rule
`runHistoricMutation` applies to the editor fields a site recipe touches.

**One entry per drag.** A frame drag calls `setFramePosition` on every
`pointermove` and an annotation drag calls `moveNote`/`moveDoc` the same way
(that position is real board state the snap guides and the autosave read, so it
cannot be deferred to pointer-up). Each tick commits, so every continuous
gesture passes a key from `boardCoalesceKey`, scoped to the ENTITY:

| Gesture | Key | Closed by |
|---|---|---|
| Frame move drag | `board:frame-move:<frameId>` | `endBoardGesture` on pointer-up |
| Frame resize drag | `board:frame-rect:<frameId>` | `endBoardGesture` on pointer-up |
| Frame arrow-nudge | `board:frame-nudge` | `endBoardGesture` on `keyup` |
| Note/doc move drag | `board:annotation-move:<kind>:<id>` | `endBoardGesture` on pointer-up |
| Note/doc resize drag | `board:annotation-resize:<kind>:<id>` | `endBoardGesture` on pointer-up |
| Note/doc arrow-nudge | `board:annotation-nudge` | `endBoardGesture` on `keyup` |
| Sticky-note text session | `board:note-text:<noteId>` | `endBoardGesture` on blur/Escape |
| Doc rich-text session | `board:doc-html:<docId>` | `endBoardGesture` on session end |
| Guide drag | `board:guide-move:<guideId>` | `endBoardGesture` on pointer-up |

Everything else (add, delete, rename, recolor, reorder, every bulk action)
passes `null` — a discrete commit is its own entry.

`endBoardGesture()` is what makes the SECOND drag of the same thing a second
undo step. Without it the key would still match and both drags would fold into
one entry.

**Persistence.** Board state is Studio's own state on disk, never the user's
`.tsx`, so undo is plain state replay plus a re-persist: `restoreBoardSnapshot`
re-raises `boardsDirty` (the signal `AdminCanvasLayout`'s 800ms autosave
watches) and re-raises `boardsPendingExplicitRemoval` when the restore shrinks
the frame set — without which `boardsSaveGuard.ts` would refuse the save that
lands the undo.

**Reload boundaries — opposite answers, on purpose.**

- A **site** reload/patch that fails `historySurvivesReload` now calls
  `retainBoardOnlyEntries` instead of `= []`. A `.tsx` reparse says nothing
  about `.studio/boards.json`; wiping a sticky-note move because a page's line
  numbers shifted is exactly the bug `store-08` fixed for the site domain.
  `remapHistoryEntries` passes board entries through untouched (they carry no
  patch paths and no structural tag).
- A **boards** read (`loadBoards`, `markBoardsLoadFailed`) calls
  `dropBoardHistory`. A stored snapshot references the object graph the store
  held at the time; once the server hands back a different graph, replaying it
  would not undo the last gesture, it would resurrect a whole boards file.
  Entries that also carry site patches keep those and lose only their board half.

**Why LIFO makes whole-file snapshots exact.** The stack is only ever read from
the top, so at the moment of undo the live state IS this entry's `after` and
assigning `before` is exact rather than approximate. The only way that breaks is
a board mutation that bypasses the history stack — which is why the two boards
READ paths purge, and why `seedFramesForActiveBoard` (the one-time default-board
hydration, not a gesture) is deliberately not recorded.

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
| `source` (`store-14`/`store-15`) — insert, duplicate, wrap, group, ungroup, paste, cross-frame transplant, OS image drop, **delete** | posts the INVERSE EDITS through the same `/save` route the gesture used (`commitStudioStructuralReissue`) | re-posts the gesture's own `forward` edits |

### The `source` gesture — the family whose undo is a WRITE

`store-14`/`store-15`. Seven of these gestures mutate **no** tree on a
studio-imported board: the element does not exist until the codemod has
written it, and its id is the `line:col` that write produces. So they
committed no transaction, pushed no entry, and ⌘Z after one of them undid
whatever came before it (`canvas-20`, landmine 10). Their entry carries **no
patches at all** — only `structural.source` — the same way a board-only entry
carries only `structural`/`board`.

**`delete` is the eighth member, and the one exception to "mutates no tree".**
It still removes the node from the tree eagerly, same-tick, the moment the
gesture runs (`broadcastOptimisticDelete`'s reason to exist) — but its UNDO
rides this same family, never a patch replay: `saveSite` has no notion of
parent or child list, so replaying the tree-removal's own inverse patch would
put the node back in memory while the `.tsx` still lacks it. Two consequences
follow from keeping the eager mutation:

- The entry already exists (pushed by `mutateActiveTree`) before the delete's
  own commit even starts, so `deleteNodesAction.ts`/`nodeActions.ts` **tag**
  it (`tagStructuralGesture`) rather than pushing a fresh one the way the
  other seven do post-hoc. Tagging with a `source` gesture also **clears that
  entry's `inverse`/`forward` patch arrays** — the real Mutative patches from
  the tree removal, which name the exact node id this gesture just made
  permanently gone. Left standing, `historyPreservation.ts`'s reload-safety
  check (next section) would read that as a stale reference on the very next
  reparse — including this gesture's own resync — and wipe the whole stack
  before the fill below ever lands.
- The gesture's `label`/`forward`/`inverseTemplate` are decided at TAG time,
  from the pre-delete tree (`captureDeleteOrigin` — the parent id and the
  child's position among the parent's own plain JSX-element children, the
  same count `reinsertJsxSource`'s `index` counts server-side). But `inverse`
  itself cannot be — the bytes to restore are not known until the delete's own
  commit answers. So it starts `null`, and a third `PendingStructuralHistory`
  kind, `fill` (distinct from `push` and `refresh`), asks
  `recordStructuralSourceWrite` to resolve `inverse` on that SAME top-of-stack
  entry once the commit's outcome (`removed`/`prunedImports`) is known —
  never pushing a second entry for a gesture that only happened once.

The inverse is expressed in the edit kinds that already exist. There is no
`revert` kind and no file snapshot:

| gesture | inverse |
|---|---|
| insert / duplicate / paste / image drop | `delete` what it created |
| wrap / group | `ungroup` the container it created |
| ungroup | `group` the children it released, into the same container |
| transplant (move) | `transplant` back to the parent it left |
| transplant (copy) | `delete` the copy it created |
| delete | `reinsert-source` each element back where it was (`reinsertJsxSource`) |

**`reinsert-source`**, `store-15`'s own edit kind: `nodeId` is the PARENT
(like `insert`'s), `index` the child position among the parent's plain
JSX-element children, `text` the exact bytes `deleteJsxElement` discarded
(`DeletedJsxText`, never re-rendered — a whole-line restore keeps its own
indentation verbatim), `imports` the standalone declaration texts the
delete's own `pruneOrphanedImports` pass removed
(`PrunedImportsResult.declarations`), re-added as their own lines after the
file's last import. A multi-node delete's restore posts one edit per element,
ordered ascending by `index` within each shared parent — ties the server's own
bottom-to-top ordering (by each edit's PARENT position) then resolves.

**One refusal remains for delete, and it is not "no `StudioEdit` kind carries
source text" any more — it is "no origin was captured".** `captureDeleteOrigin`
returns `null` when the deleted node's parent has no writable source position
at all — the synthetic page root, whose only "position" is the page's own
`return` statement. Deleting the page's sole returned element is already
refused there by `deleteJsxElement`'s own `no-jsx-parent` (the AST answers a
question the tree cannot); a delete that reaches this state anyway records an
`unsupported` inverse template rather than guessing, and ⌘Z skips it the way
it skips every other `unsupported` `source` template (see "A step that can
never happen is skipped" below).

Because the inverse addresses elements the write had not made yet (or, for
`delete`, discarded bytes the write had not yet reported), the gesture records
a **template** (`structuralUndoPlan.ts`) and `resolveStructuralInverse` fills
it in from the batch's answer — `createdNodeIds`/`relocatedNodeIds` for the
first seven, `removed`/`prunedImports` for `delete`'s own `reinsert-deleted`
template. A template rather than a closure, because a redo has to re-resolve
it: the gesture has been performed a second time, possibly at a different
position, and the entry's inverse has to describe THAT one.

**Two refusals are deliberate, and are skipped at ⌘Z (see "A step that can never
happen is skipped" below) rather than posting a write the server would decline:** a group into a COMPONENT container (dissolving it would
delete a call site — `unwrapJsxElement`'s `has-behaviour`), and an ungroup of a
container carrying a `className`/`style`/`id` (a re-wrap writes a bare tag and
would drop what it carried). Closing the second needs `props` on the
`wrap`/`group` edit.

**Why absolute ids are safe here:** undo is strictly LIFO, so undoing the top
entry restores the file to the state the entry below it was recorded against —
each inverse is always evaluated against exactly the state it was computed in.
What can break the chain is a write that is not on the stack (an agent's
edit, an external editor), and `reissueStructuralSourceEdits` checks every id
against the board first — skipping the step, and naming the file, rather than
editing whatever now sits at that line.

The re-issued gesture is an ordinary mutation: it pushes its own history entry
and clears the redo stack. `runStructuralStep` undoes both, so one Ctrl+Z
consumes exactly one entry and a pending redo chain survives.

### Undo finds the page that owns the element (ERR-3)

Pressing on a board frame activates its page, so "drag in frame A, click
frame B, ⌘Z" is the normal flow. Both halves of structural undo used to ask the
ACTIVE tree: a move answered "Nothing to undo here" and stayed on top of the
stack, and a `source` step called every id "missing" and opened a modal blaming
the file. Now:

- `reissueStructuralMove` finds the page that holds both the element and its
  destination parent through `_nodeIdToPageIds` (O(1) per id; the first such
  page wins for shared layout chrome) and activates it silently with
  `openPageInCanvas` — the way Figma takes you to the page an undo changes —
  before calling `moveNodes`, which routes through `mutateActiveTree`.
- `reissueStructuralSourceEdits` checks every id against `_nodeIdToPageIds`,
  i.e. the whole board, and reads a `transplant-back` parent's children off the
  page that owns it. Nothing is activated: the write does not need a tree.

### A step that can never happen is skipped (ERR-2 stop-gap, ERR-28)

A structural step can be impossible as recorded: an `unsupported` inverse (the
two deliberate refusals above, a delete whose parent has no source position),
an element the board no longer has, a file an agent or an editor changed under
the entry, or a move the gate refuses. Each used to leave the entry on top of
the stack — behind a modal `RefusalDialog` for the `source` family — so every
later ⌘Z hit the same refusal and nothing before it could be undone from the
keyboard.

`runStructuralStep` now **skips** it (`skipStructuralStep`, `undoRedoActions.ts`):

- **undo** drops the entry and carries on to the step below in the same
  keystroke, so one ⌘Z still does one visible thing;
- **redo** drops the whole redo chain, because every later step was recorded
  on top of the one that cannot be replayed;
- one warning toast, "Skipped “<label>” — it can’t be undone", says why, deduped
  per direction. Never a dialog. A move the gate refused has already said why
  in its own toast or dialog, so the skip adds nothing.

The real fix for delete — a compare-and-swap restore journal — is `P3-F`.

### A write that does not land is taken back (ERR-6)

A move or delete changes the tree before its write is posted; an undo/redo
moves its entry before its re-issued write is posted. When the write does not
land, `structuralCommitRollback.ts` takes that back — the same settle-or-roll-back
contract `structuralOptimism.ts` gives the insert family, handed to
`commitStructural` as `options.rollback`:

| outcome | tree | stack |
|---|---|---|
| landed (`written > 0`) | the resync owns it | `settle()` clears the mark |
| refused (`written === 0`, or a server-built error) | the gesture's own inverse patches are replayed | a gesture's entry is removed; an undo/redo step is **skipped** (removed) — it would be refused again |
| unreachable after the retry ladder | same | a gesture's entry is removed; an undo/redo step **goes back** where it was, so ⌘Z can try it again |

- The entry is found again by `HistoryEntry.pendingCommit` (`{ id, step }`),
  never by identity: a reload in between re-addresses entries by copying them.
  A re-issued move's own entry is discarded by `runStructuralStep`, which
  stamps the same id onto the entry it moved.
- The inverse patches are held by the handle, not the entry — a delete's tag
  clears the entry's patches (`store-15`), and the handle is taken before it.
- The tree half is skipped when a re-read replaced one of the gesture's pages
  since (`pageReadEpoch.ts`, bumped by `loadSite`/`createSite`/`clearSite` and
  by `patchPages` — for every page when it removes one, since removal shifts
  the page indexes the patches address). That page already says what disk
  says; replaying a stale inverse over it would invent a change. Value edits
  made meanwhile do not count: they never touch the `children`/`parentId` paths
  a move or delete restores, and every other structural gesture is queued.
- **Retry first.** `structuralWriteRetry.ts` retries a write that got no answer
  (`fetch` rejecting, or a 502/503/504 that outlived `@core/http`'s own ladder)
  on `STRUCTURAL_WRITE_RETRY_BACKOFF_MS` (1 s, 2 s, 4 s), with ONE
  `X-Studio-Idempotency-Key` across attempts (`apiRequest`'s new
  `idempotencyKey`), so a replay of a write that landed gets the stored answer
  instead of moving or deleting twice. A response the server built is never
  retried.
- **One toast.** A refused batch says its first reason once ("(N more like
  this.)"), never one card per edit.
- An `element-moved` miss (P1-A) re-plans before deciding: the re-plan inherits
  the rollback, and a re-plan that cannot run rolls back as `refused`.

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
   every patch path and structural node id through it — including, for a
   `source` entry, the node ids in the edit payloads its ⌘Z and ⌘⇧Z would post,
   which are nothing but node ids. Strict by design — same
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
- **Prototype links** (`prototypeSlice.ts` / `prototypeActions.ts`). Unlike
  board state, every link op is a SERVER round trip
  (`applyPrototypeOp` → `adoptPrototype`), so undo would have to re-issue an
  async write and handle its failure — the shape `structuralHistory.ts` uses for
  moves, not the shape `boardHistory.ts` uses for boards. Named gap.
- **`seedFramesForActiveBoard`** — the one-time default-board hydration
  `useStudioDefaultBoardSeed` runs at load. Deliberate: it is not a gesture, and
  recording it would put an undo entry on the stack before the user has touched
  anything.
- **Board/annotation SELECTION, `activeBoardId` on its own, snap guides,
  `frameDefaults`** — editor-local, same rule as node selection. (Undo does
  PRUNE an annotation selection that points at something the restore removed.)
- **Undo of a source `delete` whose parent has no writable position** — the
  page's sole returned root element, matching `deleteJsxElement`'s own
  `no-jsx-parent` refusal. Every ordinary delete IS undoable, as a
  `reinsert-source` write, since `store-15` — see "The `source` gesture" above.
- `mutateSiteState` — the recipe may write editor fields (e.g. `activeDocument`) alongside a `site` mutation; the editor fields go live but only the `site` patches enter history (parity with the prior snapshot model).
- History stacks themselves — resetting to `[]` on `clearSite` is a lifecycle operation, not a mutation.

---

## Forbidden patterns

- `structuredClone(site)` for history — the old snapshot model is gone. Never re-introduce it.
- Calling `set(state => { state.site = ... })` directly on a mutation — go through a `mutate*` helper so patches are captured.
- Returning a value from a `create` recipe — Mutative treats it as a full replacement. Capture no-op signals in a closure variable and return `false`.

---

## Related

- `src/admin/pages/site/store/slices/site/helpers.ts` — `runHistoricMutation`, all six `mutate*` helpers
- `src/admin/pages/site/store/slices/site/historyStack.ts` — `commitHistoryEntry`, `foldIntoCoalescedEntry` (the sole writer of the stacks)
- `src/admin/pages/site/store/slices/boardHistory.ts` — `commitBoardChange`, `restoreBoardSnapshot`, `boardCoalesceKey`, `retainBoardOnlyEntries`, `dropBoardHistory`
- `src/admin/pages/site/store/slices/site/undoRedoActions.ts` — `undo`, `redo`, `runStructuralStep`
- `src/admin/pages/site/store/slices/site/structuralHistory.ts` — `tagStructuralGesture`, `captureMoveOrigin`, `reissueStructuralMove`
- `src/admin/pages/site/store/slices/site/structuralCommitRollback.ts` — `trackStructuralTreeCommit`, `trackStructuralStackCommit` (ERR-6)
- `src/admin/pages/site/store/slices/site/pageReadEpoch.ts` — which pages a re-read replaced since a mark (ERR-6)
- `src/admin/pages/site/studio/structuralWriteRetry.ts` — the unreachable-write retry ladder (ERR-6)
- `src/admin/pages/site/store/slices/site/historyNodeIdRemap.ts` — `buildReparseNodeIdRemap`, `remapHistoryEntries`
- `src/admin/pages/site/store/slices/site/historyPreservation.ts` — `historySurvivesReload`
- `src/admin/pages/site/store/slices/site/types.ts` — `HistoryEntry`, `SiteSliceHelpers`
- `src/admin/pages/site/store/slices/site/defaults.ts` — `MAX_HISTORY`
- `docs/editor.md` — editor store overview
- `docs/reference/page-tree.md` — the `NodeTree` primitive mutations operate on
- Gate tests:
  - `src/__tests__/architecture/centralized-site-mutation-history.test.ts`
  - `src/__tests__/architecture/no-vc-mode-branches-in-mutations.test.ts`
- `src/__tests__/editor-store/boardUndo.test.ts` — board undo/redo, one-entry-per-drag, two-domain interleaving, reload boundaries
  - `src/__tests__/editor-store/undo-redo.test.ts`
  - `src/__tests__/editor-store/structuralMoveUndo.test.ts`
  - `src/__tests__/editor-store/undoTellsTheTruth.test.ts` — cross-frame undo, skip, rollback, retry (P1-F)
  - `src/__tests__/editor-store/structuralReloadHistoryPreservation.test.ts`
