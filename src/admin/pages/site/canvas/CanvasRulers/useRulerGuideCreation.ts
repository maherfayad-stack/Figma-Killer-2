import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { CanvasTransform } from '@site/hooks/useCanvas'
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

    const onMove = (e: PointerEvent) => writePreview(e.clientX, e.clientY)
    const onUp = (e: PointerEvent) => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onCancel)
      setPreviewVisible(false)

      const rect = root.getBoundingClientRect()
      const t = transformRef.current
      const screenPos = axis === 'x' ? e.clientX - rect.left : e.clientY - rect.top
      const pan = axis === 'x' ? t.panX : t.panY
      const boardPos = screenToBoard(screenPos, t.zoom, pan)
      onCreate(axis, Math.round(boardPos))
    }
    const onCancel = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onCancel)
      setPreviewVisible(false)
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp, { once: true })
    document.addEventListener('pointercancel', onCancel, { once: true })
  }

  return { previewElRef, onPointerDown: onCreate ? onPointerDown : undefined }
}
