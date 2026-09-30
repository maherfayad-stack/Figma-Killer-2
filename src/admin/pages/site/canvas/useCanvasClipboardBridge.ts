/**
 * useCanvasClipboardBridge — mounts P5-A's clipboard bridge for the canvas:
 * the sink that answers every bridged `paste` (`canvasPaste.ts`), the
 * listeners on the EDITOR's own document (each portal frame's document gets
 * its own from `useIframeEventForwarding`), and the copy marker.
 *
 * ## Which clipboard events are the canvas's
 *
 * The same stand-downs the key layer uses (`editorKeyGuards.ts`), for the same
 * reasons: a paste into a text field, into an open dialog/menu, or during an
 * inline text edit belongs to that surface, and the browser's own paste must
 * run there untouched. Anything else — the canvas root, a frame's body, a
 * non-text panel control — is a paste into the design, and scoped by INTENT
 * like the rest of the canvas keys (`K1`): the selection (or, with none, the
 * active frame) says where it lands.
 *
 * ## The marker follows the clipboard slice
 *
 * Every copy — ⌘C, ⌘X, a context menu, the palette — ends in the clipboard
 * slice's entry changing, so the marker is announced from THAT, once, rather
 * than by each caller. A reference comparison per store change; no scan.
 */
import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import {
  announceStudioCopy,
  installCanvasClipboardBridge,
  registerCanvasClipboardSink,
} from './canvasClipboardBridge'
import { runCanvasPaste } from './canvasPaste'
import { isInsideKeyOwningOverlay, isTextInputTarget } from './editorKeyGuards'

/** Whether a clipboard event raised at `target` is a paste into the design. */
export function canvasOwnsClipboardTarget(target: EventTarget | null): boolean {
  if (isTextInputTarget(target) || isInsideKeyOwningOverlay(target)) return false
  return useEditorStore.getState().activeInlineEdit === null
}

interface CanvasClipboardBridgeOptions {
  /** Off without structural edit rights, and in a live preview — neither writes. */
  editable: boolean
  isLive: boolean
}

export function useCanvasClipboardBridge({ editable, isLive }: CanvasClipboardBridgeOptions): void {
  useEffect(() => {
    if (!editable || isLive) return
    const unregister = registerCanvasClipboardSink({ owns: canvasOwnsClipboardTarget, paste: runCanvasPaste })
    const uninstall = installCanvasClipboardBridge(document)
    const unsubscribe = useEditorStore.subscribe((state, previous) => {
      const entry = state.clipboardEntry
      if (entry && entry !== previous.clipboardEntry) announceStudioCopy(entry.copiedAt)
    })
    return () => {
      unsubscribe()
      uninstall()
      unregister()
    }
  }, [editable, isLive])
}
