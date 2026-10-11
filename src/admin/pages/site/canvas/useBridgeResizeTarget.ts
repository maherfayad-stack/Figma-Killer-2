/**
 * useBridgeResizeTarget — `live-13`: what a Tier 2 bridge frame still needs
 * from the parent for its resize handles.
 *
 * Since SB-4 the rings, the hover ring, the node badge and the toolbar /
 * inspector anchor of a bridge frame are drawn and placed by the parent from
 * the frame's rect index like any other frame's (`BreakpointSelectionOverlay`),
 * so this hook no longer sends `select` / `hover` / ring tokens or asks the
 * frame to `measure` the selection. What remains is the frame-side resize
 * handles (`resizeHandles.ts` in the runtime), whose drag geometry only the
 * frame can see, and the facts a portal drag reads off the store that a live
 * frame cannot:
 *
 *   - `setResizeTarget` — a single selection whose MODULE can carry an inline
 *     style (`canOfferResizeForModule`, the parent's half of `resizeOffer`);
 *     the runtime applies the geometric half on its side. With it go the
 *     three facts a portal drag reads off the store and a live frame cannot
 *     (`resizeTargetContext.ts`): the node's stored sizing markers
 *     (canvas-23), its tree siblings and parent, and the zoom (canvas-26).
 *
 * Does nothing for a portal adapter.
 */
import { useEffect } from 'react'
import { canWriteInlineStyleForModule } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import type { FrameDocumentAdapter } from './frameAdapter/FrameDocumentAdapter'
import { isPortalFrameAdapter } from './frameAdapter/PortalFrameAdapter'
import { findNodeById } from './InPlaceInspector/findNodeById'
import { resizeAnchorsKey, resizeSnapPeersKey, resizeTargetOptions, storedSizingMarker } from './resizeTargetContext'

export interface BridgeSelectionChromeOptions {
  selectedNodeIds: readonly string[]
  /** The store's DEBOUNCED zoom/pan; its zoom is the snap threshold's scale. */
  committedTransform: readonly [number, number, number]
}

/** True when `adapter` is a bridge to a cross-origin frame — the only kind this hook drives. */
export function isBridgeChromeAdapter(adapter: FrameDocumentAdapter | null): adapter is FrameDocumentAdapter {
  return adapter !== null && !isPortalFrameAdapter(adapter)
}

export function useBridgeResizeTarget(adapter: FrameDocumentAdapter | null, options: BridgeSelectionChromeOptions): void {
  const { selectedNodeIds, committedTransform } = options
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
  const anchors = useEditorStore((s) => resizeAnchorsKey(s, resizeNodeId))
  const zoom = committedTransform[0]

  useEffect(() => {
    bridge?.setResizeTarget(
      resizeNodeId ? { nodeId: resizeNodeId } : null,
      resizeTargetOptions({ proportional, markers: [flexMarker, alignSelfMarker, justifySelfMarker], snapPeers, anchors, zoom }),
    )
  }, [bridge, resizeNodeId, proportional, flexMarker, alignSelfMarker, justifySelfMarker, snapPeers, anchors, zoom])
}
