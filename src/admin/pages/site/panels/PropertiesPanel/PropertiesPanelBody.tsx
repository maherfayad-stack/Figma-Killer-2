/**
 * PropertiesPanelBody — selects which inspector surface to show inside the
 * scrollable content area of the Properties panel.
 *
 * Four branches, in priority order:
 *   1. A class is selected via the Selectors panel → global selector inspector
 *      (no node context, just the rule + style sections).
 *   2. No node + no selector, but we're inside a Visual Component canvas →
 *      show the VC's param surface.
 *   3. No node at all (page canvas with nothing selected) → empty hint.
 *   4. A `base.visual-component-ref` is selected → instance view (params +
 *      override matrix). Other nodes → unconditional `StyleSurface`
 *      (ClassPicker + the `INSPECTOR_SECTIONS` manifest, one continuous
 *      scroll).
 *
 * **There is no multi-select branch any more (S5).** Selecting N layers used
 * to route here to `MultiSelectionInspector` — an action bar, a layer list,
 * and a parallel style surface that could render exactly one editing section.
 * `useSelectionModel()` describes N nodes now, so N falls through to the same
 * branch 4 that one node takes and gets the whole manifest, with Mixed
 * wherever the selection disagrees. What this file still gates on cardinality
 * is the per-node CHROME above the sections (component/slot/source notices,
 * ClassPicker) — see `singleNodeChrome` below.
 *
 * This component is the branch router for the inspector surfaces.
 * PropertiesPanel still composes the moduleTabContent JSX once (via
 * `renderModuleTabContent`) and passes it in, keeping the schema → control
 * dispatch reusable across surfaces.
 *
 * The Styles/Attributes node-view switch this file used to own was deleted
 * in P3 item 11 (`STATE.md` `panel-25`, Studio extras); direct user feedback
 * while dogfooding ("remove attributes") then retired the `attributes`
 * manifest entry outright, and S5 deleted its now-unmounted components and
 * model. The `htmlAttributes` PROP is untouched — the publisher,
 * `htmlImport`, and every base module's renderer still read it; only its
 * retired editor UI is gone.
 */
import { EmptyState } from '@ui/components/EmptyState'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import type { AnyModuleDefinition } from '@core/module-engine'
import { describeStructuralRefusal, hasWritableSourceLocation, refusePlacement } from '@core/page-tree'
import type { StyleRule, PageNode } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import type { ActiveDocument } from '../../store/slices/uiSlice'
import { ClassPicker, type ClassPickerHandle } from './ClassPicker'
import { FrameSizePanel } from './FrameSizePanel'
import { StyleSurface } from './StyleSurface'
import { ComponentRefView } from './ComponentRefView'
import { ComponentParamsOverview } from './ComponentParamsOverview'
import { ConvertToComponentButton } from './ConvertToComponentButton'
import { MultiSelectorInspector } from './MultiSelectorInspector'
import { MultiSelectTargetProvider } from '@site/inspector/MultiSelectTargetProvider'
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

  if (!selectedNode || !definition) {
    const inEmptyVcCanvas =
      activeDocument?.kind === 'visualComponent' &&
      selectedNodeId === null &&
      selectedSelectorClassId === null &&
      !!activeVc
    if (inEmptyVcCanvas && activeVc) {
      return <ComponentParamsOverview vc={activeVc} />
    }
    // panel-39 — the frame's own device preset + W/H live HERE, in the
    // nothing-selected state, and nowhere else. They used to render above
    // every single-node selection, which put a second, unrelated W/H pair
    // four rows above `MeasuresSection`'s real one and cost 88px of
    // permanent chrome on a panel that does not fit a 900px window. Figma
    // shows a frame's size when the frame is what you are looking at; a
    // multi-frame selection gets the same controls from
    // `FrameBulkInspector`. `FrameSizePanel` renders `null` when the active
    // page is not a board frame, so the empty state stands alone elsewhere.
    return (
      <div className={styles.emptySelection}>
        <FrameSizePanel />
        <EmptyState
          variant="centered"
          title="Select an element on the canvas to view its properties."
        />
      </div>
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

  // Every block above `StyleSurface` describes ONE node — which component a
  // node came from, which slot it fills, which source constraint it carries,
  // which classes it has. For a multi-selection each of those would be the
  // anchor's story told as if it were the whole selection's, and ClassPicker
  // would silently edit one layer's `classIds` out of N. So they are the
  // single-selection half of this surface; the sections below, which DO have
  // an honest N-node collapse, are the shared half.
  const singleNodeChrome = !isMultiSelect

  return (
    <MultiSelectTargetProvider>
    <div className={styles.nodeArea}>
      {/* The node-level notices share ONE inset band (UX-25): mounted
          straight into `.nodeArea` they ran edge to edge while the
          ClassPicker under them sat on the panel gutter. The band collapses
          when every notice renders nothing — the common case — so a plain
          selection pays no height for it. */}
      <div className={styles.nodeNotices} data-testid="properties-node-notices">
        {singleNodeChrome && selectedNode?.fromComponent && selectedNodeId ? (
          <SharedComponentNotice componentName={selectedNode.fromComponent} nodeId={selectedNodeId} />
        ) : null}
        {/* E2.5 — the selected node IS the content filling another component's
            slot (a `header={<Icon/>}` fill, or a fragment-slot child). States
            which slot/instance it belongs to; renders nothing for every other
            node (the common case). */}
        {singleNodeChrome && selectedNodeId ? <SlotFillNotice nodeId={selectedNodeId} /> : null}
        {/* Track F2 / R7 — the ONLY two whole-node facts left here: a
            structural lock, and where a resolved text's own literal lives. Every
            other per-field fact (`CodeValueControl`'s per-prop hint,
            `propLockReason`'s per-prop source — R2) lives next to the control
            it's about instead of repeating itself in a node-level paragraph. */}
        {singleNodeChrome && (
          <SourceConstraintNotice
            lockReason={selectedNode.lockReason}
            textOrigin={selectedNode.textOrigin}
            sharedWith={sharedTextOriginCount}
            hasWritableLocation={hasWritableSourceLocation(selectedNode.id)}
            constraint={structuralConstraint}
            nodeId={selectedNodeId ?? undefined}
          />
        )}
        {/* parser-06 — the chosen branch is NOT locked (the parser is certain of
            its structure), but the fact that OTHER branches exist and weren't
            shown is still worth surfacing. */}
        {singleNodeChrome && selectedNode.branchAlternatives?.length ? (
          <BranchChoiceNotice alternatives={selectedNode.branchAlternatives} />
        ) : null}
      </div>
      {/* ClassPicker — always visible to style-edit-capable callers. Hidden
          for content-only Clients, and for a multi-selection (it writes ONE
          node's `classIds`). */}
      {singleNodeChrome && (permissions.canEditStyle || showConvertToComponent) && (
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
          the Styles/Attributes switcher that used to gate this — every
          section now mounts from `INSPECTOR_SECTIONS`, in one continuous
          scroll with a single collapsed More group at its end. */}
      <StyleSurface moduleContent={moduleTabContent} onFocusClassPicker={onFocusClassPicker} />
    </div>
    </MultiSelectTargetProvider>
  )
}
