/**
 * layerCommands — the layer commands P5-E added, as plain functions of the
 * current selection: bring to front / send to back (IX-9), add / remove flex
 * layout (IX-10), copy / paste style (IX-props). Align is `layerAlign.ts`.
 *
 * ONE implementation, three callers: the keys (`useCanvasLayerCommandKeys`),
 * the palette (`spotlight/commands/layerArrange.ts`) and the right-click menu
 * (`LayerNodeContextMenu`). None of them re-derives a rule.
 */
import { getParent, type PageNode } from '@core/page-tree'
import { isAutoLayoutDisplay } from '@core/studio-runtime'
import { nodeAcceptsChildren } from '@core/module-engine'
import { pushToast } from '@ui/components/Toast'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { measureInRenderingFrame } from './canvasSelectionMeasure'
import { addAutoLayout, removeAutoLayoutKeepPositions } from './layoutConversion'
import { planWrapAutoLayout, type MeasuredBox } from './layoutConversionPatches'
import type { NodeRect } from './frameAdapter/FrameDocumentAdapter'

// ── Bring to front / send to back (IX-9) ─────────────────────────────────────

/**
 * FRONT is the last child: later siblings paint over earlier ones where they
 * overlap (absent a `z-index`), which is the only meaning "front" has in a DOM.
 * The Layers list shows it at the BOTTOM, because the list is code order.
 *
 * One layer moves with one `moveNode` — one write, one undo. Several layers
 * would be several moves that each shift the next one's anchor, which is the
 * chained case P3-D's sequence save exists for; until that lands, a
 * multi-selection says so instead of moving half of itself.
 */
export function moveSelectionToEnd(end: 'front' | 'back'): void {
  const store = useEditorStore.getState()
  const tree = selectActiveCanvasPage(store)
  const ids = store.selectedNodeIds.filter((id) => tree?.nodes[id] && id !== tree.rootNodeId)
  if (!tree || ids.length === 0) return
  if (ids.length > 1) {
    pushToast({
      kind: 'info',
      title: end === 'front' ? 'Bring to front' : 'Send to back',
      body: 'Select one layer at a time for now — moving several to the end is several writes that depend on each other.',
    })
    return
  }
  const [nodeId] = ids as [string]
  const parent = getParent(tree, nodeId)
  if (!parent) return
  const from = parent.children.indexOf(nodeId)
  // `moveNode`'s index counts after the node is detached.
  const to = end === 'front' ? parent.children.length - 1 : 0
  if (from === to) return
  store.moveNode(nodeId, parent.id, to)
}

// ── Auto layout (IX-10, PA-7, PA-8) ──────────────────────────────────────────

function isContainer(node: PageNode, isRoot: boolean): boolean {
  return isRoot || nodeAcceptsChildren(node)
}

/**
 * ⇧A. A container becomes auto layout with everything Figma infers from where
 * its children already are — direction, gap, padding, alignment, wrap — and
 * absolute children of a free frame flow in visual order (`addAutoLayout`,
 * one write). Pressed on a container that is auto layout already it goes back
 * the way Figma's does: the children keep their positions
 * (`removeAutoLayoutKeepPositions`).
 *
 * Anything else — a leaf, or several layers — is wrapped (`groupNodes`, one
 * layer or a run of siblings) in a container that is WRITTEN with the layout the
 * layers ran in: direction, gap and alignment read off their margin boxes
 * (`planWrapAutoLayout`), in the same write, so it is one undo entry and nothing
 * moves.
 */
export async function toggleFlexLayout(): Promise<void> {
  const store = useEditorStore.getState()
  const tree = selectActiveCanvasPage(store)
  const ids = store.selectedNodeIds.filter((id) => tree?.nodes[id])
  if (!tree || ids.length === 0) return

  const single = ids.length === 1 ? tree.nodes[ids[0]!] : undefined
  if (single && isContainer(single, single.id === tree.rootNodeId)) {
    const measured = await measureInRenderingFrame([single.id], ['display'], store.activeBreakpointId, [single.id])
    const display = measured?.get(single.id)?.computedStyle.display ?? ''
    if (isAutoLayoutDisplay(display)) removeAutoLayoutKeepPositions(single.id)
    else addAutoLayout(single.id)
    return
  }

  const layerIds = ids.filter((id) => id !== tree.rootNodeId)
  if (layerIds.length === 0) return
  const measured = await measureInRenderingFrame(layerIds, MARGIN_PROPERTIES, store.activeBreakpointId, layerIds)
  const sourceIndex = (id: string) => tree.nodes[tree.nodes[id]?.parentId ?? '']?.children.indexOf(id) ?? 0
  const layers = [...layerIds].sort((a, b) => sourceIndex(a) - sourceIndex(b)).flatMap((id) => {
    const measurement = measured?.get(id)
    return measurement?.rect ? [{ id, rect: measurement.rect, style: measurement.computedStyle }] : []
  })
  // The wrapper is written WITH its layout: one write, one undo entry, and the layers never
  // sit in a plain block that would collapse the spacing their parent gave them.
  const wrapperStyle = layers.length === layerIds.length ? planWrapAutoLayout(layers.map(measuredBoxOf)) : {}
  const wrapperId = store.groupNodes(layerIds, undefined, undefined, { wrapperStyle, memberStyles: {} })
  // A CMS tree mints the wrapper at once: select it. A source write selects it when it lands.
  if (typeof wrapperId === 'string' && wrapperId) useEditorStore.getState().selectNode(wrapperId)
}

const MARGIN_PROPERTIES = ['margin-top', 'margin-right', 'margin-bottom', 'margin-left']

/** A measured layer as the wrap plan reads it: its border box and margins (nothing else is needed to place a gap). */
function measuredBoxOf(layer: { id: string; rect: NodeRect; style: Record<string, string> }): MeasuredBox {
  const margin = (edge: string) => Number.parseFloat(layer.style[`margin-${edge}`] ?? '') || 0
  const none = { top: 0, right: 0, bottom: 0, left: 0 }
  return {
    nodeId: layer.id,
    rect: layer.rect,
    position: 'static',
    display: 'block',
    boxSizing: 'border-box',
    margin: { top: margin('top'), right: margin('right'), bottom: margin('bottom'), left: margin('left') },
    padding: none,
    border: none,
    inline: {},
  }
}

// ── Copy / paste style (IX-props) ────────────────────────────────────────────

/**
 * What "style" means here: the layer's own inline style and its classes —
 * Figma's "properties" — without WHERE it is or HOW BIG. Pasting a position
 * or a size would move or resize the target, which is not what the gesture
 * is for (Figma leaves both behind too).
 */
const GEOMETRY_PROPERTIES: ReadonlySet<string> = new Set([
  'position', 'inset', 'top', 'right', 'bottom', 'left',
  'insetBlock', 'insetBlockStart', 'insetBlockEnd', 'insetInline', 'insetInlineStart', 'insetInlineEnd',
  'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'inlineSize', 'blockSize', 'minInlineSize', 'minBlockSize', 'maxInlineSize', 'maxBlockSize',
  'gridArea', 'gridRow', 'gridColumn', 'gridRowStart', 'gridRowEnd', 'gridColumnStart', 'gridColumnEnd',
  'order', 'zIndex', 'transform', 'translate',
])

export interface CopiedStyle {
  inlineStyles: Record<string, string | number>
  classIds: string[]
}

let styleClipboard: CopiedStyle | null = null

/** The style part of a node's inline bag — everything but its geometry. */
export function styleOf(inlineStyles: Readonly<Record<string, unknown>> | undefined): Record<string, string | number> {
  const style: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(inlineStyles ?? {})) {
    if (GEOMETRY_PROPERTIES.has(key)) continue
    if (typeof value === 'string' || typeof value === 'number') style[key] = value
  }
  return style
}

/**
 * The patch that makes `target`'s style the copied one: every copied key set,
 * and every style key the target has that the copy lacks cleared. Geometry is
 * left alone either way.
 */
export function pasteStylePatch(
  copied: CopiedStyle,
  target: Readonly<Record<string, unknown>> | undefined,
): Record<string, string | number | null> {
  const patch: Record<string, string | number | null> = { ...copied.inlineStyles }
  for (const key of Object.keys(styleOf(target))) {
    if (!(key in copied.inlineStyles)) patch[key] = null
  }
  return patch
}

export function hasCopiedStyle(): boolean {
  return styleClipboard !== null
}

export function copySelectionStyle(): void {
  const store = useEditorStore.getState()
  const node = selectActiveCanvasPage(store)?.nodes[store.selectedNodeId ?? '']
  if (!node) return
  styleClipboard = { inlineStyles: styleOf(node.inlineStyles), classIds: [...node.classIds] }
  pushToast({ kind: 'info', title: 'Style copied', body: 'Paste it onto other layers with Paste style.' })
}

/** One write and one undo entry for the whole selection (OD-16): `applyNodeStyles`. */
export function pasteSelectionStyle(): void {
  const copied = styleClipboard
  if (!copied) {
    pushToast({ kind: 'info', title: 'No style copied yet', body: 'Copy a layer’s style first (Copy style).' })
    return
  }
  const store = useEditorStore.getState()
  const tree = selectActiveCanvasPage(store)
  const targets = store.selectedNodeIds.flatMap((id) => {
    const node = tree?.nodes[id]
    return node ? [node] : []
  })
  if (targets.length === 0) return
  store.applyNodeStyles(
    targets.map((node) => ({
      nodeId: node.id,
      inlinePatch: pasteStylePatch(copied, node.inlineStyles),
      addClassIds: copied.classIds,
    })),
  )
}

/** Test seam. */
export function resetStyleClipboard(): void {
  styleClipboard = null
}
