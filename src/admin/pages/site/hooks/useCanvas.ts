/**
 * useCanvas — gesture handling hook for the infinite canvas.
 *
 * Performance architecture (Contribution #312):
 * ─────────────────────────────────────────────
 * Pan/zoom state is kept in a REF during active interaction.
 * DOM writes are batched into requestAnimationFrame (one write/frame).
 * Zustand is updated with a 100ms debounce at interaction end.
 * This avoids React re-renders at 60fps during pan/zoom.
 *
 * Input support:
 * - Ctrl/Cmd + wheel → zoom towards cursor
 * - Plain wheel → pan vertically (and horizontally with shift)
 * - Space + left-drag → pan
 * - Pinch (touch) → zoom+pan
 * - +/- keys → zoom in/out (committed immediately)
 * - Ctrl/Cmd+0 → reset to 100% zoom
 * - Shift+1 → zoom to fit (every visible frame, centered) — `canvas.zoomToFit`
 * - Shift+2 → zoom to selection (the selected node(s), centered) — `canvas.zoomToSelection`
 */

import { useRef, useEffect, useCallback, type RefObject } from 'react'
import { useGesture } from '@use-gesture/react'
import { useEditorStore, type EditorStore } from '@site/store/store'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import {
  applyZoom,
  applyPan,
  zoomFromWheelDelta,
  clampZoom,
  clampPan,
  incrementalScaleFromPinchMovement,
  type CanvasTransform,
} from '@site/canvas/math'
import { panToCenterBreakpointFrame } from '@site/canvas/canvasDomGeometry'
import { computeZoomToFitTransform, type CanvasFitRect } from '@site/canvas/canvasZoomFit'
import {
  CANVAS_DRAG_PAN_BUTTONS,
  isCanvasPointerPanActive,
  isMiddleMousePointerPan,
  panDeltaFromWheel,
  setCanvasSpacePanActive,
} from '@site/canvas/canvasPanInput'

/**
 * The live canvas transform — `{ zoom, panX, panY }`.
 *
 * Re-exported (and, since D1, the `transformRef` holding it is returned from
 * `useCanvas`) because it is now a SHARED, STABLE API, not a `useCanvas`-only
 * concern: the store's `zoom`/`panX`/`panY` are debounced 100ms behind the
 * real DOM transform during an active gesture (see the module doc above), so
 * anything that must track pan/zoom live — mid-drag, not 100ms later — has to
 * read this ref instead of subscribing to the store. `CanvasRulers` (D1),
 * `D2`'s unified drag/drop, and the (future) Alt-hover measurement HUD all
 * need exactly this. Treat this as a published contract: `transformRef.current`
 * is always the up-to-date transform (mutated in place, never replaced with a
 * new object identity — do not rely on identity changes to detect updates,
 * poll the fields), and it is READ-ONLY from every consumer but this hook.
 *
 * **Defined in `math.ts`, not here** (and re-exported for every existing
 * `from '@site/hooks/useCanvas'` import site to keep working unchanged) —
 * `canvasZoomFit.ts`'s pure `computeZoomToFitTransform` needs this SHAPE
 * without importing the hook module itself, and `useCanvas.ts` imports
 * FROM `canvasZoomFit.ts` (for `zoomToFit`/`zoomToSelection`) — defining the
 * type here would make that a circular module dependency. Same fix shape
 * `useRulerCanvasPaint.ts` settled on for a comparable problem: the pure/
 * math layer owns the shared shape, the hook re-exports it.
 */
export type { CanvasTransform }

interface UseCanvasOptions {
  /** Ref to the gesture capture root */
  canvasRootRef: React.RefObject<HTMLElement | null>
  /** Ref to the div that gets the CSS transform applied to it */
  transformLayerRef: React.RefObject<HTMLElement | null>
  /**
   * Whether the canvas accepts pan/zoom gestures. False while the canvas is
   * showing a preview iframe (preview mode owns its own surface, no panning).
   * When this flips false→true the hook re-syncs the DOM transform from the
   * store so the freshly-mounted transform layer doesn't visibly jump on the
   * first wheel/pinch event.
   */
  enabled: boolean
}

type CanvasTransformSnapshot = readonly [zoom: number, panX: number, panY: number]

const selectCanvasTransformSnapshot = (state: EditorStore): CanvasTransformSnapshot => [
  state.zoom,
  state.panX,
  state.panY,
]

function areCanvasTransformSnapshotsEqual(
  a: CanvasTransformSnapshot,
  b: CanvasTransformSnapshot,
) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

/**
 * Duration of the eased zoom transition for discrete actions
 * (toolbar buttons, +/− keys, reset / fit). Kept in sync with the
 * `data-animating='true'` rule in CanvasTransformLayer.module.css.
 */
const ANIMATED_TRANSFORM_MS = 220

/**
 * WS-5.4 — how long after the last transform write to drop
 * `will-change: transform` back to `auto`. `CanvasTransformLayer.module.css`
 * already documents (and, until this fix, only documents — the constant it
 * names didn't exist) why this is transient rather than permanent: a
 * permanently promoted transform layer wraps the whole board subtree into
 * one oversized GPU-composited layer whose backing can overflow the
 * tile/memory budget and paint blank at scale (react-virtualized#453). Kept
 * slightly above the 100ms Zustand commit debounce so a promotion doesn't
 * drop mid-gesture between two rAF-batched writes.
 */
const WILL_CHANGE_RELEASE_MS = 200

/** Escape a value for safe interpolation into an attribute-equals selector. */
function cssAttrEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function useCanvas({ canvasRootRef, transformLayerRef, enabled }: UseCanvasOptions) {
  // Ref-based transform — not React state — avoids re-renders during interaction
  const transformRef = useRef<CanvasTransform>({ zoom: 1, panX: 0, panY: 0 })
  const rafRef = useRef<number | null>(null)
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const animatingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const willChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const spaceActiveRef = useRef(false)
  const isDraggingRef = useRef(false)
  const lastPinchMovementRef = useRef(1)

  // Actions — Zustand actions are stable references, subscribing to them is fine.
  const setCanvasTransform = useEditorStore((s) => s.setCanvasTransform)
  const zoomIn = useEditorStore((s) => s.zoomIn)
  const zoomOut = useEditorStore((s) => s.zoomOut)
  const resetView = useEditorStore((s) => s.resetView)

  // ─── DOM write helper ─────────────────────────────────────────────────────

  /**
   * Write the transform to the DOM.
   *
   * `animated` toggles the `data-animating='true'` attribute on the layer,
   * which activates a CSS transition on `transform` (see
   * CanvasTransformLayer.module.css). Used for discrete zoom actions
   * (toolbar buttons, +/− keys, Cmd/Ctrl+0, Shift+1) so they ease in
   * instead of snapping. Continuous gestures (wheel / pinch / drag) pass
   * `animated=false` and remain instant — animating them would visibly
   * lag the cursor.
   */
  // Exception #1: referenced in useEffect dep arrays (mount sync, external
  // store-subscription sync) — exhaustive-deps needs a stable identity here.
  const applyTransformToDOM = useCallback((t: CanvasTransform, animated = false) => {
    const el = transformLayerRef.current
    if (!el) return

    if (animatingTimerRef.current) {
      clearTimeout(animatingTimerRef.current)
      animatingTimerRef.current = null
    }

    // Use setAttribute / removeAttribute instead of `el.dataset.X = ...` and
    // `delete el.dataset.X`. React Compiler treats DOM method calls as opaque
    // side effects (acceptable) but flags direct property assignment on a
    // value reached through a hook argument as a Rules-of-React violation.
    // Functionally identical — same `data-animating` attribute, same CSS
    // selector match in CanvasTransformLayer.module.css.
    if (animated) {
      el.setAttribute('data-animating', 'true')
      animatingTimerRef.current = setTimeout(() => {
        el.removeAttribute('data-animating')
        animatingTimerRef.current = null
      }, ANIMATED_TRANSFORM_MS)
    } else if (el.hasAttribute('data-animating')) {
      // A new gesture frame interrupting an in-flight animation: drop the
      // attribute so wheel/pinch/drag updates land instantly.
      el.removeAttribute('data-animating')
    }

    // setProperty avoids the same property-assignment lint trip as above.
    el.style.setProperty('transform', `translate(${t.panX}px, ${t.panY}px) scale(${t.zoom})`)

    // WS-5.4 — promote to a GPU-composited layer for the duration of the
    // gesture, then release. `el.style.willChange` reads back the resolved
    // value, so this check is a no-op skip on every write but the first of a
    // gesture, not a redundant style recalc every rAF tick.
    if (el.style.willChange !== 'transform') {
      el.style.setProperty('will-change', 'transform')
    }
    if (willChangeTimerRef.current) clearTimeout(willChangeTimerRef.current)
    willChangeTimerRef.current = setTimeout(() => {
      willChangeTimerRef.current = null
      el.style.setProperty('will-change', 'auto')
    }, WILL_CHANGE_RELEASE_MS)
  }, [transformLayerRef])

  // Sync from store on mount AND whenever the canvas re-becomes enabled
  // (preview→design transition). Reading via getState() (not subscriptions)
  // avoids re-renders on every debounced pan commit — see Contribution #495.
  // The `enabled` dep ensures that when the user returns from preview mode,
  // the freshly-mounted transform layer immediately reflects the saved
  // pan/zoom instead of starting at the identity transform and visibly
  // jumping on the first wheel/pinch.
  useEffect(() => {
    if (!enabled) return
    const { zoom, panX, panY } = useEditorStore.getState()
    transformRef.current = { zoom, panX, panY }
    applyTransformToDOM(transformRef.current)
  }, [applyTransformToDOM, enabled])

  /**
   * Schedule a DOM write for the next animation frame.
   * Coalesces multiple updates within the same frame into a single DOM write.
   */
  // Exception #1: transitive dep of updateTransform, which feeds the wheel
  // listener's useEffect dep array — needs a stable identity.
  const scheduleTransformWrite = useCallback((t: CanvasTransform) => {
    transformRef.current = t
    if (rafRef.current !== null) return // already scheduled
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      applyTransformToDOM(transformRef.current)
    })
  }, [applyTransformToDOM])

  /**
   * Debounced Zustand commit — fires 100ms after the last interaction event.
   * Keeps the store consistent without updating on every frame.
   */
  // Exception #1: transitive dep of updateTransform, which feeds the wheel
  // listener's useEffect dep array — needs a stable identity.
  const scheduleStoreCommit = useCallback((t: CanvasTransform) => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current)
    commitTimerRef.current = setTimeout(() => {
      setCanvasTransform(t.zoom, t.panX, t.panY)
    }, 100)
  }, [setCanvasTransform])

  // Exception #1: referenced in the native wheel listener's useEffect dep array.
  const updateTransform = useCallback((t: CanvasTransform) => {
    scheduleTransformWrite(t)
    scheduleStoreCommit(t)
  }, [scheduleTransformWrite, scheduleStoreCommit])

  const panBy = (dx: number, dy: number) => {
    const t = transformRef.current
    const next = applyPan(t.panX, t.panY, dx, dy)
    updateTransform({ zoom: t.zoom, ...next })
  }

  // Exception #1: referenced in the Cmd/Ctrl+0 reset shortcut's useEffect dep array.
  const resetCanvasView = useCallback(() => {
    resetView()
    transformRef.current = { zoom: 1, panX: 0, panY: 0 }
    applyTransformToDOM(transformRef.current, true)
  }, [resetView, applyTransformToDOM])

  /**
   * Pan the canvas so the given breakpoint's frame is horizontally centered and
   * its top sits just below the viewport top — keeping the current zoom. Used to
   * honour the user's "Default viewport" preference: opening a site should focus
   * the chosen frame instead of always landing on the left-most (mobile) frame.
   *
   * Returns `false` when the frame isn't in the DOM / not laid out yet, so the
   * caller can retry on the next frame.
   *
   * Exception #1: referenced in CanvasRoot's initial-focus useEffect dep array,
   * so exhaustive-deps requires a stable identity here.
   */
  const centerOnBreakpointFrame = useCallback(
    (breakpointId: string, animated = false): boolean => {
      const root = canvasRootRef.current
      const layer = transformLayerRef.current
      if (!root || !layer) return false
      // Match the real frame wrapper (`canvas-frame-<id>`) OR its loading
      // skeleton (`canvas-loading-frame-<id>`), so the canvas is already focused
      // on the chosen viewport while the page data loads — no jump from a
      // left-aligned skeleton to the centered frame once content arrives.
      const id = cssAttrEscape(breakpointId)
      const frame = layer.querySelector<HTMLElement>(
        `[data-testid="canvas-frame-${id}"], [data-testid="canvas-loading-frame-${id}"]`,
      )
      if (!frame) return false

      const cur = transformRef.current
      const target = panToCenterBreakpointFrame(root, frame, cur)
      if (!target) return false

      const next = { zoom: cur.zoom, panX: clampPan(target.panX), panY: clampPan(target.panY) }
      // Update the ref BEFORE committing to the store so the store-subscription
      // guard sees the values already match and skips its own (animated) DOM
      // write — this call owns the `animated` flag.
      transformRef.current = next
      applyTransformToDOM(next, animated)
      setCanvasTransform(next.zoom, next.panX, next.panY)
      return true
    },
    [canvasRootRef, transformLayerRef, applyTransformToDOM, setCanvasTransform],
  )

  /**
   * Zoom/pan so `targetRects` (screen-space, relative to the canvas root)
   * are entirely visible, centered. Shared by `zoomToFit` and
   * `zoomToSelection` — the only difference between the two is which rects
   * they measure. Returns `false` when there was nothing to fit (empty or
   * fully-degenerate rect list — see `computeZoomToFitTransform`).
   */
  const applyZoomToFitRects = useCallback(
    (targetRects: readonly CanvasFitRect[]): boolean => {
      const root = canvasRootRef.current
      if (!root) return false
      const rootRect = root.getBoundingClientRect()
      const next = computeZoomToFitTransform(
        { width: rootRect.width, height: rootRect.height },
        targetRects,
        transformRef.current,
      )
      if (!next) return false
      transformRef.current = next
      applyTransformToDOM(next, true)
      setCanvasTransform(next.zoom, next.panX, next.panY)
      return true
    },
    [canvasRootRef, applyTransformToDOM, setCanvasTransform],
  )

  /**
   * `Shift+1` (`canvas.zoomToFit`) — fit every visible breakpoint frame on
   * the board (or every viewport context frame outside board mode) into the
   * viewport at once. D3, `STUDIO-FIGMA-PARITY-PLAN.md`: this used to be a
   * "reset to 100%" alias; it is now the real Figma-style fit.
   */
  const zoomToFit = useCallback((): boolean => {
    const root = canvasRootRef.current
    const layer = transformLayerRef.current
    if (!root || !layer) return false
    const rootRect = root.getBoundingClientRect()
    // `data-breakpoint-id` sits on each frame's own iframe-viewport wrapper
    // (`BreakpointFrame.tsx`) — one per rendered frame, and unlike
    // `canvas-frame-<id>` it has no `-activate-`/`-live-`/`-collapse-`
    // button siblings sharing the prefix, so a plain attribute-presence
    // selector can't accidentally pick up chrome buttons.
    const frames = layer.querySelectorAll<HTMLElement>('[data-breakpoint-id]')
    const rects: CanvasFitRect[] = []
    frames.forEach((frame) => {
      const r = frame.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return
      rects.push({ left: r.left - rootRect.left, top: r.top - rootRect.top, width: r.width, height: r.height })
    })
    return applyZoomToFitRects(rects)
  }, [canvasRootRef, transformLayerRef, applyZoomToFitRects])

  /**
   * `Shift+2` (`canvas.zoomToSelection`) — fit the current selection. Reads
   * the ALREADY-POSITIONED selection ring element(s)
   * (`[data-canvas-selection-ring="true"]`, `BreakpointSelectionOverlay.tsx`)
   * rather than re-deriving node geometry: the ring is already the exact
   * cross-iframe, `nodeVisualRect`-aware, per-`(frameId,nodeId)`-scoped
   * screen rect a selection has, computed every RAF tick this hook has no
   * visibility into (see `canvasSelectionOverlayPositioning.ts`). Multiple
   * rings (multi-select) are unioned automatically by
   * `computeZoomToFitTransform`. No-ops (`false`) when nothing is selected.
   */
  const zoomToSelection = useCallback((): boolean => {
    const root = canvasRootRef.current
    if (!root) return false
    const rootRect = root.getBoundingClientRect()
    const rings = document.querySelectorAll<HTMLElement>('[data-canvas-selection-ring="true"]')
    const rects: CanvasFitRect[] = []
    rings.forEach((ring) => {
      const r = ring.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return
      rects.push({ left: r.left - rootRect.left, top: r.top - rootRect.top, width: r.width, height: r.height })
    })
    return applyZoomToFitRects(rects)
  }, [canvasRootRef, applyZoomToFitRects])

  // ─── Spacebar tracking (for Space+drag pan) ───────────────────────────────

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code === 'Space' && !e.repeat) {
        const target = e.target as HTMLElement
        // Don't intercept space in inputs/textareas. Inline-edit keystrokes
        // never reach here: IframeFrameSurface's key forwarding stands down
        // during a session, so no space clone is dispatched on this document.
        if (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable
        ) return
        e.preventDefault()
        spaceActiveRef.current = true
        setCanvasSpacePanActive(document, 'parentDocument', true)
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === 'Space') {
        spaceActiveRef.current = false
        setCanvasSpacePanActive(document, 'parentDocument', false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    return () => {
      setCanvasSpacePanActive(document, 'parentDocument', false)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  // ─── Browser-style reset shortcut ─────────────────────────────────────────

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key !== '0') return

      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) return

      e.preventDefault()
      resetCanvasView()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [resetCanvasView])

  // ─── Keyboard shortcuts ───────────────────────────────────────────────────

  /**
   * Resolve the current canvas viewport center, in canvas-local coords.
   * Used as the zoom origin for keyboard +/− shortcuts so the zoom is
   * anchored to the middle of the visible area, not the document top-left.
   */
  const getViewportCenter = (): { x: number; y: number } | null => {
    const el = canvasRootRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { x: rect.width / 2, y: rect.height / 2 }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Don't intercept typing — let inputs and contenteditables consume keys.
    const target = e.target as HTMLElement | null
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable)
    ) return

    // Zoom in/out with +/- keys — zoom around the canvas viewport center
    if (e.key === '=' || e.key === '+') {
      e.preventDefault()
      const c = getViewportCenter()
      if (c) zoomIn(c.x, c.y)
      else zoomIn()
    } else if (e.key === '-') {
      e.preventDefault()
      const c = getViewportCenter()
      if (c) zoomOut(c.x, c.y)
      else zoomOut()
    } else if ((e.metaKey || e.ctrlKey) && e.key === '0') {
      e.preventDefault()
      resetCanvasView()
    } else if (getKeybindingForCommand('canvas.zoomToFit')?.match(e)) {
      // `Shift+1` → zoom to fit every visible frame (D3 — was a "reset to
      // 100%" alias before; see this function's own module doc).
      e.preventDefault()
      zoomToFit()
    } else if (getKeybindingForCommand('canvas.zoomToSelection')?.match(e)) {
      // `Shift+2` → zoom to the current selection (D3 — did not exist before).
      e.preventDefault()
      zoomToSelection()
    }
    // Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z handled by App-level listener
  }

  // ─── External zoom/pan sync ───────────────────────────────────────────────
  //
  // ZoomControls (toolbar + buttons) and any other external caller update the
  // Zustand store directly via zoomIn/zoomOut/resetView.  The DOM transform
  // layer is NOT subscribed to the store via React state (intentional perf
  // design — avoids re-renders during 60fps gestures).  Without this
  // subscription those external actions only update the zoom indicator number
  // and never move the canvas visually.
  //
  // Zustand subscribers fire synchronously inside set(), so the DOM is updated
  // in the same microtask as the store change — no visible frame lag.
  //
  // This subscription must be scoped to the transform tuple. During wheel pan
  // the DOM transform intentionally leads the debounced store values; unrelated
  // store updates such as canvas hover must not "sync" the DOM back to stale pan.
  // The guard `zoom !== cur.zoom || ...` then prevents redundant DOM writes from
  // our own debounced Zustand commits (scheduleStoreCommit): by the time the
  // 100ms debounce fires, transformRef already holds the committed values.
  useEffect(() => {
    const unsubscribe = useEditorStore.subscribe(
      selectCanvasTransformSnapshot,
      ([zoom, panX, panY]) => {
        const cur = transformRef.current
        if (zoom !== cur.zoom || panX !== cur.panX || panY !== cur.panY) {
          transformRef.current = { zoom, panX, panY }
          // External transform updates (toolbar buttons, +/− keys, agent
          // tools, undo/redo) animate to the new value. Continuous gestures
          // never reach this branch — by the time their debounced commit
          // fires, transformRef already matches the store and the guard
          // above skips the write.
          applyTransformToDOM(transformRef.current, true)
        }
      },
      { equalityFn: areCanvasTransformSnapshotsEqual },
    )
    return unsubscribe
  }, [applyTransformToDOM])

  // ─── Native wheel pan/zoom ────────────────────────────────────────────────
  //
  // Wheel cannot go through @use-gesture's React bind() path: React synthetic
  // wheel listeners are passive in modern React, so preventDefault is ignored,
  // and currentTarget can be null by the time @use-gesture invokes the handler.
  //
  // Skipped entirely while disabled (preview mode). If the listener stayed
  // bound, wheel-during-preview would silently mutate `transformRef` and the
  // debounced store commit, then on return to design the freshly mounted
  // transform layer would visibly jump on the first interaction.
  useEffect(() => {
    if (!enabled) return
    const canvasEl = canvasRootRef.current
    if (!canvasEl) return

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()

      const t = transformRef.current
      const rect = canvasEl.getBoundingClientRect()
      const originX = event.clientX - rect.left
      const originY = event.clientY - rect.top

      if (event.ctrlKey || event.metaKey) {
        const newZoom = zoomFromWheelDelta(t.zoom, event.deltaY)
        const next = applyZoom(t.zoom, newZoom, originX, originY, t.panX, t.panY)
        updateTransform(next)
        return
      }

      const { dx, dy } = panDeltaFromWheel(event)
      const next = applyPan(t.panX, t.panY, dx, dy)
      updateTransform({ zoom: t.zoom, ...next })
    }

    canvasEl.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      canvasEl.removeEventListener('wheel', handleWheel)
    }
  }, [canvasRootRef, updateTransform, enabled])

  // ─── Gesture handlers ─────────────────────────────────────────────────────

  const gestureBind = useGesture(
    {
      onDrag: ({ delta: [dx, dy], buttons, first, last, event }) => {
        if (first) {
          isDraggingRef.current = isCanvasPointerPanActive(
            { buttons },
            { spaceHeld: spaceActiveRef.current },
          )
          if (isDraggingRef.current && isMiddleMousePointerPan({ buttons }) && event.cancelable) {
            event.preventDefault()
          }
        }

        if (!isDraggingRef.current) return
        if (last) isDraggingRef.current = false

        const t = transformRef.current
        const next = applyPan(t.panX, t.panY, dx, dy)
        updateTransform({ zoom: t.zoom, ...next })
      },

      onPinch: ({ movement: [scaleMovement], origin: [ox, oy], first, last }) => {
        // event?.preventDefault() intentionally omitted. AdminZoomGuard blocks
        // native browser zoom at document scope; this handler applies the
        // replacement zoom to the canvas transform.
        const t = transformRef.current
        // `origin` is in page coordinates — convert to canvas-relative
        const canvasEl = transformLayerRef.current?.parentElement
        if (!canvasEl) return
        const rect = canvasEl.getBoundingClientRect()
        const originX = ox - rect.left
        const originY = oy - rect.top
        // @use-gesture pinch movement[0] is accumulated since gesture start.
        // Convert it to a per-frame multiplier before applying it to the
        // current transform; otherwise every frame compounds the full gesture.
        const previousMovement = first ? 1 : lastPinchMovementRef.current
        const scaleDelta = incrementalScaleFromPinchMovement(scaleMovement, previousMovement)
        lastPinchMovementRef.current =
          Number.isFinite(scaleMovement) && scaleMovement > 0 ? scaleMovement : previousMovement

        const newZoom = clampZoom(t.zoom * scaleDelta)
        const next = applyZoom(t.zoom, newZoom, originX, originY, t.panX, t.panY)
        updateTransform(next)

        if (last) lastPinchMovementRef.current = 1
      },
    },
    {
      drag: {
        filterTaps: true,
        pointer: { buttons: [...CANVAS_DRAG_PAN_BUTTONS] },
      },
      pinch: {
        eventOptions: { passive: false },
        // Trackpad pinch already arrives here through the native ctrl/meta
        // wheel listener above. Letting @use-gesture convert the same wheel
        // event into onPinch applies zoom twice and makes pinch far too fast.
        pinchOnWheel: false,
      },
    },
  )

  const bind = () => {
    const gestureHandlers = gestureBind()
    return {
      ...gestureHandlers,
      onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
        if (isMiddleMousePointerPan({ buttons: event.buttons }) && event.cancelable) {
          event.preventDefault()
        }
        gestureHandlers.onPointerDown?.(event)
      },
      onMouseDown: (event: React.MouseEvent<HTMLElement>) => {
        if (event.button === 1 && event.cancelable) {
          event.preventDefault()
        }
        gestureHandlers.onMouseDown?.(event)
      },
      onAuxClick: (event: React.MouseEvent<HTMLElement>) => {
        if (event.button === 1 && event.cancelable) {
          event.preventDefault()
        }
        gestureHandlers.onAuxClick?.(event)
      },
    }
  }

  // ─── Cleanup on unmount ───────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current)
      if (animatingTimerRef.current) clearTimeout(animatingTimerRef.current)
      if (willChangeTimerRef.current) clearTimeout(willChangeTimerRef.current)
    }
  }, [])

  return {
    bind,
    handleKeyDown,
    panBy,
    centerOnBreakpointFrame,
    /** `Shift+1` (`canvas.zoomToFit`) as a callable, e.g. for a future toolbar button. */
    zoomToFit,
    /** `Shift+2` (`canvas.zoomToSelection`) as a callable, e.g. for a future toolbar button. */
    zoomToSelection,
    /** Whether a space-pan drag is in progress */
    isDragging: isDraggingRef,
    /**
     * The LIVE canvas transform — see `CanvasTransform`'s doc above. Read
     * `transformRef.current` on every rAF tick / pointer event rather than
     * subscribing to the store's `zoom`/`panX`/`panY`, which lag up to 100ms
     * behind this during an active gesture. Never write to it from outside
     * this hook.
     */
    transformRef: transformRef as RefObject<CanvasTransform>,
  }
}
