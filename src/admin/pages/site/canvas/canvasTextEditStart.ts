/**
 * canvasTextEditStart — open a canvas text edit from the keyboard or a tool,
 * not from a double-click (P5-E): ⏎ on a text layer (IX-7) and the text
 * tool's new text (IX-12).
 *
 * The double-click path starts the session from inside the frame that was
 * clicked, so it always knows which frame renders the text. These two start
 * it from the SELECTION, so they must first make sure the frame showing it is
 * one whose text the editor can make editable: a live bridge frame's text
 * edit is started by its own runtime (`live-18`), and a session opened from
 * here over one would arm the `inline-edit` rung above a frame with nothing
 * editable in it — every key swallowed until Escape. There the gesture just
 * does not open an edit (a double-click still does).
 */
import { registry } from '@core/module-engine'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { isBridgeFrameAdapter } from './frameAdapter/BridgeFrameAdapter'
import { listFrameAdapters } from './frameAdapter/canvasFrameAdapterRegistry'

/** Whether board frame `frameId` (any frame, for `null`) renders through a live bridge. */
export function rendersThroughBridge(frameId: string | null): boolean {
  for (const [iframe, adapter] of listFrameAdapters()) {
    if (!isBridgeFrameAdapter(adapter)) continue
    if (frameId === null || iframe.closest('[data-frame-id]')?.getAttribute('data-frame-id') === frameId) return true
  }
  return false
}

/**
 * Start a text edit on `nodeId` in the selection's frame. `false` — and no
 * session — when it is not a text layer, its frame is a live bridge, or
 * `startInlineEdit` refuses (a text set in code says so out loud).
 */
export function startCanvasTextEdit(nodeId: string): boolean {
  const state = useEditorStore.getState()
  const node = selectActiveCanvasPage(state)?.nodes[nodeId]
  if (!node || !registry.get(node.moduleId)?.inlineTextEdit) return false
  if (rendersThroughBridge(state.selectedNodeFrameId)) return false
  return state.startInlineEdit(nodeId, state.activeBreakpointId, state.selectedNodeFrameId)
}
