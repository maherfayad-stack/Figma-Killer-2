/**
 * layoutConversion (PA-7 / PA-8) — "Add auto layout" and "Remove auto layout
 * (keep positions)" on a container: read the live frame once, plan with the
 * pure `layoutConversionPatches.ts`, and hand ONE `convertLayout` write to the
 * store. Nothing about where a child sits is guessed — the rects come from the
 * frame that renders the container.
 *
 * Portal frames only (`findRenderedCanvasElements`): a live (Tier 2) frame's
 * DOM is cross-origin, and it answers with a named reason instead of a guess.
 */
import { containingBlockBoxOf } from '@core/studio-runtime'
import { pushToast } from '@ui/components/Toast'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { findRenderedCanvasElements, presentedElementForNode } from './canvasNodeLookup'
import {
  planAddAutoLayout,
  planFreezePositions,
  type BoxSides,
  type ConversionPlan,
  type MeasuredBox,
} from './layoutConversionPatches'

const UNMEASURABLE =
  'This frame is rendered by the project itself, so Studio cannot measure where the layers sit. Switch the board to the editable canvas to change auto layout.'

const px = (value: string) => {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function sides(style: CSSStyleDeclaration, prefix: 'margin' | 'padding'): BoxSides {
  const read = (edge: 'top' | 'right' | 'bottom' | 'left') => px(style.getPropertyValue(`${prefix}-${edge}`))
  return { top: read('top'), right: read('right'), bottom: read('bottom'), left: read('left') }
}

function borderSides(style: CSSStyleDeclaration): BoxSides {
  return {
    top: px(style.borderTopWidth),
    right: px(style.borderRightWidth),
    bottom: px(style.borderBottomWidth),
    left: px(style.borderLeftWidth),
  }
}

type Measured = { ok: true; parent: MeasuredBox; children: MeasuredBox[] } | { ok: false; reason: string }

/** The container and its children as the frame draws them, in CSS px (an ancestor `scale()` divided out). */
function measure(parentId: string, childIds: readonly string[], inlineOf: (nodeId: string) => Readonly<Record<string, unknown>>, breakpointId: string): Measured {
  const rendered = findRenderedCanvasElements(parentId)
  const found = rendered.find((entry) => entry.frame.getAttribute('data-breakpoint-id') === breakpointId) ?? rendered[0]
  const doc = found?.element.ownerDocument
  const view = doc?.defaultView
  if (!found || !doc || !view) return { ok: false, reason: UNMEASURABLE }
  const parentElement = presentedElementForNode(doc, parentId) ?? found.element
  const scale = containingBlockBoxOf(view, parentElement).scale || 1

  const read = (nodeId: string, element: HTMLElement): MeasuredBox => {
    const style = view.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return {
      nodeId,
      rect: { x: rect.left / scale, y: rect.top / scale, width: rect.width / scale, height: rect.height / scale },
      position: style.position,
      display: style.display,
      boxSizing: style.boxSizing,
      margin: sides(style, 'margin'),
      padding: sides(style, 'padding'),
      border: borderSides(style),
      inline: inlineOf(nodeId),
    }
  }
  const children = childIds.flatMap((nodeId) => {
    const element = presentedElementForNode(doc, nodeId)
    return element ? [read(nodeId, element)] : []
  })
  return { ok: true, parent: read(parentId, parentElement), children }
}

function convert(parentId: string, plan: (parent: MeasuredBox, children: readonly MeasuredBox[]) => ConversionPlan): void {
  const state = useEditorStore.getState()
  const tree = selectActiveCanvasPage(state)
  const parent = tree?.nodes[parentId]
  if (!tree || !parent) return
  const inlineOf = (nodeId: string) => tree.nodes[nodeId]?.inlineStyles || {}
  const measured = measure(parentId, parent.children, inlineOf, state.activeBreakpointId)
  if (!measured.ok) {
    pushToast({ kind: 'info', title: 'Auto layout', body: measured.reason })
    return
  }
  const result = plan({ ...measured.parent, inline: parent.inlineStyles ?? {} }, measured.children)
  const outcome = state.convertLayout({
    parentId,
    parentPatch: result.parentPatch,
    childPatches: result.childPatches,
    ...(result.order ? { order: result.order } : {}),
  })
  if (outcome === 'applied' && !result.exact) {
    pushToast({
      kind: 'info',
      title: 'Auto layout',
      body: 'These layers are not evenly spaced or aligned, so a few move slightly to fit one gap. Undo if you want them where they were.',
    })
  }
}

/** ⇧A on a container: flex with the direction, gap, padding, alignment and wrap its children already have. */
export function addAutoLayout(parentId: string): void {
  convert(parentId, planAddAutoLayout)
}

/** Remove auto layout: every child is pinned where it sits now. */
export function removeAutoLayoutKeepPositions(parentId: string): void {
  convert(parentId, planFreezePositions)
}
