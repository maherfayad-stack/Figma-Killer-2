/**
 * useBridgeSelectionChrome — `live-13`: selection chrome for a Tier 2 bridge
 * frame, driven through `FrameDocumentAdapter` because the frame's document
 * is cross-origin and `BreakpointSelectionOverlay`'s own measure-and-portal
 * path (`tickOnce`) cannot reach it.
 *
 * The rings and the resize handles are the frame's: the runtime draws and
 * positions them in its own document (`runtime.ts`, `resizeHandles.ts`),
 * which is the design `live-05` built — this hook is the caller that path
 * was waiting for. The parent sends three things and reads one back:
 *
 *   - `select`/`hover` — the same selection and hover the portal overlay
 *     renders, as node refs.
 *   - `applyOverlay` of the editor's ring tokens (`--canvas-selection-ring`
 *     and friends): the runtime's own stylesheet references them but a
 *     cross-origin document cannot read the parent's computed styles, so
 *     without this block the rings position correctly and paint nothing.
 *   - `setResizeTarget` — a single selection whose MODULE can carry an inline
 *     style (`canOfferResizeForModule`, the parent's half of `resizeOffer`);
 *     the runtime applies the geometric half on its side. With it go the
 *     three facts a portal drag reads off the store and a live frame cannot
 *     (`resizeTargetContext.ts`): the node's stored sizing markers
 *     (canvas-23), its tree siblings and parent, and the zoom (canvas-26).
 *   - `measure` — once per selection change, pan/zoom commit, frame reflow
 *     or HMR swap, to anchor the selection toolbar and the in-place
 *     inspector, which stay in the PARENT document exactly as they do for a
 *     portal frame. The rect comes back relative to the frame's body and is
 *     projected through the same `createCanvasOverlayMeasureSession` the
 *     portal fallback uses; the overlay's own tick leaves both elements
 *     alone for a bridge frame.
 *
 * Does nothing for a portal adapter — that frame's chrome is the overlay's.
 */
import { useEffect, type RefObject } from 'react'
import { canWriteInlineStyleForModule } from '@core/page-tree'
import { buildSelectionChromeTokenBlock } from '@core/studio-runtime'
import { useEditorStore } from '@site/store/store'
import { createCanvasOverlayMeasureSession, unionCanvasOverlayRects, type CanvasOverlayRect } from './canvasOverlayGeometry'
import {
  hideOverlayElement,
  positionInspector,
  positionToolbar,
  publishSelectionAnchor,
} from './canvasSelectionOverlayPositioning'
import type { FrameDocumentAdapter, NodeRect } from './frameAdapter/FrameDocumentAdapter'
import { isPortalFrameAdapter } from './frameAdapter/PortalFrameAdapter'
import { findNodeById } from './InPlaceInspector/findNodeById'
import { resizeSnapPeersKey, resizeTargetOptions, storedSizingMarker } from './resizeTargetContext'
import type { RecordSelectionChromeAnchor } from './selectionChromeViewportFollow'

/** The `applyOverlay` id the forwarded ring tokens are mounted under inside the frame. */
export const SELECTION_CHROME_TOKENS_OVERLAY_ID = 'selection-chrome-tokens'

export interface BridgeSelectionChromeOptions {
  iframeElement: HTMLIFrameElement | null
  canvasRoot: HTMLElement | null
  selectedNodeIds: readonly string[]
  /** The node the hover ring should follow, or `null` — already scoped to this frame and excluding the selection. */
  hoverNodeId: string | null
  showToolbar: boolean
  inspectorNodeId: string | null
  toolbarRef: RefObject<HTMLDivElement | null>
  inspectorRef: RefObject<HTMLDivElement | null>
  /** The store's DEBOUNCED zoom/pan — a change here is the "pan/zoom committed" trigger for re-anchoring. */
  committedTransform: readonly [number, number, number]
  /** Hands each measured placement to the pan/zoom follower (`selectionChromeViewportFollow.ts`, PERF-3). */
  recordAnchor: RecordSelectionChromeAnchor
}

/** True when `adapter` is a bridge to a cross-origin frame — the only kind this hook drives. */
export function isBridgeChromeAdapter(adapter: FrameDocumentAdapter | null): adapter is FrameDocumentAdapter {
  return adapter !== null && !isPortalFrameAdapter(adapter)
}

/** A body-relative frame rect as the duck-typed rect source `createCanvasOverlayMeasureSession` projects. */
function rectSource(rect: NodeRect) {
  return {
    getBoundingClientRect: () => ({
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
    }),
  }
}

export function useBridgeSelectionChrome(adapter: FrameDocumentAdapter | null, options: BridgeSelectionChromeOptions): void {
  const {
    iframeElement,
    canvasRoot,
    selectedNodeIds,
    hoverNodeId,
    showToolbar,
    inspectorNodeId,
    toolbarRef,
    inspectorRef,
    committedTransform,
    recordAnchor,
  } = options
  const bridge = isBridgeChromeAdapter(adapter) ? adapter : null
  const resizeCandidate = selectedNodeIds.length === 1 ? (selectedNodeIds[0] ?? null) : null
  const resizeModuleId = useEditorStore((s) => (resizeCandidate ? (findNodeById(s, resizeCandidate)?.moduleId ?? null) : null))
  const resizeNodeId = resizeModuleId !== null && canWriteInlineStyleForModule(resizeModuleId) ? resizeCandidate : null
  // `K4` — the scale tool keeps the aspect ratio; the frame captures the flag
  // at pointerdown, so toggling it never changes a drag already in flight.
  const proportional = useEditorStore((s) => s.canvasTool === 'scale')
  // canvas-23/26 — primitives, so an unrelated store write re-sends nothing.
  const flexMarker = useEditorStore((s) => storedSizingMarker(s, resizeNodeId, 'flex'))
  const alignSelfMarker = useEditorStore((s) => storedSizingMarker(s, resizeNodeId, 'alignSelf'))
  const justifySelfMarker = useEditorStore((s) => storedSizingMarker(s, resizeNodeId, 'justifySelf'))
  const snapPeers = useEditorStore((s) => resizeSnapPeersKey(s, resizeNodeId))
  const zoom = committedTransform[0]

  // Ring tokens, once per adapter (a reload re-plays every queued post — see
  // `BridgeFrameAdapter`'s `ready` handling).
  useEffect(() => {
    bridge?.applyOverlay(SELECTION_CHROME_TOKENS_OVERLAY_ID, buildSelectionChromeTokenBlock(document))
  }, [bridge])

  // `selectedNodeIds` keeps its identity across equal store writes (the
  // overlay reads it through `useShallow`), so the array itself is the dep.
  useEffect(() => {
    bridge?.select(selectedNodeIds.map((nodeId) => ({ nodeId })))
  }, [bridge, selectedNodeIds])

  useEffect(() => {
    bridge?.hover(hoverNodeId ? { nodeId: hoverNodeId } : null)
  }, [bridge, hoverNodeId])

  useEffect(() => {
    bridge?.setResizeTarget(
      resizeNodeId ? { nodeId: resizeNodeId } : null,
      resizeTargetOptions({ proportional, markers: [flexMarker, alignSelfMarker, justifySelfMarker], snapPeers, zoom }),
    )
  }, [bridge, resizeNodeId, proportional, flexMarker, alignSelfMarker, justifySelfMarker, snapPeers, zoom])

  // Toolbar + inspector anchor. Async by nature (a real round trip), so a
  // reply that arrives after a newer request was sent is dropped.
  useEffect(() => {
    if (!bridge || !iframeElement) return
    const needsAnchor = showToolbar || inspectorNodeId !== null
    if (!needsAnchor || selectedNodeIds.length === 0) {
      hideOverlayElement(toolbarRef.current)
      hideOverlayElement(inspectorRef.current)
      recordAnchor(null)
      return
    }
    let generation = 0
    let disposed = false
    const refresh = () => {
      const mine = (generation += 1)
      bridge
        .measure(selectedNodeIds.map((nodeId) => ({ nodeId })))
        .then((measurements) => {
          if (disposed || mine !== generation || !iframeElement.isConnected) return
          const session = createCanvasOverlayMeasureSession(iframeElement, canvasRoot)
          let toolbarUnion: CanvasOverlayRect | null = null
          let inspectorRect: CanvasOverlayRect | null = null
          for (const measurement of measurements) {
            const rect = measurement.rect ? session.measure(rectSource(measurement.rect)) : null
            if (showToolbar && rect) toolbarUnion = unionCanvasOverlayRects(toolbarUnion, rect)
            if (measurement.nodeId === inspectorNodeId) inspectorRect = rect
          }
          positionToolbar(toolbarRef.current, showToolbar ? toolbarUnion : null, session.canvasRect)
          publishSelectionAnchor(toolbarRef.current, showToolbar ? toolbarUnion : null)
          positionInspector(inspectorRef.current, inspectorNodeId ? inspectorRect : null, session.canvasRect)
          publishSelectionAnchor(inspectorRef.current, inspectorNodeId ? inspectorRect : null)
          recordAnchor({
            toolbar: showToolbar ? toolbarUnion : null,
            inspector: inspectorNodeId ? inspectorRect : null,
            canvasRect: session.canvasRect,
          })
        })
        .catch((err: unknown) => {
          // A frame mid-reload does not answer; the next trigger re-asks.
          console.warn('[useBridgeSelectionChrome] measure failed:', err)
        })
    }
    refresh()
    const unsubscribes = [
      bridge.on('frame:resize', refresh),
      bridge.on('hmr:after', refresh),
    ]
    return () => {
      disposed = true
      for (const unsubscribe of unsubscribes) unsubscribe()
    }
    // `committedTransform` is the pan/zoom-commit trigger, not a value read here.
  }, [bridge, iframeElement, canvasRoot, selectedNodeIds, showToolbar, inspectorNodeId, committedTransform, toolbarRef, inspectorRef, recordAnchor])
}
