import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { guardDragSession } from '@core/studio-runtime'
import type { CanvasTransform } from '@site/hooks/useCanvas'
import { clearCanvasPointerRelay, markCanvasPointerRelay } from '../canvasPointerRelay'
import { screenToBoard } from './rulerGeometry'

interface UseRulerGuideCreationParams {
  axis: 'x' | 'y'
  /** `.canvas` itself — the coordinate origin every ruler/guide measurement is relative to. */
  canvasRootRef: RefObject<HTMLElement | null>
  transformRef: RefObject<CanvasTransform>
  /** `null` = no active board = guides unsupported here (see `BoardGuide`'s doc). */
  onCreate: ((axis: 'x' | 'y', boardPosition: number) => void) | null
}

/**
 * Drag-from-ruler guide creation (Figma convention): pointerdown on a ruler
 * starts a drag; a thin preview line follows the pointer 1:1 in screen space
 * (no board-space math needed mid-drag — see `.creationPreview`'s CSS doc);
 * on release, the pointer's board-space position (via `screenToBoard`) is
 * committed as a new guide.
 *
 * FULLY IMPERATIVE — no React state at all for the drag, not even a
 * `dragging` boolean. `CanvasRulers` mounts the preview line
 * UNCONDITIONALLY (hidden by default, `display: none` in
 * `CanvasRulers.module.css`), and this hook's pointer handlers toggle its
 * visibility and position directly on the DOM node through `previewElRef` —
 * the same ref-write idiom `useCanvas`'s own gesture handling uses for its
 * transform writes.
 *
 * An earlier version tracked `dragging` as `useState`, read during render to
 * conditionally mount the preview `<div ref={...}>`. `react-hooks/refs`
 * correctly flagged that as a "component may not update as expected" hazard:
 * the ref-bearing element's presence in the tree depended on state that this
 * hook flips from a native `pointermove`/`pointerup` listener outside
 * React's own render/commit timing, not on anything React scheduled itself.
 * Removing the state entirely (rather than converting it to a plain
 * render-driving flag) fixes the hazard AND is the better perf fit — no
 * re-render on drag start/end either, matching the "never `setState` per
 * pointermove" rule this hook already followed for the position writes.
 *
 * ERR-12 — a guide is dragged OUT of the ruler onto the board, which is
 * mostly iframes: without pointer capture and the cross-iframe relay the
 * release lands in a frame's document and the preview line never goes away.
 * Both are held for the drag, and `guardDragSession` creates the guide at the
 * last point on a move with the button up and drops it on a window blur.
 */
export function useRulerGuideCreation({
  axis,
  canvasRootRef,
  transformRef,
  onCreate,
}: UseRulerGuideCreationParams) {
  const previewElRef = useRef<HTMLDivElement | null>(null)

  const setPreviewVisible = (visible: boolean) => {
    const preview = previewElRef.current
    if (preview) preview.style.display = visible ? 'block' : 'none'
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!onCreate) return
    const root = canvasRootRef.current
    if (!root) return
    event.preventDefault()
    setPreviewVisible(true)
    const ruler = event.currentTarget
    const pointerId = event.pointerId
    let last = { clientX: event.clientX, clientY: event.clientY }

    const writePreview = (clientX: number, clientY: number) => {
      const preview = previewElRef.current
      const rect = root.getBoundingClientRect()
      if (!preview) return
      if (axis === 'x') {
        preview.style.transform = `translateX(${clientX - rect.left}px)`
      } else {
        preview.style.transform = `translateY(${clientY - rect.top}px)`
      }
    }

    writePreview(event.clientX, event.clientY)

    const onMove = (e: PointerEvent) => {
      last = { clientX: e.clientX, clientY: e.clientY }
      writePreview(e.clientX, e.clientY)
    }
    const end = () => {
      disposeGuard()
      clearCanvasPointerRelay()
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onCancel)
      try {
        ruler.releasePointerCapture(pointerId)
      } catch (_err) {
        // Released with the pointer already — nothing to undo.
      }
      setPreviewVisible(false)
    }
    const create = () => {
      end()
      const rect = root.getBoundingClientRect()
      const t = transformRef.current
      const screenPos = axis === 'x' ? last.clientX - rect.left : last.clientY - rect.top
      const pan = axis === 'x' ? t.panX : t.panY
      onCreate(axis, Math.round(screenToBoard(screenPos, t.zoom, pan)))
    }
    const onUp = (e: PointerEvent) => {
      last = { clientX: e.clientX, clientY: e.clientY }
      create()
    }
    const onCancel = () => end()

    try {
      ruler.setPointerCapture(pointerId)
    } catch (_err) {
      // Refused in some test environments — the relay below still carries the drag.
    }
    markCanvasPointerRelay(pointerId)
    const disposeGuard = guardDragSession({
      documents: [document],
      focusWindow: window,
      onReleaseLost: create,
      onAbandon: onCancel,
    })
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onCancel)
  }

  return { previewElRef, onPointerDown: onCreate ? onPointerDown : undefined }
}
