/**
 * subtreeInsertActions — a whole JSX subtree written into a page at the
 * position a gesture named (P5-A: an SVG pasted from the OS clipboard).
 *
 * ONE `insert` edit carries the element and everything under it
 * (`InsertEditSchema.children`, rendered by `insertJsxElement` in one splice),
 * so a pasted icon of 40 parts is one write, one resync and one undo step
 * whose inverse deletes it (`delete-created`). The subtree arrives already
 * converted and sanitised (`svgToJsxNode` runs `sanitizeSvg` first), and the
 * server validates it again against `InsertNodeSchema` and the codemod's own
 * tag-safety refusal (`validateSubtree`) — this module adds no rule of its
 * own about what the subtree may contain.
 *
 * It names its page and activates it for `dropImagesIntoPage`'s reason
 * (`gesturePage.ts`), and it waits its turn behind a structural write already
 * on the wire, re-planned against the tree that write's resync leaves
 * (`structuralCommitQueue.ts`), exactly as a drop does.
 */
import { pushToast } from '@ui/components/Toast'
import { deferWhileStructuralCommitInFlight } from '@site/studio/structuralCommitQueue'
import { commitStudioInsert } from '@site/studio/studioStructuralCommits'
import { activateGesturePage, findGesturePage } from './gesturePage'
import { STRUCTURAL_REFUSAL_TITLE, planSourceInsert, presentStructuralRefusal } from './structuralSourceEdits'
import type { SiteSlice, SiteSliceHelpers } from './types'

type SubtreeInsertActions = Pick<SiteSlice, 'insertJsxSubtreeIntoPage'>

export function createSubtreeInsertActions(helpers: SiteSliceHelpers): SubtreeInsertActions {
  const { get, set } = helpers

  const actions: SubtreeInsertActions = {
    insertJsxSubtreeIntoPage: (request) => {
      if (
        deferWhileStructuralCommitInFlight((relocate) => {
          actions.insertJsxSubtreeIntoPage({ ...request, parentId: relocate(request.parentId) })
        }, [request.parentId])
      ) {
        return
      }

      const tree = findGesturePage(get, request.pageId)
      if (!tree) return
      activateGesturePage(get, request.pageId)

      const plan = planSourceInsert(tree, request.parentId, request.index)
      if (!plan.ok) {
        presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.insert, plan.constraint, {
          nodeId: plan.nodeId,
          retry: (mapId) => actions.insertJsxSubtreeIntoPage({ ...request, parentId: mapId(request.parentId) }),
          getState: get,
          set,
        })
        return
      }
      // An ordinary CMS tree has no file to write the element into, and a
      // canvas-only node the next parse deletes is not an answer either.
      if (!plan.commit) {
        pushToast({
          kind: 'warning',
          title: STRUCTURAL_REFUSAL_TITLE.insert,
          body: 'This frame is not backed by a source file, so there is nowhere to write the element.',
          location: 'site-editor',
        })
        return
      }

      const { node } = request
      void commitStudioInsert({
        ...plan.commit,
        name: node.name,
        props: node.props ?? {},
        ...(node.children === undefined ? {} : { children: node.children }),
        undoLabel: request.undoLabel,
      })
    },
  }

  return actions
}
