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

const EMPTY_VISUAL_COMPONENTS: readonly VisualComponent[] = []
/** Stable empty fallback for the frame-scoped selection read below (Guideline #239 — no inline `?? []`). */
const EMPTY_SELECTED_NODE_IDS: readonly string[] = []

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
  // "every frame mirrors the selection" behaviour — see the module doc.
  const selectedNodeIds = useEditorStore(useShallow((s) =>
    s.selectedNodeFrameId === null || s.selectedNodeFrameId === frameId
      ? s.selectedNodeIds
      : EMPTY_SELECTED_NODE_IDS,
  ))
  // `hoveredBreakpointId === null` means "global hover" — i.e. the hover did
  // not originate from a specific breakpoint frame on the canvas (e.g. it was
  // triggered by hovering a row in the DOM panel). In that case every frame
  // mirrors the hover so the user sees the highlight wherever they're looking.
  // When the hover originated from the canvas itself, scope it to the owning
  // frame so adjacent breakpoint previews don't all light up at once.
  // `hoveredFrameId` is the SAME idea one dimension over — see its own doc.
  const hoveredNodeId = useEditorStore((s) =>
    s.hoveredNodeId &&
    (s.hoveredBreakpointId === null || s.hoveredBreakpointId === breakpointId) &&
    (s.hoveredFrameId === null || s.hoveredFrameId === frameId)
      ? s.hoveredNodeId
      : null,
  )
  const hoveredBreakpointOrigin = useEditorStore((s) => s.hoveredBreakpointId)
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
  const framePageId = use(CanvasPageContext)
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
