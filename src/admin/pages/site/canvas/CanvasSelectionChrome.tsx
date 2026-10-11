/**
 * CanvasSelectionChrome — the rings, the node-name badges, the
 * selector-affinity pool and the resize handles, as ELEMENTS. Where each of
 * them goes is `canvasSelectionOverlayPositioning.ts`'s job and stays there:
 * every node here is positioned imperatively by the overlay's placement pass
 * through the refs it hands down.
 *
 * Split out of `BreakpointSelectionOverlay.tsx` when that component passed
 * the 700-line ceiling — `canvas-17` named this block as the unit to
 * extract, and both K5 and S2 then added a mount line to it.
 *
 * **It renders nothing on its own.** It is a plain function component and it
 * deliberately holds NO state, no effect and no measurement: the overlay owns
 * all three, and a second placement pass here would be the drift `canvas-17`
 * spent a work order removing.
 *
 * ## Where these elements live (SB-4)
 *
 * In the PARENT document, inside the zero-size chrome root the overlay renders
 * beside the frame's iframe (`FrameChrome.module.css`). They used to be
 * appended to the frame's own `<body>`, which put editor DOM in the user's
 * document and made every ring write a mutation the frame's observers had to
 * filter out. They carry `data-canvas-overlay-node-id`, NOT `data-node-id`:
 * `data-node-id` is the contract the canvas's own scans (drop candidates,
 * `findRenderedCanvasNodes`, plugin `useCanvasNodeRect`) query on, and chrome
 * must never masquerade as a second copy of an authored node.
 */
import type { RefObject } from 'react'
import { CanvasGroupResizeHandles, CanvasResizeHandles } from './CanvasResizeHandles'
import styles from './FrameChrome.module.css'

interface CanvasSelectionChromeProps {
  selectedNodeIds: readonly string[]
  showSelectorHighlight: boolean
  /** The selected layers that get resize handles: one gets its own, several get a group box (IX-6g). */
  resizeNodeIds: readonly string[]
  /** The frame's same-origin document, for the handles' element reads; `null` for a bridge frame. */
  frameDocument: Document | null
  /** A design frame has the node badge and the handles; the live surface has rings only. */
  designMode: boolean
  selectorHighlightRef: RefObject<HTMLDivElement | null>
  hoverRef: RefObject<HTMLDivElement | null>
  ringRefs: RefObject<Map<string, HTMLDivElement | null> | null>
  badgeRefs: RefObject<Map<string, HTMLDivElement | null> | null>
  /**
   * Notified with the resize-handle frame element. A CALLBACK rather than
   * the ref itself: the React Compiler forbids writing to a ref that
   * arrived as a prop, and rightly — the owner of a ref should be the one
   * that writes it. `BreakpointSelectionOverlay` keeps that ref.
   */
  onResizeFrameReady: (element: HTMLDivElement | null) => void
}

export function CanvasSelectionChrome({
  selectedNodeIds,
  showSelectorHighlight,
  resizeNodeIds,
  frameDocument,
  designMode,
  selectorHighlightRef,
  hoverRef,
  ringRefs,
  badgeRefs,
  onResizeFrameReady,
}: CanvasSelectionChromeProps) {
  return (
    <>
      {/* Orange affinity rings — populated imperatively by the placement pass,
          one per element matching the hovered selector. */}
      {showSelectorHighlight && (
        <div ref={selectorHighlightRef} data-canvas-selector-highlight-layer="true" />
      )}
      {selectedNodeIds.map((id) => (
        <div
          key={`ring-${id}`}
          ref={(el) => {
            if (el) ringRefs.current?.set(id, el)
            else ringRefs.current?.delete(id)
          }}
          className={`${styles.ring} ${styles.selection}`}
          data-canvas-selection-ring="true"
          data-canvas-overlay-node-id={id}
        />
      ))}
      {/* Node-name badge (WS-5.1): one per selected node, anchored just above
          its ring by `positionNodeBadge`. Text set imperatively. No badge for
          the hover ring or selector-affinity pool (transient affordances, not
          a deliberate selection). */}
      {designMode && selectedNodeIds.map((id) => (
        <div
          key={`badge-${id}`}
          ref={(el) => {
            if (el) badgeRefs.current?.set(id, el)
            else badgeRefs.current?.delete(id)
          }}
          className={styles.nodeBadge}
          data-canvas-node-badge="true"
          data-canvas-overlay-node-id={id}
        />
      ))}
      {/* ALWAYS mounted (PERF-2): a hover starting or ending is a style write
          on this element (the overlay hides it with `hideOverlayElement`),
          never a mount or an unmount. Hover is continuous in normal use. The
          overlay also owns its `data-canvas-overlay-node-id`: it is written in
          the same step as the ring's placement, never by a render that could
          land after a newer hover has already moved the ring on. */}
      <div
        ref={hoverRef}
        className={`${styles.ring} ${styles.hover}`}
        data-canvas-hover-ring="true"
      />
      {/* The interactive part of an otherwise click-through root — see
          `CanvasResizeHandles`. */}
      {resizeNodeIds.length === 1 && (
        <CanvasResizeHandles
          nodeId={resizeNodeIds[0]!}
          frameDocument={frameDocument}
          onFrameReady={onResizeFrameReady}
        />
      )}
      {resizeNodeIds.length > 1 && (
        <CanvasGroupResizeHandles
          nodeIds={resizeNodeIds}
          frameDocument={frameDocument}
          onFrameReady={onResizeFrameReady}
        />
      )}
    </>
  )
}
