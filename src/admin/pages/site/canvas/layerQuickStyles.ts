/**
 * layerQuickStyles — the one-key style commands (P5-F, IX-misc): opacity on
 * the digit keys and Figma's flip horizontal / vertical on ⇧H / ⇧V.
 *
 * ONE implementation, every caller: the keys (`useCanvasLayerCommandKeys`)
 * and anything else that wants the same command. Both write through the
 * inspector's own value models, so a key and the panel can never disagree on
 * what "50%" or "flipped" is in CSS.
 *
 * ## Opacity (Penpot's `pressed-opacity`, Figma's digits)
 *
 * 1 … 9 set 10 % … 90 %, written as the layer's own `opacity`. 0 means 100 %:
 * it CLEARS the layer's own `opacity` rather than writing a redundant
 * `opacity: 1`. A layer whose opacity comes from a class keeps the class's —
 * that value lives in the class, and the inspector is where to change it.
 * Every selected layer gets the same value in ONE write (`setNodesInlineStyles`).
 *
 * ## Flip (the inspector's `flipValue.ts`)
 *
 * The standalone `scale` property, one axis's sign flipped — never a
 * `transform` function. A layer the flip model refuses (a `scale` it cannot
 * toggle without losing information, or a `transform` that already scales)
 * is named in an info toast and left alone; the rest of the selection flips,
 * in ONE write (`setNodesInlineStylesPerNode`).
 */
import { pushToast } from '@ui/components/Toast'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import {
  parseFlipState,
  serializeFlipState,
  toggleFlipAxis,
  TRANSFORM_SCALE_FN_RE,
} from '@site/panels/PropertiesPanel/flipValue'

/** The opacity a digit key sets: `null` (clear the layer's own) for 0, else tenths. */
export function opacityForDigit(digit: number): string | null {
  if (!Number.isInteger(digit) || digit < 0 || digit > 9) throw new Error(`[layerQuickStyles] not a digit: ${digit}`)
  return digit === 0 ? null : String(digit / 10)
}

/** The selected layers of the active page, root excluded — the ones a style key writes. */
function selectedLayers() {
  const store = useEditorStore.getState()
  const tree = selectActiveCanvasPage(store)
  if (!tree) return { store, nodes: [] }
  const nodes = store.selectedNodeIds.flatMap((id) => {
    const node = tree.nodes[id]
    return node ? [node] : []
  })
  return { store, nodes }
}

export function setSelectionOpacity(digit: number): void {
  const value = opacityForDigit(digit)
  const { store, nodes } = selectedLayers()
  const targets = value === null
    ? nodes.filter((node) => node.inlineStyles?.opacity !== undefined)
    : nodes.filter((node) => String(node.inlineStyles?.opacity ?? '') !== value)
  if (targets.length === 0) return
  store.setNodesInlineStyles(targets.map((node) => node.id), { opacity: value })
}

/** The `scale` a flip writes for one layer, or the reason it cannot. */
export function flipPatchFor(
  stored: Readonly<Record<string, unknown>> | undefined,
  axis: 'x' | 'y',
): { scale: string | null } | { refused: string } {
  const transform = typeof stored?.transform === 'string' ? stored.transform : ''
  if (TRANSFORM_SCALE_FN_RE.test(transform)) {
    return { refused: 'it is already scaled inside its transform' }
  }
  const state = parseFlipState(stored?.scale)
  if (!state) return { refused: 'its scale is not a plain one- or two-number value' }
  return { scale: serializeFlipState(toggleFlipAxis(state, axis)) ?? null }
}

export function flipSelection(axis: 'x' | 'y'): void {
  const { store, nodes } = selectedLayers()
  if (nodes.length === 0) return
  const patches: Array<{ nodeId: string; patch: Record<string, string | null> }> = []
  const refused: string[] = []
  for (const node of nodes) {
    const result = flipPatchFor(node.inlineStyles, axis)
    if ('refused' in result) refused.push(result.refused)
    else patches.push({ nodeId: node.id, patch: { scale: result.scale } })
  }
  if (patches.length > 0) store.setNodesInlineStylesPerNode(patches)
  if (refused.length > 0) {
    pushToast({
      kind: 'info',
      title: refused.length === nodes.length ? 'Nothing was flipped' : `${refused.length} layer${refused.length === 1 ? ' was' : 's were'} not flipped`,
      body: `Flip writes the layer’s own scale, and ${refused[0]}. Edit it in the inspector.`,
    })
  }
}
