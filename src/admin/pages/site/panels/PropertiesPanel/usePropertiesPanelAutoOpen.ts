/**
 * usePropertiesPanelAutoOpen — subscribes to selectedNodeId (and friends);
 * when one becomes non-null/non-empty, automatically opens the Properties
 * Panel. When selection is cleared, closes the panel instead of leaving an
 * empty inspector visible.
 *
 * Extracted to a dedicated file per Task #358 / Guideline #356.
 * The panel opens itself when it becomes relevant — no canvas or store action
 * coupling needed.
 *
 * `board-02`: also watches `selectedFrameIds` (WS-7.1 board-frame
 * multi-selection, `boardSlice`) — without this, `FrameBulkInspector` was
 * unreachable by ANY of its three selection entry points (header click,
 * shift-click, marquee): `selectFrame`/`setSelectedFrameIds`/`selectAllFrames`
 * all clear `selectedNodeId` as part of selecting a frame (the two selection
 * domains are mutually exclusive — see `boardSlice`'s module doc), and THAT
 * transition (non-null → null) is exactly what this hook's own
 * `shouldCollapse` calculation used to treat as "nothing selected, collapse
 * the panel" — so every frame selection immediately auto-closed the one
 * panel that shows it.
 *
 * @see Guideline #356 — Floating Overlay Panel Auto-Open on Selection
 * @see Task #358 Deliverable 4 — Properties Panel auto-open behavior
 */
import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'

export function usePropertiesPanelAutoOpen() {
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const selectedSelectorClassId = useEditorStore((s) => s.selectedSelectorClassId)
  const hasSelectorMultiSelect = useEditorStore((s) => s.selectedSelectorClassIds.length > 0)
  const hasFrameSelection = useEditorStore((s) => s.selectedFrameIds.length > 0)
  const setPropertiesPanel = useEditorStore((s) => s.setPropertiesPanel)
  const consumePropertiesPanelAutoOpenSuppression = useEditorStore(
    (s) => s.consumePropertiesPanelAutoOpenSuppression,
  )
  useEffect(() => {
    const shouldCollapse =
      !selectedNodeId && !selectedSelectorClassId && !hasSelectorMultiSelect && !hasFrameSelection
    const suppressed = consumePropertiesPanelAutoOpenSuppression()
    if (suppressed && !shouldCollapse) return
    setPropertiesPanel({ collapsed: shouldCollapse })
  }, [
    selectedNodeId,
    selectedSelectorClassId,
    hasSelectorMultiSelect,
    hasFrameSelection,
    consumePropertiesPanelAutoOpenSuppression,
    setPropertiesPanel,
  ])
}
