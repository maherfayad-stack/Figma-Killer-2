/**
 * selectionChromeViewportFollow — the selection toolbar and the in-place
 * inspector follow a pan or zoom WHILE it happens (audit PERF-3).
 *
 * ## The defect
 *
 * The rings live inside the frame document, so a pan moves them for free with
 * the iframe's CSS transform (WS-5.1). The toolbar and the inspector cannot
 * live there — real inputs inside a transformed iframe are a worse problem —
 * so they sit in the parent canvas root, positioned from a measurement the
 * overlay takes once per selection change and once per pan/zoom COMMIT. The
 * commit lands 100 ms after the last gesture event (`useCanvas.ts`), so for
 * the whole gesture the rings moved and the toolbar stayed pinned to its old
 * screen position, then jumped. On the 40-frame corpus the toolbar ended a
 * 12-tick wheel pan 288 px from its ring.
 *
 * ## The fix: a board-space anchor, projected arithmetically
 *
 * When the overlay measures (the expensive, rare pass), it records the rects
 * it placed the chrome from AND the transform they were measured under. On
 * every transform write (`onCanvasViewportTransform`, same task as the write)
 * the rects are re-projected to the new transform:
 *
 *   board  = screenToBoard(measured, measuredTransform)
 *   screen = boardToScreen(board, liveTransform)
 *
 * — the rulers' own `.canvas`-relative formula (`rulerGeometry.ts`, including
 * the transform layer's 80 px offset), because the chrome's coordinates are
 * `.canvas`-relative too. No layout read: the widths used to clamp were read
 * once, when the anchor was recorded. The next real measurement (the commit's
 * settle pass) replaces the anchor, so any drift an in-flight CSS zoom
 * animation introduces lasts at most until then.
 *
 * During a page-mutating gesture (`canvasGesture.ts` — an element resize) the
 * chrome holds still, exactly as the overlay's own tick does; the gesture's
 * settle pass re-measures it.
 */
import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { CanvasTransform } from '@site/hooks/useCanvas'
import { boardToScreen, screenToBoard } from './CanvasRulers/rulerGeometry'
import { isCanvasGestureActive } from './canvasGesture'
import { onCanvasViewportTransform } from './canvasViewportActivity'
import type { CanvasOverlayRect } from './canvasOverlayGeometry'
import { positionInspector, positionToolbar, publishSelectionAnchor } from './canvasSelectionOverlayPositioning'

/** What the overlay's anchor pass placed the chrome from, and under which transform. */
export interface SelectionChromeAnchor {
  /** The toolbar's union rect, `.canvas`-relative, or `null` when the toolbar is hidden. */
  toolbar: CanvasOverlayRect | null
  /** The inspected node's rect, `.canvas`-relative, or `null`. */
  inspector: CanvasOverlayRect | null
  canvasRect: DOMRect | null
  /** The live transform at measurement time — a copy, never the mutable ref. */
  transform: CanvasTransform
  toolbarWidth: number
  inspectorWidth: number
}

/** Re-project a `.canvas`-relative rect measured under `from` to where it sits under `to`. */
export function projectCanvasRect(rect: CanvasOverlayRect, from: CanvasTransform, to: CanvasTransform): CanvasOverlayRect {
  const boardX = screenToBoard(rect.x, from.zoom, from.panX)
  const boardY = screenToBoard(rect.y, from.zoom, from.panY)
  const scale = to.zoom / from.zoom
  return {
    x: boardToScreen(boardX, to.zoom, to.panX),
    y: boardToScreen(boardY, to.zoom, to.panY),
    width: rect.width * scale,
    height: rect.height * scale,
  }
}

interface SelectionChromeViewportFollowParams {
  /** The live transform (`CanvasViewportActionsContext`); `undefined` outside a board viewport, where nothing pans. */
  transformRef: RefObject<CanvasTransform> | undefined
  toolbarRef: RefObject<HTMLDivElement | null>
  inspectorRef: RefObject<HTMLDivElement | null>
}

/** The rects a measured pass placed the chrome from; `null` when it hid the chrome. */
export type PlacedSelectionChrome = Omit<SelectionChromeAnchor, 'transform' | 'toolbarWidth' | 'inspectorWidth'> | null

/**
 * Record the anchor the chrome was just placed from, or `null` when it was
 * hidden (nothing to follow). Called from a measure pass that has already
 * written the positions — so recording never writes.
 */
export type RecordSelectionChromeAnchor = (placed: PlacedSelectionChrome) => void

export function useSelectionChromeViewportFollow({
  transformRef,
  toolbarRef,
  inspectorRef,
}: SelectionChromeViewportFollowParams): RecordSelectionChromeAnchor {
  const anchorRef = useRef<SelectionChromeAnchor | null>(null)

  useEffect(() => {
    if (!transformRef) return
    return onCanvasViewportTransform(() => {
      const anchor = anchorRef.current
      if (!anchor || isCanvasGestureActive()) return
      const live = transformRef.current
      const toolbarRect = anchor.toolbar ? projectCanvasRect(anchor.toolbar, anchor.transform, live) : null
      const inspectorRect = anchor.inspector ? projectCanvasRect(anchor.inspector, anchor.transform, live) : null
      if (anchor.toolbar) {
        positionToolbar(toolbarRef.current, toolbarRect, anchor.canvasRect, anchor.toolbarWidth || undefined)
        publishSelectionAnchor(toolbarRef.current, toolbarRect)
      }
      if (anchor.inspector) {
        positionInspector(inspectorRef.current, inspectorRect, anchor.canvasRect, anchor.inspectorWidth || undefined)
        publishSelectionAnchor(inspectorRef.current, inspectorRect)
      }
    })
  }, [transformRef, toolbarRef, inspectorRef])

  // Exception #1 (CLAUDE.md, React Compiler): `useBridgeSelectionChrome`'s
  // anchor effect lists this in its dependency array, so its identity must be
  // stable or that effect re-runs — a postMessage round trip — every render.
  return useCallback<RecordSelectionChromeAnchor>(
    (placed) => {
      if (!placed || !transformRef || (!placed.toolbar && !placed.inspector)) {
        anchorRef.current = null
        return
      }
      const live = transformRef.current
      anchorRef.current = {
        ...placed,
        transform: { zoom: live.zoom, panX: live.panX, panY: live.panY },
        // Read once, here, on the rare measured pass — never per transform write.
        toolbarWidth: placed.toolbar ? (toolbarRef.current?.offsetWidth ?? 0) : 0,
        inspectorWidth: placed.inspector ? (inspectorRef.current?.offsetWidth ?? 0) : 0,
      }
    },
    [transformRef, toolbarRef, inspectorRef],
  )
}
