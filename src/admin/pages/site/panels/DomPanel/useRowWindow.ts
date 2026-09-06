/**
 * useRowWindow — measures the Layers tree's shared scroll ancestor and turns
 * scroll position into a mounted row range.
 *
 * Measurement discipline (WS-5 / `docs/agent-refs/canvas-internals.md` §Perf):
 * reads happen in the scroll/resize listener and in a layout effect; the only
 * write is a `setState` whose value is QUANTIZED to the row grid, so scrolling
 * within one row's worth of pixels commits nothing. That keeps the re-render
 * count equal to the number of rows actually crossed, not the number of scroll
 * events, without debouncing a gesture the user is directly driving.
 *
 * First paint: geometry is unknown, so the hook starts with a conservative
 * guess (`INITIAL_VISIBLE_ROWS` from the top) and corrects it in a LAYOUT
 * effect — before paint, so no wrong slice is ever visible. If that first
 * measurement finds no scroll container, the window opens to the full list and
 * stays there: an unhosted tree renders in full rather than being silently
 * truncated.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { computeRowWindow, findScrollContainer, type RowWindow } from './rowWindow'

/** Rows mounted beyond each viewport edge. ~8 rows is a quarter-screen flick. */
const OVERSCAN_ROWS = 8

/**
 * Rows mounted on the very first paint, before layout has been measured.
 * Generous enough to fill any realistic panel height; corrected in the layout
 * effect that runs before the browser paints.
 */
const INITIAL_VISIBLE_ROWS = 60

/**
 * Row height assumed until a real row can be measured. Matches the compact
 * `--tree-row-h` default in `Tree/TreeRow.module.css`; the comfortable-density
 * override (36px) is picked up by measurement on the next layout effect.
 */
const ESTIMATED_ROW_HEIGHT_PX = 28

interface Geometry {
  /** `0` until a row has been measured. */
  rowHeight: number
  /** `0` when no scroll container was found — the "render everything" signal. */
  viewportHeight: number
  /** Quantized to the row grid; see the module doc. */
  scrollOffset: number
}

const INITIAL_GEOMETRY: Geometry = {
  rowHeight: ESTIMATED_ROW_HEIGHT_PX,
  viewportHeight: INITIAL_VISIBLE_ROWS * ESTIMATED_ROW_HEIGHT_PX,
  scrollOffset: 0,
}

export interface UseRowWindowResult {
  window: RowWindow
  /** The shared scroll ancestor, for scroll-to-row. `null` when there isn't one. */
  scrollerRef: RefObject<HTMLElement | null>
  /** Measured row height in px, or `0` when unmeasured. */
  rowHeight: number
}

export function useRowWindow(
  containerRef: RefObject<HTMLElement | null>,
  rowCount: number,
): UseRowWindowResult {
  const scrollerRef = useRef<HTMLElement | null>(null)
  const [geometry, setGeometry] = useState<Geometry>(INITIAL_GEOMETRY)

  // exception #1: referenced in the layout effect's dependency array below.
  const measure = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const scroller = scrollerRef.current

    // No scroll ancestor → viewportHeight 0 → `computeRowWindow` mounts the
    // whole list. This is the correctness fallback, not a degraded mode.
    if (!scroller) {
      setGeometry((prev) =>
        prev.viewportHeight === 0 && prev.rowHeight === 0
          ? prev
          : { rowHeight: 0, viewportHeight: 0, scrollOffset: 0 },
      )
      return
    }

    const firstRow = container.querySelector<HTMLElement>('[data-layer-row]')
    const measuredRowHeight = firstRow?.offsetHeight ?? 0

    setGeometry((prev) => {
      const rowHeight = measuredRowHeight > 0 ? measuredRowHeight : prev.rowHeight
      const viewportHeight = scroller.clientHeight
      const rawOffset =
        scroller.getBoundingClientRect().top - container.getBoundingClientRect().top
      // Quantize to the row grid: the mounted range only changes when a whole
      // row's worth of scroll has happened, so a 1px wheel tick commits nothing.
      const unit = rowHeight > 0 ? rowHeight : 1
      const scrollOffset = Math.floor(rawOffset / unit) * unit

      if (
        prev.rowHeight === rowHeight &&
        prev.viewportHeight === viewportHeight &&
        prev.scrollOffset === scrollOffset
      ) {
        return prev
      }
      return { rowHeight, viewportHeight, scrollOffset }
    })
  }, [containerRef])

  // Find the scroll ancestor once the container exists, then measure before the
  // first paint so the conservative initial window is never the one shown.
  useLayoutEffect(() => {
    scrollerRef.current = findScrollContainer(containerRef.current)
    measure()
  }, [containerRef, measure])

  // Re-measure after every commit: expanding a branch, a density change, or a
  // page swap all move the row count and can move the row height.
  useLayoutEffect(() => {
    measure()
  })

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    const onScroll = () => measure()
    scroller.addEventListener('scroll', onScroll, { passive: true })

    const observer = new ResizeObserver(() => measure())
    observer.observe(scroller)
    const container = containerRef.current
    if (container) observer.observe(container)

    return () => {
      scroller.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  }, [containerRef, measure])

  return {
    window: computeRowWindow({
      rowCount,
      rowHeight: geometry.rowHeight,
      viewportHeight: geometry.viewportHeight,
      scrollOffset: geometry.scrollOffset,
      overscan: OVERSCAN_ROWS,
    }),
    scrollerRef,
    rowHeight: geometry.rowHeight,
  }
}
