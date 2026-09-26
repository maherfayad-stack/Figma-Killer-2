/**
 * useInFrameMarquee — a marquee INSIDE a frame (P5-E, IX-16, OD-6).
 *
 * The board already has a marquee for frames and notes
 * (`BoardFramesLayer/useMarqueeSelection.ts`); inside a frame a drag was
 * always a move, so a row of layers could only be gathered by ⇧-clicking each.
 * The trigger is OD-6's: a press on the frame's ROOT layer itself — the page
 * background, where no child is under the pointer — that travels past the
 * threshold. A press that does not travel is still an ordinary click (it
 * selects the page), and ⌘-drag stays free move. Which layers the rectangle
 * selects is `inFrameMarquee.ts`'s rule.
 *
 * Like `useCanvasBodyDragTrigger`, this is a native capture-phase listener on
 * the frame's own document: pointer events raised there are already in the
 * frame's untransformed CSS px, which is the space the layer rects and the
 * in-frame overlay root share, so there is no zoom arithmetic anywhere. The
 * rectangle is painted into that overlay root (editor chrome, never a box in
 * the page). Portal (design) frames only — the overlay root is the gate, as
 * it is for the body drag.
 *
 * Reads happen once, when the marquee starts (every descendant's rect); each
 * move after that is arithmetic plus, at most once per animation frame, a
 * selection write when the hit set changed.
 */
import { useEffect } from 'react'
import { getAncestors, type NodeTree, type PageNode } from '@core/page-tree'
import { guardDragSession } from '@core/studio-runtime'
import { useEditorStore } from '@site/store/store'
import { resolveSelectableNode } from '@site/store/slices/selectionResolve'
import { isCanvasSpacePanActive, shouldStartCanvasPointerPan } from './canvasPanInput'
import { CANVAS_NODE_SELECTOR, isElementLike } from './canvasEventTargets'
import { presentedElementForNode } from './canvasNodeLookup'
import { nodeVisualRect } from './canvasDomGeometry'
import { marqueeBetween, marqueeHits, type MarqueeCandidate, type MarqueeRect } from './inFrameMarquee'

/** Frame px the pointer travels before a root press becomes a marquee rather than a click. */
const MARQUEE_THRESHOLD_PX = 4

interface InFrameMarqueeOptions {
  enabled: boolean
  /** The in-frame overlay root: the design-frame gate, the frame's current document, and where the rectangle paints. */
  overlayRoot: HTMLElement | null
  frameId: string | null
}

function collectCandidates(doc: Document, tree: NodeTree<PageNode>): MarqueeCandidate[] {
  const candidates: MarqueeCandidate[] = []
  const walk = (nodeId: string, depth: number) => {
    const node = tree.nodes[nodeId]
    if (!node) return
    for (const childId of node.children) {
      const child = tree.nodes[childId]
      if (!child || child.hidden) continue
      const element = presentedElementForNode(doc, childId)
      const rect = element ? nodeVisualRect(element) : null
      if (rect && !child.locked) {
        candidates.push({ nodeId: childId, depth, rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } })
      }
      walk(childId, depth + 1)
    }
  }
  walk(tree.rootNodeId, 1)
  return candidates
}

function paintMarquee(element: HTMLElement, rect: MarqueeRect): void {
  Object.assign(element.style, {
    transform: `translate(${rect.x}px, ${rect.y}px)`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  })
}

export function useInFrameMarquee({ enabled, overlayRoot, frameId }: InFrameMarqueeOptions): void {
  useEffect(() => {
    if (!enabled || !overlayRoot) return
    const doc = overlayRoot.ownerDocument
    let cleanupGesture: (() => void) | null = null
    let swallowClick = false

    const onClickCapture = (event: MouseEvent) => {
      if (!swallowClick) return
      swallowClick = false
      event.preventDefault()
      event.stopPropagation()
    }

    const onPointerDown = (event: PointerEvent) => {
      // A marquee released outside the frame produced no click to swallow;
      // the flag must not eat this new gesture's.
      swallowClick = false
      if (event.button !== 0 || event.defaultPrevented) return
      if (event.metaKey || event.ctrlKey) return // ⌘-drag is free move
      if (shouldStartCanvasPointerPan(event, { spaceHeld: isCanvasSpacePanActive(document) })) return
      const state = useEditorStore.getState()
      if (state.activeInlineEdit || state.canvasTool !== 'move') return
      const target = event.target
      if (!isElementLike(target)) return
      // Editor chrome in the same document (rings, resize and spacing
      // handles) — the page root may be `<body>` itself, which holds them.
      if (target.closest('[data-studio-canvas-overlay-root]')) return
      const nodeId = target.closest(CANVAS_NODE_SELECTOR)?.getAttribute('data-node-id')
      if (!nodeId) return
      const resolved = resolveSelectableNode(state, nodeId)
      if (!resolved || resolved.tree.rootNodeId !== nodeId) return
      const tree = resolved.tree

      const start = { x: event.clientX, y: event.clientY }
      const additive = event.shiftKey
      const base = additive ? [...state.selectedNodeIds] : []
      let candidates: MarqueeCandidate[] | null = null
      let box: HTMLDivElement | null = null
      let lastKey = ''
      let pending: { x: number; y: number; deepest: boolean } | null = null
      let frame: number | null = null
      const isDescendant = (id: string, ancestorId: string) =>
        getAncestors(tree, id).some((ancestor) => ancestor.id === ancestorId)

      const apply = () => {
        frame = null
        const point = pending
        pending = null
        if (!point || !candidates || !box) return
        const rect = marqueeBetween(start, point)
        paintMarquee(box, rect)
        const hits = marqueeHits(candidates, rect, { deepest: point.deepest, isDescendant })
        const next = [...new Set([...base, ...hits])]
        const key = next.join('|')
        if (key === lastKey) return
        lastKey = key
        const store = useEditorStore.getState()
        if (next.length === 0) store.clearSelection()
        else store.selectMany(next, { frameId })
      }

      const onMove = (moveEvent: PointerEvent) => {
        if (!candidates) {
          if (Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < MARQUEE_THRESHOLD_PX) return
          // The marquee starts: one read of every layer's box, then chrome.
          candidates = collectCandidates(doc, tree)
          box = doc.createElement('div')
          box.setAttribute('data-canvas-in-frame-marquee', 'true')
          Object.assign(box.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            boxSizing: 'border-box',
            pointerEvents: 'none',
            border: '1px solid var(--canvas-selection-ring-color)',
            background: 'color-mix(in srgb, var(--canvas-selection-ring-color) 10%, transparent)',
          })
          overlayRoot.appendChild(box)
        }
        moveEvent.preventDefault()
        pending = { x: moveEvent.clientX, y: moveEvent.clientY, deepest: moveEvent.altKey }
        frame = frame ?? requestAnimationFrame(apply)
      }

      const end = () => {
        const wasMarquee = candidates !== null
        if (frame !== null) cancelAnimationFrame(frame)
        if (pending) apply()
        box?.remove()
        cleanupGesture?.()
        cleanupGesture = null
        // The click this release produces lands on the page root and would
        // select it, wiping the marquee's selection.
        if (wasMarquee) swallowClick = true
      }

      const disposeGuard = guardDragSession({
        documents: [doc],
        focusWindow: window,
        onReleaseLost: end,
        onAbandon: end,
      })
      doc.addEventListener('pointermove', onMove)
      doc.addEventListener('pointerup', end)
      doc.addEventListener('pointercancel', end)
      cleanupGesture = () => {
        disposeGuard()
        doc.removeEventListener('pointermove', onMove)
        doc.removeEventListener('pointerup', end)
        doc.removeEventListener('pointercancel', end)
      }
      // No text selection while sweeping across the page's copy.
      event.preventDefault()
    }

    doc.addEventListener('pointerdown', onPointerDown, true)
    doc.addEventListener('click', onClickCapture, true)
    return () => {
      cleanupGesture?.()
      doc.removeEventListener('pointerdown', onPointerDown, true)
      doc.removeEventListener('click', onClickCapture, true)
    }
  }, [enabled, overlayRoot, frameId])
}
