import type { NodeStylesPreview } from '@site/store/slices/styleRuleSlice'

/**
 * Merge a transient inline-style preview over a node's stored
 * `node.inlineStyles` — the Element (inline) target's mirror of
 * `getCanvasNodeClassIds`'s class-preview merge, and the canvas-render half
 * of Rule 7 (preview-then-commit, docs/features/inspector.md /
 * STUDIO-LIVE-CANVAS-PLAN.md Track P). The class-target preview
 * (`previewClassStyles`/`ClassStyleInjector`) has shipped end-to-end since
 * before this rule; the Element target had no preview channel at all —
 * the pre-P4 inline composers wired `onPreview={noop}`.
 * This is the other half: `previewNodeStyles` (transient UI state, no undo
 * history) consumed here, at the one render boundary that spreads
 * `node.inlineStyles` onto the DOM (`NodeRenderer`'s `useResponsiveBackgroundStyle`
 * call).
 *
 * A `null`/`undefined` value in the preview patch is treated exactly like a
 * `null`/`undefined` value in the stored bag: `bagToReactStyle` (the function
 * downstream of this merge) drops it, so previewing "no value" for a
 * property is indistinguishable from that property being unset — the same
 * contract `generatePreviewClassCSS` gives the class target.
 *
 * Returns the node's own (store-immutable) bag unchanged when no preview
 * targets this node — this runs in a per-node selector on every store set,
 * so allocating a fresh object here would cost O(nodes) per store change
 * (same rationale as `getCanvasNodeClassIds`).
 */
export function mergePreviewedInlineStyles(
  inlineStyles: Record<string, unknown> | undefined,
  previewNodeStyles: NodeStylesPreview | null,
  nodeId: string,
): Record<string, unknown> | undefined {
  if (!previewNodeStyles || !previewNodeStyles.nodeIds.includes(nodeId)) {
    return inlineStyles
  }
  // P2-C2 — a per-node bag (a multi-selection nudge) lays over the shared one.
  return { ...(inlineStyles ?? {}), ...previewNodeStyles.styles, ...previewNodeStyles.stylesByNode?.[nodeId] }
}
