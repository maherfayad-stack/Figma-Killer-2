import { useEffect, useRef, type RefObject } from 'react'
import { isPortalFrameAdapter } from './frameAdapter/PortalFrameAdapter'
import type { FrameDocumentAdapter } from './frameAdapter/FrameDocumentAdapter'

interface IframeCursorBridgeHandlers {
  onCursorMove?: (event: MouseEvent) => void
  onCursorLeave?: () => void
}

/**
 * Surfaces iframe-native cursor movement to parent editor chrome. Empty body
 * regions inside the iframe do not produce React events, so cursor-following
 * overlays need native listeners at the iframe boundary.
 *
 * Portal mode only (`live-05`, STATE.md, Batch 3): reads the frame's native
 * `Window`/`Document` through `PortalFrameAdapter`'s narrow escape hatch
 * (`getPortalWindow` — see its own doc for why this can't be a generic
 * `FrameDocumentAdapter` method). Bridge mode is a documented gap, not a
 * silent one: `mousemove` has a real analog in `runtime.ts`'s outbound
 * `pointer` message (`phase: 'move'`), but `mouseleave` has no wire message
 * at all today, and nothing exercises `documentMode==='bridge'` yet (that
 * prop doesn't exist until a later batch) — building an unverifiable
 * bridge-mode cursor relay now would be speculation, not a working feature.
 */
export function useIframeCursorBridge(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  adapter: FrameDocumentAdapter | null,
  handlers: IframeCursorBridgeHandlers,
): void {
  const handlersRef = useRef(handlers)

  useEffect(() => {
    handlersRef.current = handlers
  }, [handlers])

  useEffect(() => {
    if (!isPortalFrameAdapter(adapter)) return
    const iframeDoc = adapter.getPortalWindow()?.document
    if (!iframeDoc) return
    const iframe = iframeRef.current
    if (!iframe) return

    const handleMove = (event: MouseEvent) => {
      handlersRef.current.onCursorMove?.(event)
    }
    const handleLeave = () => {
      handlersRef.current.onCursorLeave?.()
    }

    iframeDoc.addEventListener('mousemove', handleMove)
    iframe.addEventListener('mouseleave', handleLeave)
    return () => {
      iframeDoc.removeEventListener('mousemove', handleMove)
      iframe.removeEventListener('mouseleave', handleLeave)
    }
  }, [adapter, iframeRef])
}
