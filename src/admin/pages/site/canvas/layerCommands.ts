/**
 * layerCommands — the layer commands P5-E added, as plain functions of the
 * current selection: bring to front / send to back (IX-9), add / remove flex
 * layout (IX-10), copy / paste style (IX-props). Align is `layerAlign.ts`.
 *
 * ONE implementation, three callers: the keys (`useCanvasLayerCommandKeys`),
 * the palette (`spotlight/commands/layerArrange.ts`) and the right-click menu
 * (`LayerNodeContextMenu`). None of them re-derives a rule.
 */
import { getParent, type CSSPropertyBag } from '@core/page-tree'
import { registry } from '@core/module-engine'
import { pushToast } from '@ui/components/Toast'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { measureInRenderingFrame } from './canvasSelectionMeasure'
import { armCreatedNodeFollowUp } from './createdNodeFollowUp'
import { runSelectionStyleCommand } from './selectionStyleCommands'

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

// ── Flex layout (IX-10) ──────────────────────────────────────────────────────

/**
 * Which way a container's children already run, from their measured rects:
 * the second child starting below the first one's bottom is a column. Fewer
 * than two children keep a block's vertical stacking — a column.
 */
export function inferFlexDirection(rects: ReadonlyArray<{ x: number; y: number; width: number; height: number }>): 'row' | 'column' {
  const [first, second] = rects
  if (!first || !second) return 'column'
  // Half a pixel of slack: sub-pixel layouts put a stacked second child a
  // fraction above the first one's bottom.
  if (second.y >= first.y + first.height - 0.5) return 'column'
  return 'row'
}

function isContainer(moduleId: string, isRoot: boolean): boolean {
  return isRoot || registry.get(moduleId)?.canHaveChildren === true
}

/** The flex patch for a container, or `null` for its removal when it is flex already. */
export function flexLayoutPatch(display: string, direction: 'row' | 'column'): Partial<Record<keyof CSSPropertyBag, string | null>> {
  if (display === 'flex' || display === 'inline-flex') return { display: null, flexDirection: null }
  return { display: 'flex', flexDirection: direction }
}

/**
 * ⇧A. A container becomes `display: flex` in the direction its children
 * already run; pressed on a flex container it goes back (Penpot's toggle).
 * Anything else — a leaf, or several layers — is wrapped first (one layer:
 * `wrapNode`; siblings: ⌘G's `groupNodes`) and the new wrapper is laid out in
 * the direction the layers ran. On a studio tree the wrapper exists only once
 * its write lands, so that half runs as a follow-up on it
 * (`createdNodeFollowUp.ts`): two undo entries, the wrap and the layout, which
 * is honest about the two writes it made.
 */
export async function toggleFlexLayout(): Promise<void> {
  const store = useEditorStore.getState()
  const tree = selectActiveCanvasPage(store)
  const ids = store.selectedNodeIds.filter((id) => tree?.nodes[id])
  if (!tree || ids.length === 0) return

  const single = ids.length === 1 ? tree.nodes[ids[0]!] : undefined
  if (single && isContainer(single.moduleId, single.id === tree.rootNodeId)) {
    const measured = await measureInRenderingFrame([single.id, ...single.children], ['display'], store.activeBreakpointId, [single.id])
    const display = measured?.get(single.id)?.computedStyle.display ?? ''
    const rects = single.children.flatMap((id) => {
      const rect = measured?.get(id)?.rect
      return rect && rect.width + rect.height > 0 ? [rect] : []
    })
    const patch = flexLayoutPatch(display, inferFlexDirection(rects))
    runSelectionStyleCommand((commit) => commit.commitStyleMany(patch))
    return
  }

  const layerIds = ids.filter((id) => id !== tree.rootNodeId)
  if (layerIds.length === 0) return
  const measured = await measureInRenderingFrame(layerIds, [], store.activeBreakpointId, layerIds)
  const direction = inferFlexDirection(
    [...layerIds]
      .sort((a, b) => (tree.nodes[tree.nodes[a]?.parentId ?? '']?.children.indexOf(a) ?? 0) - (tree.nodes[tree.nodes[b]?.parentId ?? '']?.children.indexOf(b) ?? 0))
      .flatMap((id) => {
        const rect = measured?.get(id)?.rect
        return rect ? [rect] : []
      }),
  )
  const layOut = () => runSelectionStyleCommand((commit) => commit.commitStyleMany({ display: 'flex', flexDirection: direction }))
  armCreatedNodeFollowUp(() => layOut())
  const wrapperId = layerIds.length === 1
    ? store.wrapNode(layerIds[0]!, 'base.container')
    : store.groupNodes(layerIds)
  // A CMS tree mints the wrapper at once: select it, which runs the follow-up.
  if (typeof wrapperId === 'string' && wrapperId) useEditorStore.getState().selectNode(wrapperId)
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
