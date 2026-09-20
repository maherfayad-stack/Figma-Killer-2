/**
 * structuralSourceHistory — the undo stack's half of "a gesture that wrote the
 * user's markup without touching the tree".
 *
 * `structuralHistory.ts` next door covers the gestures that DO mutate the tree
 * (a move, a delete): those already commit a transaction, so all it has to do
 * is tag it and re-issue the gesture on ⌘Z. This module covers the other
 * family — insert, duplicate, wrap, group, ungroup, paste, cross-frame
 * transplant, OS image drop — which mutate no tree at all
 * (`studioSourceWrites.ts`: "the board is NOT updated here"), commit no
 * transaction, and therefore pushed nothing onto the stack. ⌘Z after one of
 * them undid whatever came before it (`canvas-20`, landmine 10).
 *
 * ## The entry is patch-free on purpose
 *
 * A structural source gesture has no `site` patches to record — the document
 * it changed is the `.tsx`, and the board learns about it by being re-read.
 * So the entry it pushes carries empty `inverse`/`forward` patch lists and
 * nothing but its `structural` field, exactly as a board-only entry
 * (`boardHistory.ts`) carries nothing but its `board` field. `undoRedoActions`
 * routes on `entry.structural` before it ever reaches `apply()`.
 *
 * ## What ⌘Z actually does
 *
 * It posts the inverse edits through the SAME writeback route the gesture used
 * (`commitStudioStructuralReissue`), so an undo rides every refusal gate the
 * forward direction rode, resolves against the files as they are now, and
 * ends in the same resync. It is one write, one toast, one step.
 *
 * Before posting, every node id the inverse names is checked against the live
 * tree. That check is what stands between "undo" and "delete whatever happens
 * to sit at that line now": the ids were minted against the file as the
 * gesture left it, and anything that changed the file outside the undo stack
 * (an external editor, a value edit that collapsed a `style={{…}}` onto one
 * line) invalidates them. A failed check refuses out loud, naming the file.
 */
import type { NodeTree, PageNode } from '@core/page-tree'
import { describeStructuralRefusal } from '@core/page-tree'
import { commitStudioStructuralReissue } from '@site/studio/studioStructuralCommits'
import {
  anchorTransplantBack,
  fileOfNodeId,
  structuralEditNodeIds,
  type StructuralEditPayload,
} from '@site/studio/structuralUndoPlan'
import type { PendingStructuralHistory } from '@site/studio/pendingStructuralOutcome'
import { resolveStructuralInverse } from '@site/studio/structuralUndoPlan'
import { commitHistoryEntry } from './historyStack'
import { STRUCTURAL_REFUSAL_TITLE, presentStructuralRefusal } from './structuralSourceEdits'
import { resolveActiveTreeTarget } from './helpers'
import type { HistoryEntry, SiteSlice, SiteSliceHelpers, StructuralSourceHistory } from './types'

type StructuralSourceHistoryActions = Pick<SiteSlice, 'recordStructuralSourceWrite'>

/**
 * Apply what a landed structural write means for the undo stack — called by
 * `usePersistence.ts` once the board has read the write back, draining
 * `pendingStructuralOutcome.ts`.
 *
 * `push` is an ordinary gesture: one new entry, one ⌘Z. `fill` (`store-15`) is
 * `delete`'s own forward commit filling in the `inverse` of the entry its own
 * tree mutation already pushed. `refresh` is an undo or a redo that has just
 * re-issued a stored entry; its own stack bookkeeping already happened in
 * `undoRedoActions.ts`, and what is left is to re-resolve the entry's inverse
 * against the ids THIS write reported — a redo re-creates the element at a
 * position its previous undo cannot have known.
 */
export function createStructuralSourceHistoryActions({
  set,
}: SiteSliceHelpers): StructuralSourceHistoryActions {
  return {
    recordStructuralSourceWrite: (history: PendingStructuralHistory) => {
      set((state) => {
        if (history.kind === 'push') {
          const entry: HistoryEntry = {
            inverse: [],
            forward: [],
            coalesceKey: null,
            structural: { gesture: 'source', source: history.gesture },
          }
          // A structural gesture never coalesces: folding one into a typing
          // burst would make a single ⌘Z revert a duplicate and five
          // keystrokes together. `commitHistoryEntry` with a `null` key also
          // ENDS any burst in progress, which is what closes the other
          // direction.
          commitHistoryEntry(state, entry)
          return
        }
        if (history.kind === 'fill') {
          // `store-15` — `delete`'s own forward commit. The entry already
          // exists (the tree mutation pushed it; `tagStructuralGesture`
          // tagged it), sitting at the top of `_historyPast` — this fills in
          // the `inverse` its `unsupported`-free template can only now
          // resolve, without pushing a second entry for one gesture.
          const top = state._historyPast[state._historyPast.length - 1]
          const structural = top?.structural
          if (!top || structural?.gesture !== 'source') return
          top.structural = {
            gesture: 'source',
            source: {
              ...structural.source,
              inverse: resolveStructuralInverse(structural.source.inverseTemplate, history.outcome),
            },
          }
          return
        }
        const stack = history.direction === 'undo' ? state._historyFuture : state._historyPast
        const top = stack[stack.length - 1]
        const structural = top?.structural
        if (!top || structural?.gesture !== 'source') return
        // Only a REDO changes what the next undo has to address: it re-made
        // the elements, at positions its own write is the first to know. An
        // undo leaves `forward` valid as-is, because undoing restores the file
        // to the bytes `forward` was planned against.
        if (history.direction !== 'redo') return
        top.structural = {
          gesture: 'source',
          source: {
            ...structural.source,
            inverse: resolveStructuralInverse(structural.source.inverseTemplate, history.outcome),
          },
        }
      })
    },
  }
}

/**
 * Re-issue one direction of a stored source-writing gesture. Returns whether
 * the write was actually posted — `false` means the stacks must be left
 * exactly as they were, because nothing happened.
 *
 * Three ways it declines, all of them out loud:
 *  - the direction has no edits at all (an `unsupported` inverse — an ungroup
 *    whose container carried styling a plain re-wrap would not restore);
 *  - the tree the ids belong to is not open;
 *  - an id no longer resolves, which means the file is not what this entry was
 *    recorded against. That refusal names the file, because the remedy is in
 *    the file: look at what changed there.
 */
export function reissueStructuralSourceEdits(
  get: SiteSliceHelpers['get'],
  set: SiteSliceHelpers['set'],
  entry: StructuralSourceHistory,
  direction: 'undo' | 'redo',
): boolean {
  const { label, forward, inverse, inverseTemplate } = entry.source
  const state = get()
  const target = resolveActiveTreeTarget(state)
  if (!target) {
    refuseReissue(get, set, direction, 'That change was made on a document that is no longer open. Open it again to undo it.')
    return false
  }

  const planned = direction === 'undo' ? inverse : forward
  if (planned === null || planned.length === 0) {
    refuseReissue(
      get,
      set,
      direction,
      inverseTemplate.kind === 'unsupported'
        ? inverseTemplate.message
        : `Studio could not work out how to take “${label}” back out of your project source, so it has left the files alone. Use your editor’s undo or \`git\`.`,
      // The gesture's own target: the one thing the user can usefully be
      // pointed at when the editor cannot reverse what it did there.
      forward[0]?.nodeId,
    )
    return false
  }

  const edits =
    direction === 'undo'
      ? anchorTransplantBack(planned, inverseTemplate, parentChildIds(target.tree, inverseTemplate))
      : [...planned]

  const missing = unresolvedNodeIds(edits, target.tree)
  if (missing.length > 0) {
    refuseReissue(
      get,
      set,
      direction,
      `${fileOfNodeId(missing[0]!)} has changed since “${label}” was written, so ${
        direction === 'undo' ? 'undoing' : 'redoing'
      } it would edit code Studio can no longer account for. Nothing was written — check what changed in that file.`,
      missing[0]!,
    )
    return false
  }

  void commitStudioStructuralReissue(edits, direction, label)
  return true
}

/**
 * The destination parent's current child list, for a `transplant-back` whose
 * anchor has to be resolved against the tree as it is now. Empty for every
 * other template, which `anchorTransplantBack` ignores.
 */
function parentChildIds(
  tree: NodeTree<PageNode>,
  template: StructuralSourceHistory['source']['inverseTemplate'],
): readonly string[] {
  if (template.kind !== 'transplant-back') return []
  return tree.nodes[template.parentNodeId]?.children ?? []
}

/**
 * The node ids these edits name that the live tree does not have.
 *
 * Every id a structural edit carries — the target, the anchor, the
 * destination, a group's siblings — has to still be a node the board can see,
 * because the board was read from the same files the write is about to edit.
 * A cross-FILE transplant is the one exception the tree cannot answer for: its
 * destination lives in another page, which may not be the active tree, so only
 * ids belonging to the active tree's own file are checked.
 */
function unresolvedNodeIds(
  edits: readonly StructuralEditPayload[],
  tree: NodeTree<PageNode>,
): string[] {
  const missing: string[] = []
  for (const edit of edits) {
    for (const id of structuralEditNodeIds(edit)) {
      if (!tree.nodes[id] && fileOfNodeId(id) === fileOfNodeId(edit.nodeId) && !missing.includes(id)) missing.push(id)
    }
  }
  return missing
}


/**
 * Say why the step did not happen — through the refusal DIALOG, not a toast.
 *
 * A refused undo is the one case in this family where the editor has to
 * interrupt: the user pressed ⌘Z expecting their last change to be gone, and
 * it is still there. A toast that auto-dismisses leaves them believing the
 * undo worked. Everything else about this family stays quiet.
 */
function refuseReissue(
  get: SiteSliceHelpers['get'],
  set: SiteSliceHelpers['set'],
  direction: 'undo' | 'redo',
  message: string,
  /** The element the refusal is about, when one is nameable — supplies `origin` and the jump-to-source remedy. */
  nodeId?: string,
): void {
  presentStructuralRefusal(
    direction === 'undo' ? STRUCTURAL_REFUSAL_TITLE.undo : STRUCTURAL_REFUSAL_TITLE.redo,
    describeStructuralRefusal({
      refusal: { reason: 'stale-undo', message },
      ...(nodeId ? { node: { id: nodeId } } : {}),
    }),
    { getState: get, set, ...(nodeId ? { nodeId } : {}) },
  )
}
