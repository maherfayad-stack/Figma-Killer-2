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
 * A live bridge frame is cross-origin: its DOM cannot be searched for the node,
 * so the frame is named by the board frame that holds it (a ready bridge frame
 * is the only one on screen — its portal fallback unmounts) and the runtime is
 * asked to open the editor (`beginTextEdit`), waiting for the element to reach
 * its DOM if the write is still on its way. The typed text then comes back as
 * the runtime's `text:commit` (`useBridgeFrameInteraction.ts`).
 */
import { registry } from '@core/module-engine'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { isBridgeFrameAdapter } from './frameAdapter/BridgeFrameAdapter'
import { listFrameAdapters } from './frameAdapter/canvasFrameAdapterRegistry'
import type { FrameDocumentAdapter } from './frameAdapter/FrameDocumentAdapter'
import { isPortalFrameAdapter } from './frameAdapter/PortalFrameAdapter'
import { escapeCssAttributeValue } from './escapeCssAttributeValue'

/** Where a text edit opens: the board frame (`null` outside a board) and the breakpoint of the frame's viewport. */
export interface TextEditRendering {
  frameId: string | null
  breakpointId: string
  /** Set for a live bridge frame: the adapter that opens the editor inside the frame. */
  bridge?: FrameDocumentAdapter
}

/**
 * The frame rendering `nodeId` — preferring board frame `frameId` when given.
 * A ready live bridge frame is matched by `frameId` alone. `null` when nothing
 * renders it.
 */
export function findTextEditRendering(nodeId: string, frameId: string | null): TextEditRendering | null {
  const selector = `[data-node-id="${escapeCssAttributeValue(nodeId)}"]`
  let fallback: TextEditRendering | null = null
  for (const [iframe, adapter] of listFrameAdapters()) {
    const wrapper = iframe.closest<HTMLElement>('[data-frame-id]')
    const wrapperFrameId = wrapper?.dataset.frameId ?? null
    if (frameId !== null && wrapperFrameId !== frameId) continue
    if (isBridgeFrameAdapter(adapter)) {
      // Only a named, ready frame: a bridge frame cannot be searched for the
      // node, and one still booting is hidden behind its portal fallback.
      if (frameId === null || !adapter.isFrameReady()) continue
      return {
        frameId: wrapperFrameId,
        breakpointId: iframe.getAttribute('data-breakpoint-id') ?? useEditorStore.getState().activeBreakpointId,
        bridge: adapter,
      }
    }
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

type TextEditAttempt = 'started' | 'unrendered' | 'refused'

function attemptCanvasTextEdit(
  nodeId: string,
  preferredFrameId: string | null | undefined,
  options: { selectAll?: boolean } | undefined,
): TextEditAttempt {
  const state = useEditorStore.getState()
  const node = selectActiveCanvasPage(state)?.nodes[nodeId]
  if (!node || !registry.get(node.moduleId)?.inlineTextEdit) return 'refused'
  const rendering = findTextEditRendering(nodeId, preferredFrameId ?? state.selectedNodeFrameId)
  if (!rendering) return 'unrendered'
  const started = state.startInlineEdit(nodeId, rendering.breakpointId, rendering.frameId, options)
  if (started && rendering.bridge) {
    rendering.bridge.beginTextEdit(nodeId, useEditorStore.getState().activeInlineEdit?.initialValue ?? '')
  }
  return started ? 'started' : 'refused'
}

/**
 * Start a text edit on `nodeId`. `false` - and no session - when it is not a
 * text layer, no portal frame renders it, or `startInlineEdit` refuses (a
 * text set in code says so out loud). `selectAll` opens with the whole text
 * selected (the text tool's placeholder).
 */
export function startCanvasTextEdit(
  nodeId: string,
  preferredFrameId?: string | null,
  options?: { selectAll?: boolean },
): boolean {
  return attemptCanvasTextEdit(nodeId, preferredFrameId, options) === 'started'
}

/** How long a just-created text may take to reach its frame's DOM before the edit is given up. */
const RENDER_WAIT_MS = 4_000
const RENDER_POLL_MS = 30

/**
 * {@link startCanvasTextEdit} for a node the gesture has only just created.
 *
 * The follow-up runs the moment the store SELECTS the new node, which is a
 * render before the frame has painted it: no frame yet contains its element, so
 * "no portal frame renders it" was the answer and the text tool never opened
 * its edit (typed text went nowhere). The node is in the store, so it WILL be
 * rendered - poll (a timer, not rAF: a backgrounded tab never runs rAF) until
 * it is, then start. Gives up when the node leaves the selection, another edit
 * opened, or the wait runs out.
 */
export function startCanvasTextEditWhenRendered(
  nodeId: string,
  preferredFrameId?: string | null,
  options?: { selectAll?: boolean },
): void {
  const deadline = Date.now() + RENDER_WAIT_MS
  const attempt = () => {
    const state = useEditorStore.getState()
    if (state.activeInlineEdit || state.selectedNodeId !== nodeId) return
    const result = attemptCanvasTextEdit(nodeId, preferredFrameId, options)
    if (result === 'unrendered' && Date.now() < deadline) setTimeout(attempt, RENDER_POLL_MS)
  }
  attempt()
}
