/**
 * boardNameActions - renaming a page or a layer, as board state.
 *
 * A page's name and a layer's name are not in the user's source. A page is
 * `pages/<Name>.tsx` (its id and route come from the file name, so renaming it
 * for real would change the id under every link, comment and frame that names
 * it), and a layer is a JSX element, which has no name to write. So a rename is
 * Studio's own state in `.studio/boards.json` (`pageNames`, `layerNames`),
 * exactly like a frame's size or a note's text:
 *
 *   - it is ONE undo entry, through `commitBoardChange`, and undo restores the
 *     file's bytes because the autosave writes the restored snapshot;
 *   - the page's `title` and the node's `label` in the site document are
 *     DERIVED from it (`boardNamesSync.ts`), never written on their own, so a
 *     reload, an agent's re-read or an undo cannot leave the two disagreeing.
 */
import type { EditorStore, EditorStoreSliceCreator } from '@site/store/types'
import { resolveLayerNameTarget, setLayerName, setPageName } from '@core/studio-board'
import { captureNodeHint } from '@core/studio-anchor'
import { commitBoardChange } from './boardHistory'

type BoardNameActions = Pick<EditorStore, 'renamePageOnBoard' | 'renameLayerOnBoard'>

export function createBoardNameActions(
  set: Parameters<EditorStoreSliceCreator<EditorStore>>[0],
  get: Parameters<EditorStoreSliceCreator<EditorStore>>[1],
): BoardNameActions {
  return {
    renamePageOnBoard: (pageId, title) => {
      const { boards } = get()
      commitBoardChange(set, get, null, setPageName(boards, pageId, title))
    },

    renameLayerOnBoard: (pageId, nodeId, name) => {
      const { boards, site } = get()
      const page = site?.pages.find((candidate) => candidate.id === pageId)
      const hint = page ? captureNodeHint(page, nodeId) : null
      if (!page || !hint) return false
      // The entry that already names this element, wherever an edit above it has
      // since moved it: the stored hints that resolve to this node.
      const existing = (boards.layerNames ?? []).find(
        (entry) => entry.pageId === pageId && resolveLayerNameTarget(page, entry.hint) === nodeId,
      )
      commitBoardChange(
        set,
        get,
        null,
        setLayerName(boards, { pageId, hint, supersedes: existing?.hint.nodeId }, name),
      )
      return true
    },
  }
}
