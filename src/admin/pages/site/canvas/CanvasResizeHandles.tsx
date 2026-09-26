/**
 * CanvasResizeHandles — the eight drag handles drawn on a selected element.
 *
 * Portalled (by `BreakpointSelectionOverlay`) into the iframe's own overlay
 * root, so the handles live in the same coordinate space as the element they
 * size. The FRAME is positioned by the overlay's RAF tick off the very same
 * measured rect the selection ring uses, which is why this component writes no
 * position of its own: two independent measurements of one element is exactly
 * how handles end up drifting off the box they belong to.
 *
 * Appearance and hit areas are the injected stylesheet's
 * (`CanvasSelectionOverlayInjector`) — corners are visible squares, edges are
 * invisible full-length strips, because the ask was "drag the sides" and a 9px
 * dot at the midpoint of a 300px edge is a worse version of that gesture.
 *
 * This is the ONLY interactive thing in an otherwise click-through overlay:
 * the frame stays `pointer-events: none` and only the handles opt back in, so
 * clicking page content anywhere but within a few px of the selected element's
 * edge behaves exactly as it did before.
 *
 * Just outside each corner is a rotation zone (P5-F, IX-25 —
 * `useElementRotateDrag`), writing the standalone `rotate` property.
 *
 * A multi-selection gets ONE set of handles on the union of its layers
 * (`CanvasGroupResizeHandles`, below — P5-F, IX-6g).
 *
 * Whether handles are drawn at all is `canOfferResize`'s decision, not this
 * component's — see `resizeOffer.ts` for the three ways a drag can have no
 * honest target, and why offering one anyway is worse than offering nothing.
 */
import { useState } from 'react'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { presentedElementForNode } from './canvasNodeLookup'
import { findNodeById } from './InPlaceInspector/findNodeById'
import { RESIZE_HANDLE_ATTR, RESIZE_HANDLES, RESIZE_SIZE_BADGE_ATTR, ROTATE_CORNERS, ROTATE_HANDLE_ATTR } from '@core/studio-runtime'
import { useVectorEditTarget } from './BoardVectorLayer/vectorEditState'
import { canOfferResize } from './resizeOffer'
import { useElementResizeDrag } from './useElementResizeDrag'
import { useGroupResizeDrag } from './useGroupResizeDrag'
import { hasNestedMember } from './groupResize'
import { useElementRotateDrag } from './useElementRotateDrag'
import { CanvasSpacingHandles } from './CanvasSpacingHandles'

interface CanvasResizeHandlesProps {
  /** The single selected node. May not be resizable — `canOfferResize` decides. */
  nodeId: string
  /** The frame's document, so the element's display can be checked before rendering anything. */
  iframeDoc: Document | null
  /**
   * Hands the frame element back to the overlay, which positions it in its RAF
   * tick. A callback rather than a forwarded ref because the overlay needs it
   * in an effect (where a ref is right) while this component needs it as STATE
   * (an effect dependency cannot see a ref mutate).
   */
  onFrameReady: (element: HTMLDivElement | null) => void
}

export function CanvasResizeHandles({ nodeId, iframeDoc, onFrameReady }: CanvasResizeHandlesProps) {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null)

  // The node itself, for its `moduleId` — the fact that decides whether a
  // width dragged here ever reaches the user's file. Without it the drag is
  // accepted by the store, dropped by `fsCodemodAdapter.saveSite`, and the
  // element snaps back the instant the preview override is released.
  const node = useEditorStore((s) => findNodeById(s, nodeId))

  // The element the user SEES, which for an `alm.*` node is one level below
  // the `display: contents` host carrying the node id. Read once per render
  // rather than in the overlay's RAF tick: this is a `getComputedStyle` call,
  // and the tick runs 60 times a second.
  const target = iframeDoc ? presentedElementForNode(iframeDoc, nodeId) : null
  const display = target ? (iframeDoc?.defaultView?.getComputedStyle(target).display ?? '') : ''
  // P5-D — while this svg's POINTS are being edited, a drag on it means a
  // point; its box handles would compete for the same presses.
  const editingPoints = useVectorEditTarget()?.hostNodeId === nodeId
  const sizeable = !editingPoints && canOfferResize({
    moduleId: node?.moduleId ?? null,
    hasOwnElement: target !== null,
    display,
    localName: target?.localName ?? '',
  })

  useElementResizeDrag({
    frame,
    iframeDoc: sizeable ? iframeDoc : null,
    nodeId,
  })
  // P5-F / IX-25 — the rotation zones ride the same frame and the same gate.
  useElementRotateDrag({
    frame,
    iframeDoc: sizeable ? iframeDoc : null,
    nodeId,
  })

  // Rendering nothing is the honest answer in every case `canOfferResize`
  // refuses — see that module for which three they are. The alternative is
  // handles that track the cursor and then undo themselves.
  if (!sizeable) return null

  return (
    <div
      ref={(element) => {
        setFrame(element)
        onFrameReady(element)
      }}
      data-canvas-resize-frame="true"
      data-canvas-overlay-node-id={nodeId}
    >
      {/* P5-E (IX-17) — padding and gap bands of a flex / grid container,
          riding this same frame (so the one ring measurement places them).
          FIRST, so the resize strips paint over them where the two meet at
          an edge: the edge is the size, the inside is the padding. */}
      {iframeDoc && target && <CanvasSpacingHandles nodeId={nodeId} iframeDoc={iframeDoc} target={target} />}
      {/* P5-F / IX-25 — rotation zones just OUTSIDE each corner handle, so a
          press on the corner still resizes. Invisible; the cursor says it. */}
      {ROTATE_CORNERS.map((corner) => (
        <div key={`rotate-${corner}`} {...{ [ROTATE_HANDLE_ATTR]: corner }} />
      ))}
      {RESIZE_HANDLES.map((handle) => (
        <div key={handle} {...{ [RESIZE_HANDLE_ATTR]: handle }} />
      ))}
      {/* IX-18 — the W×H badge; shown by the injected CSS only while a drag
          marks this frame, its text written by the drag and the overlay's
          measure pass. */}
      <div {...{ [RESIZE_SIZE_BADGE_ATTR]: 'true' }} />
    </div>
  )
}

interface CanvasGroupResizeHandlesProps {
  /** Two or more selected nodes. The group box is offered only when EVERY one is resizable. */
  nodeIds: readonly string[]
  iframeDoc: Document | null
  /** As `CanvasResizeHandles`: the frame goes to the overlay, which places it on the union of the rings. */
  onFrameReady: (element: HTMLDivElement | null) => void
}

/**
 * P5-F / IX-6g — ONE set of handles on the union of a multi-selection, which
 * scales every member with the box (`groupResize.ts`, `useGroupResizeDrag`).
 *
 * All or nothing, like the single handles' `canOfferResize`: a member the
 * gate refuses would be a layer the box claims to resize and does not, so
 * one refusal draws no group handles at all — and neither does a selection
 * with a layer inside another selected layer (`hasNestedMember`), which
 * would scale that layer twice. No padding / gap handles here —
 * those belong to ONE container.
 */
export function CanvasGroupResizeHandles({ nodeIds, iframeDoc, onFrameReady }: CanvasGroupResizeHandlesProps) {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null)
  // A joined string, not an array: a fresh array per store change would be a
  // new snapshot every time. One module id per member, in selection order.
  const moduleIdsKey = useEditorStore((s) => nodeIds.map((id) => findNodeById(s, id)?.moduleId ?? '').join('\n'))
  const moduleIds = moduleIdsKey.split('\n')

  // A layer inside another selected layer would be scaled twice.
  const nested = useEditorStore((s) => {
    const tree = selectActiveCanvasPage(s)
    return hasNestedMember((id) => tree?.nodes[id]?.parentId ?? null, nodeIds)
  })

  const sizeable = iframeDoc !== null && !nested && nodeIds.every((nodeId, index) => {
    const target = presentedElementForNode(iframeDoc, nodeId)
    return canOfferResize({
      moduleId: moduleIds[index] || null,
      hasOwnElement: target !== null,
      display: target ? (iframeDoc.defaultView?.getComputedStyle(target).display ?? '') : '',
      localName: target?.localName ?? '',
    })
  })

  useGroupResizeDrag({
    frame,
    iframeDoc: sizeable ? iframeDoc : null,
    nodeIdsKey: nodeIds.join(' '),
  })

  if (!sizeable) return null

  return (
    <div
      ref={(element) => {
        setFrame(element)
        onFrameReady(element)
      }}
      data-canvas-resize-frame="true"
      data-canvas-resize-group="true"
    >
      {RESIZE_HANDLES.map((handle) => (
        <div key={handle} {...{ [RESIZE_HANDLE_ATTR]: handle }} />
      ))}
      <div {...{ [RESIZE_SIZE_BADGE_ATTR]: 'true' }} />
    </div>
  )
}
