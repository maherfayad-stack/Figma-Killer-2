/**
 * useScrubDrag — THE scrub gesture. One implementation, every numeric field.
 *
 * "Drag the field's mark sideways to change its number" is one interaction,
 * and it used to be written twice: once inside `ScrubInput` (with rAF-coalesced
 * previews, min/max clamping and pointer capture) and once inside
 * `ScrubTokenField` (without any of those). Which of the two you got depended
 * on whether the field underneath happened to need token autocomplete — an
 * invisible distinction that made padding scrub coarser than width, and made
 * every fix to the gesture a fix that had to be made twice, or forgotten once.
 *
 * The gesture cannot simply live in `ScrubInput` and be reused by rendering
 * one: a token-aware field is an `Input` + an autocomplete dropdown, so a
 * component that renders `ScrubInput` cannot also be `TokenAwareInput`. What
 * both field kinds share is the STATE MACHINE, not the markup — so that is what
 * this hook is. `ScrubInput` and `ScrubTokenField` both call it, spread
 * `handleProps` onto whatever they draw as the field's mark, and display
 * `dragValue` while it is non-null.
 *
 * What the hook owns:
 *   - the refusal: a non-empty, non-numeric baseline (`auto`, `var(--space-md)`,
 *     `calc(...)`) has no numeric baseline to drag from, so `pointerdown` is
 *     declined outright and the click falls through to `onLabelClick`
 *     (normally "focus the field so it can be typed"). Silently coercing a
 *     keyword to `0px` would be exactly the kind of lying control this
 *     codebase's controls avoid;
 *   - the ladder: 1 unit per pixel, ×10 with Shift, ×0.1 with Alt, resolved
 *     through `nudgeStepFor` so drag and arrow keys cannot disagree;
 *   - min/max clamping, and the field's `unit` for a drag that starts empty;
 *   - rAF coalescing of `onPreview`. A drag can deliver `pointermove` well
 *     over 60Hz, and each call is wired to a live editor-store write that every
 *     mounted breakpoint iframe re-derives style CSS from — firing it faster
 *     than the screen can paint is strictly more work for zero smoothness.
 *     Only the external preview channel is throttled; `dragValue` updates
 *     synchronously, so the control itself never looks laggy;
 *   - the release: the final value is computed fresh from `pointerup`'s own
 *     `clientX` and committed directly, with any pending coalesced preview
 *     CANCELLED rather than flushed — a stale mid-gesture value must never
 *     land a frame after the real final value already did.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { applyScrubDelta, nudgeStepFor, parseScrubValue } from './scrubMath'

export interface ScrubDragOptions {
  /**
   * The value a gesture starts from — the field's current value (or its live
   * draft, when the user is mid-edit). Read once, at `pointerdown`.
   */
  baseline: string
  /** Fired once, on release, with the final value. Not fired for a click with no movement. */
  onCommit: (next: string) => void
  /** Fired (rAF-coalesced) on every move. */
  onPreview?: (next: string) => void
  onClearPreview?: () => void
  /**
   * A press with no movement. The mark is a drag affordance, not a button —
   * a plain click should put the caret in the field so the value can be typed.
   */
  onLabelClick?: () => void
  /** Unit assigned when the drag starts from an empty field. Default `'px'`. */
  unit?: string
  /** Units of change per pixel, unmodified. Default 1 — see `nudgeStepFor`. */
  step?: number
  /** Units of change per pixel with Shift held. Default 10. */
  shiftStep?: number
  min?: number
  max?: number
  disabled?: boolean
}

/** Spread onto whatever the field draws as its draggable mark. */
export interface ScrubHandleProps {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
}

export interface ScrubDragState {
  /** The live value while dragging, or `null` when no gesture is in flight. */
  dragValue: string | null
  isDragging: boolean
  handleProps: ScrubHandleProps
}

interface DragState {
  pointerId: number
  startX: number
  baseline: string
  moved: boolean
}

export function useScrubDrag({
  baseline,
  onCommit,
  onPreview,
  onClearPreview,
  onLabelClick,
  unit = 'px',
  step,
  shiftStep,
  min,
  max,
  disabled = false,
}: ScrubDragOptions): ScrubDragState {
  const [dragValue, setDragValue] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const dragRef = useRef<DragState | null>(null)

  // Kept fresh every render (not memoized) so a scheduled frame always calls
  // the LATEST `onPreview`, never one captured in a stale closure from
  // whichever `pointermove` happened to start it. Refs must not be written
  // during render, so the sync runs in an effect with no dependency array —
  // it re-runs after every commit, deliberately.
  const onPreviewRef = useRef(onPreview)
  useEffect(() => {
    onPreviewRef.current = onPreview
  })
  const previewRafIdRef = useRef<number | null>(null)
  const pendingPreviewValueRef = useRef<string | null>(null)

  function schedulePreview(next: string) {
    pendingPreviewValueRef.current = next
    if (previewRafIdRef.current !== null) return
    previewRafIdRef.current = requestAnimationFrame(() => {
      previewRafIdRef.current = null
      const value = pendingPreviewValueRef.current
      pendingPreviewValueRef.current = null
      if (value !== null) onPreviewRef.current?.(value)
    })
  }

  function cancelScheduledPreview() {
    if (previewRafIdRef.current !== null) {
      cancelAnimationFrame(previewRafIdRef.current)
      previewRafIdRef.current = null
    }
    pendingPreviewValueRef.current = null
  }

  // A drag abandoned by unmount (the selection changes mid-scrub, the panel
  // closes) must not fire a scheduled preview at a caller that is already
  // gone. Written against the ref directly so this effect has no non-ref
  // dependency and never needs to re-run.
  useEffect(() => {
    return () => {
      if (previewRafIdRef.current !== null) cancelAnimationFrame(previewRafIdRef.current)
    }
  }, [])

  function scaleFor(e: { altKey: boolean; shiftKey: boolean }): number {
    return nudgeStepFor(e, { step, shiftStep })
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLElement>) {
    if (disabled) return
    const start = baseline
    // The refusal — see the module doc.
    if (parseScrubValue(start) === null && start.trim() !== '') return
    e.preventDefault()
    // Feature-checked: pointer capture isn't universal (older touch browsers).
    // Dragging still works without it — capture just keeps the gesture live
    // when the pointer strays off the (few-pixel-tall) mark.
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, baseline: start, moved: false }
    setIsDragging(true)
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const totalDx = e.clientX - drag.startX
    if (totalDx !== 0) drag.moved = true
    const next = applyScrubDelta(drag.baseline, totalDx, {
      scale: scaleFor(e),
      min,
      max,
      fallbackUnit: unit,
    })
    if (next !== null) {
      setDragValue(next)
      schedulePreview(next)
    }
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture?.(e.pointerId)
    }
    dragRef.current = null
    setIsDragging(false)
    setDragValue(null)
    cancelScheduledPreview()
    if (!drag.moved) {
      onLabelClick?.()
      return
    }
    onClearPreview?.()
    const finalValue = applyScrubDelta(drag.baseline, e.clientX - drag.startX, {
      scale: scaleFor(e),
      min,
      max,
      fallbackUnit: unit,
    })
    if (finalValue !== null) onCommit(finalValue)
  }

  return {
    dragValue,
    isDragging,
    handleProps: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
    },
  }
}
