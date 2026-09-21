/**
 * useCanvasInsertionDrag — drag something onto the canvas and see where it will
 * land before letting go.
 *
 * One gesture, three callers: the notch's element primitives, the module
 * inserter dialog, and the media explorer. Each of those grew its own copy of
 * the same ~60 lines — pointer threshold, window listeners, the canvas pointer
 * relay, drop resolution on every move, click suppression on release — and the
 * copies had already drifted (one cleared the relay on unmount, one did not).
 *
 * The seam is deliberate: this hook owns the GESTURE and the GEOMETRY, the
 * caller owns WHAT gets inserted. That is the only part that genuinely differs
 * — the dialog inserts modules, saved layouts or Visual Components through its
 * own dispatch, the other two insert a single known module — and pulling it in
 * here would have meant a union type that each caller then had to narrow again.
 *
 * ## Why pointer events and not HTML5 drag-and-drop
 *
 * The drop target is inside an `<iframe>`. A native `dragover` never reaches
 * the parent document from a cross-document child, and the drag image cannot be
 * drawn outside the source document either. Pointer events with
 * `markCanvasPointerRelay` (which tells the iframe layer to forward the
 * pointer stream back up) are what make a drop INTO a frame observable at all.
 *
 * The preview rect and its label come from `resolveCanvasPointerInsertionDrop`,
 * which is also what a click-to-insert resolves through — so "where the ghost
 * says it will land" and "where it lands" are the same computation, not two
 * that agree by luck.
 *
 * ## `speed-06` — candidates are a per-drag snapshot, resolution is rAF-throttled
 *
 * Before this, EVERY raw `pointermove` re-ran `resolveCanvasPointerInsertionDrop`,
 * which re-scanned the frame's whole DOM (`querySelectorAll` + one
 * `getBoundingClientRect`/`getComputedStyle` per node) — and did nothing at
 * all for a Tier 2 bridge frame (`resolvePortalDocument` is `null` there, so
 * the scan silently found zero candidates and every live-frame drop fell
 * back to "page root"). `beginInsertionDragSnapshotSession`
 * (`canvasInsertionDragSnapshot.ts`) now measures each frame's candidates
 * ONCE, lazily, the first time the drag visits it (bridge-aware — it goes
 * through `FrameDocumentAdapter.measureDropCandidates()`), and resolution
 * itself runs at most once per animation frame, with the LAST pointer
 * position of whatever moves arrived since the previous frame.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { InsertLocation } from '@site/store/insertLocation'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { resolveCanvasPointerInsertionDrop, type CanvasDropPreview } from './canvasInsertionDrop'
import { beginInsertionDragSnapshotSession } from './canvasInsertionDragSnapshot'
import { clearCanvasPointerRelay, markCanvasPointerRelay } from './canvasPointerRelay'

/** Pointer travel (screen px) before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD_PX = 6

export interface CanvasInsertionDragState<TGhost> {
  /** Whatever the caller needs to draw its own cursor ghost. */
  ghost: TGhost
  x: number
  y: number
  /** Null while the pointer is outside every frame — the caller renders no preview. */
  preview: CanvasDropPreview | null
}

interface UseCanvasInsertionDragOptions<TGhost> {
  /**
   * Insert at the resolved location. Return true when something actually
   * landed — that is what promotes the dropped-on frame to the active
   * breakpoint, so a drop into a frame you were not editing switches to it.
   */
  onDrop: (ghost: TGhost, location: InsertLocation) => boolean
  /**
   * Called when the gesture crosses the threshold, and again when it ends.
   * For chrome that has to get out of the way of its own drop target (the
   * inserter dialog dims its backdrop).
   */
  onDraggingChange?: (dragging: boolean) => void
}

export function useCanvasInsertionDrag<TGhost>({
  onDrop,
  onDraggingChange,
}: UseCanvasInsertionDragOptions<TGhost>) {
  const canvasPage = useEditorStore(selectActiveCanvasPage)
  const setActiveBreakpoint = useEditorStore((s) => s.setActiveBreakpoint)
  const [drag, setDrag] = useState<CanvasInsertionDragState<TGhost> | null>(null)
  // A drag ends on the same pointerup that would otherwise fire a click on the
  // button it started from — which would insert a SECOND copy, at the default
  // location. Suppressed for one tick.
  const suppressClickRef = useRef(false)
  const teardownRef = useRef<(() => void) | null>(null)

  // Unmounting mid-drag (a panel closing under the pointer) must not leave the
  // window listeners or the iframe pointer relay armed.
  useEffect(() => {
    return () => {
      teardownRef.current?.()
      teardownRef.current = null
      clearCanvasPointerRelay()
    }
  }, [])

  const startDrag = (event: ReactPointerEvent<HTMLElement>, ghost: TGhost, label: string) => {
    if (event.button !== 0) return

    const startX = event.clientX
    const startY = event.clientY
    let started = false
    const snapshot = beginInsertionDragSnapshotSession()

    const resolveDrop = (clientX: number, clientY: number) =>
      canvasPage
        ? resolveCanvasPointerInsertionDrop({
            canvasPage,
            clientX,
            clientY,
            label,
            candidatesForViewport: (viewport, iframe) => snapshot.candidatesFor(viewport, iframe, canvasPage),
          })
        : null

    // `speed-06` — at most one resolve per animation frame, with the LAST
    // pointer position of whatever moves arrived since the previous one (100
    // native moves inside a single frame resolve exactly once).
    let pendingPoint: { x: number; y: number } | null = null
    let pendingFrame: number | null = null

    const applyPendingResolve = () => {
      pendingFrame = null
      const point = pendingPoint
      pendingPoint = null
      if (!point) return
      const resolved = resolveDrop(point.x, point.y)
      setDrag({ ghost, x: point.x, y: point.y, preview: resolved?.preview ?? null })
    }

    const scheduleResolve = (clientX: number, clientY: number) => {
      pendingPoint = { x: clientX, y: clientY }
      pendingFrame ??= window.requestAnimationFrame(applyPendingResolve)
    }

    const teardown = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      clearCanvasPointerRelay()
      teardownRef.current = null
      if (pendingFrame !== null) {
        window.cancelAnimationFrame(pendingFrame)
        pendingFrame = null
      }
      snapshot.dispose()
      if (started) onDraggingChange?.(false)
    }

    const move = (moveEvent: PointerEvent) => {
      if (!started) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_THRESHOLD_PX) return
        started = true
        onDraggingChange?.(true)
      }
      scheduleResolve(moveEvent.clientX, moveEvent.clientY)
    }

    const up = (upEvent: PointerEvent) => {
      // Resolve BEFORE teardown, synchronously — never wait another
      // animation frame for a release that ends the gesture anyway. The
      // relay also has to still be armed for the drop point to hit-test
      // against a frame's iframe. A bridge frame the drag never actually
      // paused over (a fast flick-and-release) may still have its
      // candidates in flight at this point; `snapshot.candidatesFor` then
      // answers `[]` and the drop falls back to "page root" — the same
      // honest answer a pointer outside every frame gets, not a hang.
      const resolved = started ? resolveDrop(upEvent.clientX, upEvent.clientY) : null
      teardown()
      setDrag(null)
      if (!started) return

      suppressClickRef.current = true
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 0)

      if (!resolved) return
      if (onDrop(ghost, resolved.location)) setActiveBreakpoint(resolved.breakpointId)
    }

    const cancel = () => {
      teardown()
      setDrag(null)
    }

    teardownRef.current?.()
    markCanvasPointerRelay(event.pointerId)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    teardownRef.current = teardown
  }

  return {
    drag,
    startDrag,
    /** True for the click that ends a drag — the caller's `onClick` must bail. */
    shouldSuppressClick: () => suppressClickRef.current,
  }
}
