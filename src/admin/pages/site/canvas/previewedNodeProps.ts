/**
 * previewedNodeProps — the node an inspector text field is typing into, with the
 * typed (uncommitted) props laid over its stored ones.
 *
 * `NodeRenderer` reads it inside its existing per-node selector, so showing the
 * draft costs no extra store subscription per node. A selector must return the
 * same reference while its inputs are unchanged or React re-renders forever, so
 * the overlaid node is cached per (stored node, preview) pair.
 */
import type { PageNode } from '@core/page-tree'

interface PropsPreview {
  nodeId: string
  props: Record<string, unknown>
}

const overlaid = new WeakMap<PropsPreview, WeakMap<PageNode, PageNode>>()

export function withPreviewedProps(node: PageNode | null | undefined, preview: PropsPreview | null): PageNode | null {
  if (!node) return null
  if (!preview || preview.nodeId !== node.id) return node
  let byNode = overlaid.get(preview)
  if (!byNode) {
    byNode = new WeakMap()
    overlaid.set(preview, byNode)
  }
  let result = byNode.get(node)
  if (!result) {
    result = { ...node, props: { ...node.props, ...preview.props } }
    byNode.set(node, result)
  }
  return result
}
