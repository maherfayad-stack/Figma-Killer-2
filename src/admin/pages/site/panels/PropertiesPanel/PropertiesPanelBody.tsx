/**
 * PropertiesPanelBody — selects which inspector surface to show inside the
 * scrollable content area of the Properties panel.
 *
 * Five branches, in priority order:
 *   1. A class is selected via the Selectors panel → global selector inspector
 *      (no node context, just the rule + style sections).
 *   2. Multiple nodes are selected → multi-select inspector.
 *   3. No node + no selector, but we're inside a Visual Component canvas →
 *      show the VC's param surface.
 *   4. No node at all (page canvas with nothing selected) → empty hint.
 *   5. A `base.visual-component-ref` is selected → instance view (params +
 *      override matrix). Other nodes → unconditional `StyleSurface`
 *      (ClassPicker + the `INSPECTOR_SECTIONS` manifest, one continuous
 *      scroll).
 *
 * This component is the branch router for the inspector surfaces.
 * PropertiesPanel still composes the moduleTabContent JSX once (via
 * `renderModuleTabContent`) and passes it in, keeping the schema → control
 * dispatch reusable across surfaces.
 *
 * The Styles/Attributes node-view switch this file used to own was deleted
 * in P3 item 11 (`STATE.md` `panel-25`, Studio extras) — Attributes briefly
 * became its own `INSPECTOR_SECTIONS` manifest entry (`AttributesSection.
 * tsx`), rendered inline in the same scroll as every other section instead
 * of behind a tab. Direct user feedback while dogfooding ("remove
 * attributes") retired that manifest entry outright — `AttributesSection.
 * tsx` and `htmlAttributesModel.ts` are kept in place, unmounted, since
 * `htmlAttributes` is a real prop other consumers (publisher, `htmlImport`,
 * every base module's renderer) still read — see `inspector/sections/
 * index.ts`'s own doc for the full reasoning.
 */
import { EmptyState } from '@ui/components/EmptyState'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import type { AnyModuleDefinition } from '@core/module-engine'
import { describeStructuralRefusal, hasWritableSourceLocation, refusePlacement } from '@core/page-tree'
import type { StyleRule, PageNode } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import type { ActiveDocument } from '../../store/slices/uiSlice'
import { ClassPicker, type ClassPickerHandle } from './ClassPicker'
import { StyleSurface } from './StyleSurface'
import { ComponentRefView } from './ComponentRefView'
import { ComponentParamsOverview } from './ComponentParamsOverview'
import { ConvertToComponentButton } from './ConvertToComponentButton'
import { MultiSelectionInspector } from './MultiSelectionInspector'
import { MultiSelectorInspector } from './MultiSelectorInspector'
import { SelectorInspector } from './SelectorInspector'
import { canComponentizeNode } from '@site/componentization'
import { BranchChoiceNotice } from './BranchChoiceNotice'
import { SharedComponentNotice } from './SharedComponentNotice'
import { SlotFillNotice } from './SlotFillNotice'
import { SourceConstraintNotice } from './SourceConstraintNotice'
import { useEditorStore } from '@site/store/store'
import { textOriginKey } from '@site/store/slices/site/nodeIndex'
import styles from './PropertiesPanel.module.css'

interface PropertiesPanelBodyProps {
  selectedSelectorClass: StyleRule | null
  selectedSelectorClassId: string | null
  selectedSelectorClassIds: string[]
  isSelectorMultiSelect: boolean
  activeBreakpointId: string | undefined
  isMultiSelect: boolean
  selectedNodeIds: string[]
  selectedNode: PageNode | null
  selectedNodeId: string | null
  definition: AnyModuleDefinition | null | undefined
  activeDocument: ActiveDocument | null
  activeVc: VisualComponent | null
  moduleTabContent: React.ReactNode
  classPickerRef: React.RefObject<ClassPickerHandle | null>
  onFocusClassPicker: () => void
}

export function PropertiesPanelBody(props: PropertiesPanelBodyProps): React.ReactNode {
  const {
    selectedSelectorClass,
    selectedSelectorClassId,
    selectedSelectorClassIds,
    isSelectorMultiSelect,
    activeBreakpointId,
    isMultiSelect,
    selectedNodeIds,
    selectedNode,
    selectedNodeId,
    definition,
    activeDocument,
    activeVc,
    moduleTabContent,
    classPickerRef,
    onFocusClassPicker,
  } = props
  const permissions = useEditorPermissions()

  // How many nodes across the site read their text from the SAME literal. A
  // dictionary key is shared copy by design, so an edit to it lands on every
  // screen using it — stated before the user commits, the same way
  // `SharedComponentNotice` states a shared component's blast radius.
  //
  // A primitive selector (no object identity to keep stable) reading the O(1)
  // `_textOriginKeyToCount` index (WS-5.2) instead of scanning every node of
  // every page on every store change.
  const sharedTextOriginCount = useEditorStore((s) => {
    const origin = selectedNode?.textOrigin
    if (!origin || !s.site) return 1
    return s._textOriginKeyToCount.get(textOriginKey(origin)) ?? 1
  })

  // Selector multi-selection (Selectors panel checkboxes) takes priority — the
  // user explicitly built a bulk set and expects the bulk action surface.
  if (isSelectorMultiSelect) {
    return <MultiSelectorInspector selectedSelectorClassIds={selectedSelectorClassIds} />
  }

  if (selectedSelectorClass) {
    return (
      <SelectorInspector cls={selectedSelectorClass} activeBreakpointId={activeBreakpointId} />
    )
  }

  if (isMultiSelect) {
    return <MultiSelectionInspector selectedNodeIds={selectedNodeIds} />
  }

  if (!selectedNode || !definition) {
    const inEmptyVcCanvas =
      activeDocument?.kind === 'visualComponent' &&
      selectedNodeId === null &&
      selectedSelectorClassId === null &&
      !!activeVc
    if (inEmptyVcCanvas && activeVc) {
      return <ComponentParamsOverview vc={activeVc} />
    }
    return (
      <EmptyState
        variant="centered"
        title="Select an element on the canvas to view its properties."
      />
    )
  }

  if (selectedNode.moduleId === 'base.visual-component-ref') {
    // Visual Component instance view (Task #438 / Contribution #619 §8.5).
    return (
      <ComponentRefView
        nodeId={selectedNodeId!}
        componentId={String(selectedNode.props.componentId ?? '')}
        propOverrides={(selectedNode.props.propOverrides ?? {}) as Record<string, unknown>}
      />
    )
  }

  // Default node surface — ClassPicker above StyleSurface.
  //
  // ClassPicker mutates the classes registry, so it is style-editing. Hide it
  // from callers without `site.style.edit` — a content-only Client can't add
  // or remove classes regardless.
  //
  // ConvertToComponentButton is structural (it adds a new VC to the registry
  // and replaces the selected subtree with a ref) — gate on structure.
  const showConvertToComponent =
    permissions.canEditStructure && canComponentizeNode(activeDocument, selectedNode)

  // R3 (`STUDIO-LIVE-CANVAS-PLAN.md` Track R) — `SourceConstraintNotice`'s
  // structural half used to reconstruct its facts independently of the
  // engine; this is the SAME two calls `explainPropConstraint`'s own
  // `list-row` branch makes internally, so the notice and every per-prop
  // control agree on which reason a given node has. `null` when the node
  // isn't structurally locked at all (`refusePlacement` needs a `lockReason`
  // to ever return non-null here — see that function's own doc comment).
  const structuralConstraint = selectedNode.lockReason === undefined
    ? null
    : (() => {
        const refusal = refusePlacement(
          { id: selectedNode.id, lockReason: selectedNode.lockReason },
          'Moved or deleted',
        )
        return refusal ? describeStructuralRefusal({ refusal, node: selectedNode }) : null
      })()

  return (
    <div className={styles.nodeArea}>
      {selectedNode?.fromComponent && selectedNodeId ? (
        <SharedComponentNotice componentName={selectedNode.fromComponent} nodeId={selectedNodeId} />
      ) : null}
      {/* E2.5 — the selected node IS the content filling another component's
          slot (a `header={<Icon/>}` fill, or a fragment-slot child). States
          which slot/instance it belongs to; renders nothing for every other
          node (the common case). */}
      {selectedNodeId ? <SlotFillNotice nodeId={selectedNodeId} /> : null}
      {/* Track F2 / R7 — the ONLY two whole-node facts left here: a
          structural lock, and where a resolved text's own literal lives. Every
          other per-field fact (`CodeValueControl`'s per-prop hint,
          `propLockReason`'s per-prop source — R2) lives next to the control
          it's about instead of repeating itself in a node-level paragraph. */}
      <SourceConstraintNotice
        lockReason={selectedNode.lockReason}
        textOrigin={selectedNode.textOrigin}
        sharedWith={sharedTextOriginCount}
        hasWritableLocation={hasWritableSourceLocation(selectedNode.id)}
        constraint={structuralConstraint}
        nodeId={selectedNodeId ?? undefined}
      />
      {/* parser-06 — the chosen branch is NOT locked (the parser is certain of
          its structure), but the fact that OTHER branches exist and weren't
          shown is still worth surfacing. */}
      {selectedNode.branchAlternatives?.length ? (
        <BranchChoiceNotice alternatives={selectedNode.branchAlternatives} />
      ) : null}
      {/* ClassPicker — always visible to style-edit-capable callers. Hidden
          for content-only Clients. */}
      {(permissions.canEditStyle || showConvertToComponent) && (
        <div className={styles.headerClassPicker}>
          {permissions.canEditStyle ? (
            <ClassPicker
              ref={classPickerRef}
              nodeId={selectedNodeId!}
              trailingAction={
                showConvertToComponent
                  ? <ConvertToComponentButton nodeId={selectedNodeId!} />
                  : undefined
              }
            />
          ) : (
            <ConvertToComponentButton nodeId={selectedNodeId!} />
          )}
        </div>
      )}

      {/* Unified StyleSurface: Module section + CSS sections (scroll-anchor).
          P4 — `StyleSurface` now reads `useSelectionModel()` itself for
          every style/class/lock fact (inline writability already folds in
          the `.map`-row / structural-lock / module-ownership gate that used
          to be threaded here as `sourceLockReason`/`nodeModuleId`/
          `codeProps` props — see `selectionModel.ts`'s own doc). Only the
          module/panel-chrome concerns SelectionModel deliberately doesn't
          own are still passed down. P3 item 11 (`STATE.md` `panel-25`) deleted
          the Styles/Attributes switcher that used to gate this — Attributes
          is now `AttributesSection.tsx`, one of `StyleSurface`'s own
          `INSPECTOR_SECTIONS` entries, rendered unconditionally alongside
          every other section in the same scroll. */}
      <StyleSurface
        definition={definition}
        moduleContent={moduleTabContent}
        onFocusClassPicker={onFocusClassPicker}
      />
    </div>
  )
}
