/**
 * canvasTextEditStart — open a canvas text edit from the keyboard or a tool,
 * not from a double-click (P5-E): ⏎ on a text layer (IX-7) and the text
 * tool's new text (IX-12).
 *
 * The double-click path starts the session from inside the frame that was
 * clicked, so it always knows WHICH rendering to make editable — the board
 * frame id and the breakpoint the session is keyed on
 * (`isInlineEditSessionFor`). A keyboard or tool start knows only a node id,
 * so it resolves them first:
 *
 *   - the frame the caller names (the text tool knows the frame it drew in);
 *   - else the selection's own frame (`selectedNodeFrameId`, set by a canvas
 *     click);
 *   - else the one mounted board frame whose document renders the node (a
 *     selection made in the Layers panel carries no frame).
 *
 * A session whose frame / breakpoint match NO rendering would arm the
 * `inline-edit` rung over nothing editable — every key swallowed until
 * Escape — so when the rendering cannot be found, no session is opened.
 * Portal frames only: a live bridge frame's text edit is started by its own
 * runtime (`live-18`); there the gesture just does not open an edit (a
 * double-click still does).
 */
import { registry } from '@core/module-engine'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { isBridgeFrameAdapter } from './frameAdapter/BridgeFrameAdapter'
import { listFrameAdapters } from './frameAdapter/canvasFrameAdapterRegistry'
import { isPortalFrameAdapter } from './frameAdapter/PortalFrameAdapter'
import { escapeCssAttributeValue } from './escapeCssAttributeValue'

/** Where a text edit opens: the board frame (`null` outside a board) and the breakpoint of the frame's viewport. */
export interface TextEditRendering {
  frameId: string | null
  breakpointId: string
}

/**
 * The portal frame rendering `nodeId` — preferring board frame `frameId` when
 * given. `null` when no portal frame renders it, or the frame renders through
 * a live bridge.
 */
export function findTextEditRendering(nodeId: string, frameId: string | null): TextEditRendering | null {
  const selector = `[data-node-id="${escapeCssAttributeValue(nodeId)}"]`
  let fallback: TextEditRendering | null = null
  for (const [iframe, adapter] of listFrameAdapters()) {
    const wrapper = iframe.closest<HTMLElement>('[data-frame-id]')
    const wrapperFrameId = wrapper?.dataset.frameId ?? null
    if (frameId !== null && wrapperFrameId !== frameId) continue
    // A frame that renders through a live bridge has its own text editing.
    if (isBridgeFrameAdapter(adapter)) return null
    if (!isPortalFrameAdapter(adapter)) continue
    const doc = adapter.getPortalWindow()?.document
    if (!doc?.querySelector(selector)) continue
    const breakpointId = iframe.getAttribute('data-breakpoint-id') ?? useEditorStore.getState().activeBreakpointId
    const rendering = { frameId: wrapperFrameId, breakpointId }
    if (frameId !== null) return rendering
    fallback ??= rendering
  }
  return fallback
}

/**
 * Start a text edit on `nodeId`. `false` — and no session — when it is not a
 * text layer, no portal frame renders it, or `startInlineEdit` refuses (a
 * text set in code says so out loud).
 */
export function startCanvasTextEdit(nodeId: string, preferredFrameId?: string | null): boolean {
  const state = useEditorStore.getState()
  const node = selectActiveCanvasPage(state)?.nodes[nodeId]
  if (!node || !registry.get(node.moduleId)?.inlineTextEdit) return false
  const rendering = findTextEditRendering(nodeId, preferredFrameId ?? state.selectedNodeFrameId)
  if (!rendering) return false
  return state.startInlineEdit(nodeId, rendering.breakpointId, rendering.frameId)
}
