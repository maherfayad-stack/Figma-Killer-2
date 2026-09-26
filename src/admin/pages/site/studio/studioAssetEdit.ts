/**
 * studioAssetEdit — WS-8.3's "replace this image" commit. Split out of
 * `studioSaveRequests.ts` (which the editor store's structural commits import)
 * because its refusal answer is the autosave's one (`refusalToasts.ts`, with
 * its "Open in code" remedy), and that module reaches the store — which a
 * module in the store's own import graph must not.
 */
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { elementMovedNodeIds, warnElementMoved } from './elementMovedRecovery'
import { reportEditRefusals } from './refusalToasts'
import { postOneEdit } from './studioSaveRequests'

/**
 * Commits ONE `kind: 'asset'` edit immediately — WS-8.3's "replace this
 * image" action — instead of letting the ordinary optimistic prop-diff loop
 * in `saveSite` pick it up:
 *
 *   - An image swap is a discrete, deliberate commit (pick a file, confirm),
 *     not a value the user is continuously typing — nothing to debounce.
 *   - The edit's target is `PageNode.assetOrigin` (the import declaration),
 *     never the node's own `src` prop — writing it as an ordinary prop diff
 *     would need `updateNodeProps`'s codeProps guard to special-case this one
 *     prop, which the store slices do not currently know how to do.
 *   - The save route ALWAYS reports an asset edit as shared
 *     (`isSharedSourceNodeId`'s `kind === 'asset'` branch) because the import
 *     it rewrites can back more than one node — so this always reloads on a
 *     successful write, the same remedy `saveSite` uses for `shifted`/
 *     `sharedComponents`, without waiting for the next autosave tick.
 *
 * An import that moved since the board read it is re-read and retried once,
 * silently (`postOneEdit`, P1-A); only a second miss warns. Any other refusal
 * (`asset-unavailable`, `not-a-literal`) is the same named warning the
 * autosave shows — never the red "Image was not saved to source" that used to
 * stand for every one of them.
 *
 * `nodeId` is the ORIGIN's own `rel:line:col` (`PageNode.assetOrigin`), not
 * the editing node's id — same convention the `literal` edit kind uses for
 * resolved text. `assetPath` is the new file's workspace-relative POSIX path.
 */
export async function saveStudioAssetEdit(nodeId: string, assetPath: string): Promise<void> {
  const result = await postOneEdit({ kind: 'asset', nodeId, assetPath })

  const moved = elementMovedNodeIds(result.refusals)
  if (moved.size > 0) {
    warnElementMoved(moved)
    return
  }
  reportEditRefusals(result.refusals ?? [])
  if (result.written > 0) requestCmsSiteReload()
}
