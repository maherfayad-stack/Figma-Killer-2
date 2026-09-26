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
 *
 * ## `speed-06` follow-up — a board can show more than one page's frames
 *
 * A live Playwright dogfood on real dev-server-backed frames found the drop
 * line always fell back to "page root", never a container, whenever the
 * hovered frame's `<iframe>` shared its `data-breakpoint-id` stamp with the
 * WRAPPER it lives inside (see `canvasInsertionDrop.ts`'s own hardening) —
 * but the deeper, PROVEN cause (a dedicated round-trip test reproduces it)
 * is that resolution ALWAYS filtered candidates against `canvasPage`, the
 * store's single ACTIVE page, even when the hovered frame showed a
 * DIFFERENT page entirely (a board can have many). Every real candidate
 * measured from that other frame's own tree then failed
 * `canvasInsertionDragSnapshot.ts`'s `tree.nodes[id]` check — a different
 * page's node ids never appear in `canvasPage.nodes` — so resolution always
 * fell back to "page root" of the WRONG page. `resolvePageForViewport`
 * below climbs to `data-page-id` on the frame's own outer wrapper
 * (`BoardFrameView.tsx`'s existing stamp — not a second copy on the
 * viewport itself) and resolves ITS tree instead; a successful drop then
 * switches the active document to that page (`openPageInCanvas`) BEFORE
 * committing the insert, since every insert action writes through
 * `mutateActiveTree` — the page a resolved node id happens to belong to is
 * not enough on its own.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { InsertLocation } from '@site/store/insertLocation'
import { lookupCanvasPageById, selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { resolveCanvasPointerInsertionDrop, type CanvasDropPreview } from './canvasInsertionDrop'
import { beginInsertionDragSnapshotSession } from './canvasInsertionDragSnapshot'
import { clearCanvasPointerRelay, markCanvasPointerRelay } from './canvasPointerRelay'
import { guardDragSession } from '@core/studio-runtime'

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

    // The page the drag starts over, read now rather than subscribed: every
    // panel that offers a draggable item (the Assets panel, the notch) would
    // otherwise re-render on every keystroke, which makes a new page object,
    // for a value only a drag reads (P6-C).
    const canvasPage = selectActiveCanvasPage(useEditorStore.getState())
    const startX = event.clientX
    const startY = event.clientY
    let lastPoint = { clientX: startX, clientY: startY }
    let started = false
    const snapshot = beginInsertionDragSnapshotSession()

    // `speed-06` follow-up — the hovered viewport's OWN page, when it
    // differs from `canvasPage`. `data-page-id` is `BoardFrameView.tsx`'s
    // OWN existing stamp (its outer `.frame` wrapper — `viewport.closest`,
    // not a second copy on the viewport itself: `framePoolMountReason.test.tsx`
    // already reads every `[data-page-id]` element back through
    // `readFrameMountReason`, so a second, mount-reason-less element with
    // the same attribute would fail that test's "every frame answers" check).
    // `null` (unknown page id, or none found — a hand-built test fixture, a
    // canvas surface with no board frame wrapper) keeps resolving against
    // `canvasPage`, matching the previous behavior.
    const resolvePageForViewport = (viewport: HTMLElement) => {
      const pageId = viewport.closest<HTMLElement>('[data-page-id]')?.dataset.pageId
      if (!pageId || pageId === canvasPage?.id) return null
      const site = useEditorStore.getState().site
      return site ? lookupCanvasPageById(site, pageId) : null
    }

    const resolveDrop = (clientX: number, clientY: number) =>
      canvasPage
        ? resolveCanvasPointerInsertionDrop({
            canvasPage,
            clientX,
            clientY,
            label,
            candidatesForViewport: (viewport, iframe, tree) => snapshot.candidatesFor(viewport, iframe, tree),
            resolvePageForViewport,
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
      pendingFrame = pendingFrame ?? window.requestAnimationFrame(applyPendingResolve)
    }

    const teardown = () => {
      disposeGuard()
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
      lastPoint = { clientX: moveEvent.clientX, clientY: moveEvent.clientY }
      if (!started) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_THRESHOLD_PX) return
        started = true
        onDraggingChange?.(true)
      }
      scheduleResolve(moveEvent.clientX, moveEvent.clientY)
    }

    const up = (upEvent: Pick<PointerEvent, 'clientX' | 'clientY'>) => {
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
      // `speed-06` follow-up — `resolved.location.parentId` is a node id in
      // `resolved.pageId`'s OWN tree; every insert action writes through
      // `mutateActiveTree`, so the active document has to already BE that
      // page before `onDrop` runs, not after.
      if (resolved.pageId !== canvasPage?.id) {
        useEditorStore.getState().openPageInCanvas(resolved.pageId)
      }
      if (onDrop(ghost, resolved.location)) useEditorStore.getState().setActiveBreakpoint(resolved.breakpointId)
    }

    const cancel = () => {
      teardown()
      setDrag(null)
    }

    teardownRef.current?.()
    markCanvasPointerRelay(event.pointerId)
    // ERR-12 — a move with the button up: the release landed where no relay
    // heard it, so drop at the last point the preview showed. A window blur
    // abandons the insert.
    const disposeGuard = guardDragSession({
      documents: [document],
      focusWindow: window,
      onReleaseLost: () => up(lastPoint),
      onAbandon: cancel,
    })
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
