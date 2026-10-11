/**
 * useParentPlacementKind (PA-4) — how the selected element's container places
 * its children (`parentPlacementKind`), read from the live frame. Auto layout
 * and a plain flow container are answered from the container's own computed
 * style; only a positioned, non-auto-layout container needs its children's
 * positions to tell a free frame from a flow one, so only that case reads them.
 *
 * `null` when no portal frame is rendering the element or its parent (a live
 * frame, an unmounted board) — the caller shows nothing rather than guessing.
 */
import { getParent } from '@core/page-tree'
import { childPlacementPositions, isAutoLayoutDisplay, parentPlacementKind, type ParentPlacementKind, type SizingParentLayout } from '@core/studio-runtime'
import { findRenderedCanvasElements, presentedElementForNode } from '@site/canvas/canvasNodeLookup'
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { useFrameComputedStyleValues } from '@site/panels/InspectPanel/useInspectComputedStyle'

const PARENT_POSITION = ['position'] as const

export function useParentPlacementKind(parentLayout: SizingParentLayout | null): ParentPlacementKind | null {
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  const page = useEditorStore(selectActiveCanvasPage)
  const parentNode = selectedNodeId && page ? getParent(page, selectedNodeId) : undefined
  const { value: parentComputed } = useFrameComputedStyleValues(parentNode?.id ?? null, activeBreakpointId, PARENT_POSITION)

  if (!selectedNodeId || !parentNode || !parentLayout || !parentComputed) return null
  if (isAutoLayoutDisplay(parentLayout.display)) return 'auto-layout'
  if (parentComputed.position === 'static') return 'flow'

  const doc = findRenderedCanvasElements(selectedNodeId)[0]?.element.ownerDocument
  const view = doc?.defaultView
  const parentElement = doc ? presentedElementForNode(doc, parentNode.id) : null
  if (!view || !parentElement) return null
  return parentPlacementKind(
    { display: parentLayout.display, position: parentComputed.position },
    childPlacementPositions(view, parentElement),
  )
}
