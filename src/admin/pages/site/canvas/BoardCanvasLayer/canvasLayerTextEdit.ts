/**
 * canvasLayerTextEdit — open a loose layer's text for editing in place (P5-G).
 *
 * A layer's nodes are not in the page tree and are never selected one by one,
 * so the page-side starters (`canvasTextEditStart.ts`, a double-click inside a
 * frame) do not reach them. The session itself is the ordinary inline edit
 * (`inlineEditSlice.ts`), keyed on the surface's `'studio'` breakpoint and the
 * layer's `canvas:<id>` page id — exactly the pair the layer's `NodeRenderer`s
 * match against — and the slice writes the finished text into the layer's
 * `.studio/canvas/<id>.tsx` as one undo entry.
 *
 * Two entries:
 *  - a double-click on a layer (`startLayerTextEditAtPoint`): the text node
 *    under the pointer, else the layer's root;
 *  - a text just drawn on the empty board (`placeDrawOnBoard`, through
 *    `whenLayerReady`): the layer's module is written and read back AFTER the
 *    gesture, so the session waits for the layer page to arrive.
 */
import { registry } from '@core/module-engine'
import { canvasLayerPageId } from '@core/studio-board'
import { canvasLayerRootNodeId } from '@site/store/slices/canvasLayerGestures'
import { useEditorStore } from '@site/store/store'
import { escapeCssAttributeValue } from '../escapeCssAttributeValue'
import { STUDIO_BREAKPOINT_ID } from './canvasLayerGeometry'

/** How long a freshly drawn layer may take to be written and read back before its edit is given up. */
const READY_TIMEOUT_MS = 15_000

/** Open `nodeId` (default: the layer's root) of `layerId` for editing. False — and no session — when it is not text. */
export function startLayerTextEdit(layerId: string, nodeId?: string, options?: { selectAll?: boolean }): boolean {
  const state = useEditorStore.getState()
  const pageId = canvasLayerPageId(layerId)
  const page = state.canvasLayerPages[pageId]
  if (!page) return false
  const target = nodeId ?? canvasLayerRootNodeId(page)
  const node = target ? page.nodes[target] : undefined
  if (!target || !node || !registry.get(node.moduleId)?.inlineTextEdit) return false
  return state.startInlineEdit(target, STUDIO_BREAKPOINT_ID, pageId, options)
}

/**
 * Run `ready` as soon as a just-created layer's module has been read back
 * (now, if it already has). Gives up quietly after {@link READY_TIMEOUT_MS}: a
 * write that never landed leaves no layer to act on.
 */
export function whenLayerReady(layerId: string, ready: () => void): void {
  const pageId = canvasLayerPageId(layerId)
  if (pageId in useEditorStore.getState().canvasLayerPages) {
    ready()
    return
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const unsubscribe = useEditorStore.subscribe((state) => {
    if (!(pageId in state.canvasLayerPages)) return
    unsubscribe()
    if (timer !== null) clearTimeout(timer)
    ready()
  })
  timer = setTimeout(unsubscribe, READY_TIMEOUT_MS)
}

/**
 * The editable text node of `layerId` under a client point: the deepest node
 * there that edits inline, else the layer's root. `surface` is the free-canvas
 * document; the iframe is scaled by the board zoom, so the point is converted
 * to its own CSS pixels first.
 */
export function layerTextNodeAt(surface: Document, layerId: string, client: { x: number; y: number }): string | undefined {
  const frame = surface.defaultView?.frameElement
  if (!(frame instanceof HTMLElement)) return undefined
  const rect = frame.getBoundingClientRect()
  const scale = frame.offsetWidth > 0 ? rect.width / frame.offsetWidth : 1
  const hit = surface.elementFromPoint((client.x - rect.left) / scale, (client.y - rect.top) / scale)
  const host = surface.querySelector(`[data-studio-layer-id="${escapeCssAttributeValue(layerId)}"]`)
  const page = useEditorStore.getState().canvasLayerPages[canvasLayerPageId(layerId)]
  for (let el = hit?.closest<HTMLElement>('[data-node-id]'); el && host?.contains(el); el = el.parentElement?.closest<HTMLElement>('[data-node-id]') ?? null) {
    const node = page?.nodes[el.dataset.nodeId ?? '']
    if (node && registry.get(node.moduleId)?.inlineTextEdit) return node.id
  }
  return undefined
}

/** A double-click on a loose layer: edit the text under the pointer. True when an edit opened. */
export function startLayerTextEditAtPoint(surface: Document | null, layerId: string, client: { x: number; y: number }): boolean {
  const nodeId = surface ? layerTextNodeAt(surface, layerId, client) : undefined
  return startLayerTextEdit(layerId, nodeId)
}
