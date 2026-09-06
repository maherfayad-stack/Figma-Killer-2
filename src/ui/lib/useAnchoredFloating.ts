/**
 * useAnchoredFloating — shared anchored/point positioning for portalled
 * floating surfaces (menus, dropdowns, inspector popovers).
 *
 * This is the ONE copy of the positioning maths that used to live as two
 * private hooks inside `ContextMenu/` (`useAnchorPosition`, `usePointPosition`).
 * `ContextMenu` and `InspectorPopover` both build on this — see
 * `docs/agent-refs/conventions-quickref.md` §10: no old-and-new copies
 * side by side.
 *
 * Two mutually exclusive modes, selected by which inputs are supplied:
 *
 *   - **Anchor mode** (`anchorRef` set): auto-flips relative to a trigger
 *     element via `computeFloatingPosition`, the same helper `<Tooltip>`
 *     uses. Recomputes on the anchor's `getBoundingClientRect()`, on window
 *     resize/scroll, and whenever the floating element's own measured size
 *     changes (content that loads in after the first frame must not leave
 *     the panel pinned to a now-wrong position). `matchAnchorWidth` tracks
 *     the anchor's live width via `ResizeObserver` and folds it into
 *     `effectiveWidth`.
 *   - **Point mode** (`pointX`/`pointY` set, no `anchorRef`): viewport-fit
 *     positioning for a fixed click point (right-click context menus) —
 *     flips around the point when it would overflow an edge, then clamps.
 *
 * `position` is `null` until the floating element has been measured once;
 * callers should render off-screen (`visibility: hidden`) until then so the
 * panel never flashes at `(0, 0)`.
 */
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import {
  computeFloatingPosition,
  type FloatingAlign,
  type FloatingSide,
  type ResolvedFloatingSide,
} from './floatingPosition'
import { useEvent } from './useEvent'

/**
 * Default auto-flip priority: prefer opening below the trigger, then above,
 * then right, then left. Dropdown menus feel inverted if they open upward
 * by default, so this differs from Tooltip's `['top', 'bottom', 'right',
 * 'left']`. Callers with a different natural direction (e.g.
 * `InspectorPopover`'s "always prefer left") pass their own `autoPriority`.
 */
const DEFAULT_AUTO_PRIORITY: ReadonlyArray<ResolvedFloatingSide> = [
  'bottom',
  'top',
  'right',
  'left',
]

export interface AnchoredFloatingPosition {
  x: number
  y: number
  /** Resolved side after flip. Only meaningful in anchor mode — `undefined` in point mode. */
  side: ResolvedFloatingSide | undefined
}

export interface UseAnchoredFloatingParams {
  /**
   * Element whose rect anchors the floating element. Selects anchor mode.
   * Mutually exclusive with `pointX`/`pointY`.
   */
  anchorRef?: RefObject<HTMLElement | null>
  /** Ref to the floating element being positioned (measured for flip/fit). */
  floatingRef: RefObject<HTMLElement | null>
  /**
   * Optional override for the rect used for position math in anchor mode.
   * See `ContextMenu`'s `getAnchorRect` doc for the motivating case.
   */
  getAnchorRect?: () => DOMRect | null
  /** Absolute viewport-pixel click point. Selects point mode when both are set. */
  pointX?: number
  pointY?: number
  /** Preferred side (anchor mode only). `'auto'` tries `autoPriority` in order. Default `'auto'`. */
  side?: FloatingSide
  /** Cross-axis alignment relative to the anchor (anchor mode only). Default `'start'`. */
  align?: FloatingAlign
  /** Gap between anchor edge and floating element, px (anchor mode only). Default 6. */
  offset?: number
  /** Side priority tried when `side === 'auto'` (anchor mode only). */
  autoPriority?: ReadonlyArray<ResolvedFloatingSide>
  /** Explicit render width the CSS applies (used in position math). */
  width: number
  /** Lower bound for `matchAnchorWidth`. */
  minWidth: number
  /** Optional width ceiling applied after `matchAnchorWidth`. */
  maxWidth?: number
  maxHeight?: number
  /** Anchor mode only: track the anchor's measured width live. */
  matchAnchorWidth?: boolean
}

export interface UseAnchoredFloatingResult {
  /** Resolved position, or `null` until the floating element has been measured. */
  position: AnchoredFloatingPosition | null
  /** Render width after applying `matchAnchorWidth` and `maxWidth`. */
  effectiveWidth: number
}

export function useAnchoredFloating({
  anchorRef,
  floatingRef,
  getAnchorRect,
  pointX,
  pointY,
  side = 'auto',
  align = 'start',
  offset = 6,
  autoPriority = DEFAULT_AUTO_PRIORITY,
  width,
  minWidth,
  maxWidth,
  maxHeight,
  matchAnchorWidth = false,
}: UseAnchoredFloatingParams): UseAnchoredFloatingResult {
  const isAnchorMode = anchorRef != null
  const isPointMode = !isAnchorMode && pointX != null && pointY != null

  const [position, setPosition] = useState<AnchoredFloatingPosition | null>(null)
  // Live anchor width, used when `matchAnchorWidth` is set (anchor mode only).
  const [anchorWidth, setAnchorWidth] = useState<number | null>(null)

  const anchorMatchedWidth = matchAnchorWidth && anchorWidth != null
    ? Math.max(anchorWidth, minWidth)
    : width
  const effectiveWidth = maxWidth != null
    ? Math.min(anchorMatchedWidth, maxWidth)
    : anchorMatchedWidth

  const recompute = useEvent(() => {
    const floatingEl = floatingRef.current
    if (!floatingEl) return

    if (isAnchorMode) {
      const anchorEl = anchorRef?.current
      if (!anchorEl) return
      // See ContextMenu's `getAnchorRect` doc: lets a caller decouple the
      // dismiss-handling anchor from the rect used for positioning.
      const anchorRect = getAnchorRect?.() ?? anchorEl.getBoundingClientRect()
      const floatingRect = floatingEl.getBoundingClientRect()
      const effectiveHeight = maxHeight != null
        ? Math.min(floatingRect.height, maxHeight)
        : floatingRect.height
      const next = computeFloatingPosition(anchorRect, {
        floatingWidth: effectiveWidth,
        floatingHeight: effectiveHeight,
        side,
        align,
        offset,
        autoPriority,
      })
      setPosition({ x: next.x, y: next.y, side: next.side })
      return
    }

    if (isPointMode) {
      const floatingRect = floatingEl.getBoundingClientRect()
      const effectiveHeight = maxHeight != null
        ? Math.min(floatingRect.height, maxHeight)
        : floatingRect.height
      const vw = window.innerWidth
      const vh = window.innerHeight
      const margin = 8
      let x = pointX as number
      let y = pointY as number
      // Flip around the click point when it would overflow an edge: the
      // panel opens to the left/above of the click instead of the default
      // right/below.
      if (x + effectiveWidth > vw - margin) {
        x = Math.max(margin, x - effectiveWidth)
      }
      if (y + effectiveHeight > vh - margin) {
        y = Math.max(margin, y - effectiveHeight)
      }
      x = Math.max(margin, Math.min(x, vw - effectiveWidth - margin))
      y = Math.max(margin, Math.min(y, vh - effectiveHeight - margin))
      setPosition({ x, y, side: undefined })
    }
  })

  // Initial measure, and re-measure when the inputs that change the computed
  // position change: anchor-mode's tracked anchor width (`matchAnchorWidth`),
  // or point-mode's click coordinates (reopening at a new point).
  useLayoutEffect(() => {
    if (!isAnchorMode && !isPointMode) return
    recompute()
  }, [isAnchorMode, isPointMode, anchorWidth, pointX, pointY, recompute])

  // Re-run whenever the floating element's own measured size changes —
  // content that mounts short and grows asynchronously (e.g. a lazy-loaded
  // list) must not stay pinned to the position computed for its first,
  // smaller frame.
  useLayoutEffect(() => {
    if (!isAnchorMode && !isPointMode) return
    const floatingEl = floatingRef.current
    if (!floatingEl || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => recompute())
    observer.observe(floatingEl)
    return () => observer.disconnect()
  }, [isAnchorMode, isPointMode, floatingRef, recompute])

  // Track the anchor's measured width so `matchAnchorWidth` floating panels
  // stay flush with their trigger, including as it resizes.
  useLayoutEffect(() => {
    if (!matchAnchorWidth || !isAnchorMode) return
    const anchorEl = anchorRef?.current
    if (!anchorEl) return
    setAnchorWidth(anchorEl.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      setAnchorWidth(entry.contentRect.width)
    })
    observer.observe(anchorEl)
    return () => observer.disconnect()
  }, [matchAnchorWidth, isAnchorMode, anchorRef])

  // Position recomputes on window resize and capture-phase scroll while
  // open, so the floating element stays glued to its trigger/point.
  useEffect(() => {
    if (!isAnchorMode && !isPointMode) return
    function onViewportChange() {
      recompute()
    }
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
    return () => {
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [isAnchorMode, isPointMode, recompute])

  return { position, effectiveWidth }
}
