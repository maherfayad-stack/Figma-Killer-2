/**
 * useLiveCursorSender - publishes this tab's pointer, in board space.
 *
 * Two sources, because a canvas frame is an iframe and swallows the pointer
 * events its content receives: the admin window (board background, chrome) and
 * each same-origin frame document. A pointer outside the canvas root sends
 * `cursor: null` once, so peers do not leave a ghost where the pointer was.
 *
 * The client itself throttles to 30 Hz; this only translates coordinates.
 */
import { useEffect } from 'react'
import {
  listFrameAdapters,
  onFrameAdapterRegistryChange,
} from '../../canvas/frameAdapter/canvasFrameAdapterRegistry'
import { resolvePortalDocument } from '../../canvas/frameAdapter/resolvePortalDocument'
import { boardPointFromClient, boardPointFromFrameEvent, findCanvasRoot, findTransformLayer } from './liveBoardPoint'
import { getLiveClient } from './studioLiveConnection'

const FRAME_RESYNC_MS = 1_000

export function useLiveCursorSender(): void {
  useEffect(() => {
    let cursorShown = false

    function publish(point: { x: number; y: number } | null): void {
      if (point === null && !cursorShown) return
      cursorShown = point !== null
      getLiveClient()?.sendPresence({ cursor: point })
    }

    function onWindowMove(event: PointerEvent): void {
      const layer = findTransformLayer()
      const root = findCanvasRoot()
      if (!layer || !root) return
      const rect = root.getBoundingClientRect()
      const inside =
        event.clientX >= rect.left && event.clientX <= rect.right &&
        event.clientY >= rect.top && event.clientY <= rect.bottom
      publish(inside ? boardPointFromClient(layer, event.clientX, event.clientY) : null)
    }

    // One listener per live frame document, torn down when the frame goes.
    const attached = new Map<Document, () => void>()
    function syncFrames(): void {
      const current = new Map<Document, HTMLIFrameElement>()
      for (const iframe of listFrameAdapters().keys()) {
        const doc = resolvePortalDocument(iframe)
        if (doc) current.set(doc, iframe)
      }
      for (const [doc, detach] of attached) {
        if (!current.has(doc)) {
          detach()
          attached.delete(doc)
        }
      }
      for (const [doc, iframe] of current) {
        if (attached.has(doc)) continue
        const onFrameMove = (event: PointerEvent): void => {
          const layer = findTransformLayer()
          if (!layer) return
          publish(boardPointFromFrameEvent(layer, iframe, event.clientX, event.clientY))
        }
        doc.addEventListener('pointermove', onFrameMove, { passive: true })
        attached.set(doc, () => doc.removeEventListener('pointermove', onFrameMove))
      }
    }

    window.addEventListener('pointermove', onWindowMove, { passive: true })
    const unsubscribeRegistry = onFrameAdapterRegistryChange(syncFrames)
    // A frame whose srcdoc reloads swaps its document without a registry event.
    const resync = setInterval(syncFrames, FRAME_RESYNC_MS)
    syncFrames()

    return () => {
      window.removeEventListener('pointermove', onWindowMove)
      unsubscribeRegistry()
      clearInterval(resync)
      for (const detach of attached.values()) detach()
      attached.clear()
    }
  }, [])
}
