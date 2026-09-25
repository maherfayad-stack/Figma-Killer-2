/**
 * layerAlign — ⌥A ⌥D ⌥W ⌥S ⌥H ⌥V and the menu's Align items (P5-E, IX-20).
 *
 * Figma aligns every selected layer to the selection's bounds, or a single
 * layer to its parent. Studio's layers are a React tree, so "move it left" is
 * only honest where a single CSS write says it, and the write differs by what
 * decides the layer's position:
 *
 *   - a FLOW child (its parent lays it out) aligns through the parent's own
 *     alignment: `align-self` / `justify-self` on the layer, or the parent's
 *     `justify-content` when the layer is its only child. That is exactly the
 *     inspector's Align row (`resolveAlignWrite`), and a single layer goes
 *     through the inspector's write target, so the row and the key agree;
 *   - a POSITIONED layer (`absolute | fixed`) moves its offsets. Alone, it
 *     aligns to its containing block: its used `left` / `right` / `top` /
 *     `bottom` ARE the distances to that block's edges, so ⌥A is "left
 *     becomes 0" with no rect in sight. Two or more align to EACH OTHER — the
 *     bounds of the positioned layers, from their measured rects (the case
 *     P2-C2 found missing). Either way the offsets written are the ones the
 *     source authored (`authoredOffsets` / `planNudge`), so a right-anchored
 *     layer stays right-anchored (IX-21);
 *   - a multi-selection does both at once, per layer, as ONE write and ONE
 *     undo entry (OD-16). A layer no single write can align is left alone;
 *     only when none can does the command say why.
 *
 * The planner is pure (`planAlign`); `alignSelection` measures, plans and
 * writes.
 */
import type { AlignEdge } from '@ui/components/AlignBar'
import type { NodeTree, PageNode, StyleRule } from '@core/page-tree'
import { getAncestors } from '@core/page-tree'
import { isPositionedFreely } from '@core/studio-runtime'
import { pushToast } from '@ui/components/Toast'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { resolveAlignWrite, type ParentLayoutInfo } from '@site/inspector/sections/resolveAlignWrite'
import type { NodeRect } from './frameAdapter/FrameDocumentAdapter'
import {
  authoredOffsets,
  LAYOUT_PROPERTIES,
  nudgeStylePatch,
  OWN_PROPERTIES,
  planNudge,
  readLayout,
  readOwn,
  type ArrowParentLayout,
  type ArrowTargetStyle,
} from './canvasNodeArrowMove'
import { measureInRenderingFrame } from './canvasSelectionMeasure'
import { runSelectionStyleCommand } from './selectionStyleCommands'

/** What `planAlign` needs to know about one selected layer. */
export interface AlignLayer {
  nodeId: string
  own: ArrowTargetStyle
  /** Frame-local rect; `null` for a node with no element of its own. */
  rect: NodeRect | null
  /** The nearest boxed ancestor's layout, or `null`. */
  layout: ArrowParentLayout | null
  /** The TREE parent, and how many children it has (the selected layer included). */
  parentId: string | null
  siblingCount: number
}

export type AlignPlan =
  /** One flow child: the inspector's own commit (its write target decides inline vs class). */
  | { kind: 'self'; nodeId: string; property: 'alignSelf' | 'justifySelf'; value: string }
  /** One flow child that is its parent's only child: the parent's inline `justify-content`. */
  | { kind: 'parent'; parentId: string; property: 'justifyContent'; value: string }
  /** Everything else: one inline patch per node, written as one transaction. */
  | { kind: 'patches'; patches: Array<{ nodeId: string; patch: Record<string, string> }> }
  | { kind: 'refused'; reason: string }

const HORIZONTAL: ReadonlySet<AlignEdge> = new Set(['left', 'center', 'right'])

/** `inline-flex` aligns like `flex`; anything else has no children to align. */
function parentLayoutInfo(layer: AlignLayer): ParentLayoutInfo | null {
  if (!layer.layout) return null
  const display = layer.layout.display.includes('grid') ? 'grid' : layer.layout.display.includes('flex') ? 'flex' : layer.layout.display
  return { display, flexDirection: layer.layout.flexDirection || 'row', siblingCount: layer.siblingCount }
}

function px(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** How far a positioned layer moves to meet its containing block's `edge` — its used insets ARE those distances. */
function deltaToContainingBlock(edge: AlignEdge, own: ArrowTargetStyle): { dx: number; dy: number } {
  const left = px(own.left)
  const right = px(own.right)
  const top = px(own.top)
  const bottom = px(own.bottom)
  switch (edge) {
    case 'left': return { dx: -left, dy: 0 }
    case 'right': return { dx: right, dy: 0 }
    case 'center': return { dx: (right - left) / 2, dy: 0 }
    case 'top': return { dx: 0, dy: -top }
    case 'bottom': return { dx: 0, dy: bottom }
    case 'middle': return { dx: 0, dy: (bottom - top) / 2 }
  }
}

/** How far `rect` moves to meet the `bounds`' `edge`. */
function deltaToBounds(edge: AlignEdge, rect: NodeRect, bounds: NodeRect): { dx: number; dy: number } {
  switch (edge) {
    case 'left': return { dx: bounds.x - rect.x, dy: 0 }
    case 'right': return { dx: bounds.x + bounds.width - (rect.x + rect.width), dy: 0 }
    case 'center': return { dx: bounds.x + bounds.width / 2 - (rect.x + rect.width / 2), dy: 0 }
    case 'top': return { dx: 0, dy: bounds.y - rect.y }
    case 'bottom': return { dx: 0, dy: bounds.y + bounds.height - (rect.y + rect.height) }
    case 'middle': return { dx: 0, dy: bounds.y + bounds.height / 2 - (rect.y + rect.height / 2) }
  }
}

function unionRect(rects: readonly NodeRect[]): NodeRect {
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Pure — see the module doc for the rules. */
export function planAlign(
  edge: AlignEdge,
  layers: readonly AlignLayer[],
  tree: NodeTree<PageNode>,
  styleRules: Readonly<Record<string, StyleRule>> | undefined,
): AlignPlan {
  if (layers.length === 0) return { kind: 'refused', reason: 'Select a layer to align.' }
  const positioned = layers.filter((layer) => isPositionedFreely(layer.own.position))
  const bounds = positioned.length >= 2 && positioned.every((layer) => layer.rect)
    ? unionRect(positioned.map((layer) => layer.rect!))
    : null

  // One flow child: the inspector's own targets, so the key and the Align row agree.
  if (layers.length === 1 && positioned.length === 0) {
    const [layer] = layers as [AlignLayer]
    const resolution = resolveAlignWrite(edge, parentLayoutInfo(layer))
    if (resolution.target === 'unavailable') return { kind: 'refused', reason: resolution.reason }
    if (resolution.target === 'self') return { kind: 'self', nodeId: layer.nodeId, property: resolution.property, value: resolution.value }
    if (!layer.parentId) return { kind: 'refused', reason: "Can't verify the parent's layout." }
    return { kind: 'parent', parentId: layer.parentId, property: resolution.property, value: resolution.value }
  }

  const patches = new Map<string, Record<string, string>>()
  let firstReason: string | null = null
  for (const layer of layers) {
    if (isPositionedFreely(layer.own.position)) {
      const node = tree.nodes[layer.nodeId]
      if (!node) continue
      const delta = bounds && layer.rect ? deltaToBounds(edge, layer.rect, bounds) : deltaToContainingBlock(edge, layer.own)
      const patch = nudgeStylePatch(planNudge(layer.own, authoredOffsets(node, styleRules)), delta.dx, delta.dy)
      if (Object.keys(patch).length > 0) patches.set(layer.nodeId, patch)
      continue
    }
    const resolution = resolveAlignWrite(edge, parentLayoutInfo(layer))
    if (resolution.target === 'self') {
      patches.set(layer.nodeId, { ...(patches.get(layer.nodeId) ?? {}), [resolution.property]: resolution.value })
    } else if (resolution.target === 'parent' && layer.parentId) {
      patches.set(layer.parentId, { ...(patches.get(layer.parentId) ?? {}), [resolution.property]: resolution.value })
    } else if (resolution.target === 'unavailable') {
      firstReason ??= resolution.reason
    }
  }
  if (patches.size === 0) {
    // Everything already sits on the edge — an honest no-op, not a refusal.
    if (positioned.length > 0) return { kind: 'patches', patches: [] }
    return { kind: 'refused', reason: firstReason ?? 'Nothing here can be aligned.' }
  }
  return { kind: 'patches', patches: [...patches].map(([nodeId, patch]) => ({ nodeId, patch })) }
}

const MEASURED = [...new Set([...OWN_PROPERTIES, ...LAYOUT_PROPERTIES])]

/** Measure the selection and align it to `edge` — the keyboard, the palette and the menu all call this. */
export async function alignSelection(edge: AlignEdge): Promise<void> {
  const state = useEditorStore.getState()
  const tree = selectActiveCanvasPage(state)
  const nodeIds = state.selectedNodeIds.filter((id) => tree?.nodes[id] && id !== tree.rootNodeId)
  if (!tree || nodeIds.length === 0) return
  const chains = new Map(nodeIds.map((id) => [id, getAncestors(tree, id).map((ancestor) => ancestor.id).reverse()] as const))
  const measured = await measureInRenderingFrame(
    nodeIds.flatMap((id) => [id, ...(chains.get(id) ?? [])]),
    MEASURED,
    state.activeBreakpointId,
    nodeIds,
  )
  if (!measured) return
  const layers: AlignLayer[] = nodeIds.map((nodeId) => {
    const parentId = tree.nodes[nodeId]?.parentId ?? null
    return {
      nodeId,
      own: readOwn(measured.get(nodeId)),
      rect: measured.get(nodeId)?.rect ?? null,
      layout: readLayout((chains.get(nodeId) ?? []).map((id) => measured.get(id))),
      parentId,
      siblingCount: parentId ? (tree.nodes[parentId]?.children.length ?? 0) : 0,
    }
  })
  applyAlignPlan(planAlign(edge, layers, tree, useEditorStore.getState().site?.styleRules), HORIZONTAL.has(edge))
}

function applyAlignPlan(plan: AlignPlan, horizontal: boolean): void {
  const store = useEditorStore.getState()
  switch (plan.kind) {
    case 'self':
      runSelectionStyleCommand((commit) => commit.commitStyle(plan.property, plan.value))
      return
    case 'parent':
      store.setNodeInlineStyles(plan.parentId, { [plan.property]: plan.value })
      return
    case 'patches':
      if (plan.patches.length === 1) store.setNodeInlineStyles(plan.patches[0]!.nodeId, plan.patches[0]!.patch)
      else if (plan.patches.length > 1) store.setNodesInlineStylesPerNode(plan.patches)
      return
    case 'refused':
      pushToast({ kind: 'info', title: horizontal ? 'Nothing to align horizontally' : 'Nothing to align vertically', body: plan.reason })
  }
}
