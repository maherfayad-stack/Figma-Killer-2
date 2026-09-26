/**
 * `transplantNodes` — D2 G3's commit: an element dragged out of one board
 * frame and dropped into a container in another one.
 *
 * ## Why it is not a parameter on `moveNodes`
 *
 * `moveNodes` mutates the ACTIVE tree and then writes the file that tree came
 * from. A cross-frame drop has two trees and two files, and none of
 * `moveNodes`'s machinery survives that: `mutateActiveTree` can only reach one
 * of them, the undo/redo origin it captures (`captureMoveOrigin`) describes a
 * position in the tree the node is leaving, and the id the element gets in its
 * new file does not exist until the codemod has written it. A flag on
 * `moveNodes` would be a second function wearing the first one's name.
 *
 * ## Nothing is moved on the canvas first
 *
 * The same discipline `studioSourceWrites.ts` states for insert / duplicate /
 * wrap / group, one step further. Those four have no node to show until the
 * write lands; this one additionally has a node it must NOT move, because the
 * element that appears in the destination frame is a different node from the
 * one that left the origin frame — its id is the `rel:line:col` the write
 * produces. Optimistically splicing the origin tree would therefore show the
 * element nowhere at all for the length of the round trip, and a refusal would
 * leave the board diverged from both files.
 *
 * So: plan, refuse out loud or post, and let the commit's own resync bring
 * both pages back. The batch reports BOTH files as touched, so the two frames
 * update together rather than one at a time.
 *
 * ## Same-page drops never reach here
 *
 * Two board frames can show the SAME page (a "duplicate as variant" sibling),
 * and a drop between those two is an ordinary reparent. The caller routes on
 * page id; `previewStructuralTransplant` refuses a same-file gesture as a
 * backstop so a caller that gets the routing wrong gets a sentence rather than
 * a cross-file codemod pointed at one file.
 */
import { commitStudioTransplant } from '@site/studio/studioStructuralCommits'
import { deferWhileStructuralCommitInFlight } from '@site/studio/structuralCommitQueue'
import { STRUCTURAL_REFUSAL_TITLE, planSourceTransplant, presentStructuralRefusal } from './structuralSourceEdits'
import type { Page, SiteDocument } from '@core/page-tree'
import type { SiteSlice, SiteSliceHelpers } from './types'

type TransplantActions = Pick<SiteSlice, 'transplantNodes'>

/**
 * The page with this id, or `null`.
 *
 * A plain scan rather than `store.ts`'s memoised `lookupCanvasPageById`,
 * deliberately: this module is imported BY the composed store, so importing
 * that memo back would close a cycle (`store -> siteSlice -> nodeActions ->
 * here -> store`). The cost is one O(pages) walk per DROP — once per gesture,
 * not per store change — which is the reason the memo exists at all and not a
 * budget this path can trouble.
 */
function findPage(site: SiteDocument, pageId: string): Page | null {
  return site.pages.find((page) => page.id === pageId) ?? null
}

/**
 * The slot `nodeId` occupies in `page` right now — its parent and its index in
 * that parent's child list.
 *
 * The parent falls back to the page's root and the index to the end when the
 * node is not addressable, which is a position an append already means; a
 * transplant whose origin cannot be named simply has an undo that puts the
 * element back last rather than one that puts it somewhere wrong.
 */
function originSlot(page: Page, nodeId: string): { parentNodeId: string; index: number } {
  const parentNodeId = page.nodes[nodeId]?.parentId ?? page.rootNodeId
  const index = page.nodes[parentNodeId]?.children.indexOf(nodeId) ?? -1
  return { parentNodeId, index: index < 0 ? Number.MAX_SAFE_INTEGER : index }
}

export function createTransplantActions(helpers: SiteSliceHelpers): TransplantActions {
  const { get, set } = helpers

  const actions: TransplantActions = {
    transplantNodes: (nodeIds, destination) => {
      if (nodeIds.length === 0) return
      // `store-14`'s queue: this gesture has nothing optimistic on screen, so
      // a second drag fired before the first one's resync would plan against
      // the still-unshifted original and post a SECOND real write. Parked and
      // re-planned once the first has landed, rather than refused.
      if (
        deferWhileStructuralCommitInFlight(
          (relocate) => { actions.transplantNodes(nodeIds.map(relocate), { ...destination, parentId: relocate(destination.parentId) }) },
          [...nodeIds, destination.parentId],
        )
      ) {
        return
      }

      const state = get()
      const site = state.site
      if (!site) return

      const originPage = findPage(site, destination.originPageId)
      const destinationPage = findPage(site, destination.pageId)
      if (!originPage || !destinationPage) return

      const plan = planSourceTransplant(
        originPage,
        nodeIds,
        destinationPage,
        destination.parentId,
        destination.index,
        destination.copy === true,
      )
      if (!plan.ok) {
        presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.transplant, plan.constraint, {
          nodeId: plan.nodeId,
          // The refused node is always the one the gesture named — re-issuing
          // after a detach/extract remedy lands means re-issuing the same drop
          // with that id swapped for its replacement.
          retry: (mapId) => actions.transplantNodes(nodeIds.map(mapId), { ...destination, parentId: mapId(destination.parentId) }),
          // D2 G3 — "Duplicate into frame instead": the SAME drop, with Alt's
          // meaning. It is the same store action and therefore the same gate,
          // the same `guardAgainstConcurrentStructuralCommit`, and the same
          // single "Copied into <page>" toast an Alt-drag would have landed —
          // one gesture, one write, one toast, even though the user reached it
          // through a button. `planSourceTransplant` only attaches the action
          // when this call will actually be allowed, so the remedy cannot
          // bounce straight back to the refusal it was offered for.
          ...(plan.constraint.actions.some((action) => action.kind === 'duplicate-into-frame')
            ? { duplicateIntoFrame: () => actions.transplantNodes(nodeIds, { ...destination, copy: true }) }
            : {}),
          getState: get,
          set,
        })
        return
      }
      // `planSourceTransplant` never returns a null commit — see its own doc.
      const commit = plan.commit
      if (!commit) return

      void commitStudioTransplant({
        nodeId: commit.nodeId,
        parentNodeId: commit.destinationParentNodeId,
        anchorNodeId: commit.anchorNodeId,
        position: commit.position,
        copy: commit.copy,
        // `store-14` — where it came from, which is the whole of a MOVE's undo.
        // The slot is recorded as parent + index rather than as a sibling id:
        // every sibling below the element shifts up the moment it leaves, so a
        // sibling id captured here would name a line that has moved by the time
        // ⌘Z is pressed. `anchorTransplantBack` re-reads the slot from the live
        // tree instead.
        origin: originSlot(originPage, commit.nodeId),
      })
    },
  }

  return actions
}
