/**
 * spacingHandleMeasure — the one layout read the padding / gap handles make
 * (P5-E, IX-17): the container's padding, border and gaps, and its in-flow
 * children's boxes, all in the frame's own CSS px.
 *
 * Portal frames only (the handles live in the in-frame overlay, like the
 * resize handles they sit beside). Children are read through
 * `presentedElementForNode` + `nodeVisualRect`, the same "which box IS this
 * layer" answers the rings use, so a `display: contents` host measures as the
 * union of what it renders instead of as zeros. An absolutely positioned or
 * `display: none` child takes no part in the gaps, so it is left out.
 */
import { nodeVisualRect } from './canvasDomGeometry'
import { presentedElementForNode } from './canvasNodeLookup'
import type { PaddingSide, SpacingGeometry, SpacingRect } from './spacingHandleRules'

function px(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function rectOf(element: Element): SpacingRect | null {
  const rect = nodeVisualRect(element as HTMLElement)
  return rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null
}

/** `null` when the element has no box to put handles on. */
export function readSpacingGeometry(
  doc: Document,
  element: HTMLElement,
  childIds: readonly string[],
): SpacingGeometry | null {
  const view = doc.defaultView
  const rect = rectOf(element)
  if (!view || !rect) return null
  const style = view.getComputedStyle(element)
  const sides: PaddingSide[] = ['top', 'right', 'bottom', 'left']
  const padding = Object.fromEntries(sides.map((side) => [side, px(style.getPropertyValue(`padding-${side}`))])) as Record<PaddingSide, number>
  const border = Object.fromEntries(sides.map((side) => [side, px(style.getPropertyValue(`border-${side}-width`))])) as Record<PaddingSide, number>
  const children: SpacingRect[] = []
  for (const childId of childIds) {
    const child = presentedElementForNode(doc, childId)
    if (!child) continue
    const childStyle = view.getComputedStyle(child)
    if (childStyle.display === 'none' || childStyle.position === 'absolute' || childStyle.position === 'fixed') continue
    const childRect = rectOf(child)
    if (childRect && childRect.width + childRect.height > 0) children.push(childRect)
  }
  return {
    rect,
    padding,
    border,
    // `normal` (no gap) parses to 0, which is what it lays out as.
    rowGap: px(style.rowGap),
    columnGap: px(style.columnGap),
    children,
  }
}
