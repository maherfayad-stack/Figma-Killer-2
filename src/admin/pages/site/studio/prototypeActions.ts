/**
 * prototypeActions — the round trip between a UI gesture and a project's flows.
 *
 * Same split `commentActions.ts` documents: `prototypeSlice` is a pure state
 * container with no HTTP, and every network call lives here.
 *
 * ONE LOAD, TWO REQUESTS, AND THEY FAIL SEPARATELY
 * ────────────────────────────────────────────────
 * The authored links and the derived flow map come from different endpoints
 * with different costs — one is a file read, the other is a syntactic parse of
 * every page — so they are fetched independently and a failure in either is
 * reported on its own. Coupling them would mean an unreadable page file blanks
 * the links the user drew, which have nothing to do with it.
 */
import { useEditorStore } from '@site/store/store'
import { getStudioWorkspaceDir } from '@site/studio/studioWorkspaceDir'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { captureNodeHint } from '@core/studio-anchor'
import type { NodeTree } from '@core/page-tree'
import {
  actionTakesTarget,
  transitionsForAction,
  type PrototypeAction,
  type PrototypeLink,
  type PrototypeTransition,
} from '@core/studio-prototype'
import { applyPrototypeOp, fetchCodeFlow, fetchPrototype, type PrototypeOp } from './prototypeApi'

async function run(op: PrototypeOp, failureTitle: string): Promise<boolean> {
  try {
    useEditorStore.getState().adoptPrototype(await applyPrototypeOp(op, getStudioWorkspaceDir()))
    return true
  } catch (err) {
    console.error('[prototypeActions] prototype operation failed:', err)
    pushToast({
      kind: 'error',
      title: failureTitle,
      body: getErrorMessage(err, 'Unknown error writing prototype links'),
    })
    return false
  }
}

/** Re-read the authored links — after a load, a project switch, or an agent push. */
export async function reloadPrototype(): Promise<void> {
  try {
    useEditorStore.getState().adoptPrototype(await fetchPrototype(getStudioWorkspaceDir()))
  } catch (err) {
    console.error('[prototypeActions] failed to load prototype links:', err)
    useEditorStore.getState().setPrototypeLoadFailed(true)
    pushToast({
      kind: 'error',
      title: 'Failed to load prototype links',
      body: getErrorMessage(err, 'Unknown error loading studio prototype links'),
    })
  }
}

/**
 * Re-derive the flow map from the project's source.
 *
 * A failure here is logged but NOT toasted. Unlike the authored links, nothing
 * the user did is at stake — the flow map is a read of their code, it re-derives
 * on the next reload, and an error toast for a background analysis they never
 * asked for is noise on a board that is otherwise working fine. The connectors
 * simply are not drawn.
 */
export async function reloadCodeFlow(): Promise<void> {
  try {
    useEditorStore.getState().adoptCodeFlow(await fetchCodeFlow(getStudioWorkspaceDir()))
  } catch (err) {
    console.error('[prototypeActions] failed to derive the code flow map:', err)
  }
}

export interface LinkDraft {
  /** Reuse an existing link's id to EDIT it; omit to create a new one. */
  id?: string
  pageId: string
  nodeId: string
  action: PrototypeAction
  /** Ignored for `back`/`close`, which are defined by the history stack. */
  targetPageId: string | null
  transition?: PrototypeTransition
}

/**
 * Create or update the link on one element.
 *
 * The hint is captured from the LIVE tree at the moment of authoring, which is
 * the only moment `indexPath`/`textSnippet` are known to be true — see
 * `@core/studio-anchor`. A node that is not in the tree yields no hint and no
 * link: unlike a comment pin, a prototype link has no coordinate fallback that
 * would still mean something.
 *
 * The transition is repaired here rather than trusted, so the panel can offer a
 * target before an action and never send an illegal pair the serializer would
 * have to fix on the way back in.
 */
export async function saveLink(draft: LinkDraft, tree: NodeTree): Promise<boolean> {
  const node = captureNodeHint(tree, draft.nodeId)
  if (!node) {
    pushToast({
      kind: 'error',
      title: 'Could not link this element',
      body: 'It is no longer in the page tree — reselect it and try again.',
    })
    return false
  }

  const legal = transitionsForAction(draft.action)
  const transition = legal.find((t) => t === draft.transition) ?? legal[0]
  const takesTarget = actionTakesTarget(draft.action)
  if (takesTarget && !draft.targetPageId) return false

  const link: PrototypeLink = {
    id: draft.id ?? crypto.randomUUID(),
    source: { pageId: draft.pageId, node },
    trigger: 'click',
    action: draft.action,
    targetPageId: takesTarget ? draft.targetPageId : null,
    ...(transition ? { transition } : {}),
  }
  return run({ kind: 'upsert', link }, 'Failed to save the prototype link')
}

/** Delete one authored link. */
export async function deleteLink(linkId: string): Promise<boolean> {
  return run({ kind: 'remove', linkId }, 'Failed to delete the prototype link')
}
