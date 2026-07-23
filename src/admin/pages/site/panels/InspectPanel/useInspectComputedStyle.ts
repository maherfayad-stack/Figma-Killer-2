/**
 * useInspectComputedStyle — resolves the selected node's REAL rendered
 * element inside a canvas iframe and reads its computed style.
 *
 * Deliberately a synchronous, render-time read (no `useEffect` + `useState`,
 * no RAF loop, no polling) — mirroring the existing
 * `useClassPickerDerivedState` pattern (`findRenderedCanvasNodeElement`
 * called straight from render). `getComputedStyle` is a pure read with no
 * side effects, so there's nothing to defer to an effect for.
 *
 * Recompute triggers: this only re-runs when the CALLER re-renders, and the
 * caller subscribes to exactly `selectedNodeId`, the selected node object,
 * and `activeBreakpointId` — so an unrelated store change never triggers an
 * extra DOM read. Within a render it recomputes because:
 *   - `selectedNodeId` changed (a different node is selected, or selection
 *     is cleared).
 *   - `selectedNode` object identity changed. The store's tree mutations go
 *     through Mutative, which produces a NEW object reference for a node
 *     whenever ANY of its own fields change (props, inlineStyles, classIds,
 *     label, ...) while leaving untouched siblings' references alone — so
 *     this fires exactly on "this node's own data changed", not on
 *     unrelated tree edits.
 *   - `activeBreakpointId` changed (switching device previews re-renders the
 *     frame at a different width, which can change computed values).
 *
 * Staleness caveat: a live edit to something the node's style *depends on*
 * but that isn't the node's own object — e.g. editing a shared class rule's
 * declarations, or an ancestor's inline style that this node inherits from
 * (font-family, color) — does NOT change this node's own object reference
 * and does NOT re-render this component, so the panel will not auto-refresh
 * for those edits until something re-renders it (e.g. re-selecting the
 * node).
 *
 * When multiple canvas frames have rendered the node (one per breakpoint),
 * the frame whose `data-breakpoint-id` matches the active breakpoint is
 * preferred; otherwise the first rendered match is used.
 */
import { findRenderedCanvasNodes } from '@site/canvas/canvasNodeLookup'
import type { ComputedStyleSnapshot } from './inspectModel'

function frameBodyElement(frame: HTMLIFrameElement): HTMLElement | null {
  try {
    return frame.contentDocument?.body ?? null
  } catch (_err) {
    // Cross-origin iframe (a plugin or dev tool surface) — never a canvas frame.
    return null
  }
}

function resolveElement(nodeId: string, activeBreakpointId: string): HTMLElement | null {
  const rendered = findRenderedCanvasNodes(nodeId)
  if (rendered.length === 0) return null
  const preferred = rendered.find(
    (entry) => frameBodyElement(entry.frame)?.getAttribute('data-breakpoint-id') === activeBreakpointId,
  )
  return (preferred ?? rendered[0]).element
}

function readComputedStyleSnapshot(element: HTMLElement): ComputedStyleSnapshot | null {
  const view = element.ownerDocument.defaultView
  if (!view) return null
  const cs = view.getComputedStyle(element)
  return {
    color: cs.color,
    backgroundColor: cs.backgroundColor,
    borderTopColor: cs.borderTopColor,
    borderRightColor: cs.borderRightColor,
    borderBottomColor: cs.borderBottomColor,
    borderLeftColor: cs.borderLeftColor,
    borderTopWidth: cs.borderTopWidth,
    borderRightWidth: cs.borderRightWidth,
    borderBottomWidth: cs.borderBottomWidth,
    borderLeftWidth: cs.borderLeftWidth,
    borderTopStyle: cs.borderTopStyle,
    borderRightStyle: cs.borderRightStyle,
    borderBottomStyle: cs.borderBottomStyle,
    borderLeftStyle: cs.borderLeftStyle,
    fontFamily: cs.fontFamily,
    fontSize: cs.fontSize,
    fontWeight: cs.fontWeight,
    lineHeight: cs.lineHeight,
    letterSpacing: cs.letterSpacing,
    width: cs.width,
    height: cs.height,
    marginTop: cs.marginTop,
    marginRight: cs.marginRight,
    marginBottom: cs.marginBottom,
    marginLeft: cs.marginLeft,
    paddingTop: cs.paddingTop,
    paddingRight: cs.paddingRight,
    paddingBottom: cs.paddingBottom,
    paddingLeft: cs.paddingLeft,
  }
}

/**
 * `node` is accepted only to document the recompute contract (see module
 * doc) — the caller passing a fresh reference on relevant changes is what
 * makes this re-run; the value's fields aren't read here.
 */
export function useInspectComputedStyle(
  nodeId: string | null,
  node: unknown,
  activeBreakpointId: string,
): ComputedStyleSnapshot | null {
  void node
  if (!nodeId) return null
  const element = resolveElement(nodeId, activeBreakpointId)
  if (!element) return null
  return readComputedStyleSnapshot(element)
}
