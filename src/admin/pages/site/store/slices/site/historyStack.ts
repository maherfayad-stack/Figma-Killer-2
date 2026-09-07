/**
 * historyStack — the ONE writer of `_historyPast` / `_historyFuture` /
 * `_historyCoalesceKey` for a new transaction.
 *
 * Extracted from `helpers.ts` (`store-09`) because there is now more than one
 * mutation domain that has to reach it. `runHistoricMutation` records
 * `site`-scoped Mutative patches; the board slice records a board-domain
 * snapshot pair (`boardHistory.ts`). Both push the SAME `HistoryEntry` shape
 * onto the SAME stack, so ⌘Z consumes whatever the user did last regardless of
 * which domain it lived in — which is the whole point: the user does not know
 * that a sticky note and a padding value are stored in different places.
 *
 * Coalescing is domain-agnostic and lives here:
 *   - site patches fold by patch PATH (oldest inverse wins, newest forward
 *     value wins) — see `foldIntoCoalescedEntry`;
 *   - a board snapshot pair folds by keeping the burst's ORIGINAL `before` and
 *     taking the newest `after`, which is exactly "one undo entry per drag".
 */
import type { Draft, Patches } from 'mutative'
import type { EditorStore } from '@site/store/types'
import { MAX_HISTORY } from './defaults'
import type { HistoryEntry } from './types'

/** Serialize a patch path so fold dedup can key on it. */
function patchPathKey(path: Patches[number]['path']): string {
  return JSON.stringify(path)
}

/**
 * Fold one coalesced keystroke's patch pair into the in-progress burst entry,
 * deduplicating by patch path: the entry holds AT MOST one inverse and one
 * forward patch per touched path, instead of accumulating 2K pairs (each
 * carrying the full prop value at that instant) over a K-keystroke burst.
 *
 *  - inverse (undo): the OLDEST patch per path wins — it restores the
 *    pre-burst value. Patches for newly-touched paths are prepended, keeping
 *    the previous newest-first replay order for hierarchically-overlapping
 *    paths.
 *  - forward (redo): the NEWEST value per path wins, but the stored patch
 *    keeps the op of the OLDEST forward patch: if the burst CREATED the prop,
 *    the folded patch stays 'add'-shaped so redo replays from the post-undo
 *    state where the prop is absent. Mutative's `apply` treats 'add' and
 *    'replace' identically for plain-object keys (verified against
 *    mutative@1.3.0 `src/apply.ts`, pinned by `historyCoalescingFold.test.ts`)
 *    — they differ only for array indices, which coalescing recipes never
 *    patch — so preserving the op is exactness, not necessity. When a
 *    'remove' op is involved on either side, the incoming patch replaces the
 *    stored one wholesale: deleting an absent object key is a no-op, so the
 *    newest patch already describes the burst's net effect for that path.
 *
 * Undo/redo results are bit-identical to the previous concat behavior —
 * replaying [newest…oldest] inverses leaves the oldest value per path, and
 * replaying [oldest…newest] forwards leaves the newest.
 */
function foldIntoCoalescedEntry(top: Draft<HistoryEntry>, entry: HistoryEntry): void {
  const knownInverse = new Set<string>()
  for (const p of top.inverse) knownInverse.add(patchPathKey(p.path))
  const freshInverse = entry.inverse.filter((p) => !knownInverse.has(patchPathKey(p.path)))
  if (freshInverse.length > 0) top.inverse = [...freshInverse, ...top.inverse]

  const forward = [...top.forward]
  const forwardIndexByPath = new Map<string, number>()
  forward.forEach((p, i) => forwardIndexByPath.set(patchPathKey(p.path), i))
  for (const incoming of entry.forward) {
    const key = patchPathKey(incoming.path)
    const i = forwardIndexByPath.get(key)
    if (i === undefined) {
      forwardIndexByPath.set(key, forward.length)
      forward.push(incoming)
      continue
    }
    const oldest = forward[i]!
    forward[i] =
      oldest.op === 'remove' || incoming.op === 'remove'
        ? incoming
        : { op: oldest.op, path: incoming.path, value: incoming.value }
  }
  top.forward = forward

  // `store-09` — the board domain's fold. A drag writes the whole board file
  // on every pointermove, so the burst's undo target is the FIRST `before` it
  // ever saw and its redo target is the LATEST `after`. Keeping the original
  // `before` is what makes one drag exactly one undo entry.
  if (entry.board) {
    top.board = { before: top.board?.before ?? entry.board.before, after: entry.board.after }
  }
}

/**
 * Commit one transaction's history entry.
 *
 * Coalescing: when the incoming key matches the in-progress burst, the entry
 * folds into the existing top entry instead of pushing a new one, so a whole
 * typing burst (or one pointer drag) is one undo step.
 */
export function commitHistoryEntry(state: Draft<EditorStore>, entry: HistoryEntry): void {
  const coalescing =
    entry.coalesceKey !== null &&
    entry.coalesceKey === state._historyCoalesceKey &&
    state._historyPast.length > 0
  if (coalescing) {
    foldIntoCoalescedEntry(state._historyPast[state._historyPast.length - 1]!, entry)
    state._historyFuture = []
    state.canRedo = false
    return
  }

  state._historyPast.push(entry)
  if (state._historyPast.length > MAX_HISTORY) {
    state._historyPast.shift() // evict oldest
  }
  state._historyFuture = []
  // Open a new burst (coalesceKey set) or end any prior one (null).
  state._historyCoalesceKey = entry.coalesceKey
  state.canUndo = true
  state.canRedo = false
}
