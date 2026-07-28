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
 *      override matrix). Other nodes → Styles/Attributes switcher with the
 *      existing ClassPicker + StyleSurface behind the Styles view.
 *
 * This component is the branch router for the inspector surfaces. It owns only
 * the local Styles/Attributes node-view switch; PropertiesPanel still composes
 * the moduleTabContent JSX once (via `renderModuleTabContent`) and passes it
 * in, keeping the schema → control dispatch reusable across surfaces.
 */
import { useState } from 'react'
import { EmptyState } from '@ui/components/EmptyState'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import type { AnyModuleDefinition } from '@core/module-engine'
import { hasWritableSourceLocation, isPropWritableToSource } from '@core/page-tree'
import type { StyleRule, PageNode } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import type { ActiveDocument } from '../../store/slices/uiSlice'
import { Button } from '@ui/components/Button'
import { ClassPicker, type ClassPickerHandle } from './ClassPicker'
import { StyleSurface } from './StyleSurface'
import { HtmlAttributesPanel } from './HtmlAttributesPanel'
import { ComponentRefView } from './ComponentRefView'
import { ComponentParamsOverview } from './ComponentParamsOverview'
import { ConvertToComponentButton } from './ConvertToComponentButton'
import { MultiSelectionInspector } from './MultiSelectionInspector'
import { MultiSelectorInspector } from './MultiSelectorInspector'
import { SelectorInspector } from './SelectorInspector'
import { canComponentizeNode } from '@site/componentization'
import { SharedComponentNotice } from './SharedComponentNotice'
import { SourceLockedNotice } from './SourceLockedNotice'
import { useEditorStore } from '@site/store/store'
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
  activeClass: StyleRule | null
  activeClassId: string | null
  moduleTabContent: React.ReactNode
  classPickerRef: React.RefObject<ClassPickerHandle | null>
  onFocusClassPicker: () => void
}

type NodeInspectorView = 'styles' | 'attributes'

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
    activeClass,
    activeClassId,
    moduleTabContent,
    classPickerRef,
    onFocusClassPicker,
  } = props
  const permissions = useEditorPermissions()
  const [activeNodeView, setActiveNodeView] = useState<NodeInspectorView>('styles')

  // How many nodes across the site read their text from the SAME literal. A
  // dictionary key is shared copy by design, so an edit to it lands on every
  // screen using it — stated before the user commits, the same way
  // `SharedComponentNotice` states a shared component's blast radius.
  //
  // A primitive selector (no object identity to keep stable), and the O(nodes)
  // scan only runs for a node that actually has an origin.
  const sharedTextOriginCount = useEditorStore((s) => {
    const origin = selectedNode?.textOrigin
    if (!origin || !s.site) return 1
    const key = `${origin.rel}:${origin.line}:${origin.col}`
    let count = 0
    for (const page of s.site.pages) {
      for (const node of Object.values(page.nodes)) {
        const other = node.textOrigin
        if (other && `${other.rel}:${other.line}:${other.col}` === key) count += 1
      }
    }
    return count
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


  return (
    <div className={styles.nodeArea}>
      {selectedNode?.fromComponent && selectedNodeId ? (
        <SharedComponentNotice componentName={selectedNode.fromComponent} nodeId={selectedNodeId} />
      ) : null}
      {selectedNode?.lockReason ? (
        <SourceLockedNotice
          lockReason={selectedNode.lockReason}
          note={selectedNode.resolution?.note}
          textOrigin={selectedNode.textOrigin}
          sharedWith={sharedTextOriginCount}
          codeProps={selectedNode.codeProps}
          hasWritableLocation={hasWritableSourceLocation(selectedNode.id)}
        />
      ) : null}
      <nav className={styles.nodeViewSwitcher} aria-label="Element options">
        <Button
          variant="ghost"
          size="xs"
          className={styles.nodeViewButton}
          active={activeNodeView === 'styles'}
          onClick={() => setActiveNodeView('styles')}
        >
          Styles
        </Button>
        <Button
          variant="ghost"
          size="xs"
          className={styles.nodeViewButton}
          active={activeNodeView === 'attributes'}
          onClick={() => setActiveNodeView('attributes')}
        >
          Attributes
        </Button>
      </nav>

      {/* ClassPicker — always visible to style-edit-capable callers. Hidden
          for content-only Clients. */}
      {activeNodeView === 'styles' && (permissions.canEditStyle || showConvertToComponent) && (
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

      {/* Unified StyleSurface: Module section + CSS sections (scroll-anchor) */}
      {activeNodeView === 'styles' ? (
        <StyleSurface
          definition={definition}
          activeClass={activeClass}
          activeClassId={activeClassId}
          activeBreakpointId={activeBreakpointId}
          nodeId={selectedNodeId}
          inlineStyles={selectedNode.inlineStyles}
          // Only the case where NO inline-style edit can ever land: a `.map` row,
          // whose single piece of source JSX renders every row, so a `style={{}}`
          // write there would restyle all of them. A structurally locked element
          // with a real source location of its own (a ternary branch, a spread
          // bearer) takes ordinary inline styles — `setJsxStyle` merges into the
          // literal object at that line. Per-property refusals are handled by
          // `setNodeInlineStyles` against `codeProps`.
          sourceLockReason={
            hasWritableSourceLocation(selectedNode.id) ? undefined : selectedNode.lockReason
          }
          moduleContent={moduleTabContent}
          onFocusClassPicker={onFocusClassPicker}
        />
      ) : (
        <HtmlAttributesPanel
          nodeId={selectedNode.id}
          htmlAttributes={selectedNode.props.htmlAttributes}
          // `htmlAttributes` is an ordinary prop, so it follows the same per-prop
          // rule as every other one.
          readOnly={
            !permissions.canEditStructure ||
            !isPropWritableToSource(selectedNode, 'htmlAttributes')
          }
        />
      )}
    </div>
  )
}
