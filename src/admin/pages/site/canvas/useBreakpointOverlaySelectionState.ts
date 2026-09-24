/**
 * useBreakpointOverlaySelectionState — the store reads `BreakpointSelectionOverlay`
 * needs to know WHAT this frame should show: the (possibly frame-scoped)
 * selection and hover, the selector-affinity highlight, this frame's own
 * page, and the visual-component list the node badge resolves labels
 * against. Pulled out of that component (module-size-budgets — `speed-04`,
 * STATE.md) because it is exactly that: eight independent `useEditorStore`
 * reads with no state, no refs, no effect — the same shape
 * `useCanvasAnimationScrub`/`useResolvedFrameAxes` already use for a
 * component-local slice of store state.
 */
import { use } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Page } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import { styleRuleSelector } from '@core/page-tree'
import { selectCanvasPageFor, useEditorStore } from '@site/store/store'
import { CanvasPageContext } from './CanvasContexts'
import { useCanvasHoverSelect } from './canvasHover'

const EMPTY_VISUAL_COMPONENTS: readonly VisualComponent[] = []
/** Stable empty fallback for the frame-scoped selection read below (Guideline #239 — no inline `?? []`). */
const EMPTY_SELECTED_NODE_IDS: readonly string[] = []

/**
 * PERF-13 — the ids of `ids` this frame's page can render. A selection or
 * hover made WITHOUT a frame (a Layers-panel row: `selectedNodeFrameId` /
 * the hover's `frameId` null) used to arm the rings, the in-place inspector
 * wrapper and a measure scheduler in EVERY mounted board frame, each of which
 * then queried its document for a node it does not contain, on every pass.
 * `_nodeIdToPageIds` (WS-5.2) answers "which pages contain this id" in O(1).
 *
 * `framePageId === null` is the CMS/VC canvas, which mirrors one selection
 * across every breakpoint frame of ONE document on purpose — unscoped. An id
 * the index does not know (a Visual Component's own tree) is kept, so the
 * scoping can only ever remove chrome from a frame that provably cannot show
 * it. Returns `ids` itself when nothing is removed.
 */
export function idsRenderedByFramePage(
  nodeIdToPageIds: ReadonlyMap<string, readonly string[]>,
  ids: readonly string[],
  framePageId: string | null,
): readonly string[] {
  if (framePageId === null || ids.length === 0) return ids
  const rendered = ids.filter((id) => framePageCanRender(nodeIdToPageIds, id, framePageId))
  if (rendered.length === ids.length) return ids
  return rendered.length === 0 ? EMPTY_SELECTED_NODE_IDS : rendered
}

/** One id's answer to {@link idsRenderedByFramePage} — no allocation, for the per-store-change hover read. */
function framePageCanRender(
  nodeIdToPageIds: ReadonlyMap<string, readonly string[]>,
  id: string,
  framePageId: string | null,
): boolean {
  return framePageId === null || (nodeIdToPageIds.get(id)?.includes(framePageId) ?? true)
}

export interface BreakpointOverlaySelectionState {
  selectedNodeIds: readonly string[]
  hoveredNodeId: string | null
  hoveredBreakpointOrigin: string | null
  activeBreakpointId: string | null
  highlightedSelector: string | null
  framePage: Page | null
  visualComponents: readonly VisualComponent[]
}

export function useBreakpointOverlaySelectionState(
  breakpointId: string,
  frameId: string | null,
): BreakpointOverlaySelectionState {
  // Multi-select: render one ring per selected node. `useShallow` keeps the
  // subscription stable when the array reference changes but its contents
  // are equal (matters because selectedNodeIds is a new array every set call).
  //
  // WS-10 Phase 2 — frame-scoped when the selection originated from a board
  // frame (`selectedNodeFrameId` set): a "duplicate as variant" sibling of
  // the same page shares every node id (trap #2), so without this an
  // rtl/dark variant would show the SAME selection ring as its light/ltr
  // sibling. `null` origin (every CMS/VC selection) keeps the existing
  // "every frame mirrors the selection" behaviour — see the module doc —
  // narrowed to the frames whose page contains the node (PERF-13).
  const framePageId = use(CanvasPageContext)
  const selectedNodeIds = useEditorStore(useShallow((s) => {
    if (s.selectedNodeFrameId !== null) {
      return s.selectedNodeFrameId === frameId ? s.selectedNodeIds : EMPTY_SELECTED_NODE_IDS
    }
    return idsRenderedByFramePage(s._nodeIdToPageIds, s.selectedNodeIds, framePageId)
  }))
  // Hover is read from `canvasHover.ts`, not the store (P2-I, PERF-1) — one
  // subscription per mounted FRAME, which is the right multiplier for it. Each
  // read returns a primitive, so a crossing re-renders only the frames whose
  // answer changed, not every mounted frame.
  //
  // `breakpointId === null` means "global hover" — i.e. the hover did not
  // originate from a specific breakpoint frame on the canvas (e.g. it was
  // triggered by hovering a row in the DOM panel). In that case every frame
  // mirrors the hover so the user sees the highlight wherever they're looking.
  // When the hover originated from the canvas itself, scope it to the owning
  // frame so adjacent breakpoint previews don't all light up at once.
  // `frameId` is the SAME idea one dimension over — see its own doc.
  const nodeIdToPageIds = useEditorStore((s) => s._nodeIdToPageIds)
  const hoveredNodeId = useCanvasHoverSelect((hover) =>
    hover &&
    (hover.breakpointId === null || hover.breakpointId === breakpointId) &&
    (hover.frameId === null
      ? framePageCanRender(nodeIdToPageIds, hover.nodeId, framePageId)
      : hover.frameId === frameId)
      ? hover.nodeId
      : null,
  )
  const hoveredBreakpointOrigin = useCanvasHoverSelect((hover) => hover?.breakpointId ?? null)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)

  // Selector-affinity highlight: the CSS selector of the rule currently hovered
  // in the Selectors panel, or null. Resolved to its selector string here so the
  // RAF tick can `querySelectorAll` it inside the iframe and ring every match.
  // Like the DOM-panel hover, this is a global highlight — every breakpoint
  // frame mirrors it, so the user sees the affinity wherever they're looking.
  const highlightedSelector = useEditorStore((s) => {
    const classId = s.highlightedSelectorClassId
    if (!classId) return null
    const rule = s.site?.styleRules[classId]
    return rule ? styleRuleSelector(rule) : null
  })
  // THIS frame's page (board: one page per frame) — O(1) node-map reads for the
  // in-iframe badge label (WS-5.1) and the zero-DOM fragment-node rect fallback.
  const framePage = useEditorStore((s) => selectCanvasPageFor(s, framePageId))
  const visualComponents = useEditorStore((s) => s.site?.visualComponents ?? EMPTY_VISUAL_COMPONENTS)

  return {
    selectedNodeIds,
    hoveredNodeId,
    hoveredBreakpointOrigin,
    activeBreakpointId,
    highlightedSelector,
    framePage,
    visualComponents,
  }
}
