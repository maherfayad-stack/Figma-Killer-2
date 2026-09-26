/**
 * CanvasLayerHost — one loose layer inside the free-canvas surface (P5-G, FC-4):
 * the box that stands where `<body>` stands for a page's root.
 *
 * ## Why this box is not the §6.1 trap
 *
 * The canvas rule is "no wrapper BETWEEN AUTHORED ELEMENTS": a Studio box
 * inside a page breaks `%` and flex chains and every `>`/`+`/`:nth-child`
 * combinator that crosses it. A loose layer's root has no authored parent at
 * all — inside a frame its parent would be `<body>`, which is Studio's too.
 * This host is that `<body>`: absolutely positioned at the layer's placement,
 * `display: flow-root` so the root's margins cannot collapse out of it, and
 * either the placement's `w` wide (a fill-width root keeps filling, and
 * round-trips back into a page byte-identical) or `max-content` (hug). The
 * one fidelity difference is a selector that names `body` itself; it cannot
 * affect a page (design §4.3). `canvas-layer-isolation.test.ts` holds this
 * attribute to this one file, so no other Studio box can borrow the exception.
 *
 * ## What renders inside
 *
 * The layer page's root node is a `base.body` whose job is to claim the
 * iframe's `<body>` — right for a page, wrong for one of many layers sharing a
 * document. So the host renders the root's CHILDREN (the module's one returned
 * element), the same thing `CanvasComposedTree` does when a template wraps a
 * page. `CanvasPageContext` is the layer's own `canvas:<id>` page id, which is
 * how every `NodeRenderer` below resolves its node against the layer's tree.
 *
 * ## Size
 *
 * A `ResizeObserver` from the SURFACE's own window (an observer constructed in
 * the parent does not watch another document's layout reliably) reports the
 * host's box to `canvasLayerGeometry.ts` — the rings, the hit test and the
 * snapping all read it from there, never from the store.
 */
import { useEffect, useRef, type CSSProperties } from 'react'
import type { Page } from '@core/page-tree'
import type { CanvasLayerPlacement } from '@core/studio-board'
import { CanvasFrameContext, CanvasPageContext } from '../CanvasContexts'
import { NodeRenderer } from '../NodeRenderer'
import { forgetCanvasLayerSize, setCanvasLayerSize } from './canvasLayerGeometry'

interface CanvasLayerHostProps {
  placement: CanvasLayerPlacement
  page: Page
  pageId: string
  /** The virtual frame id every node in this layer is scoped to. */
  frameId: string
}

export function CanvasLayerHost({ placement, page, pageId, frameId }: CanvasLayerHostProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const layerId = placement.id

  useEffect(() => {
    const host = hostRef.current
    const view = host?.ownerDocument.defaultView as (Window & typeof globalThis) | null | undefined
    if (!host || !view || typeof view.ResizeObserver !== 'function') return
    const measure = () => setCanvasLayerSize(layerId, { width: host.offsetWidth, height: host.offsetHeight })
    measure()
    const observer = new view.ResizeObserver(measure)
    observer.observe(host)
    return () => {
      observer.disconnect()
      forgetCanvasLayerSize(layerId)
    }
  }, [layerId])

  const rootChildren = page.nodes[page.rootNodeId]?.children ?? []
  const hostStyle = {
    '--studio-layer-x': `${placement.x}px`,
    '--studio-layer-y': `${placement.y}px`,
    ...(placement.w !== undefined ? { '--studio-layer-w': `${placement.w}px` } : {}),
  } as CSSProperties

  return (
    <div
      ref={hostRef}
      data-studio-canvas-host=""
      data-studio-layer-id={layerId}
      data-studio-layer-fill={placement.w !== undefined ? '' : undefined}
      style={hostStyle}
    >
      <CanvasPageContext.Provider value={pageId}>
        <CanvasFrameContext.Provider value={frameId}>
          {rootChildren.map((childId) => (
            <NodeRenderer key={childId} nodeId={childId} />
          ))}
        </CanvasFrameContext.Provider>
      </CanvasPageContext.Provider>
    </div>
  )
}
