/**
 * PropertiesPanel — self-contained inspector for element properties.
 *
 * Layout modes:
 * - Docked: default right-sidebar inspector, resized through the sidebar shell.
 * - Floating: unpinned draggable overlay using useDraggablePanel.
 * - Auto-opens when selectedNodeId becomes non-null and closes on deselection.
 * - Independent panel with its own visibility state — NOT a tab in a shared shell.
 *   AI assistant (AgentPanel) is a separate independent floating panel. (Guideline #410)
 * - Phase 6E: also stays open (with no node selected) when the active page is
 *   a studio board frame, so `FrameSizePanel`'s device-size picker is visible
 *   the moment a frame is activated — see the `isActiveBoardFrame` check
 *   below. `PropertiesPanelBody` still shows its own "select an element"
 *   empty state underneath in that case.
 *
 * Unified icon-rail design (Task #unified-panel):
 *   - StyleCategoryRail is the primary navigation for the panel's lower half.
 *   - First rail icon: Module settings (always enabled).
 *   - Remaining icons: CSS style categories (disabled when no active class).
 *   - ClassPicker always-visible above the rail+content area.
 *   - Default active section on node selection: MODULE_CATEGORY_ID.
 *
 * Guideline #357 (Compact UI Density):
 * - Property rows: 26px height, label font 11px, value font 12px
 * - Header: 36px
 *
 * Accessibility (WCAG 2.1 AA):
 * - role="complementary" + aria-label="Properties" on the panel aside
 * - data-testid="properties-panel" (Guideline #221)
 * - Individual controls carry data-testid="property-control-{propKey}"
 * - Keyboard-navigable; F6 cycles focus
 *
 * Architecture: this file is the JSX shell only. All store subscriptions and
 * derivations live in `usePropertiesPanelData`; the body branch lives in
 * `PropertiesPanelBody`; the schema → control dispatch lives in
 * `renderModuleTabContent`. Keeping the shell trivial means the hotspot
 * complexity score stays bounded as the panel grows.
 */
import { useEffect, useRef } from 'react'
import { usePropertiesPanelAutoOpen } from './usePropertiesPanelAutoOpen'
import { usePropertiesPanelData } from './usePropertiesPanelData'
import { renderModuleTabContent } from './renderModuleTabContent'
import { PropertiesPanelBody } from './PropertiesPanelBody'
import { FrameSizePanel } from './FrameSizePanel'
import { FrameBulkInspector } from './FrameBulkInspector'
import { NodeHeader } from './NodeHeader'
import { SelectorHeader } from './SelectorHeader'
import { MultiSelectionHeader } from './MultiSelectionInspector'
import { MultiSelectorHeader } from './MultiSelectorInspector'
import { type ClassPickerHandle } from './ClassPicker'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSelectors'
import { PanelHeader } from '@admin/shared/PanelHeader'
import { useDraggablePanel } from '@admin/shared/FloatingWindow'
import { Button } from '@ui/components/Button'
import { OpenSolidIcon } from 'pixel-art-icons/icons/open-solid'
import { DockSolidIcon } from 'pixel-art-icons/icons/dock-solid'
import { cn } from '@ui/cn'
import styles from './PropertiesPanel.module.css'

const DEFAULT_WIDTH = 360

type PanelVariant = 'floating' | 'docked'

interface PropertiesPanelProps {
  variant?: PanelVariant
}

function handlePropertiesPanelKeyDown(e: React.KeyboardEvent) {
  if (e.key === 'F6') {
    e.preventDefault()
    useEditorStore.getState().cycleFocusedPanel()
  }
}

// ---------------------------------------------------------------------------
// PropertiesPanel
// ---------------------------------------------------------------------------

export function PropertiesPanel({ variant = 'floating' }: PropertiesPanelProps) {
  // ─── Auto-open when a node is selected (Guideline #358 / Architect #504) ──
  usePropertiesPanelAutoOpen()

  const data = usePropertiesPanelData()

  // ── Phase 6E: keep the panel open on a bare board-frame activation (no
  // node selected yet) so `FrameSizePanel` is reachable the moment a frame
  // is clicked, not only once something inside it is also selected. ────────
  const activeBoard = useEditorStore(selectActiveBoard)
  const activePageId = useEditorStore((s) => s.activePageId)
  const isActiveBoardFrame =
    !!activeBoard && activeBoard.frames.some((f) => f.pageId === activePageId)
  // WS-7.1/7.2 — a bulk frame selection (distinct from `isActiveBoardFrame`
  // above, which tracks the single EDITING target, not a multi-select set)
  // also keeps the panel open and swaps its body for `FrameBulkInspector`.
  const selectedFrameIds = useEditorStore((s) => s.selectedFrameIds)
  const isFrameMultiSelect = selectedFrameIds.length > 0

  // ── ClassPicker ref — for the locked-state 'Add class' CTA ────────────────
  const classPickerRef = useRef<ClassPickerHandle>(null)
  const handleFocusClassPicker = () => {
    classPickerRef.current?.focusInput()
  }

  // ── Draggable panel position ───────────────────────────────────────────────
  const {
    panelRef: dragPanelElementRef,
    setPanelRef: setDragPanelElementRef,
    headerDragProps,
    panelPositionStyle,
  } = useDraggablePanel(
    'properties',
    () => ({
      x: typeof window !== 'undefined' ? window.innerWidth - DEFAULT_WIDTH - 16 : 16,
      y: 16,
    }),
  )

  // ─── Focus management: F6 moves focus into panel ──────────────────────────
  useEffect(() => {
    if (data.focusedPanel !== 'properties') return
    const panel = dragPanelElementRef.current
    if (!panel) return
    if (panel.contains(document.activeElement)) return
    panel.focus()
  }, [data.focusedPanel, dragPanelElementRef])

  if (
    data.collapsed ||
    (!data.selectedNodeId &&
      !data.selectedSelectorClass &&
      !data.isSelectorMultiSelect &&
      !isActiveBoardFrame &&
      !isFrameMultiSelect)
  ) {
    return null
  }

  // ── Module tab content — pre-rendered, passed to StyleSurface as a ReactNode.
  // The dispatch lives in `renderModuleTabContent` (own file) to keep this
  // shell flat — see that helper for the per-branch rationale.
  const moduleTabContent: React.ReactNode = renderModuleTabContent({
    selectedNode: data.selectedNode,
    selectedNodeId: data.selectedNodeId,
    definition: data.definition,
    resolvedPropsForBreakpoint: data.resolvedPropsForBreakpoint,
    overrideKeys: data.overrideKeys,
    activeDocument: data.activeDocument,
    activePage: data.activePage,
    handleChange: data.handleChange,
    handlePatch: data.handlePatch,
  })

  return (
    <aside
      ref={setDragPanelElementRef}
      data-panel=""
      data-testid="properties-panel"
      role="complementary"
      aria-label="Properties"
      tabIndex={-1}
      data-variant={variant}
      /*
       * Opts every shared primitive rendered inside this panel into the
       * inspector field skin — filled 24px rectangles with no resting border,
       * bare icon toggle groups — instead of the admin's form-shaped pill
       * outlines. Declared once here rather than threaded as a prop through
       * the ~40 components between this shell and a leaf `Input`; the skins
       * themselves live next to the primitives they restyle
       * (`Input.module.css`, `SegmentedControl.module.css`).
       */
      data-field-skin="inspector"
      onKeyDown={handlePropertiesPanelKeyDown}
      onFocus={() => data.setFocusedPanel('properties')}
      onClick={(e) => e.stopPropagation()}
      style={
        variant === 'floating'
          ? { '--panel-w': `${data.width}px`, ...panelPositionStyle } as React.CSSProperties
          : undefined
      }
      className={cn(styles.panel, variant === 'docked' && styles.panelDocked)}
    >
      {/* ─── Screen-reader live region (Guideline #331) ─────────────────── */}
      <div role="status" aria-live="polite" className={styles.srLiveRegion}>
        {data.statusMessage}
      </div>

      {/* ─── Shared Panel Header — drag handle + close button ─────────────── */}
      <PanelHeader
        panelId="properties"
        title="Properties"
        titleContent={
          isFrameMultiSelect ? (
            <span>{selectedFrameIds.length} frames selected</span>
          ) : (
            <HeaderTitleContent
              selectedSelectorClass={data.selectedSelectorClass}
              isSelectorMultiSelect={data.isSelectorMultiSelect}
              selectedSelectorClassIdsCount={data.selectedSelectorClassIds.length}
              isMultiSelect={data.isMultiSelect}
              selectedNodeIdsCount={data.selectedNodeIds.length}
              selectedNode={data.selectedNode}
              selectedNodeId={data.selectedNodeId}
              definition={data.definition}
              renameClass={data.renameClass}
              deleteClass={data.deleteClass}
              selectedSelectorUsage={data.selectedSelectorUsage}
              renameNode={data.renameNode}
            />
          )
        }
        onClose={data.togglePropertiesPanel}
        dragHandleProps={variant === 'floating' ? headerDragProps : undefined}
      >
        <PanelModeButton
          variant={variant}
          onClick={() => data.setPropertiesPanelMode(variant === 'docked' ? 'floating' : 'docked')}
        />
      </PanelHeader>

      {/* ─── Properties content (independent panel — Guideline #410) ─────── */}
      <div
        aria-label="Properties editor"
        className={styles.propertiesPanel}
      >
        {isFrameMultiSelect ? (
          <FrameBulkInspector />
        ) : (
          <>
            <FrameSizePanel />
            <PropertiesPanelBody
              selectedSelectorClass={data.selectedSelectorClass}
              selectedSelectorClassId={data.selectedSelectorClassId}
              selectedSelectorClassIds={data.selectedSelectorClassIds}
              isSelectorMultiSelect={data.isSelectorMultiSelect}
              activeBreakpointId={data.activeBreakpointId}
              isMultiSelect={data.isMultiSelect}
              selectedNodeIds={data.selectedNodeIds}
              selectedNode={data.selectedNode}
              selectedNodeId={data.selectedNodeId}
              definition={data.definition}
              activeDocument={data.activeDocument}
              activeVc={data.activeVc}
              activeClass={data.activeClass}
              activeClassId={data.activeClassId}
              assignedClassRules={data.assignedClassRules}
              moduleTabContent={moduleTabContent}
              classPickerRef={classPickerRef}
              onFocusClassPicker={handleFocusClassPicker}
            />
          </>
        )}
      </div>

    </aside>
  )
}

// ---------------------------------------------------------------------------
// Header title — selects between class-rename, multi-select count, single
// node header, or undefined (PanelHeader falls back to `title="Properties"`).
// Lifted out of the main body so the JSX above stays scannable.
// ---------------------------------------------------------------------------

interface HeaderTitleProps {
  selectedSelectorClass: ReturnType<typeof usePropertiesPanelData>['selectedSelectorClass']
  isSelectorMultiSelect: boolean
  selectedSelectorClassIdsCount: number
  isMultiSelect: boolean
  selectedNodeIdsCount: number
  selectedNode: ReturnType<typeof usePropertiesPanelData>['selectedNode']
  selectedNodeId: string | null
  definition: ReturnType<typeof usePropertiesPanelData>['definition']
  renameClass: (classId: string, name: string) => void
  deleteClass: (classId: string) => void
  selectedSelectorUsage: string | null
  renameNode: (nodeId: string, label: string) => void
}

function HeaderTitleContent({
  selectedSelectorClass,
  isSelectorMultiSelect,
  selectedSelectorClassIdsCount,
  isMultiSelect,
  selectedNodeIdsCount,
  selectedNode,
  selectedNodeId,
  definition,
  renameClass,
  deleteClass,
  selectedSelectorUsage,
  renameNode,
}: HeaderTitleProps): React.ReactNode {
  if (isSelectorMultiSelect) {
    return <MultiSelectorHeader count={selectedSelectorClassIdsCount} />
  }
  if (selectedSelectorClass) {
    return (
      <SelectorHeader
        cls={selectedSelectorClass}
        usage={selectedSelectorUsage}
        onRename={(name) => renameClass(selectedSelectorClass.id, name)}
        onDelete={() => deleteClass(selectedSelectorClass.id)}
      />
    )
  }
  if (isMultiSelect) {
    return <MultiSelectionHeader count={selectedNodeIdsCount} />
  }
  if (selectedNode && definition && selectedNodeId) {
    return (
      <NodeHeader
        key={selectedNodeId}
        nodeId={selectedNodeId}
        label={selectedNode.label}
        moduleName={definition.name}
        onRename={(label) => renameNode(selectedNodeId, label)}
      />
    )
  }
  return undefined
}

// ---------------------------------------------------------------------------
// PanelModeButton — icon-only toggle between docked and floating modes,
// rendered as a child of PanelHeader.
// ---------------------------------------------------------------------------

interface PanelModeButtonProps {
  variant: PanelVariant
  onClick: () => void
}

function PanelModeButton({ variant, onClick }: PanelModeButtonProps) {
  const label = variant === 'docked' ? 'Unpin Properties panel' : 'Dock Properties panel'
  const tooltip = variant === 'docked' ? 'Unpin to floating panel' : 'Dock in right sidebar'
  return (
    <Button
      variant="ghost"
      size="xs"
      iconOnly
      onClick={onClick}
      aria-label={label}
      tooltip={tooltip}
    >
      {variant === 'docked' ? (
        <OpenSolidIcon size={12} aria-hidden="true" />
      ) : (
        <DockSolidIcon size={12} aria-hidden="true" />
      )}
    </Button>
  )
}
