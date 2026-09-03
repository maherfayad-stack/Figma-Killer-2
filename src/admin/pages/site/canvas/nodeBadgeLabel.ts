/**
 * The label the in-iframe node badge shows for a selected node (WS-5.1).
 *
 * Its own module rather than a helper inside `BreakpointSelectionOverlay`
 * because it is the only thing in that file that needs the module registry and
 * the display-name helpers — three imports and a `VisualComponent[]` fallback
 * that exist for these ten lines. The overlay is a measurement/RAF component;
 * naming a node is a different job.
 */
import { getNodeDisplayName, getNodeHtmlTag, type Page } from '@core/page-tree'
import { registry } from '@core/module-engine'
import type { VisualComponent } from '@core/visualComponents'

/** Stable empty fallback, so a page with no Visual Components doesn't churn the selector. */
export const EMPTY_VISUAL_COMPONENTS: readonly VisualComponent[] = []

/**
 * The node's tag or display name — the same fallback order the Alt-hover tree
 * ladder rows already use (`CanvasTreeLadderRowButton`), so the two never
 * disagree about what a node is called.
 */
export function resolveNodeBadgeLabel(
  page: Page | null,
  nodeId: string,
  visualComponents: ReadonlyArray<VisualComponent>,
): string | null {
  const node = page?.nodes[nodeId]
  if (!node) return null
  const definition = registry.get(node.moduleId)
  return getNodeHtmlTag(node, definition) || getNodeDisplayName(node, definition, visualComponents) || null
}
