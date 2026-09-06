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
import { fetchCodeFlow, fetchPrototype } from './prototypeApi'

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
