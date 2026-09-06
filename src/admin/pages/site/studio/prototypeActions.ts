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
import { DEFAULT_PAGE_KIND, type PageKind } from '@core/studio-board'
import {
  actionTakesTarget,
  defaultLinkPresentation,
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

/**
 * Commit the connector currently being dragged as a real link.
 *
 * The hint is captured HERE, at the drop, against the tree as it stands — not
 * when the drag started. Between the two the user cannot have edited anything
 * (a drag is modal), but capturing at the drop is the rule that stays true when
 * that stops being so.
 *
 * The action and transition come from what the TARGET IS: dragging onto a
 * popup or a sheet means "present this over the current screen", dragging onto
 * a screen means "navigate to it". Asking the user to say so twice — once by
 * aiming, once in a dropdown — is a question the drop already answered.
 *
 * Returns the new link's id so the caller can select it, or `null` when the
 * drop produced nothing storable.
 */
export async function commitLinkDraft(
  targetPageId: string,
  targetKind: PageKind = DEFAULT_PAGE_KIND,
): Promise<string | null> {
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

/**
 * Change an existing link WHOLE — the link inspector's every control routes
 * here.
 *
 * Distinct from `saveLink`, which is keyed on an ELEMENT and re-anchors the
 * source: this one already has the link, hint and all, because the user reached
 * it by clicking the connector rather than by selecting the element it starts
 * from. Re-capturing the hint there would silently re-anchor a link to whatever
 * happened to be selected on the canvas.
 *
 * A targetless interaction (`back`, `close`) is authored through `saveLink`
 * like any other — pick the action, and the target question stops being asked.
 * There is deliberately no second entry point for it: "go back" names no
 * screen, so the drag gesture cannot express it, but the inspector already can.
 */
export async function updateLink(link: PrototypeLink): Promise<boolean> {
  return run({ kind: 'upsert', link }, 'Could not update the link')
}

/** Delete one authored link. */
export async function deleteLink(linkId: string): Promise<boolean> {
  const ok = await run({ kind: 'remove', linkId }, 'Failed to delete the prototype link')
  if (ok && useEditorStore.getState().selectedLinkId === linkId) {
    useEditorStore.getState().setSelectedLink(null)
  }
  return ok
}
