import type { CSSProperties } from 'react'
import type { Page } from '@core/page-tree'
import { registry } from '@core/module-engine'
import type { InsertLocation } from '@site/store/insertLocation'
import {
  getViewportLocalPoint,
  getViewportZoom,
  measureCanvasDropCandidates,
} from './canvasDomGeometry'
import {
  resolveCanvasInsertionTarget,
  type CanvasDropCandidate,
  type CanvasInsertionTarget,
} from './canvasDnd'

const CANVAS_VIEWPORT_SELECTOR = '[data-breakpoint-id]'

export interface CanvasDropPreview {
  left: number
  top: number
  width: number
  height: number
  position: CanvasInsertionTarget['position'] | 'inside'
  label: string
}

export interface CanvasPointerInsertionDrop {
  location: InsertLocation
  preview: CanvasDropPreview
  breakpointId: string
  /**
   * `speed-06` follow-up — the FILE (page id) `location` was resolved
   * against. Equal to `canvasPage.id` unless `resolvePageForViewport`
   * resolved the hovered frame to a DIFFERENT page than the active one; the
   * caller must switch the active document to this page BEFORE committing
   * the insert (`mutateActiveTree` writes to whatever page is active, not
   * to the page a resolved node id happens to belong to).
   */
  pageId: string
}

interface ResolveCanvasPointerInsertionDropInput {
  canvasPage: Page
  clientX: number
  clientY: number
  label: string
  /**
   * `speed-06` — pre-measured candidates for the viewport the pointer turns
   * out to be over, keyed by that viewport's own DOM element, against the
   * TREE this function resolved for it (`resolvePageForViewport`'s answer,
   * or `canvasPage` when there is none). Supplied by `useCanvasInsertionDrag`'s
   * per-drag snapshot (`canvasInsertionDragSnapshot.ts`) so this function
   * never scans the DOM itself. Omitted callers (the direct unit test, any
   * future one-shot caller) keep the original synchronous
   * `measureCanvasDropCandidates` scan — unchanged behavior for them.
   */
  candidatesForViewport?: (viewport: HTMLElement, iframe: HTMLIFrameElement | null, tree: Page) => CanvasDropCandidate[]
  /**
   * `speed-06` follow-up — a board can show MANY pages' frames at once
   * (`data-page-id` on each frame's own viewport, `BreakpointFrame.tsx`),
   * while `canvasPage` is always the store's single ACTIVE page. Without
   * this, dragging onto a frame that shows a DIFFERENT page always resolved
   * "page root" — every real candidate measured from that frame's own tree
   * got filtered out by `canvasInsertionDragSnapshot.ts`'s `tree.nodes[id]`
   * check, since a different page's node ids never appear in `canvasPage`.
   * Returns `null` (or is omitted) to keep resolving against `canvasPage` —
   * the direct unit test and any one-shot caller with no page-switching
   * story do this.
   */
  resolvePageForViewport?: (viewport: HTMLElement) => Page | null
}

/**
 * `speed-06` hardening — BOTH `IframeFrameSurface`'s outer wrapper AND the
 * `<iframe>` element it renders carry `data-breakpoint-id` (the iframe's own
 * copy exists so a caller holding only the `HTMLIFrameElement` — e.g.
 * `preferredRenderedCanvasNode` — can read the breakpoint without touching
 * `contentDocument`; see `IframeFrameSurface`'s own doc comment). A drag
 * resolver needs the WRAPPER, never the bare iframe: `viewport.querySelector
 * ('iframe')` (`canvasInsertionDrop.ts`'s own iframe lookup) finds nothing
 * inside an `<iframe>` — it has no light-DOM children, cross-origin or not —
 * so if `[data-breakpoint-id]`'s document-order match ever resolved to the
 * iframe itself, every downstream candidate measurement would silently see
 * `iframe === null` and fall back to scanning the WRAPPER'S OWN (empty, for
 * a real frame) light DOM. Document order guarantees the wrapper precedes
 * its own nested iframe, so this exclusion should be a no-op in the common
 * case — it exists so a match can never resolve to the wrong element.
 *
 * `tagName`, not `instanceof HTMLIFrameElement`: a duck-typed check, same
 * realm-safety reasoning `canvasDomGeometry.ts`'s own element checks use —
 * this file's `viewport` can arrive from any document an admin caller
 * resolved it in, and a bare global `HTMLIFrameElement` reference is not
 * guaranteed to be the SAME constructor an element from a different realm
 * was minted against.
 */
function isViewportCandidate(el: Element): boolean {
  return el.tagName !== 'IFRAME'
}

export function findCanvasViewportAtPoint(
  clientX: number,
  clientY: number,
): HTMLElement | null {
  const viewports = document.querySelectorAll<HTMLElement>(CANVAS_VIEWPORT_SELECTOR)
  for (const viewport of viewports) {
    if (!isViewportCandidate(viewport)) continue
    const rect = viewport.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      return viewport
    }
  }
  return null
}

export function resolveCanvasPointerInsertionDrop({
  canvasPage,
  clientX,
  clientY,
  label,
  candidatesForViewport,
  resolvePageForViewport,
}: ResolveCanvasPointerInsertionDropInput): CanvasPointerInsertionDrop | null {
  const viewport = findCanvasViewportAtPoint(clientX, clientY)
  if (!viewport) return null
  const breakpointId = viewport.dataset.breakpointId
  if (!breakpointId) return null

  const viewportRect = viewport.getBoundingClientRect()
  if (
    clientX < viewportRect.left ||
    clientX > viewportRect.right ||
    clientY < viewportRect.top ||
    clientY > viewportRect.bottom
  ) {
    return null
  }

  // The tree THIS viewport actually renders — `canvasPage` (the store's
  // single active page) whenever the caller has no better answer, or the
  // hovered frame's OWN page. See `resolvePageForViewport`'s own doc.
  const tree = resolvePageForViewport?.(viewport) ?? canvasPage

  // `findCanvasViewportAtPoint` already excludes a bare `<iframe>` from
  // matching as `viewport` — this covers a caller that resolved `viewport`
  // some OTHER way (a future one-shot caller, a test fixture): an iframe has
  // no light-DOM children to find its own tag inside of.
  const iframe = viewport.tagName === 'IFRAME' ? (viewport as unknown as HTMLIFrameElement) : viewport.querySelector<HTMLIFrameElement>('iframe')
  const point = getViewportLocalPoint(viewport, clientX, clientY)
  const candidates = candidatesForViewport
    ? candidatesForViewport(viewport, iframe, tree)
    : measureCanvasDropCandidates(viewport, tree, iframe)
  // See `MIN_EDGE_HIT_ZONE_SCREEN_PX` in `canvasDnd.ts` — the edge bands are
  // screen-space; convert with the live zoom before hit-testing frame-space
  // candidates.
  const zoom = getViewportZoom(viewport)
  const target = resolveCanvasInsertionTarget({
    tree,
    candidates,
    point,
    zoom,
    canHaveChildren: (moduleId) => registry.get(moduleId)?.canHaveChildren === true,
  })

  if (!target) {
    return {
      location: { parentId: tree.rootNodeId, index: undefined },
      preview: fixedPreviewForViewport(viewport, 'inside', `${label} at page root`),
      breakpointId,
      pageId: tree.id,
    }
  }

  return {
    location: { parentId: target.parentId, index: target.index },
    preview: fixedPreviewForTarget(viewport, target, `${label} ${target.position}`),
    breakpointId,
    pageId: tree.id,
  }
}

export function fixedPreviewForTarget(
  viewport: HTMLElement,
  target: CanvasInsertionTarget,
  label: string,
): CanvasDropPreview {
  const viewportRect = viewport.getBoundingClientRect()
  const scale = viewport.offsetWidth > 0 ? viewportRect.width / viewport.offsetWidth : 1
  return {
    left: viewportRect.left + target.rect.left * scale,
    top: viewportRect.top + target.rect.top * scale,
    width: target.rect.width * scale,
    height: target.rect.height * scale,
    position: target.position,
    label,
  }
}

export function fixedPreviewForViewport(
  viewport: HTMLElement,
  position: CanvasDropPreview['position'],
  label: string,
): CanvasDropPreview {
  const viewportRect = viewport.getBoundingClientRect()
  return {
    left: viewportRect.left,
    top: viewportRect.top,
    width: viewportRect.width,
    height: viewportRect.height,
    position,
    label,
  }
}

export function dropPreviewStyle(preview: CanvasDropPreview): CSSProperties {
  return {
    '--drop-left': `${preview.left}px`,
    '--drop-top': `${preview.top}px`,
    '--drop-width': `${preview.width}px`,
    '--drop-height': `${preview.height}px`,
  } as CSSProperties
}
