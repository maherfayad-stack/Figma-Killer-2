/**
 * `insertImageIntoPage` — D2 G15's commit: the `<img src alt>` a dropped file
 * becomes, written into the page the drop landed on.
 *
 * ## Why it names the page instead of using the active one
 *
 * Every other insert path in this store writes into the ACTIVE tree, because
 * every other insert is started from a surface that already belongs to it (the
 * picker, the layers panel, a keyboard command). A file dropped from the
 * operating system is not: it lands wherever the pointer happens to be, which
 * can be any frame on the board, and the frame under a drop has never been
 * activated by a pointerdown because there was no pointerdown. Taking the page
 * as an argument is the honest shape — and it is the same reason
 * `transplantNodes` takes both of its pages explicitly.
 *
 * ## One structural commit
 *
 * The upload already happened and is the user's file on disk; this is the ONE
 * write to their source that the gesture makes. Nothing is minted on the canvas
 * first, for `studioSourceWrites.ts`'s stated reason: the element does not exist
 * until the codemod has written it, and its id is the `line:col` that write
 * produces. The commit's own resync brings it in.
 *
 * The `alt` text is the file's own name with its extension dropped. That is a
 * placeholder and the inspector is where it gets fixed — but an `<img>` with no
 * `alt` at all is a real accessibility defect written into someone's
 * repository, and writing an empty string would assert the image is decorative,
 * which Studio has no way to know.
 */
import { commitStudioInsert } from '@site/studio/studioStructuralCommits'
import { deferWhileStructuralCommitInFlight } from '@site/studio/structuralCommitQueue'
import { STRUCTURAL_REFUSAL_TITLE, planSourceInsert, presentStructuralRefusal } from './structuralSourceEdits'
import type { SiteSlice, SiteSliceHelpers } from './types'

type ImageDropActions = Pick<SiteSlice, 'insertImageIntoPage'>

export function createImageDropActions(helpers: SiteSliceHelpers): ImageDropActions {
  const { get, set } = helpers

  const actions: ImageDropActions = {
    insertImageIntoPage: (pageId, parentId, index, image) => {
      // `store-14`'s queue: this gesture shows nothing optimistically, so a
      // second drop fired before the first one's resync would plan against the
      // still-unshifted file and post a second real write. Parked and re-run
      // (re-planned) once the first one's resync has landed — dropping three
      // files at once is three images, not one.
      if (
        deferWhileStructuralCommitInFlight(() => {
          actions.insertImageIntoPage(pageId, parentId, index, image)
        })
      ) {
        return
      }

      const site = get().site
      if (!site) return
      // A plain scan, not `store.ts`'s memoised `lookupCanvasPageById`: this
      // module is imported BY the composed store, so importing that memo back
      // would close a cycle. One O(pages) walk per DROP, once per gesture.
      const tree = site.pages.find((page) => page.id === pageId) ?? null
      if (!tree) return

      const plan = planSourceInsert(tree, parentId, index)
      if (!plan.ok) {
        presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.insert, plan.constraint, {
          nodeId: plan.nodeId,
          retry: (newParentId) => actions.insertImageIntoPage(pageId, newParentId, index, image),
          getState: get,
          set,
        })
        return
      }
      // A `null` commit means this page is an ordinary CMS tree, which has no
      // file for an `<img>` literal to point at — the drop has nowhere honest
      // to land, and saying so is better than minting a canvas-only node the
      // next parse would delete.
      const commit = plan.commit
      if (!commit) return

      void commitStudioInsert({
        parentNodeId: commit.parentNodeId,
        anchorNodeId: commit.anchorNodeId,
        position: commit.position,
        name: 'img',
        props: { src: image.src, alt: image.alt },
      })
    },
  }

  return actions
}
