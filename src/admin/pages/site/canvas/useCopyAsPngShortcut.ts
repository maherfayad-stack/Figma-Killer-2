/**
 * useCopyAsPngShortcut — ⌘⇧C / Ctrl+Shift+C puts a PNG of the selection on the
 * clipboard.
 *
 * The same capture the Export section's PNG row downloads
 * (`fetchNodePngBlob` → `/admin/api/studio/node-png`), written to the clipboard
 * as an `image/png` `ClipboardItem` instead of to a file — so what you paste
 * into Figma or a doc is byte-identical to what you would have downloaded.
 * Density is @2×, matching the Export section's own default row.
 *
 * A document-level listener, scoped by INTENT rather than by focus, for the
 * reason `useBoardSelectAllShortcut` is: this shortcut has to work while the
 * user is looking at the Properties panel, and a React `onKeyDown` on the
 * canvas div stops firing the moment focus leaves it. Four things stand it
 * down, in the order they are cheapest to check:
 *
 *   - `event.defaultPrevented` — somebody upstream already claimed the key;
 *   - an active inline text edit on the canvas (`activeInlineEdit`);
 *   - a text field holding an UNCOMMITTED draft (`hasPendingTextEdit`) — the
 *     exact rule `UndoRedoButtons` follows for ⌘Z, and for the same reason:
 *     whoever has an edit in progress owns the keystroke;
 *   - any input / textarea / contenteditable target (`isTextInputTarget`),
 *     where ⌘⇧C may mean something to the browser.
 *
 * Note `hasPendingTextEdit` is checked SEPARATELY from `isTextInputTarget`
 * even though the second subsumes the first here. It is not redundant
 * documentation: it is the assertion the routing test pins, so a later
 * loosening of the field guard (to make ⌘⇧C reachable from a parked-but-clean
 * inspector field, the way ⌘Z already is) cannot silently start firing
 * mid-draft.
 *
 * One in-flight capture at a time. A capture is a headless browser round trip,
 * and holding the key down would otherwise queue a browser launch per repeat.
 */
import { useEffect, useRef } from 'react'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { copyPngToClipboard } from '@site/panels/PropertiesPanel/nodeExportClient'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSelectors'
import { resolveCopyAsPngTarget, type CopyAsPngSelection } from './copyAsPngTarget'
import { hasPendingTextEdit } from './pendingTextEdit'
import { isTextInputTarget } from './useCanvasKeyboardShortcuts'

/** Matches the Export section's own default PNG density. */
const COPY_AS_PNG_SCALE = 2

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
  const frames = selectActiveBoard(state)?.frames ?? []
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

export function useCopyAsPngShortcut(isLive: boolean): void {
  const runningRef = useRef(false)

  useEffect(() => {
    if (isLive) return undefined
    const binding = getKeybindingForCommand('export.copySelectionPng')
    if (!binding) return undefined

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (!binding.match(event)) return
      if (useEditorStore.getState().activeInlineEdit) return
      if (hasPendingTextEdit(event.target)) return
      if (isTextInputTarget(event.target)) return

      // Claimed before any async work: the browser's own ⌘⇧C must not also run,
      // and a refusal below is still this shortcut answering, not nothing.
      event.preventDefault()
      if (runningRef.current) return

      const target = resolveCopyAsPngTarget(readCopyAsPngSelection())
      if (!target.ok) {
        pushToast({ kind: 'error', title: 'Nothing to copy as PNG', body: target.reason })
        return
      }

      runningRef.current = true
      void copyPngToClipboard({
        pageId: target.pageId,
        nodeId: target.nodeId,
        scale: COPY_AS_PNG_SCALE,
      })
        .then(() => {
          pushToast({ kind: 'success', title: 'Copied as PNG', body: `${target.label} @${COPY_AS_PNG_SCALE}×` })
        })
        .catch((err: unknown) => {
          console.error('[useCopyAsPngShortcut] copy as PNG failed:', err)
          pushToast({
            kind: 'error',
            title: 'Copy as PNG failed',
            body: getErrorMessage(err, 'Unknown export error'),
          })
        })
        .finally(() => {
          runningRef.current = false
        })
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isLive])
}
