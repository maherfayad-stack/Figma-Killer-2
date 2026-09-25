/**
 * copyAsPng — put a PNG of the current selection on the clipboard, the one
 * implementation behind ⌘⇧C (`useCopyAsPngShortcut`) and the empty-selection
 * panel's "Copy screen as PNG" button (P5-F, UX-9).
 *
 * The same capture the Export section's PNG row downloads
 * (`fetchNodePngBlob` → `/admin/api/studio/node-png`), written to the
 * clipboard as an `image/png` `ClipboardItem` instead of to a file — so what
 * you paste into Figma or a doc is byte-identical to what you would have
 * downloaded. Density is @2×, matching the Export section's own default row.
 * WHAT it photographs is `copyAsPngTarget.ts`'s decision.
 *
 * One in-flight capture at a time, however many callers ask. A capture is a
 * headless browser round trip, and holding the key down (or clicking the
 * button twice) would otherwise queue a browser launch per repeat.
 */
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { copyPngToClipboard } from '@site/panels/PropertiesPanel/nodeExportClient'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { selectActiveBoardFrames } from '@site/store/slices/boardSelectors'
import { resolveCopyAsPngTarget, type CopyAsPngSelection } from './copyAsPngTarget'

/** Matches the Export section's own default PNG density. */
const COPY_AS_PNG_SCALE = 2

let copying = false

/**
 * Read the selection facts `resolveCopyAsPngTarget` decides on out of the live
 * store.
 *
 * `selectActiveCanvasPage` — the VC-aware selector, per
 * `canvas-aware-selectors.test.ts` — so a node selected inside a Visual
 * Component still resolves to a real node here rather than silently to `null`.
 * The VC case is then refused explicitly by `resolveCopyAsPngTarget`, because
 * the page that selector returns in VC mode is a VIRTUAL one with no frame on
 * disk for the capture route to photograph.
 */
function readCopyAsPngSelection(): CopyAsPngSelection {
  const state = useEditorStore.getState()
  const activeCanvasPage = selectActiveCanvasPage(state)
  const selectedNodeId = state.selectedNodeId
  const node = selectedNodeId ? activeCanvasPage?.nodes[selectedNodeId] ?? null : null
  const frames = selectActiveBoardFrames(state)
  const selectedFramePageIds = state.selectedFrameIds
    .map((frameId) => frames.find((frame) => frame.id === frameId)?.pageId)
    .filter((pageId): pageId is string => typeof pageId === 'string')

  return {
    isVisualComponentDocument: state.activeDocument?.kind === 'visualComponent',
    selectedNodeId,
    selectedNodeLabel: node?.label ?? null,
    selectedFramePageIds,
    activePageId: activeCanvasPage?.id ?? null,
    activePageTitle: activeCanvasPage?.title ?? null,
  }
}

/** Copy the selection (or, with nothing selected, the open screen) as a PNG. */
export function copySelectionAsPng(): void {
  if (copying) return

  const target = resolveCopyAsPngTarget(readCopyAsPngSelection())
  if (!target.ok) {
    // ERR-24 — a no-op, not a failure: nothing is open to photograph.
    pushToast({ kind: 'info', title: 'Nothing to copy as PNG', body: target.reason })
    return
  }

  copying = true
  void copyPngToClipboard({
    pageId: target.pageId,
    nodeId: target.nodeId,
    scale: COPY_AS_PNG_SCALE,
  })
    .then(() => {
      pushToast({ kind: 'success', title: 'Copied as PNG', body: `${target.label} @${COPY_AS_PNG_SCALE}×` })
    })
    .catch((err: unknown) => {
      console.error('[copyAsPng] copy as PNG failed:', err)
      pushToast({
        kind: 'error',
        title: 'Copy as PNG failed',
        body: getErrorMessage(err, 'Unknown export error'),
      })
    })
    .finally(() => {
      copying = false
    })
}
