/**
 * canvasSnapPeers — what an element snaps TO: its siblings, and its parent's
 * own edges and centre (P2-E / IX-5b).
 *
 * K6 snapped a free move to siblings only. An element dragged towards the
 * edge of its container found nothing to align with, which is the first
 * thing a designer reaches for ("flush left", "centred in the card"). Penpot
 * snaps to the parent frame's edges and centre (`main/snap.cljs`, frame snap
 * points); so does Figma.
 *
 * ## Which parent box
 *
 * Two, collapsed to one when they coincide:
 *
 *  - the **padding box** — inside the border. It is where `left: 0` lands for
 *    an absolutely positioned child, and the parent's visible inner edge;
 *  - the **content box** — inside the padding. It is where the parent's flow
 *    children start, so "align with the text in this card" is a snap here.
 *
 * Both share a centre, so a centred element snaps once either way. The border
 * box (outside the border) is not offered: snapping there writes `left: -1px`
 * on a bordered parent, which nobody means.
 *
 * ## Ruler guides, in a frame's space (P5-F, IX-5c)
 *
 * Ruler guides are persisted in BOARD space; an element's rects are in its
 * frame's space. {@link guideLinesInSpace} converts one into the other through
 * the client coordinates both can be expressed in: the board's origin on
 * screen (the transform layer's own rect — its `transform-origin` is `0 0`, so
 * its rect's top-left IS board (0, 0) at any pan and zoom) and the frame
 * space's origin and scale. Read once per gesture: a drag never pans the
 * frame relative to the board, so the converted lines hold for its length.
 *
 * Pure except {@link readBoxInsets} and {@link readBoardScreenOrigin}, the
 * reads taken once at the start of a gesture.
 */
import { canvasTransformLayerOf, canvasZoomOf } from './canvasZoom'
import type { SnapLine, SnapRect } from './boardSnapping'

/** One set of four side lengths, in CSS px. */
export interface SideLengths {
  top: number
  right: number
  bottom: number
  left: number
}

/** A box's border and padding widths, in CSS px — what separates its three boxes. */
export interface BoxInsets {
  border: SideLengths
  padding: SideLengths
}

const ZERO_SIDES: SideLengths = { top: 0, right: 0, bottom: 0, left: 0 }

function inset(rect: SnapRect, sides: SideLengths): SnapRect {
  return {
    x: rect.x + sides.left,
    y: rect.y + sides.top,
    width: Math.max(0, rect.width - sides.left - sides.right),
    height: Math.max(0, rect.height - sides.top - sides.bottom),
  }
}

function sameRect(a: SnapRect, b: SnapRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * The parent's snap rects: its padding box and, when padding makes it
 * different, its content box. `borderRect` is the parent's rendered border
 * box, in the same space as the dragged element's rect.
 */
export function parentSnapRects(borderRect: SnapRect, insets: BoxInsets): SnapRect[] {
  const paddingBox = inset(borderRect, insets.border)
  const contentBox = inset(paddingBox, insets.padding)
  return sameRect(paddingBox, contentBox) ? [paddingBox] : [paddingBox, contentBox]
}

function px(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * The element's border and padding widths from its computed style. A box-less
 * element (`display: contents`, a module's layout-transparent host) computes
 * padding it does not render; it has no box, so it reads as all zeros — the
 * same answer `nodeVisualRect`'s child-union rect needs.
 */
export function readBoxInsets(view: Window, element: Element): BoxInsets {
  const style = view.getComputedStyle(element)
  if (style.display === 'contents') return { border: ZERO_SIDES, padding: ZERO_SIDES }
  return {
    border: {
      top: px(style.borderTopWidth),
      right: px(style.borderRightWidth),
      bottom: px(style.borderBottomWidth),
      left: px(style.borderLeftWidth),
    },
    padding: {
      top: px(style.paddingTop),
      right: px(style.paddingRight),
      bottom: px(style.paddingBottom),
      left: px(style.paddingLeft),
    },
  }
}

/** Where a coordinate space's (0, 0) is on screen, and how many client px one of its units is. */
export interface ScreenSpace {
  originX: number
  originY: number
  scale: number
}

/**
 * Board-space lines (`rulerGuideLines`) in another space — a frame's, where
 * the dragged element's rects are. Both spaces are given as their screen
 * origin and scale; see the module doc.
 */
export function guideLinesInSpace(lines: readonly SnapLine[], board: ScreenSpace, space: ScreenSpace): SnapLine[] {
  const scale = space.scale > 0 ? space.scale : 1
  return lines.map((line) => {
    const client = line.axis === 'x'
      ? board.originX + line.position * board.scale
      : board.originY + line.position * board.scale
    const origin = line.axis === 'x' ? space.originX : space.originY
    return { axis: line.axis, position: (client - origin) / scale }
  })
}

/**
 * The board's screen space, read off the canvas transform layer `element`
 * sits in (a frame's viewport or iframe). `null` outside a board canvas — a
 * live view, a test — where there are no ruler guides to convert.
 */
export function readBoardScreenOrigin(element: Element | null): ScreenSpace | null {
  if (!(element instanceof HTMLElement)) return null
  const layer = canvasTransformLayerOf(element)
  if (!layer) return null
  const rect = layer.getBoundingClientRect()
  return { originX: rect.left, originY: rect.top, scale: canvasZoomOf(layer) }
}
