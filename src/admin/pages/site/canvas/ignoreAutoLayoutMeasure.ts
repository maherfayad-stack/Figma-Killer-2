/**
 * ignoreAutoLayoutMeasure (PA-4) — the DOM half of "Ignore auto layout": the
 * facts about the live frame that the tree cannot hold, read once when the
 * toggle is pressed and handed to `setIgnoreAutoLayout`.
 *
 *   - on: where the child sits NOW against its container's padding box (via
 *     `containingBlockOffsets`, so a border, a scroll or a zoomed ancestor is
 *     accounted for, and the child's own margin — `left` places the margin
 *     edge — is taken off), and whether the container already contains an
 *     absolute child.
 *   - off: whether anything else in the container still needs it positioned,
 *     so the `position: relative` this gesture added can go with the child.
 *
 * Portal frames only (`findRenderedCanvasElements`): a live (Tier 2) frame's
 * DOM is cross-origin, and it answers with a named reason instead of a guess.
 */
import {
  containingBlockBoxOf,
  containingBlockOffsets,
  establishesContainingBlock,
  isOutOfFlow,
} from '@core/studio-runtime'
import { findRenderedCanvasElements, presentedElementForNode } from './canvasNodeLookup'

/** Above this many descendants the container is not scanned and its `relative` stays. */
const MAX_SCANNED_DESCENDANTS = 2000

export type IgnoreAutoLayoutMeasure =
  | { ok: true; parentContains: boolean; offsets: { left: number; top: number }; releaseParent: boolean }
  | { ok: false; reason: string }

const UNMEASURABLE =
  'This frame is rendered by the project itself, so Studio cannot measure where the layer sits. Switch the board to the editable canvas.'

const px = (value: string) => {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function measureIgnoreAutoLayout(
  nodeId: string,
  parentNodeId: string,
  activeBreakpointId: string,
): IgnoreAutoLayoutMeasure {
  const rendered = findRenderedCanvasElements(nodeId)
  const found = rendered.find((entry) => entry.frame.getAttribute('data-breakpoint-id') === activeBreakpointId) ?? rendered[0]
  const doc = found?.element.ownerDocument
  const view = doc?.defaultView
  if (!found || !doc || !view) return { ok: false, reason: UNMEASURABLE }

  const element = presentedElementForNode(doc, nodeId) ?? found.element
  const parentElement = presentedElementForNode(doc, parentNodeId)
  if (!parentElement) return { ok: false, reason: UNMEASURABLE }

  const own = view.getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  const offsets = containingBlockOffsets(
    { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    containingBlockBoxOf(view, parentElement),
  )

  const parentStyle = view.getComputedStyle(parentElement)
  let releaseParent = parentStyle.zIndex === 'auto'
  if (releaseParent) {
    const descendants = parentElement.querySelectorAll<HTMLElement>('*')
    releaseParent = descendants.length <= MAX_SCANNED_DESCENDANTS
    for (const descendant of descendants) {
      if (!releaseParent) break
      if (descendant === element || element.contains(descendant)) continue
      if (isOutOfFlow(view.getComputedStyle(descendant).position)) releaseParent = false
    }
  }

  return {
    ok: true,
    parentContains: establishesContainingBlock(parentStyle),
    // `left` / `top` place the MARGIN edge, the rect is the border box.
    offsets: { left: offsets.left - Math.round(px(own.marginLeft)), top: offsets.top - Math.round(px(own.marginTop)) },
    releaseParent,
  }
}
