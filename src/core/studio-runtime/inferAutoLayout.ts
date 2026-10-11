/**
 * inferAutoLayout (PA-7) — what Figma's "Add auto layout" reads out of a frame
 * whose children already sit somewhere: which way they run, the gap between
 * them, how they align across that axis, whether they wrap, and the padding
 * that keeps the first child where it is. Pure: rects in, one description out.
 * `toggleFlexLayout` writes it as flex; `convertToFlow` uses `order` to put an
 * absolute free frame's children into source order.
 *
 * The inference is judged by one thing: the layout it describes puts every
 * child within a pixel of where it already is (`exact`). Where it cannot (an
 * uneven gap, a staggered row) it picks the closest honest answer and says so
 * through `exact: false` — the caller still writes it, as Figma does.
 *
 * All rects share one coordinate space. `inner` is the parent's PADDING box
 * (its border-box minus its border), the box the padding is measured from.
 */

export interface LayoutRect {
  x: number
  y: number
  width: number
  height: number
}

export interface InferredPadding {
  top: number
  right: number
  bottom: number
  left: number
}

export type CrossAlignment = 'flex-start' | 'center' | 'flex-end'

export interface InferredAutoLayout {
  direction: 'row' | 'column'
  wrap: boolean
  /** Gap along the main axis, in whole px, never negative. */
  gap: number
  /** Gap between wrapped lines (`gap` when the layout does not wrap). */
  lineGap: number
  /** Alignment across the main axis (`align-items`). */
  align: CrossAlignment
  padding: InferredPadding
  /** Indices into the input, in the order the layout will place them. */
  order: number[]
  /** `true` when every child is predicted within 1px of where it is now. */
  exact: boolean
}

/** Sub-pixel layouts put neighbours a fraction apart; this much is "the same". */
const TOLERANCE = 1

const bottomOf = (rect: LayoutRect) => rect.y + rect.height
const rightOf = (rect: LayoutRect) => rect.x + rect.width
const whole = (value: number) => Math.max(0, Math.round(value)) + 0

function transpose(rect: LayoutRect): LayoutRect {
  return { x: rect.y, y: rect.x, width: rect.height, height: rect.width }
}

/** Row-space padding (cross = top/bottom) back to the real top/right/bottom/left of a column. */
function unTranspose(padding: InferredPadding): InferredPadding {
  return { top: padding.left, left: padding.top, bottom: padding.right, right: padding.bottom }
}

/** Indices grouped into lines of vertically overlapping rects, top line first, each line left to right. */
function groupLines(rects: readonly LayoutRect[]): number[][] {
  const byTop = rects.map((_, index) => index).sort((a, b) => rects[a]!.y - rects[b]!.y || rects[a]!.x - rects[b]!.x)
  const lines: Array<{ top: number; bottom: number; members: number[] }> = []
  for (const index of byTop) {
    const rect = rects[index]!
    const line = lines.at(-1)
    if (line) {
      const overlap = Math.min(line.bottom, bottomOf(rect)) - Math.max(line.top, rect.y)
      // Joined when they share more than half of the shorter one's height.
      const shorter = Math.min(line.bottom - line.top, rect.height)
      if (overlap > shorter / 2 + 1e-6 || (shorter === 0 && overlap >= 0)) {
        line.members.push(index)
        line.top = Math.min(line.top, rect.y)
        line.bottom = Math.max(line.bottom, bottomOf(rect))
        continue
      }
    }
    lines.push({ top: rect.y, bottom: bottomOf(rect), members: [index] })
  }
  return lines.map((line) => line.members.sort((a, b) => rects[a]!.x - rects[b]!.x))
}

interface RowAnswer {
  wrap: boolean
  gap: number
  lineGap: number
  align: CrossAlignment
  /** Padding in ROW space: top/bottom are the cross axis, left/right the main axis. */
  padding: InferredPadding
  order: number[]
  exact: boolean
}

/** The row-space inference; a column layout is the same problem with x and y swapped. */
function inferRow(rects: readonly LayoutRect[], inner: LayoutRect, lines: number[][]): RowAnswer {
  const wrap = lines.length > 1
  const order = lines.flat()

  const gaps: number[] = []
  for (const line of lines) {
    for (let i = 1; i < line.length; i += 1) {
      gaps.push(rects[line[i]!]!.x - rightOf(rects[line[i - 1]!]!))
    }
  }
  const mean = gaps.length > 0 ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length : 0
  const gap = whole(mean)
  const gapSpread = gaps.length > 0 ? Math.max(...gaps) - Math.min(...gaps) : 0
  let exact = gapSpread <= TOLERANCE && (gaps.length === 0 || Math.min(...gaps) >= -TOLERANCE)

  const lineBounds = lines.map((line) => {
    const members = line.map((index) => rects[index]!)
    return { top: Math.min(...members.map((rect) => rect.y)), bottom: Math.max(...members.map(bottomOf)) }
  })
  const lineGaps: number[] = []
  for (let i = 1; i < lineBounds.length; i += 1) lineGaps.push(lineBounds[i]!.top - lineBounds[i - 1]!.bottom)
  const lineGap = lineGaps.length > 0 ? whole(lineGaps.reduce((sum, value) => sum + value, 0) / lineGaps.length) : gap
  if (lineGaps.length > 0 && Math.max(...lineGaps) - Math.min(...lineGaps) > TOLERANCE) exact = false

  // Cross alignment: whichever edge the children share, judged inside each line.
  const deviation = { start: 0, center: 0, end: 0 }
  lines.forEach((line, lineIndex) => {
    const bounds = lineBounds[lineIndex]!
    const middle = (bounds.top + bounds.bottom) / 2
    for (const index of line) {
      const rect = rects[index]!
      deviation.start = Math.max(deviation.start, Math.abs(rect.y - bounds.top))
      deviation.center = Math.max(deviation.center, Math.abs(rect.y + rect.height / 2 - middle))
      deviation.end = Math.max(deviation.end, Math.abs(bottomOf(rect) - bounds.bottom))
    }
  })
  let align: CrossAlignment = 'flex-start'
  let best = deviation.start
  if (deviation.center + 1e-6 < best) {
    align = 'center'
    best = deviation.center
  }
  if (deviation.end + 1e-6 < best) {
    align = 'flex-end'
    best = deviation.end
  }
  if (best > TOLERANCE) exact = false

  // Padding: the start edges are exact. A free space after the last child is
  // not padding (a fixed-size parent already has it), so an end edge keeps the
  // leftover only where the alignment depends on it.
  const members = order.map((index) => rects[index]!)
  const minX = Math.min(...members.map((rect) => rect.x))
  const maxRight = Math.max(...members.map(rightOf))
  const top = whole(lineBounds[0]!.top - inner.y)
  const left = whole(minX - inner.x)
  const leftoverRight = whole(rightOf(inner) - maxRight)
  const leftoverBottom = whole(bottomOf(inner) - lineBounds.at(-1)!.bottom)
  const right = wrap ? leftoverRight : Math.min(leftoverRight, left)
  let topPad = top
  let bottom = Math.min(leftoverBottom, top)
  if (!wrap && align === 'center') bottom = leftoverBottom
  if (!wrap && align === 'flex-end') {
    bottom = leftoverBottom
    topPad = Math.min(top, bottom)
  }
  return { wrap, gap, lineGap, align, padding: { top: topPad, right, bottom, left }, order, exact }
}

export function inferAutoLayout(childRects: readonly LayoutRect[], inner: LayoutRect): InferredAutoLayout {
  const empty: InferredAutoLayout = {
    direction: 'column',
    wrap: false,
    gap: 0,
    lineGap: 0,
    align: 'flex-start',
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    order: childRects.map((_, index) => index),
    exact: true,
  }
  if (childRects.length === 0) return empty

  // One child has no direction to read: a block stacks vertically, so a column.
  const rowLines = childRects.length > 1 ? groupLines(childRects) : null
  if (rowLines && rowLines.length < childRects.length) {
    return { direction: 'row', ...inferRow(childRects, inner, rowLines) }
  }
  const flipped = childRects.map(transpose)
  const byPosition = flipped.map((_, index) => index).sort((a, b) => flipped[a]!.x - flipped[b]!.x)
  const answer = inferRow(flipped, transpose(inner), [byPosition])
  return { direction: 'column', ...answer, padding: unTranspose(answer.padding), wrap: false, lineGap: answer.gap }
}
