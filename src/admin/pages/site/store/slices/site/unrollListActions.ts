/**
 * unrollListActions — G-9 / OD-24: "Unroll list". The explicit, menu-only,
 * lossy action that writes a `.map` over an array literal out as the elements
 * it renders (`unrollMapExpression`), and — when it was offered as the way
 * forward from a refused gesture — replays that gesture against the new
 * elements.
 *
 * OD-24 was still "proposed" when this shipped; this implements the program
 * doc's recommendation (yes, explicit and menu-only), not a settled owner
 * decision. Nothing offers it unprompted: the refusal dialog lists it beside the
 * other remedies, and the Layers menu and the command palette carry it.
 *
 * The flow is OD-7's (`instanceOnlyGesture.ts`), one step shorter:
 *
 *   1. **Write the rows** (`commitStudioUnrollList`): one journaled `/save`
 *      edit; the board re-reads and the list is N ordinary elements.
 *   2. **Replay the gesture** the user tried, with every id it named followed
 *      to its new address. A `.map`'s rows were already N nodes on the board, so
 *      the page tree before and after is the same shape and the reparse
 *      correspondence (`buildReparseNodeIdRemap`) is exact — rows, what is
 *      inside them, and every element below the list whose line moved. If it
 *      cannot account for every row the gesture is NOT replayed against guessed
 *      ids: the list is unrolled and the user is told to make the change again.
 *   3. **Link the two history entries** (`gestureReplayLink.ts`): one ⌘Z undoes
 *      the gesture and brings the list back.
 *
 * The consequence is named, once, as an info notice with Undo — the list is no
 * longer data-driven, and its array is left in the file.
 */
import { planUnrollList } from '@core/page-tree'
import { pushToast } from '@ui/components/Toast'
import { deferWhileStructuralCommitInFlight } from '@site/studio/structuralCommitQueue'
import { commitStudioUnrollList } from '@site/studio/studioStructuralCommits'
import type { StructuralWriteOutcome } from '@site/studio/structuralUndoPlan'
import { linkReplay, structuralWritesIdle, unlinkIfNothingLanded } from './gestureReplayLink'
import { resolveActiveTreeTarget } from './helpers'
import { buildReparseNodeIdRemap } from './historyNodeIdRemap'
import type { EditorStore } from '@site/store/types'
import type { SiteSliceHelpers } from './types'

/** Every id a refused gesture named, re-addressed after the write — see {@link UnrollReplay}. */
type NodeIdMap = (nodeId: string) => string

/** The gesture to run again once the rows exist: the refused gesture's own closure, which takes its ids through `mapId`. */
export interface UnrollReplay {
  retry: (mapId: NodeIdMap) => void
}

/** `deferred`: another structural write was on the wire, so this one is queued behind it and will run on its own. */
export type UnrollListOutcome = 'unrolled' | 'refused' | 'nothing' | 'deferred'

export interface UnrollListSlice {
  /**
   * Write the list `nodeId` is a row of (or sits inside) out as explicit
   * elements. `nothing` when it is not in a list Studio can unroll — see
   * `planUnrollList`. With `replay`, the gesture that was refused runs again on
   * the written elements.
   */
  unrollList: (nodeId: string, replay?: UnrollReplay) => Promise<UnrollListOutcome>
}

/** True for the history entry `commitStudioUnrollList` pushed. */
function isUnrollEntry(entry: EditorStore['_historyPast'][number] | undefined): boolean {
  return entry?.structural?.gesture === 'source' && entry.structural.source.forward[0]?.kind === 'unroll-list'
}

export function createUnrollListActions(helpers: SiteSliceHelpers): Pick<UnrollListSlice, 'unrollList'> {
  const { get, set } = helpers

  async function unrollList(nodeId: string, replay?: UnrollReplay): Promise<UnrollListOutcome> {
    const target = resolveActiveTreeTarget(get())
    if (!target || target.vc) return 'nothing'
    const plan = planUnrollList(target.tree, nodeId)
    if (!plan) return 'nothing'
    // A write is on the wire: this one waits for it, then is aimed at the row it named (the write renumbered the file).
    if (deferWhileStructuralCommitInFlight((relocate) => void unrollList(relocate(nodeId), replay), [nodeId])) return 'deferred'

    const before = get().site
    const written: StructuralWriteOutcome | null = await commitStudioUnrollList({ edit: plan.edit, label: `Unroll ${plan.source}` })
    if (!written) return 'refused'

    const unrollAt = get()._historyPast.length - 1
    const after = get().site
    const remap = before && after ? buildReparseNodeIdRemap(before, after) : new Map<string, string>()
    // Every row root must be accounted for, and be the element the write reported at its place.
    const followed =
      remap.size > 0 &&
      written.createdNodeIds.length === plan.rowRootIds.length &&
      plan.rowRootIds.every((rowId, index) => remap.get(rowId) === written.createdNodeIds[index])

    if (replay && followed && isUnrollEntry(get()._historyPast[unrollAt])) {
      linkReplay(get, set, unrollAt, true)
      replay.retry((id) => remap.get(id) ?? id)
      await structuralWritesIdle()
      unlinkIfNothingLanded(get, set, unrollAt)
    }

    pushToast({
      kind: 'info',
      title: 'List unrolled',
      body:
        replay && !followed
          ? `${plan.source} is now ${plan.rowRootIds.length} separate elements. Make the change again on the one you meant.`
          : `${plan.source} is now ${plan.rowRootIds.length} separate elements in your file, no longer drawn from the array. The array is left where it was.`,
      location: 'site-editor',
      action: { label: 'Undo', onSelect: () => get().undo() },
    })
    return 'unrolled'
  }

  return { unrollList }
}
