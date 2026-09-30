/**
 * penPath — the pen tool's path while it is being drawn, and the `<svg>` it
 * becomes (P5-D, SVG-7).
 *
 * A pen session is a list of anchors in BOARD units — CSS pixels of the
 * frame, since iframe content is unscaled. Each anchor may carry an outgoing
 * handle (a drag on placement makes a smooth point) and the mirrored incoming
 * one. Segments between two corner anchors are `L`; any handle makes the
 * segment a `C`, with a missing handle collapsing onto its own anchor.
 *
 * Finishing writes a NEW inline `<svg>` sized to the drawn bounds, with the
 * path translated so the bounds sit at the stroke's half-width from (0, 0),
 * and owner decision D5's defaults: `fill="none" stroke="currentColor"
 * strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"` —
 * `currentColor` inherits the text colour, the idiomatic form in code.
 */
import { cubicBounds, formatPathNumber, unionRects, type Point, type Rect } from '@core/vector'

export interface PenAnchor {
  point: Point
  /** Outgoing handle (absolute). */
  out?: Point
  /** Incoming handle (absolute) — the reflection of `out` unless ⌥ broke it. */
  in?: Point
}

/** D5 — the stroke a drawn path gets. */
export const PEN_STROKE_WIDTH = 2

/** Decimals written for a drawn coordinate: a hundredth of a CSS pixel. */
const PEN_DECIMALS = 2

function fmt(p: Point, offset: Point): string {
  return `${formatPathNumber(p.x - offset.x, PEN_DECIMALS)} ${formatPathNumber(p.y - offset.y, PEN_DECIMALS)}`
}

function segmentCommand(from: PenAnchor, to: PenAnchor, offset: Point): string {
  if (!from.out && !to.in) return `L${fmt(to.point, offset)}`
  return `C${fmt(from.out ?? from.point, offset)} ${fmt(to.in ?? to.point, offset)} ${fmt(to.point, offset)}`
}

/** The path's `d`, every coordinate shifted by `-offset`. `closed` adds the segment back to the first anchor and `Z`. */
export function penPathData(anchors: readonly PenAnchor[], closed: boolean, offset: Point = { x: 0, y: 0 }): string {
  if (anchors.length === 0) return ''
  let d = `M${fmt(anchors[0]!.point, offset)}`
  for (let i = 1; i < anchors.length; i += 1) d += segmentCommand(anchors[i - 1]!, anchors[i]!, offset)
  if (closed && anchors.length > 2) d += `${segmentCommand(anchors[anchors.length - 1]!, anchors[0]!, offset)}Z`
  return d
}

/** The drawn geometry's bounds (curves included, handles excluded — the ink, not the scaffolding). */
export function penPathBounds(anchors: readonly PenAnchor[], closed: boolean): Rect | undefined {
  const rects: Rect[] = anchors.map((a) => ({ minX: a.point.x, minY: a.point.y, maxX: a.point.x, maxY: a.point.y }))
  const pairs: [PenAnchor, PenAnchor][] = []
  for (let i = 1; i < anchors.length; i += 1) pairs.push([anchors[i - 1]!, anchors[i]!])
  if (closed && anchors.length > 2) pairs.push([anchors[anchors.length - 1]!, anchors[0]!])
  for (const [from, to] of pairs) {
    if (from.out || to.in) rects.push(cubicBounds([from.point, from.out ?? from.point, to.in ?? to.point, to.point]))
  }
  return unionRects(rects)
}

/** A drag on placement: the outgoing handle at the pointer, the incoming mirrored — unless ⌥ keeps the incoming where it was. */
export function withDraggedHandle(anchor: PenAnchor, pointer: Point, breakSymmetry: boolean): PenAnchor {
  const mirrored = { x: 2 * anchor.point.x - pointer.x, y: 2 * anchor.point.y - pointer.y }
  return { point: anchor.point, out: pointer, in: breakSymmetry ? (anchor.in ?? anchor.point) : mirrored }
}

export interface PenSvgElement {
  /** Where the svg's top-left sits, in board units. */
  origin: Point
  width: number
  height: number
  props: Record<string, string | number>
  d: string
}

/**
 * The `<svg>` a finished path is written as, or `null` for fewer than two
 * anchors (nothing was drawn). Width and height are whole CSS pixels, so the
 * stroke is never clipped at a fractional edge.
 */
export function penSvgElement(anchors: readonly PenAnchor[], closed: boolean): PenSvgElement | null {
  if (anchors.length < 2) return null
  const bounds = penPathBounds(anchors, closed)
  if (!bounds) return null
  const pad = PEN_STROKE_WIDTH / 2
  const origin = { x: Math.floor(bounds.minX - pad), y: Math.floor(bounds.minY - pad) }
  const width = Math.max(1, Math.ceil(bounds.maxX + pad) - origin.x)
  const height = Math.max(1, Math.ceil(bounds.maxY + pad) - origin.y)
  return {
    origin,
    width,
    height,
    props: {
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: PEN_STROKE_WIDTH,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    },
    d: penPathData(anchors, closed, origin),
  }
}
