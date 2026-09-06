/**
 * rowWindow — which slice of a flat row list is worth mounting.
 *
 * Uniform-height windowing: every Layers row is exactly `--tree-row-h` tall
 * (28px compact / 36px comfortable — `Tree/TreeRow.module.css`), so the visible
 * slice is arithmetic, not measurement. Rows outside the slice are replaced by
 * two spacer blocks whose heights sum to exactly what the missing rows would
 * have occupied, so the scrollbar never moves when the window does.
 *
 * The one rule that matters for correctness: **if we cannot measure, we do not
 * window.** A zero row height or a zero viewport (no scroll container found, a
 * headless renderer, a panel rendered outside its usual host) returns the full
 * range. Truncating a tree because layout was unavailable would be a
 * correctness bug traded for speed; rendering everything is merely slow.
 *
 * Pure function, no React, no DOM. Unit-tested in
 * `src/__tests__/panels/rowWindow.test.ts`.
 */

export interface RowWindowInput {
  rowCount: number
  /** Measured height of one row, in px. `0` means "not measured". */
  rowHeight: number
  /** Height of the scroll viewport, in px. `0` means "no scroller / not measured". */
  viewportHeight: number
  /**
   * How far the list's top edge sits ABOVE the viewport's top edge, in px.
   * Positive once the list has scrolled up past the top of the viewport;
   * negative while the list still starts below it.
   */
  scrollOffset: number
  /** Extra rows mounted beyond each edge, so a flick does not show blanks. */
  overscan: number
}

export interface RowWindow {
  /** First mounted row index (inclusive). */
  start: number
  /** Last mounted row index (exclusive). */
  end: number
  /** Height of the spacer standing in for rows before `start`. */
  padTopPx: number
  /** Height of the spacer standing in for rows after `end`. */
  padBottomPx: number
}

export function computeRowWindow(input: RowWindowInput): RowWindow {
  const { rowCount, rowHeight, viewportHeight, scrollOffset, overscan } = input

  if (rowCount <= 0) return { start: 0, end: 0, padTopPx: 0, padBottomPx: 0 }

  // Unmeasurable — mount everything rather than risk hiding rows. See the
  // module doc.
  if (!(rowHeight > 0) || !(viewportHeight > 0)) {
    return { start: 0, end: rowCount, padTopPx: 0, padBottomPx: 0 }
  }

  const firstVisible = Math.floor(scrollOffset / rowHeight)
  // +1 covers the partially-visible row at the bottom edge.
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + 1

  const start = clamp(firstVisible - overscan, 0, rowCount)
  const end = clamp(firstVisible + visibleCount + overscan, start, rowCount)

  return {
    start,
    end,
    padTopPx: start * rowHeight,
    padBottomPx: (rowCount - end) * rowHeight,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Nearest scrollable element at or above `element`, or `null` when there isn't
 * one.
 *
 * The Layers tree deliberately has NO scroller of its own — `StudioPagesTree`'s
 * page list is the single scroll container for the whole column (see
 * `DomPanel.module.css`), and several page subtrees share it. Both windowing
 * and drag auto-scroll have to be computed against that shared ancestor, which
 * is also why a page whose subtree has scrolled off screen mounts zero rows.
 */
export function findScrollContainer(element: HTMLElement | null): HTMLElement | null {
  let current = element
  while (current) {
    const overflowY = getComputedStyle(current).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return current
    current = current.parentElement
  }
  return null
}
