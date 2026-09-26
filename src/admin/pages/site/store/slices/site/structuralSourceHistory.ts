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
 * Before posting, every node id the inverse names is checked against the
 * board. That check is what stands between "undo" and "delete whatever happens
 * to sit at that line now": the ids were minted against the file as the
 * gesture left it, and anything that changed the file outside the undo stack
 * (an agent's edit, an external editor, a value edit that collapsed a
 * `style={{…}}` onto one line) invalidates them.
 *
 * ERR-3 — the check asks the WHOLE board (`_nodeIdToPageIds`, O(1) per id),
 * not the active page: clicking another frame activates its page, and the
 * old active-tree check then called every id "missing" and blamed the file.
 *
 * ERR-2/ERR-28 — a step that cannot happen as recorded is SKIPPED: the entry
 * is dropped with a one-line notice and the stack moves on
 * (`undoRedoActions.ts`). It used to stay on top behind a modal, so every
 * later ⌘Z hit the same refusal and nothing before it could be undone.
 */
import type { NodeTree, PageNode } from '@core/page-tree'
import { canvasLayerIdFromRel, canvasLayerPageId, isCanvasLayerEditNodeId } from '@core/studio-board'
import type { EditorStore } from '@site/store/types'
import { commitStudioStructuralReissue } from '@site/studio/studioStructuralCommits'
import {
  addressesJournalEntry,
  addressesSourceLiteral,
  anchorTransplantBack,
  fileOfNodeId,
  structuralEditNodeIds,
  type StructuralEditPayload,
} from '@site/studio/structuralUndoPlan'
import type { PendingStructuralHistory } from '@site/studio/pendingStructuralOutcome'
import { resolveStructuralInverse } from '@site/studio/structuralUndoPlan'
import { commitHistoryEntry } from './historyStack'
import type { StructuralCommitRollback } from './structuralCommitRollback'
import type { StructuralStepOutcome } from './structuralHistory'
import type { HistoryEntry, SiteSlice, SiteSliceHelpers, StructuralSourceHistory } from './types'

type StructuralSourceHistoryActions = Pick<SiteSlice, 'recordStructuralSourceWrite'>

/**
 * Apply what a landed structural write means for the undo stack — called by
 * `siteReloadApply.ts` once the board has read the write back, applying the
 * `pendingStructuralOutcome.ts` value that rode that re-read.
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
 * Re-issue one direction of a stored source-writing gesture. `posted` means
 * the write is on its way, answering to `rollback` if it does not land;
 * `skipped` means it never can, for one of two reasons:
 *  - the direction has no edits at all (an `unsupported` inverse — an ungroup
 *    whose container carried styling a plain re-wrap would not restore);
 *  - an id no longer resolves anywhere on the board, which means the file is
 *    not what this entry was recorded against. The notice names the file,
 *    because that is where the change that got in the way lives.
 */
export function reissueStructuralSourceEdits(
  get: SiteSliceHelpers['get'],
  entry: StructuralSourceHistory,
  direction: 'undo' | 'redo',
  rollback: StructuralCommitRollback,
): StructuralStepOutcome {
  const { label, forward, inverse, inverseTemplate } = entry.source
  const state = get()

  const planned = direction === 'undo' ? inverse : forward
  if (planned === null || planned.length === 0) {
    return {
      kind: 'skipped',
      notice:
        direction === 'redo'
          ? `“${label}” can’t be redone from here — make the change again.`
          : inverseTemplate.kind === 'unsupported'
            ? inverseTemplate.message
            : `Studio could not work out how to take “${label}” back out of your project source, so it left the files alone.`,
    }
  }

  const edits =
    direction === 'undo'
      ? anchorTransplantBack(planned, inverseTemplate, parentChildIds(state, inverseTemplate))
      : [...planned]

  const missing = unresolvedNodeIds(edits, state)
  if (missing.length > 0) {
    return {
      kind: 'skipped',
      notice: `${fileOfNodeId(missing[0]!)} has changed since, so ${
        direction === 'undo' ? 'undoing' : 'redoing'
      } it would edit code Studio can no longer account for. Nothing was written.`,
    }
  }

  // P5-G — a canvas-layer gesture's placement half moves with its write, and
  // comes back if the write does not land.
  const placements = entry.source.placements
  const side = direction === 'undo' ? 'before' : 'after'
  const posted = placements && placements.length > 0 ? withPlacements(get, placements, side, rollback) : rollback
  void commitStudioStructuralReissue(edits, direction, label, posted, direction === 'redo' ? entry.source.sequence : undefined)
  return { kind: 'posted', pendingCommitId: rollback.id }
}

/**
 * The destination parent's current child list, for a `transplant-back` whose
 * anchor has to be resolved against the tree as it is now — read off the page
 * that owns the parent, which need not be the active one (ERR-3). Empty for
 * every other template, which `anchorTransplantBack` ignores.
 */
function parentChildIds(
  state: Pick<EditorStore, 'site' | '_nodeIdToPageIds'>,
  template: StructuralSourceHistory['source']['inverseTemplate'],
): readonly string[] {
  if (template.kind !== 'transplant-back' && template.kind !== 'canvas-layer-lift-back') return []
  const pageId = state._nodeIdToPageIds.get(template.parentNodeId)?.[0]
  const page: NodeTree<PageNode> | undefined = state.site?.pages.find((candidate) => candidate.id === pageId)
  return page?.nodes[template.parentNodeId]?.children ?? []
}

/**
 * P5-G — put a canvas-layer gesture's placements on `side` now, and return a
 * rollback that puts them back on the other side if the re-issued write does
 * not land, before handing on to the stack's own.
 */
function withPlacements(
  get: SiteSliceHelpers['get'],
  placements: NonNullable<StructuralSourceHistory['source']['placements']>,
  side: 'before' | 'after',
  rollback: StructuralCommitRollback,
): StructuralCommitRollback {
  get().applyCanvasLayerPlacements(placements, side)
  return {
    id: rollback.id,
    settle: rollback.settle,
    rollback: (failure) => {
      get().applyCanvasLayerPlacements(placements, side === 'before' ? 'after' : 'before')
      rollback.rollback(failure)
    },
  }
}

/**
 * The node ids these edits name that the board does not have.
 *
 * Every id a structural edit carries — the target, the anchor, the
 * destination, a group's siblings — has to still be a node the board can see,
 * because the board was read from the same files the write is about to edit.
 * "The board" is every page (`_nodeIdToPageIds`), so a cross-FILE transplant's
 * far end is checked too, and an undo pressed from another frame asks the
 * right tree (ERR-3).
 */
function unresolvedNodeIds(
  edits: readonly StructuralEditPayload[],
  state: Pick<EditorStore, '_nodeIdToPageIds' | 'canvasLayerPages'>,
): string[] {
  const missing: string[] = []
  for (const edit of edits) {
    if (addressesSourceLiteral(edit) || addressesJournalEntry(edit)) continue
    for (const id of structuralEditNodeIds(edit)) {
      if (!state._nodeIdToPageIds.has(id) && !onFreeCanvas(state, id) && !missing.includes(id)) missing.push(id)
    }
  }
  return missing
}

/**
 * P5-G — an id a canvas-layer edit names that the board still has, outside
 * `site.pages`: the synthetic `canvas-layer:<id>` a create/delete/restore
 * addresses (it names a layer, never a position), or a node inside a loose
 * layer's own module, looked up in that layer's tree.
 */
function onFreeCanvas(state: Pick<EditorStore, 'canvasLayerPages'>, id: string): boolean {
  if (isCanvasLayerEditNodeId(id)) return true
  const layerId = canvasLayerIdFromRel(fileOfNodeId(id))
  return layerId !== null && Boolean(state.canvasLayerPages[canvasLayerPageId(layerId)]?.nodes[id])
}
