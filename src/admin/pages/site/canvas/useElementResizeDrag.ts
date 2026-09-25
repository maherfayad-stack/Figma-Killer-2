/**
 * useElementResizeDrag — the pointer half of dragging a selected element's
 * edge, wired imperatively onto handles that live INSIDE the frame's iframe.
 *
 * ## Why native listeners rather than React props
 *
 * The handles are portalled into `CanvasSelectionOverlayInjector`'s overlay
 * root, which is in the IFRAME's document. React attaches its listeners at the
 * root container of the tree, and a portal into a second document puts the
 * elements outside the document React is delegating from — so `onPointerDown`
 * on a portalled handle is not something to rely on. Attaching real listeners
 * to the real nodes sidesteps the question entirely, and costs one effect.
 *
 * ## Why there is no zoom division anywhere in here
 *
 * The canvas zoom is a CSS transform on the iframe ELEMENT, applied in the
 * parent document. Pointer events raised inside the iframe's own document are
 * reported in that document's untransformed CSS pixels — the browser
 * un-projects the ancestor transform before the event is dispatched. So a 40px
 * pointer delta read here is 40 CSS px of element, at every zoom level. This
 * is the same property that let the selection rings drop their zoom math
 * (`BreakpointSelectionOverlay`'s docblock); dividing by zoom here would
 * double-correct and make the element run away from the cursor at any zoom
 * other than 1. `setPointerCapture` on the handle keeps the whole gesture in
 * that one document even when the cursor leaves the frame. The ONE zoom-aware
 * number is the snap threshold, which is screen px by design (IX-5a).
 *
 * ## Snapping (P2-E / IX-6e)
 *
 * The edge under the cursor snaps to its siblings' and its parent's edges and
 * centres — `elementResizeSnap.ts` says which edge that is (only one the drag
 * really moves), reads the peers once at pointerdown, and snaps the POINTER
 * delta before `resizeElementBox` sees it. The guides are painted in the
 * frame's parent-document drag layer in the same rAF as the preview.
 *
 * ## What a drag writes
 *
 * The geometry is `elementResizeRules.ts` (shared with the live runtime's
 * handles): the dragged border box is converted to the CSS `width`/`height`
 * the element's `box-sizing` means (IX-6a), ⇧ / ⌥ are read from every move
 * and every modifier key change (IX-6c), and a `position: absolute | fixed`
 * element's W/N handles also move its offset so the opposite edge stays put
 * (IX-6d) — the offsets the source ANCHORS it by, so a `right`-anchored layer
 * keeps `right` and never gains a `left` (IX-21, `elementResizeAnchoring.ts`).
 * Every axis the drag writes also carries the inspector's Fixed
 * switch (`elementResizeSizing.ts`), so a flex item's `flex: 1` cannot swallow
 * the width (IX-6b).
 *
 * ## Preview, then commit
 *
 * During the drag that whole patch is written straight onto the element's own
 * `style` — no store round trip, so it tracks the pointer at frame rate and
 * the selection ring (which re-measures every tick) follows for free. On drop
 * the real edit goes through ONE `setNodeInlineStyles` call: one undo entry,
 * one source write, `style={{ width: '240px' }}` on that one JSX element.
 *
 * The preview is RESTORED BEFORE the store commit, so React's re-render is
 * what finally sets the styles and the DOM never disagrees with what React
 * thinks it wrote. When the commit is refused (a locked node, a write the
 * codemod will not make) nothing re-renders and the element is left at what
 * the document actually says — the honest outcome, and better than a canvas
 * showing a size that was never written.
 *
 * ## Double-click: Hug (P5-F, IX-6f)
 *
 * A double-click on a handle sets Hug contents on the axes it owns
 * (`hugPatchForHandle`) — one `setNodeInlineStyles`, one undo entry. The two
 * presses before it are zero-distance drags that commit nothing
 * (`resizeInlinePatch` is `null` for a step that moved nothing). It is handled
 * in the same document-capture listener that swallows the handle's clicks,
 * because that listener stops the event before any handle-level one would
 * hear it.
 *
 * Escape and a window blur cancel: the preview is restored and nothing is
 * committed. A move that arrives with the button already up (the release
 * happened somewhere this document never heard) finishes the drag at the last
 * point it showed — `guardDragSession`, ERR-12.
 */
import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoardGuides } from '@site/store/slices/boardSelectors'
import { startResizeHandleDrag } from './resizeHandleDragSession'
import { presentedElementForNode } from './canvasNodeLookup'
import { findNodeById } from './InPlaceInspector/findNodeById'
import {
  MIN_ELEMENT_SIZE,
  readResizeBoxStart,
  RESIZE_HANDLE_ATTR,
  RESIZE_SIZE_BADGE_ATTR,
  resizeElementBox,
  resizeStartStep,
  writeSizeBadge,
  type ResizeHandle,
} from '@core/studio-runtime'
import {
  createInlineStylePreview,
  hugPatchForHandle,
  planResizeSizing,
  readSizingParentLayout,
  resizeInlinePatch,
} from './elementResizeSizing'
import { sizingUnavailableReason } from '@site/panels/PropertiesPanel/elementSizing'
import { pushToast } from '@ui/components/Toast'
import { anchorResizePatch } from './elementResizeAnchoring'
import { authoredOffsets, planNudge, type NudgePlan } from './canvasNodeArrowMove'
import { nodeVisualRect } from './canvasDomGeometry'
import type { SnapGuide } from './boardSnapping'
import {
  iframeZoom,
  paintResizeGuides,
  readResizeSnapInput,
  resizeGuideLines,
  resizeSnapEdges,
  resolveResizeGuideSurface,
  snapResizeDelta,
} from './elementResizeSnap'

/** A node with no `style={{…}}` of its own — stable, so no fallback object is built per press. */
const NO_INLINE_STYLES: Readonly<Record<string, unknown>> = {}

interface ElementResizeDragOptions {
  /** The handle container portalled into the iframe overlay root, or `null`. */
  frame: HTMLElement | null
  /** The iframe document the selected element lives in. */
  iframeDoc: Document | null
  /** The single selected node, or `null` when resize is not offered. */
  nodeId: string | null
}

export function useElementResizeDrag({ frame, iframeDoc, nodeId }: ElementResizeDragOptions): void {
  useEffect(() => {
    const view = iframeDoc?.defaultView
    if (!frame || !iframeDoc || !view || !nodeId) return

    const cleanups: Array<() => void> = []
    // The drag in flight, if any — cancelled when the handles are torn down
    // under it, so a gesture can never outlive its element and leave
    // `canvasGesture` frozen.
    let cancelActive: (() => void) | null = null

    // A press on a handle ends in a `click` (and two in a `dblclick`) ON the
    // handle — and the overlay root sits inside the page's body, so that click
    // bubbled into the body node's click-to-select: every resize ended with
    // the PAGE selected instead of the element just sized (measured in
    // `element-resize.e2e.ts`). Captured at the document, which runs before
    // any node's own capture handler, and only for targets inside the handle
    // frame — a click anywhere else is untouched.
    const swallowHandleClick = (event: MouseEvent) => {
      if (!frame.contains(event.target as Node | null)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.type === 'dblclick') hugFromHandle(event.target)
    }

    // IX-6f — Hug on the double-clicked handle's axes. Resolved per gesture
    // like a drag: the element on screen now, its parent's layout now.
    const hugFromHandle = (target: EventTarget | null) => {
      const handleEl = target instanceof Element ? target.closest(`[${RESIZE_HANDLE_ATTR}]`) : null
      const handle = handleEl?.getAttribute(RESIZE_HANDLE_ATTR) as ResizeHandle | null | undefined
      const element = handle ? presentedElementForNode(iframeDoc, nodeId) : null
      if (!handle || !element) return
      const state = useEditorStore.getState()
      const stored = findNodeById(state, nodeId)?.inlineStyles ?? NO_INLINE_STYLES
      const patch = hugPatchForHandle(handle, readSizingParentLayout(view, element), stored)
      if (!patch) {
        pushToast({
          kind: 'info',
          title: 'Hug is not available here',
          body: sizingUnavailableReason(null),
        })
        return
      }
      state.setNodeInlineStyles(
        nodeId,
        Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value ?? null])),
      )
    }
    iframeDoc.addEventListener('click', swallowHandleClick, true)
    iframeDoc.addEventListener('dblclick', swallowHandleClick, true)
    cleanups.push(() => {
      iframeDoc.removeEventListener('click', swallowHandleClick, true)
      iframeDoc.removeEventListener('dblclick', swallowHandleClick, true)
    })

    for (const handleEl of frame.querySelectorAll<HTMLElement>(`[${RESIZE_HANDLE_ATTR}]`)) {
      const handle = handleEl.getAttribute(RESIZE_HANDLE_ATTR) as ResizeHandle | null
      if (!handle) continue

      const onPointerDown = (event: PointerEvent) => {
        // Left button only, and never let this reach the canvas's own
        // selection/pan handling — a drag on a handle is not a click on the
        // element underneath it.
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()

        // The same resolver `CanvasResizeHandles` gates on, so the thing being
        // dragged and the thing the handles were drawn for cannot disagree —
        // which matters most for an `alm.*` node, where the node id sits on a
        // `display: contents` host and the box is one level down. Resolved per
        // press, not per effect: a write re-renders the page, and an element
        // captured before it may no longer be the one on screen.
        const target = presentedElementForNode(iframeDoc, nodeId)
        if (!target) return
        const start = readResizeBoxStart(view, target)
        const state = useEditorStore.getState()
        // `K4` — the scale tool (`K`) locks the ratio as if ⇧ were held. Read
        // once, here: the tool is latched for the gesture, ⇧ and ⌥ are live.
        const scaleTool = state.canvasTool === 'scale'
        const node = findNodeById(state, nodeId)
        const stored = node?.inlineStyles ?? NO_INLINE_STYLES
        const plan = planResizeSizing(view, target, start, stored)
        // IX-21 — which offsets a positioned layer is anchored by, read once.
        const anchors: NudgePlan | null = start.offsets && node
          ? planNudge(view.getComputedStyle(target), authoredOffsets(node, state.site?.styleRules))
          : null
        const patchAt = (step: typeof last) => anchorResizePatch(resizeInlinePatch(start, step, plan), start, step, anchors)
        const preview = createInlineStylePreview(target)
        let last = resizeStartStep(start)

        // IX-6e — what the moving edge snaps to, and where its guides paint.
        // Both read once, here, before the first write of the drag.
        const iframe = view.frameElement
        const guideSurface = resolveResizeGuideSurface(iframe)
        const parentNode = node?.parentId ? findNodeById(state, node.parentId) : null
        const snapInput = readResizeSnapInput({
          view,
          element: target,
          siblingIds: (parentNode?.children ?? []).filter((id) => id !== nodeId),
          parentId: parentNode?.id ?? null,
          resolveElement: (id) => presentedElementForNode(iframeDoc, id),
          resolveRect: (element) => {
            const rect = nodeVisualRect(element)
            return rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null
          },
          zoom: guideSurface?.zoom ?? iframeZoom(iframe),
          // P5-F - the ruler guides (IX-5c) and the snap toggles (IX-5e).
          guideLines: resizeGuideLines(iframe, selectActiveBoardGuides(state)),
          preferences: state.snapPreferences,
        })
        let guides: SnapGuide[] = []

        // IX-18 — the W×H badge under the element. The overlay's measure pass
        // keeps its text current from the ring's own rect while the frame
        // carries the resize-active attribute; seed it here so the first
        // painted frame of the drag already reads right.
        const badge = frame.querySelector<HTMLElement>(`[${RESIZE_SIZE_BADGE_ATTR}]`)
        if (badge) writeSizeBadge(badge, start.width + start.insetWidth, start.height + start.insetHeight)

        cancelActive = startResizeHandleDrag({
          event,
          handleEl,
          frame,
          iframeDoc,
          scaleTool,
          callbacks: {
            step: (dx, dy, modifiers) => {
              const snapped = snapInput
                ? snapResizeDelta(
                    resizeSnapEdges(handle, modifiers, start.offsets !== null, snapInput.anchored),
                    snapInput.rect,
                    dx,
                    dy,
                    snapInput.peers,
                    snapInput.threshold,
                    snapInput.lines,
                  )
                : { dx, dy, guides: [] }
              guides = snapped.guides
              last = resizeElementBox(handle, start, snapped.dx, snapped.dy, modifiers, MIN_ELEMENT_SIZE)
            },
            paint: () => {
              preview.apply(patchAt(last) ?? {})
              paintResizeGuides(guideSurface, guides)
            },
            end: (commit) => {
              cancelActive = null
              paintResizeGuides(guideSurface, [])
              // Restore the preview BEFORE the commit, never after. The
              // preview and the committed value are the SAME DOM properties,
              // so restoring afterwards deletes exactly what React just wrote
              // — and React will not write it again, because from its point
              // of view the style prop did not change.
              preview.clear()
              const patch = commit ? patchAt(last) : null
              if (patch) {
                useEditorStore.getState().setNodeInlineStyles(
                  nodeId,
                  Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value ?? null])),
                )
              }
            },
          },
        })
      }

      handleEl.addEventListener('pointerdown', onPointerDown)
      cleanups.push(() => handleEl.removeEventListener('pointerdown', onPointerDown))
    }

    return () => {
      cancelActive?.()
      for (const cleanup of cleanups) cleanup()
    }
  }, [frame, iframeDoc, nodeId])
}
