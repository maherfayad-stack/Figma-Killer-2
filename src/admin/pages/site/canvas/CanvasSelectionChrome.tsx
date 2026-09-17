/**
 * CanvasSelectionChrome — the rings, the node-name badges, the
 * selector-affinity pool and the resize handles, as ELEMENTS. Where each of
 * them goes is `canvasSelectionOverlayPositioning.ts`'s job and stays there:
 * every node here is positioned imperatively by the overlay's measure pass
 * through the refs it hands down.
 *
 * Split out of `BreakpointSelectionOverlay.tsx` when that component passed
 * the 700-line ceiling — `canvas-17` named this block as the unit to
 * extract, and both K5 and S2 then added a mount line to it.
 *
 * **It renders nothing on its own.** It is a plain function component so it
 * can be portaled as one child, and it deliberately holds NO state, no
 * effect and no measurement: the overlay owns all three, and a second
 * measure pass here would be the drift `canvas-17` spent a work order
 * removing.
 */
import type { RefObject } from 'react'
import { cn } from '@ui/cn'
import { CanvasResizeHandles } from './CanvasResizeHandles'
import styles from './BreakpointSelectionOverlay.module.css'

interface CanvasSelectionChromeProps {
  selectedNodeIds: readonly string[]
  showHover: boolean
  hoverRingNodeId: string | null
  showSelectorHighlight: boolean
  usingIframeOverlay: boolean
  toolbarMode: 'scoped' | 'fixed'
  resizeNodeId: string | null
  overlayRoot: HTMLElement | null
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
  showHover,
  hoverRingNodeId,
  showSelectorHighlight,
  usingIframeOverlay,
  toolbarMode,
  resizeNodeId,
  overlayRoot,
  selectorHighlightRef,
  hoverRef,
  ringRefs,
  badgeRefs,
  onResizeFrameReady,
}: CanvasSelectionChromeProps) {
  const legacyRingClassName = (variant: 'selection' | 'hover') =>
    usingIframeOverlay ? undefined : cn(styles.ring, styles[variant])
  const legacyRingMode = usingIframeOverlay ? undefined : toolbarMode
  return (
    <>
      {/* Orange affinity rings — populated imperatively by the RAF tick, one
          per element matching the hovered selector. */}
      {showSelectorHighlight && (
        <div ref={selectorHighlightRef} data-canvas-selector-highlight-layer="true" />
      )}
      {/* `data-canvas-overlay-node-id`, NOT `data-node-id`: when hosted inside
          the iframe (WS-5.1), these elements live in the SAME document as
          authored content. `data-node-id` is the contract many other
          subsystems query on inside a canvas iframe — drag/drop candidate
          measurement (`measureCanvasDropCandidates`'s `[data-node-id]` scan),
          `findRenderedCanvasNodes`/`CanvasNodeElementCache`'s node
          resolution, plugin `useCanvasNodeRect` — carrying it here would
          make chrome masquerade as a second, ring-shaped copy of the
          authored node wherever those scans run. The correlating id below is
          JS-only bookkeeping (ref maps, the e2e/test hook), never a selector
          any other subsystem treats as "this is an authored node". */}
      {selectedNodeIds.map((id) => (
        <div
          key={`ring-${id}`}
          ref={(el) => {
            if (el) ringRefs.current?.set(id, el)
            else ringRefs.current?.delete(id)
          }}
          className={legacyRingClassName('selection')}
          data-canvas-ring-mode={legacyRingMode}
          data-canvas-selection-ring="true"
          data-canvas-overlay-node-id={id}
        />
      ))}
      {/* Node-name badge (WS-5.1) — design-mode only (see props doc): one per
          selected node, anchored just above its ring by `positionNodeBadge`.
          Text set imperatively. No badge for the hover ring or
          selector-affinity pool (transient affordances, not a deliberate
          selection), and none in the live-mode fallback — the badge is a
          WS-5.1 addition, not a pre-existing affordance to preserve there. */}
      {usingIframeOverlay && selectedNodeIds.map((id) => (
        <div
          key={`badge-${id}`}
          ref={(el) => {
            if (el) badgeRefs.current?.set(id, el)
            else badgeRefs.current?.delete(id)
          }}
          data-canvas-node-badge="true"
          data-canvas-overlay-node-id={id}
        />
      ))}
      {showHover && hoverRingNodeId && (
        <div
          ref={hoverRef}
          className={legacyRingClassName('hover')}
          data-canvas-ring-mode={legacyRingMode}
          data-canvas-hover-ring="true"
          data-canvas-overlay-node-id={hoverRingNodeId}
        />
      )}
      {/* The one interactive thing in this click-through overlay — see
          `CanvasResizeHandles`. */}
      {resizeNodeId && (
        <CanvasResizeHandles
          nodeId={resizeNodeId}
          iframeDoc={overlayRoot?.ownerDocument ?? null}
          onFrameReady={onResizeFrameReady}
        />
      )}
    </>
  )
}
