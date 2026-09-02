/**
 * prototypeActions — the round trip between a prototype gesture and
 * `.studio/prototype.json`.
 *
 * Each function posts ONE op, adopts the server's merged result, and toasts on
 * failure. They live outside `prototypeSlice.ts` because that slice is a pure
 * state container with no HTTP.
 *
 * FAILURE POSTURE: a failed write leaves store state exactly as it was and
 * raises a toast — no optimistic insert-then-roll-back. A connector that
 * appears and then vanishes is worse than one that takes 40 ms to appear,
 * because the user cannot tell whether the link exists.
 */
import { useEditorStore } from '@site/store/store'
import { getStudioWorkspaceDir } from '@site/studio/studioWorkspaceDir'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { captureNodeHint } from '@core/studio-anchor'
import { defaultLinkPresentation, type PrototypeLink } from '@core/studio-prototype'
import { DEFAULT_PAGE_KIND, type PageKind } from '@core/studio-board'
import { applyPrototypeOp, fetchPrototype, type PrototypeOp } from './prototypeApi'

async function run(op: PrototypeOp, failureTitle: string): Promise<boolean> {
  try {
    const file = await applyPrototypeOp(op, getStudioWorkspaceDir())
    useEditorStore.getState().adoptPrototype(file)
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

/** Re-read the whole file — after a load or a project switch. */
export async function reloadPrototype(): Promise<void> {
  try {
    const file = await fetchPrototype(getStudioWorkspaceDir())
    useEditorStore.getState().loadPrototype(file)
  } catch (err) {
    console.error('[prototypeActions] failed to load prototype links:', err)
    useEditorStore.getState().markPrototypeLoadFailed()
    pushToast({
      kind: 'error',
      title: 'Failed to load prototype links',
      body: getErrorMessage(err, 'Unknown error loading studio prototype links'),
    })
  }
}

/**
 * Commit the connector currently being dragged as a real link.
 *
 * The hint is captured HERE, at the drop, against the tree as it stands — not
 * when the drag started. Between the two the user cannot have edited anything
 * (a drag is modal), but capturing at the drop is the rule that stays true when
 * that stops being so.
 *
 * Returns the new link's id so the caller can select it, or `null` when the
 * drop produced nothing storable.
 */
export async function commitLinkDraft(targetPageId: string, targetKind: PageKind = DEFAULT_PAGE_KIND): Promise<string | null> {
  const state = useEditorStore.getState()
  const draft = state.linkDraft
  if (!draft) return null

  const page = state.site?.pages.find((candidate) => candidate.id === draft.sourcePageId)
  const hint = page ? captureNodeHint(page, draft.sourceNodeId) : null
  if (!hint) {
    // The source element vanished mid-gesture (a re-parse landed under the
    // drag). Say so rather than storing a link to nothing.
    state.cancelLinkDraft()
    pushToast({
      kind: 'error',
      title: 'Could not create the link',
      body: 'The element it would start from is no longer on the page.',
    })
    return null
  }

  const { action, transition } = defaultLinkPresentation(targetKind)
  const link: PrototypeLink = {
    id: crypto.randomUUID(),
    origin: 'design',
    source: { pageId: draft.sourcePageId, node: hint },
    trigger: 'click',
    action,
    targetPageId,
    transition,
  }

  state.cancelLinkDraft()
  const ok = await run({ kind: 'upsert', link }, 'Could not create the link')
  if (!ok) return null
  useEditorStore.getState().setSelectedLink(link.id)
  return link.id
}

/** Change an existing link — the inspector's every control routes through here. */
export async function updateLink(link: PrototypeLink): Promise<void> {
  await run({ kind: 'upsert', link }, 'Could not update the link')
}

export async function deleteLink(linkId: string): Promise<void> {
  const ok = await run({ kind: 'remove', linkId }, 'Could not delete the link')
  if (ok && useEditorStore.getState().selectedLinkId === linkId) {
    useEditorStore.getState().setSelectedLink(null)
  }
}

/**
 * Drop links orphaned by a page deletion.
 *
 * Called with the pages that STILL EXIST, because that is the only list the
 * server can act on without parsing the project. A caller with no pages loaded
 * must not call this: the server refuses an empty list rather than wiping every
 * flow, but the honest fix is not to ask.
 */
export async function prunePrototypeToPages(pageIds: string[]): Promise<void> {
  if (pageIds.length === 0) return
  await run({ kind: 'prune', pageIds }, 'Could not clean up prototype links')
}
