/**
 * renderModuleTabContent — derive the JSX shown inside StyleSurface's Module
 * section.
 *
 * Three branches:
 *   1. `base.loop` — substitute the schema-driven control list with the
 *      dedicated `LoopPropertiesView` (source picker + dynamic filter UI).
 *      The loop's empty `schema` would otherwise leave the section blank.
 *      Crucially, we still render this *inside* the standard StyleSurface
 *      flow, which means the ClassPicker + style sections (display, layout,
 *      etc.) keep working — the user can assign classes to the loop wrapper
 *      to lay out iterations as a grid, flex row, columns, etc.
 *   2. Visual-component-mode — wrap each control in `ParamPromotableRow` so
 *      the user can lift the prop to the VC's param surface in one click.
 *   3. Default — render each control via `PropertyControlRenderer` with
 *      optional dynamic-binding wiring when the node sits inside an entry-
 *      template page or a `base.loop` ancestor subtree.
 *
 * Lives in its own file because it owns the schema → control dispatch — one
 * of the two highest-churn surfaces of the Properties panel — and benefits
 * from being editable without touching the panel shell.
 */
import { PropertyControlRenderer } from '@site/property-controls/PropertyControlRenderer'
import { evaluateCondition, isPropWritableToSource } from '@core/page-tree'
import type {
  AnyModuleDefinition,
  PropertyControl,
} from '@core/module-engine'
import type {
  DynamicPropBinding,
  Page,
  PageNode,
} from '@core/page-tree'
import type { LoopEntitySource } from '@core/loops/types'
import type { ActiveDocument } from '../../store/slices/uiSlice'
import { isStudioMode } from '@site/studio/studioMode'
import { LoopPropertiesView } from './LoopPropertiesView'
import { InstanceCallSiteView } from './InstanceCallSiteView'
import { propLockReason } from './propLockReason'
import { ParamPromotableRow } from './ParamPromotableRow'
import { FormSettingsPanel } from './FormSettingsPanel'
import { isFormSettingsModule } from './formSettingsAnalysis'
import { ImageSourceSection } from './ImageSourceSection'

const PROMOTED_FORM_PROPERTY_KEYS = new Set(['mode', 'formId', 'targetTableId'])

interface ModuleTabContentArgs {
  selectedNode: PageNode | null
  selectedNodeId: string | null
  definition: AnyModuleDefinition | null | undefined
  resolvedPropsForBreakpoint: Record<string, unknown> | null
  overrideKeys: Set<string>
  activeDocument: ActiveDocument | null
  activePage: Page | null
  dynamicBindingsEnabled: boolean
  enclosingLoopSource: LoopEntitySource | undefined
  enclosingLoopTableId: string | null
  handleChange: (propKey: string, value: unknown) => void
  handlePatch: (patch: Record<string, unknown>) => void
  onSetDynamicBinding: (propKey: string, binding: DynamicPropBinding) => void
  onClearDynamicBinding: (propKey: string) => void
}

export function renderModuleTabContent(args: ModuleTabContentArgs): React.ReactNode {
  const {
    selectedNode,
    selectedNodeId,
    definition,
    resolvedPropsForBreakpoint,
    overrideKeys,
    activeDocument,
    activePage,
    dynamicBindingsEnabled,
    enclosingLoopSource,
    enclosingLoopTableId,
    handleChange: updateModuleProp,
    handlePatch: patchModuleProps,
    onSetDynamicBinding,
    onClearDynamicBinding,
  } = args

  // Branch 1: `base.loop` gets the dedicated loop UI.
  if (selectedNode?.moduleId === 'base.loop' && selectedNodeId) {
    return (
      <LoopPropertiesView
        nodeId={selectedNodeId}
        props={selectedNode.props as Record<string, unknown>}
      />
    )
  }

  // instance-ui-01 — `studio.instance` (WS-4.2) has an empty `schema` (its
  // editable surface is the call-site prop bag, `props.callSiteProps`,
  // classified per-instance rather than from a fixed control map every
  // instance would otherwise share — see that module's own doc comment), so
  // it needs the same dedicated-view treatment `base.loop` gets above,
  // before the schema-driven branches below (which would render nothing for
  // it) ever run.
  if (selectedNode?.moduleId === 'studio.instance' && selectedNodeId) {
    return <InstanceCallSiteView nodeId={selectedNodeId} node={selectedNode} />
  }

  // Branches 2 & 3 share the schema iteration; bail when there's nothing
  // to render against.
  if (!definition || !selectedNode || !resolvedPropsForBreakpoint) return null

  const inVisualComponent =
    activeDocument?.kind === 'visualComponent' && selectedNodeId !== null
  const showFormSettings =
    activePage !== null &&
    selectedNodeId !== null &&
    isFormSettingsModule(selectedNode.moduleId)

  // WS-8.3 — a Studio-imported node whose module declares `imageEdit` gets the
  // dedicated image picker (upload / replace against the WORKSPACE, not the
  // CMS media library) INSTEAD of the schema-driven `type: 'image'` row,
  // whenever there is something honest for it to do: an `assetOrigin` to
  // rewrite (the import-bound case WS-8.3 unlocks), or an ordinary writable
  // literal `src`. A node this control can do nothing for (locked, no traced
  // origin) falls through to the schema loop's existing `CodeValueControl`
  // below unchanged.
  const imageEditProp = definition.imageEdit?.prop
  const showImageSource =
    isStudioMode() &&
    imageEditProp !== undefined &&
    (selectedNode.assetOrigin !== undefined || isPropWritableToSource(selectedNode, imageEditProp))

  return (
    <>
      {showFormSettings && (
        <FormSettingsPanel
          page={activePage}
          nodeId={selectedNodeId}
          onPatchProps={patchModuleProps}
        />
      )}

      {showImageSource && imageEditProp !== undefined && (
        <ImageSourceSection
          node={selectedNode}
          prop={imageEditProp}
          value={resolvedPropsForBreakpoint[imageEditProp]}
          onChange={updateModuleProp}
        />
      )}

      {Object.entries(definition.schema).map(([key, control]: [string, PropertyControl]) => {
        // Hidden controls carry a type for the engine (escaping dispatch) but
        // render no editor surface — e.g. base.outlet.html, a publisher-filled
        // binding target the author never edits.
        if (control.hidden) return null
        if (isPromotedFormProperty(selectedNode, key)) return null
        // Already rendered above as the dedicated Studio image picker.
        if (showImageSource && key === imageEditProp) return null
        if (control.condition && !evaluateCondition(control.condition, resolvedPropsForBreakpoint)) {
          return null
        }

        if (inVisualComponent && activeDocument?.kind === 'visualComponent' && selectedNodeId) {
          return (
            <ParamPromotableRow
              key={key}
              vcId={activeDocument.vcId}
              nodeId={selectedNodeId}
              propKey={key}
              control={control}
              value={resolvedPropsForBreakpoint[key]}
              isOverride={overrideKeys.has(key)}
              onChange={updateModuleProp}
            />
          )
        }

        return (
          <PropertyControlRenderer
            key={key}
            propKey={key}
            control={control}
            value={resolvedPropsForBreakpoint[key]}
            onChange={updateModuleProp}
            isOverride={overrideKeys.has(key)}
            sourceLockReason={propLockReason(selectedNode, key)}
            dynamicBinding={dynamicBindingsEnabled && selectedNodeId ? {
              binding: selectedNode.dynamicBindings?.[key],
              onSet: (binding) => onSetDynamicBinding(key, binding),
              onClear: () => onClearDynamicBinding(key),
              availableFields: enclosingLoopSource?.fields,
              sourceLabel: enclosingLoopSource?.label,
              loopTableId: enclosingLoopTableId,
            } : undefined}
          />
        )
      })}
    </>
  )
}

function isPromotedFormProperty(selectedNode: PageNode, key: string): boolean {
  return selectedNode.moduleId === 'base.form' && PROMOTED_FORM_PROPERTY_KEYS.has(key)
}

