/**
 * usePrototypeEndpoints — where each connector's ends are, in BOARD space.
 *
 * WHAT IS MEASURED, AND WHAT IS NOT
 * ─────────────────────────────────
 * A frame's board rect is STORE DATA (`BoardFrame.x/y/width/height`). Nothing
 * about it needs the DOM, so moving or resizing a frame is a plain re-render
 * with no measurement at all.
 *
 * The only thing that genuinely needs measuring is where an element sits INSIDE
 * its frame, and that changes for exactly one reason: the page's content
 * reflowed. So the DOM read is driven by a `ResizeObserver` on each source
 * frame's document element and by nothing else — no polling, no per-frame
 * remeasure, and above all nothing on pan or zoom, which cannot move a
 * board-space endpoint because `CanvasTransformLayer` moves the whole layer for
 * free. Measuring per animation frame instead would re-read two iframes per
 * connector on every wheel tick, which is how this feature becomes a stutter
 * machine.
 *
 * An element's rect inside its iframe is already frame-local and UNSCALED: the
 * canvas transform scales the `<iframe>` ELEMENT, not the CSS pixels of the
 * document inside it. That is why none of this needs the canvas root's rect or
 * the live transform ref, and why composing `frame origin + element rect` is
 * the whole conversion.
 */
import { useEffect, useState } from 'react'
import { FRAME_HEIGHT, FRAME_WIDTH, type BoardFrame } from '@core/studio-board'
import { findRenderedCanvasNodes } from '../canvasNodeLookup'
import type { BoardRect } from './connectorGeometry'

export function frameBoardRect(frame: BoardFrame): BoardRect {
  return {
    x: frame.x,
    y: frame.y,
    width: frame.width ?? FRAME_WIDTH,
    height: frame.height ?? FRAME_HEIGHT,
  }
}

/**
 * The box an element OCCUPIES ON SCREEN, even when it has none of its own.
 *
 * Every node Studio renders for a component out of a design-system package is a
 * `display: contents` wrapper: the node id has to live on an element, but that
 * element must not add a box, or it would break the CSS combinators
 * (`body > nav`, `:nth-child()`) that the published DOM relies on. Such an
 * element's `getBoundingClientRect()` is `0×0` — correct per spec, and useless
 * here, because the thing the user is pointing at is plainly visible.
 *
 * A `Range` over the element's contents reports what its children actually
 * occupy, text nodes included, which is the honest answer to "where is this
 * node". `NodeRenderer` measures inline text the same way.
 *
 * `null` only when there genuinely is nothing rendered.
 */
export function visualBox(element: Element): DOMRect | null {
  const own = element.getBoundingClientRect()
  if (own.width > 0 || own.height > 0) return own

  const range = element.ownerDocument.createRange()
  range.selectNodeContents(element)
  const contents = range.getBoundingClientRect()
  range.detach()
  return contents.width > 0 || contents.height > 0 ? contents : null
}

/**
 * A node's rect RELATIVE TO ITS FRAME's top-left, in unscaled CSS pixels.
 *
 * `null` when the node has no element in any canvas frame — a page that is not
 * mounted, an id that has gone stale, or a node that renders nothing at all.
 * Callers draw nothing rather than guessing at a position.
 */
export function measureNodeFrameRect(nodeId: string): BoardRect | null {
  const rendered = findRenderedCanvasNodes(nodeId)[0]
  if (!rendered) return null

  const box = visualBox(rendered.element)
  if (!box) return null

  const view = rendered.element.ownerDocument.defaultView
  // The rect is relative to the iframe's VIEWPORT, so a scrolled frame needs
  // its scroll added back to get a stable frame-local coordinate.
  return {
    x: box.left + (view?.scrollX ?? 0),
    y: box.top + (view?.scrollY ?? 0),
    width: box.width,
    height: box.height,
  }
}

/** Compose a frame-local rect with its frame's board position. */
export function toBoardRect(frameRect: BoardRect, local: BoardRect): BoardRect {
  return { x: frameRect.x + local.x, y: frameRect.y + local.y, width: local.width, height: local.height }
}

/**
 * Frame-local rects for `nodeIds`, remeasured whenever one of their pages
 * reflows.
 *
 * The initial measurement is the `ResizeObserver`'s own first callback —
 * observing an element fires immediately — so there is no separate
 * measure-on-mount effect writing state synchronously during an effect body.
 */
export function useNodeFrameRects(nodeIds: readonly string[]): ReadonlyMap<string, BoardRect> {
  const [rects, setRects] = useState<ReadonlyMap<string, BoardRect>>(EMPTY_RECTS)
  // Join on a stable primitive: `nodeIds` is a fresh array on every render, so
  // depending on it directly would tear down and rebuild the observer forever.
  const key = nodeIds.join('|')

  useEffect(() => {
    const ids = key.length > 0 ? key.split('|') : []
    // Nothing to watch: leave the last map in place rather than clearing it.
    // Every read is `get(id)` for an id the caller wants RIGHT NOW, so a stale
    // entry is unreachable, and clearing here would mean writing state
    // synchronously inside an effect body for no observable difference.
    if (ids.length === 0) return
    if (typeof ResizeObserver === 'undefined') return

    const measure = () => {
      const next = new Map<string, BoardRect>()
      for (const id of ids) {
        const rect = measureNodeFrameRect(id)
        if (rect) next.set(id, rect)
      }
      setRects((previous) => (sameRects(previous, next) ? previous : next))
    }

    const observer = new ResizeObserver(measure)
    const seen = new Set<Document>()
    for (const id of ids) {
      const doc = findRenderedCanvasNodes(id)[0]?.element.ownerDocument
      if (!doc || seen.has(doc)) continue
      seen.add(doc)
      observer.observe(doc.documentElement)
    }

    // A node whose page is not mounted yet has no document to observe, so
    // nothing above would ever fire for it. One deferred pass covers the
    // frames that mounted in the same commit.
    const timer = setTimeout(measure, 0)

    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [key])

  return rects
}

const EMPTY_RECTS: ReadonlyMap<string, BoardRect> = new Map()


function sameRect(a: BoardRect, b: BoardRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** Value equality, so a remeasure that found nothing new re-renders nothing. */
function sameRects(a: ReadonlyMap<string, BoardRect>, b: ReadonlyMap<string, BoardRect>): boolean {
  if (a.size !== b.size) return false
  for (const [id, rect] of a) {
    const other = b.get(id)
    if (!other || !sameRect(rect, other)) return false
  }
  return true
}
