/**
 * The slot a dragged Canvas-section row is dropped into, and the paint index it
 * means. Pure, so the arithmetic that once put a drop one slot off is a unit
 * test and not a feeling.
 *
 * The section lists loose layers FRONT first (row 0 is painted last, on top),
 * as Figma's Layers panel does; `reorderLayerPlacements` counts paint order,
 * lowest first. A "slot" is a gap between rows: slot `k` is above row `k`, and
 * slot `count` is below the last row.
 */

/** The slot nearest `pointerY`, given each row's `[top, bottom]` in display order (row midpoints decide). */
export function dropSlotAt(rowBounds: ReadonlyArray<{ top: number; bottom: number }>, pointerY: number): number {
  for (let index = 0; index < rowBounds.length; index += 1) {
    const { top, bottom } = rowBounds[index]!
    if (pointerY < (top + bottom) / 2) return index
  }
  return rowBounds.length
}

/**
 * Paint index (0 = lowest) a row dragged from display row `from` lands at when
 * dropped in `slot`, for `count` layers. Dropping in the slot directly above or
 * below its own row changes nothing.
 */
export function paintIndexForDrop(from: number, slot: number, count: number): number {
  // The row is lifted out first, so every slot below its own row shifts up by one.
  const displayIndex = slot > from ? slot - 1 : slot
  // Display index d in the list WITHOUT the row sits above `count - 1 - d` rows.
  return count - 1 - displayIndex
}
