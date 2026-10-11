/**
 * canvasMeasureGeometry — the pure math behind the Alt-hover measurement
 * overlay (`MeasureLayer.tsx`, work order K5).
 *
 * Everything here is a total function over plain numbers: two rects in, the
 * segments and bands to draw out. No DOM, no store, no React — so the
 * awkward cases (overlap, containment, exact touching, a selection that
 * sticks out of the hovered box) are unit-testable without an iframe, which
 * is the only way to test them at all (canvas DOM lives inside iframes and
 * happy-dom has no layout).
 *
 * ## The four distances
 *
 * Figma draws, for each axis, either ONE gap (the two boxes are disjoint on
 * that axis) or TWO insets (they overlap on that axis — the usual "hovered
 * element contains the selection" case). That is the whole rule, applied
 * once per axis, which is why {@link measureRectDistances} returns between
 * two and four segments rather than always four:
 *
 * - disjoint on X  → one `left` OR one `right` segment, `gap: true`,
 *   running from the selection's facing edge to the hovered box's facing
 *   edge (the empty space between them).
 * - overlapping on X → a `left` and a `right` segment, `gap: false`,
 *   each running from the selection's edge to the hovered box's SAME-SIDE
 *   edge (the inset). A selection that sticks out past the hovered box
 *   simply produces a segment that runs the other way; `distance` is the
 *   absolute length either way, so the pill never shows a negative number.
 *
 * Same, transposed, for Y.
 *
 * The cross-axis coordinate a segment is drawn at is the centre of the two
 * boxes' overlap on the OTHER axis when they overlap there, and the
 * selection's own centre when they don't — so a nested measurement runs
 * through the middle of the shared band instead of clipping the corner.
 *
 * ## Coordinate space
 *
 * Whatever space the caller measured the two rects in. `MeasureLayer` works
 * in the frame document's own coordinates (the space the in-iframe overlay
 * root paints in) and projects to canvas-root coordinates only for the
 * parent-document fallback — so the NUMBERS on the pills are always CSS px
 * in the user's page, never zoom-multiplied screen px.
 */

export interface MeasureRect {
  x: number
  y: number
  width: number
  height: number
}

export type MeasureSide = 'left' | 'right' | 'top' | 'bottom'

export interface MeasureSegment {
  side: MeasureSide
  axis: 'horizontal' | 'vertical'
  /** Segment start (on the SELECTION's edge) in the caller's coordinate space. */
  x1: number
  y1: number
  /** Segment end (on the HOVERED box's edge). */
  x2: number
  y2: number
  /** Length in CSS px. Never negative — direction is carried by the endpoints. */
  distance: number
  /**
   * `true` when the two boxes are disjoint on this segment's axis, so the
   * segment spans empty space between facing edges. `false` when they
   * overlap and the segment is an inset between same-side edges.
   */
  gap: boolean
}

export interface MeasurePadding {
  top: number
  right: number
  bottom: number
  left: number
}

export interface MeasurePaddingBand {
  side: MeasureSide
  rect: MeasureRect
  /** The padding value in CSS px. Bands with a zero value are not emitted. */
  value: number
}

interface AxisSpan {
  start: number
  end: number
}

/** Sub-pixel layout reads are real; two decimals is the finest a pill can honestly show. */
function roundPx(value: number): number {
  return Math.round(value * 100) / 100
}

function spanX(rect: MeasureRect): AxisSpan {
  return { start: rect.x, end: rect.x + rect.width }
}

function spanY(rect: MeasureRect): AxisSpan {
  return { start: rect.y, end: rect.y + rect.height }
}

/**
 * One axis of the rule in the module doc: a gap when disjoint, two insets
 * when overlapping. `from` is always on the selection, `to` always on the
 * hovered box.
 */
function axisSegments(
  selection: AxisSpan,
  hovered: AxisSpan,
): Array<{ side: 'start' | 'end'; from: number; to: number; gap: boolean }> {
  if (hovered.end <= selection.start) {
    return [{ side: 'start', from: selection.start, to: hovered.end, gap: true }]
  }
  if (hovered.start >= selection.end) {
    return [{ side: 'end', from: selection.end, to: hovered.start, gap: true }]
  }
  return [
    { side: 'start', from: selection.start, to: hovered.start, gap: false },
    { side: 'end', from: selection.end, to: hovered.end, gap: false },
  ]
}

/** Centre of the two spans' overlap, or the selection's own centre when they don't overlap. */
function crossCoordinate(selection: AxisSpan, hovered: AxisSpan): number {
  const start = Math.max(selection.start, hovered.start)
  const end = Math.min(selection.end, hovered.end)
  if (end > start) return (start + end) / 2
  return (selection.start + selection.end) / 2
}

/**
 * The distance segments from `selection` to `hovered` — two when the boxes
 * are disjoint on both axes, four when they overlap on both (containment),
 * three in the mixed case. See the module doc for the rule.
 */
export function measureRectDistances(
  selection: MeasureRect,
  hovered: MeasureRect,
): MeasureSegment[] {
  const selX = spanX(selection)
  const selY = spanY(selection)
  const hovX = spanX(hovered)
  const hovY = spanY(hovered)
  const lineY = crossCoordinate(selY, hovY)
  const lineX = crossCoordinate(selX, hovX)

  const segments: MeasureSegment[] = []
  for (const part of axisSegments(selX, hovX)) {
    segments.push({
      side: part.side === 'start' ? 'left' : 'right',
      axis: 'horizontal',
      x1: part.from,
      y1: lineY,
      x2: part.to,
      y2: lineY,
      distance: roundPx(Math.abs(part.to - part.from)),
      gap: part.gap,
    })
  }
  for (const part of axisSegments(selY, hovY)) {
    segments.push({
      side: part.side === 'start' ? 'top' : 'bottom',
      axis: 'vertical',
      x1: lineX,
      y1: part.from,
      x2: lineX,
      y2: part.to,
      distance: roundPx(Math.abs(part.to - part.from)),
      gap: part.gap,
    })
  }
  return segments
}

/** The rect a segment is painted as: a 1px-thick band along its own axis. */
export function measureSegmentRect(segment: MeasureSegment, thickness: number = 1): MeasureRect {
  if (segment.axis === 'horizontal') {
    return {
      x: Math.min(segment.x1, segment.x2),
      y: segment.y1 - thickness / 2,
      width: Math.abs(segment.x2 - segment.x1),
      height: thickness,
    }
  }
  return {
    x: segment.x1 - thickness / 2,
    y: Math.min(segment.y1, segment.y2),
    width: thickness,
    height: Math.abs(segment.y2 - segment.y1),
  }
}

/** Midpoint of a segment — where its numeric pill is centred. */
export function measureSegmentMidpoint(segment: MeasureSegment): { x: number; y: number } {
  return { x: (segment.x1 + segment.x2) / 2, y: (segment.y1 + segment.y2) / 2 }
}

/**
 * `padding-*` computed-style strings (as the frame adapter's `measure`
 * returns them) as numbers. A value that doesn't parse — `auto`, an empty
 * string from a node the frame doesn't render — is 0, which is also what it
 * paints as.
 */
export function parseMeasurePadding(computedStyle: Record<string, string>): MeasurePadding {
  const read = (property: string): number => {
    const value = Number.parseFloat(computedStyle[property] ?? '')
    return Number.isFinite(value) && value > 0 ? roundPx(value) : 0
  }
  return {
    top: read('padding-top'),
    right: read('padding-right'),
    bottom: read('padding-bottom'),
    left: read('padding-left'),
  }
}

/** `rect` minus its padding, never inverted (a padding larger than the box collapses to 0). */
export function measureContentBox(rect: MeasureRect, padding: MeasurePadding): MeasureRect {
  const width = Math.max(0, rect.width - padding.left - padding.right)
  const height = Math.max(0, rect.height - padding.top - padding.bottom)
  return {
    x: rect.x + Math.min(padding.left, rect.width),
    y: rect.y + Math.min(padding.top, rect.height),
    width,
    height,
  }
}

/**
 * The four painted padding bands, Figma's layout: top and bottom span the
 * full width, left and right fill only the gap between them. Sides with no
 * padding are omitted, so an element with none produces an empty array and
 * the layer draws nothing.
 */
export function measurePaddingBands(
  rect: MeasureRect,
  padding: MeasurePadding,
): MeasurePaddingBand[] {
  const content = measureContentBox(rect, padding)
  const bands: MeasurePaddingBand[] = []
  if (padding.top > 0) {
    bands.push({
      side: 'top',
      value: padding.top,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: Math.min(padding.top, rect.height) },
    })
  }
  if (padding.bottom > 0) {
    const height = Math.min(padding.bottom, rect.height)
    bands.push({
      side: 'bottom',
      value: padding.bottom,
      rect: { x: rect.x, y: rect.y + rect.height - height, width: rect.width, height },
    })
  }
  if (padding.left > 0) {
    bands.push({
      side: 'left',
      value: padding.left,
      rect: { x: rect.x, y: content.y, width: Math.min(padding.left, rect.width), height: content.height },
    })
  }
  if (padding.right > 0) {
    const width = Math.min(padding.right, rect.width)
    bands.push({
      side: 'right',
      value: padding.right,
      rect: { x: rect.x + rect.width - width, y: content.y, width, height: content.height },
    })
  }
  return bands
}

/** Centre of a band — where its numeric pill goes. */
export function measureBandMidpoint(band: MeasurePaddingBand): { x: number; y: number } {
  return { x: band.rect.x + band.rect.width / 2, y: band.rect.y + band.rect.height / 2 }
}

/**
 * The number on a pill. Integers stay integers (the overwhelming majority of
 * real layouts); anything else keeps one decimal, because two decimals of
 * sub-pixel noise on a 1em-wide pill is unreadable and never actionable.
 */
export function formatMeasureDistance(distance: number): string {
  const rounded = Math.round(distance * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/**
 * The K5 ↔ tree-ladder coordination rule, in ONE place so the layer and
 * `CanvasTreeLadderOverlay` can never disagree about who owns Alt.
 *
 * Both gestures are "hold Alt and hover" and both fire immediately, so one
 * of them has to stand down. The split is by WHAT the pointer is over:
 *
 * - over a node that is NOT in the selection → **measurement wins**. The
 *   user is comparing two things; that is the only reading of Alt+hover
 *   that needs a selection to exist at all.
 * - over the selection itself, or with nothing selected → **the ladder
 *   wins**, i.e. its existing behaviour is completely unchanged. Picking an
 *   ancestor out of the ladder is what Alt+hover has always meant there,
 *   and measuring a box against itself is four zeros.
 *
 * Because the ladder is fully suppressed (not merely hidden) while
 * measurement owns the gesture, releasing Alt over another node commits
 * nothing — measuring must never change the selection out from under the
 * thing being measured.

 * With NO hover at all the ladder has nothing to anchor on, and measurement
 * takes that case too — against the selection's parent ({@link resolveMeasureTarget},
 * P2-E / IX-19). This predicate stays the hovered-node rule both layers share.
 */
export function measurementWinsOverTreeLadder(
  selectedNodeIds: readonly string[],
  hoveredNodeId: string | null,
): boolean {
  if (!hoveredNodeId) return false
  if (selectedNodeIds.length === 0) return false
  return !selectedNodeIds.includes(hoveredNodeId)
}

/**
 * What Alt measures the selection against (P2-E / IX-19), or `null` when
 * measurement does not own this Alt hold.
 *
 *  - a hovered node outside the selection → that node
 *    ({@link measurementWinsOverTreeLadder}, unchanged);
 *  - NO hovered node → the selection's parent: Figma's and Penpot's "Alt with
 *    nothing under the pointer measures to the container"
 *    (`ui/measurements.cljs:370-381`). With several layers selected it is the
 *    nearest ancestor they all share.
 *
 * The parent fallback only applies while no node has been hovered during this
 * Alt hold (`hoverSeenDuringHold`). Once one has, the tree ladder is anchored
 * on it, and the pointer leaving the frame is how the user REACHES the
 * ladder's rows — measuring the parent there would pull the ladder out from
 * under the pointer on its way to a row.
 */
export function resolveMeasureTarget(input: {
  selectedNodeIds: readonly string[]
  hoveredNodeId: string | null
  hoverSeenDuringHold: boolean
  parentOf: (nodeId: string) => string | null
}): string | null {
  const { selectedNodeIds, hoveredNodeId, hoverSeenDuringHold, parentOf } = input
  if (measurementWinsOverTreeLadder(selectedNodeIds, hoveredNodeId)) return hoveredNodeId
  if (hoveredNodeId !== null || hoverSeenDuringHold || selectedNodeIds.length === 0) return null
  return sharedParent(selectedNodeIds, parentOf)
}

/** The nearest ancestor of every id in `ids` that is not itself one of them. */
function sharedParent(ids: readonly string[], parentOf: (nodeId: string) => string | null): string | null {
  const selected = new Set(ids)
  const ancestorsOf = (id: string): string[] => {
    const chain: string[] = []
    const seen = new Set<string>()
    for (let current = parentOf(id); current !== null && !seen.has(current); current = parentOf(current)) {
      seen.add(current)
      chain.push(current)
    }
    return chain
  }
  const [first, ...rest] = ids
  if (first === undefined) return null
  const restChains = rest.map((id) => new Set(ancestorsOf(id)))
  for (const candidate of ancestorsOf(first)) {
    if (selected.has(candidate)) continue
    if (restChains.every((chain) => chain.has(candidate))) return candidate
  }
  return null
}
