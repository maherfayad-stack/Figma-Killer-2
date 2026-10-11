/**
 * useBridgeFrameMarquee — the in-frame marquee (`useInFrameMarquee`) for a
 * Tier 2 BRIDGE frame.
 *
 * A portal frame's marquee is a capture listener on the frame's own document
 * that paints into the frame's overlay root. A live frame is cross-origin: the
 * parent hears the press, the moves and the release as runtime `pointer`
 * messages (`useBridgeBodyDragTrigger` reads the same ones), asks the runtime
 * for every node's box once the sweep starts (`measureDropCandidates` — the
 * drop snapshot's own measurement), and paints the rectangle in the PARENT
 * document over the iframe, where nothing is cross-origin.
 *
 * What the rectangle selects is the portal marquee's rule
 * (`inFrameMarquee.ts`), unchanged: the same press rule (`isFrameBackgroundHit`
 * — the page body or the screen element, never a layer), the same threshold,
 * ⇧ adds, ⌥ takes the deepest hits, ⌘/Ctrl stays free move, Space / middle /
 * the hand tool is the pan. The press and the sweep happen in the frame's own
 * pixels (the runtime reports `clientX/Y` in them), which are also the space
 * the measured boxes are in, so the rectangle is compared with no zoom
 * arithmetic and converted to parent pixels only to be drawn.
 *
 * A sweep marks the press as a drag (`markCanvasPressDragged`), so the click
 * the release raises does not deselect what it just selected
 * (`useBridgeFrameInteraction`'s `click`).
 */
import { useEffect, useEffectEvent, use } from 'react'
import { getAncestors } from '@core/page-tree'
import { selectCanvasPageFor, useEditorStore } from '@site/store/store'
import { CanvasFrameAdapterContext } from './CanvasContexts'
import { isPortalFrameAdapter } from './frameAdapter/PortalFrameAdapter'
import { markCanvasPressDragged } from './canvasNodeGestureLatch'
import { isCanvasSpacePanActive, shouldStartCanvasPointerPan } from './canvasPanInput'
import { canvasPressContext, frameContentRootId, isFrameBackgroundHit } from './canvasPressTarget'
import { iframeLocalPointToParentClientPoint } from './iframeEventCoordinates'
import { collectMarqueeCandidates, marqueeBetween, marqueeHits, type MarqueeCandidate, type MarqueeRect } from './inFrameMarquee'
import styles from './useBridgeFrameMarquee.module.css'

/** Frame px the pointer travels before a background press becomes a marquee rather than a click. */
const MARQUEE_THRESHOLD_PX = 4

interface BridgeFrameMarqueeOptions {
  enabled: boolean
  iframeElement: HTMLIFrameElement | null
  /** The page this frame renders — the tree the press and the sweep are resolved against. */
  pageId: string | null
  frameId: string | null
}

interface Sweep {
  pointerId: number
  start: { x: number; y: number }
  base: string[]
  /** `undefined` before the threshold; `null` while the measurement is in flight. */
  candidates: MarqueeCandidate[] | null | undefined
  box: HTMLDivElement | null
  lastKey: string
}

function parentPoint(iframe: HTMLIFrameElement, point: { x: number; y: number }): { x: number; y: number } {
  return iframeLocalPointToParentClientPoint(
    iframe.getBoundingClientRect(),
    { width: iframe.clientWidth, height: iframe.clientHeight },
    point,
  )
}

function paintBox(box: HTMLDivElement, iframe: HTMLIFrameElement, rect: MarqueeRect): void {
  const from = parentPoint(iframe, { x: rect.x, y: rect.y })
  const to = parentPoint(iframe, { x: rect.x + rect.width, y: rect.y + rect.height })
  box.style.setProperty('--marquee-x', `${from.x}px`)
  box.style.setProperty('--marquee-y', `${from.y}px`)
  box.style.setProperty('--marquee-w', `${to.x - from.x}px`)
  box.style.setProperty('--marquee-h', `${to.y - from.y}px`)
}

export function useBridgeFrameMarquee({ enabled, iframeElement, pageId, frameId }: BridgeFrameMarqueeOptions): void {
  // A portal frame's marquee is `useInFrameMarquee`'s; only a BRIDGE adapter arms this one.
  const frameAdapter = use(CanvasFrameAdapterContext)
  const adapter = frameAdapter && !isPortalFrameAdapter(frameAdapter) ? frameAdapter : null
  // Read at gesture time (the frame's current tree), not re-subscribed per render.
  const currentPage = useEffectEvent(() => selectCanvasPageFor(useEditorStore.getState(), pageId, frameId))

  useEffect(() => {
    if (!enabled || !adapter || !iframeElement) return
    const iframe = iframeElement
    let sweep: Sweep | null = null

    const finish = () => {
      sweep?.box?.remove()
      sweep = null
    }

    const select = (current: Sweep, point: { x: number; y: number }, deepest: boolean) => {
      const page = currentPage()
      if (!page || !current.candidates || !current.box) return
      const rect = marqueeBetween(current.start, point)
      paintBox(current.box, iframe, rect)
      const hits = marqueeHits(current.candidates, rect, {
        deepest,
        isDescendant: (id, ancestorId) => getAncestors(page, id).some((ancestor) => ancestor.id === ancestorId),
      })
      const next = [...new Set([...current.base, ...hits])]
      const key = next.join('|')
      if (key === current.lastKey) return
      current.lastKey = key
      const store = useEditorStore.getState()
      if (next.length === 0) store.clearSelection()
      else store.selectMany(next, { frameId })
    }

    const stop = adapter.on('pointer', (event) => {
      if (event.phase === 'down') {
        finish()
        if (event.button !== 0 || !event.nodeId) return
        if (event.modifiers.metaKey || event.modifiers.ctrlKey) return // ⌘-drag is free move
        if (shouldStartCanvasPointerPan(event, { spaceHeld: isCanvasSpacePanActive(document) })) return
        const state = useEditorStore.getState()
        if (state.activeInlineEdit || state.canvasTool !== 'move') return
        const page = currentPage()
        if (!page || !isFrameBackgroundHit(page, event.nodeId, canvasPressContext(state, frameId))) return
        sweep = {
          pointerId: event.pointerId,
          start: { x: event.clientX, y: event.clientY },
          base: event.modifiers.shiftKey ? [...state.selectedNodeIds] : [],
          candidates: undefined,
          box: null,
          lastKey: '',
        }
        return
      }
      const current = sweep
      if (!current || event.pointerId !== current.pointerId) return
      if (event.phase === 'up') {
        finish()
        return
      }
      if (event.phase !== 'move') return
      // A move with the button up is a release that was never heard.
      if ((event.buttons & 1) === 0) {
        finish()
        return
      }
      const point = { x: event.clientX, y: event.clientY }
      if (current.candidates === undefined) {
        if (Math.hypot(point.x - current.start.x, point.y - current.start.y) < MARQUEE_THRESHOLD_PX) return
        // The sweep starts: the click that ends it is not a click, and the
        // runtime measures every box once.
        markCanvasPressDragged()
        current.candidates = null
        const box = document.createElement('div')
        box.className = styles.marquee ?? ''
        document.body.appendChild(box)
        current.box = box
        void adapter
          .measureDropCandidates()
          .then((geometry) => {
            if (sweep !== current) return
            const page = currentPage()
            if (!page) return
            const rects = new Map(geometry.map((candidate) => [candidate.nodeId, candidate.rect] as const))
            current.candidates = collectMarqueeCandidates(page, frameContentRootId(page), (id) => rects.get(id) ?? null)
            select(current, point, event.modifiers.altKey)
          })
          .catch((err: unknown) => {
            console.error('[bridge-marquee] could not measure the frame:', err)
            if (sweep === current) finish()
          })
        return
      }
      select(current, point, event.modifiers.altKey)
    })

    return () => {
      stop()
      finish()
    }
  }, [enabled, adapter, iframeElement, frameId])
}
