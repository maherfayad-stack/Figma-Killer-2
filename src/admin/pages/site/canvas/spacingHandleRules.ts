/**
 * spacingHandleRules — the on-canvas padding and gap handles (P5-E, IX-17):
 * where they are, and what a drag on one writes. Pure; the elements are
 * `CanvasSpacingHandles`, the gesture `useSpacingHandleDrag`.
 *
 * Penpot's flex controls (`ui/flex_controls/{padding,gap}.cljs`): a selected
 * flex or grid container shows a band for each padding side and one for each
 * gap between its children; dragging a band changes that value.
 *
 *   - ⇧ drags the AXIS PAIR of a padding (top + bottom, or left + right) —
 *     Penpot's `padding.cljs:166-167`;
 *   - ⌥ drags ALL FOUR paddings;
 *   - a gap band writes `columnGap` (between children side by side) or
 *     `rowGap` (between children stacked), so a flex row's handle never
 *     touches its wrapped lines' spacing and a grid's two axes stay apart.
 *
 * Every value is in the element's own CSS px — the drag is read in the
 * frame's document, whose pointer events are already un-zoomed (the same
 * property `useElementResizeDrag` documents) — rounded, and never negative.
 */

export type PaddingSide = 'top' | 'right' | 'bottom' | 'left'

export interface SpacingRect {
  x: number
  y: number
  width: number
  height: number
}

/** What a spacing layout read produces for the selected container. */
export interface SpacingGeometry {
  /** The container's border box, frame-local. */
  rect: SpacingRect
  padding: Record<PaddingSide, number>
  border: Record<PaddingSide, number>
  rowGap: number
  columnGap: number
  /** The in-flow children's boxes, frame-local, in tree order. */
  children: SpacingRect[]
}

export type SpacingBand =
  | { kind: 'padding'; side: PaddingSide; rect: SpacingRect; value: number }
  | { kind: 'gap'; axis: 'column' | 'row'; rect: SpacingRect; value: number }

export interface SpacingModifiers {
  /** ⇧ — the side and its opposite. */
  axisPair: boolean
  /** ⌥ — all four sides. */
  allSides: boolean
}

/** A band is never thinner than this on screen-independent frame px, so a `0` padding still has a handle. */
export const MIN_BAND_THICKNESS = 6

const OPPOSITE: Record<PaddingSide, PaddingSide> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }
const PADDING_PROPERTY: Record<PaddingSide, 'paddingTop' | 'paddingRight' | 'paddingBottom' | 'paddingLeft'> = {
  top: 'paddingTop',
  right: 'paddingRight',
  bottom: 'paddingBottom',
  left: 'paddingLeft',
}

/** Is the display one whose children a gap spaces (and whose padding the handles offer)? */
export function isSpacingLayout(display: string): boolean {
  return display.includes('flex') || display.includes('grid')
}

/**
 * The bands, RELATIVE to the container's border box (so they ride the handle
 * frame the overlay already positions on the selection ring). A padding band
 * spans the padding box's side; a gap band spans the space between two
 * consecutive children that sit side by side (column gap) or one above the
 * other (row gap), across the extent the two share.
 */
export function spacingBands(geometry: SpacingGeometry): SpacingBand[] {
  const { rect, padding, border } = geometry
  const innerWidth = Math.max(0, rect.width - border.left - border.right)
  const innerHeight = Math.max(0, rect.height - border.top - border.bottom)
  const thick = (value: number) => Math.max(MIN_BAND_THICKNESS, value)
  // The side bands run between the top and bottom ones, so a corner belongs
  // to exactly one handle.
  const sideTop = border.top + thick(padding.top)
  const sideHeight = Math.max(0, innerHeight - thick(padding.top) - thick(padding.bottom))
  const bands: SpacingBand[] = [
    { kind: 'padding', side: 'top', value: padding.top, rect: { x: border.left, y: border.top, width: innerWidth, height: thick(padding.top) } },
    {
      kind: 'padding',
      side: 'bottom',
      value: padding.bottom,
      rect: { x: border.left, y: rect.height - border.bottom - thick(padding.bottom), width: innerWidth, height: thick(padding.bottom) },
    },
    { kind: 'padding', side: 'left', value: padding.left, rect: { x: border.left, y: sideTop, width: thick(padding.left), height: sideHeight } },
    {
      kind: 'padding',
      side: 'right',
      value: padding.right,
      rect: { x: rect.width - border.right - thick(padding.right), y: sideTop, width: thick(padding.right), height: sideHeight },
    },
  ]

  const children = geometry.children
  for (let index = 1; index < children.length; index += 1) {
    const a = children[index - 1]!
    const b = children[index]!
    const sideBySide = b.x >= a.x + a.width - 0.5 && overlap(a.y, a.height, b.y, b.height) > 0
    const stacked = b.y >= a.y + a.height - 0.5 && overlap(a.x, a.width, b.x, b.width) > 0
    if (sideBySide) {
      const top = Math.min(a.y, b.y)
      const gap = b.x - (a.x + a.width)
      bands.push({
        kind: 'gap',
        axis: 'column',
        value: geometry.columnGap,
        rect: centredBand(a.x + a.width - rect.x, gap, top - rect.y, Math.max(a.y + a.height, b.y + b.height) - top, 'column'),
      })
    } else if (stacked) {
      const left = Math.min(a.x, b.x)
      const gap = b.y - (a.y + a.height)
      bands.push({
        kind: 'gap',
        axis: 'row',
        value: geometry.rowGap,
        rect: centredBand(a.y + a.height - rect.y, gap, left - rect.x, Math.max(a.x + a.width, b.x + b.width) - left, 'row'),
      })
    }
  }
  return bands
}

function overlap(startA: number, sizeA: number, startB: number, sizeB: number): number {
  return Math.min(startA + sizeA, startB + sizeB) - Math.max(startA, startB)
}

/** A gap band centred on the gap, at least `MIN_BAND_THICKNESS` thick. */
function centredBand(gapStart: number, gap: number, crossStart: number, crossSize: number, axis: 'column' | 'row'): SpacingRect {
  const thickness = Math.max(MIN_BAND_THICKNESS, gap)
  const along = gapStart + gap / 2 - thickness / 2
  return axis === 'column'
    ? { x: along, y: crossStart, width: thickness, height: crossSize }
    : { x: crossStart, y: along, width: crossSize, height: thickness }
}

/**
 * How far a drag of (`dx`, `dy`) grows the band's value: a padding grows as
 * its band is pulled INTO the box (down for the top side, left for the right
 * side …), a gap as its band is pulled along its axis.
 */
export function bandDelta(band: SpacingBand, dx: number, dy: number): number {
  if (band.kind === 'gap') return band.axis === 'column' ? dx : dy
  switch (band.side) {
    case 'top': return dy
    case 'bottom': return -dy
    case 'left': return dx
    case 'right': return -dx
  }
}

/**
 * The style patch a drag writes — React-style keys, `px` strings, whole
 * pixels, never negative. Every side the modifiers take moves by the SAME
 * delta from its own start value, so ⌥ on uneven paddings keeps their
 * differences (Penpot's behaviour).
 */
export function spacingPatch(
  band: SpacingBand,
  geometry: SpacingGeometry,
  dx: number,
  dy: number,
  modifiers: SpacingModifiers,
): Record<string, string> {
  const delta = bandDelta(band, dx, dy)
  const px = (value: number) => `${Math.max(0, Math.round(value + delta))}px`
  if (band.kind === 'gap') {
    return band.axis === 'column' ? { columnGap: px(geometry.columnGap) } : { rowGap: px(geometry.rowGap) }
  }
  const sides: PaddingSide[] = modifiers.allSides
    ? ['top', 'right', 'bottom', 'left']
    : modifiers.axisPair
      ? [band.side, OPPOSITE[band.side]]
      : [band.side]
  const patch: Record<string, string> = {}
  for (const side of sides) patch[PADDING_PROPERTY[side]] = px(geometry.padding[side])
  return patch
}
