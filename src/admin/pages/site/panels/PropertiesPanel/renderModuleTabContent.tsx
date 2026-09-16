/**
 * renderModuleTabContent — derive the JSX shown inside StyleSurface's Module
 * section.
 *
 * Two branches:
 *   1. `base.loop` — substitute the schema-driven control list with the
 *      dedicated `LoopPropertiesView` (source picker + dynamic filter UI).
 *      The loop's empty `schema` would otherwise leave the section blank.
 *      Crucially, we still render this *inside* the standard StyleSurface
 *      flow, which means the ClassPicker + style sections (display, layout,
 *      etc.) keep working — the user can assign classes to the loop wrapper
 *      to lay out iterations as a grid, flex row, columns, etc.
 *   2. Default (covers both plain modules and visual-component-mode) —
 *      render each control via `PropertyControlRenderer`, wrapped in
 *      `ParamPromotableRow` in VC mode, with optional dynamic-binding wiring
 *      when the node sits inside an entry-template page or a `base.loop`
 *      ancestor subtree.
 *
 * `studio.instance` (WS-4.2) used to get a THIRD dedicated branch here
 * (`InstanceCallSiteView`) — P3 item 11 (`STATE.md` `panel-25`, Studio
 * extras) promoted that view to its own `INSPECTOR_SECTIONS` manifest entry
 * (`ComponentSection.tsx`, `inspector/sections/`), so this function now
 * returns `null` for that module id — `studio.instance`'s own `schema` is
 * `{}`, so the schema loop below would render an empty Module-section body
 * anyway; the explicit early return keeps that fact obvious rather than
 * relying on the loop falling through to nothing.
 *
 * Lives in its own file because it owns the schema → control dispatch — one
 * of the two highest-churn surfaces of the Properties panel — and benefits
 * from being editable without touching the panel shell.
 */
import { PropertyControlRenderer } from '@site/property-controls/PropertyControlRenderer'
import { evaluateCondition, explainPropConstraint, hasWritableSourceLocation, isPropWritableToSource } from '@core/page-tree'
import type {
  AnyModuleDefinition,
  PropertyApplicability,
  PropertyControl,
} from '@core/module-engine'
import type { Page, PageNode } from '@core/page-tree'
import type { ActiveDocument } from '../../store/slices/uiSlice'
import { LoopPropertiesView } from './LoopPropertiesView'
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
  handleChange: (propKey: string, value: unknown) => void
  handlePatch: (patch: Record<string, unknown>) => void
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
    handleChange: updateModuleProp,
    handlePatch: patchModuleProps,
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

  // `studio.instance` (WS-4.2) has an empty `schema` — its editable surface
  // is the call-site prop bag (`props.callSiteProps`), now rendered by its
  // own manifest entry (`ComponentSection.tsx`, see this file's own doc
  // header) rather than here. Returning `null` (instead of falling through
  // to an empty schema loop) keeps `StyleSurface`'s `hasModuleContent` check
  // from rendering an empty, headerless Module-section block above it.
  if (selectedNode?.moduleId === 'studio.instance') {
    return null
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
  //
  // `hasWritableSourceLocation` — not just `isPropWritableToSource` — gates
  // this: a node with no source location at all (no `relFile:line:col` id)
  // trivially passes `isPropWritableToSource` ("these rules must not narrow
  // what the ordinary editor can do to it" — see that predicate's own doc),
  // which would otherwise route a non-source-backed node into a picker whose
  // whole job is writing to a real workspace file.
  const imageEditProp = definition.imageEdit?.prop
  const showImageSource =
    imageEditProp !== undefined &&
    (selectedNode.assetOrigin !== undefined ||
      (hasWritableSourceLocation(selectedNode.id) && isPropWritableToSource(selectedNode, imageEditProp)))

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
        if (control.appliesWhen && !propAppliesToInstance(control.appliesWhen, key, resolvedPropsForBreakpoint)) {
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
            // Only `collection-index` reads this: `TabBar.value` names one entry
            // of the sibling `items`, so its options are the node's own data.
            siblingProps={resolvedPropsForBreakpoint}
            constraint={explainPropConstraint(selectedNode, key, resolvedPropsForBreakpoint[key]) ?? undefined}
            // E2.5 — only `SlotControl` reads this: a package/design-system
            // component's own `node`-kind prop is filled directly on ITS OWN
            // element (unlike `studio.instance`, there's no separate call
            // site), so the owner IS the selected node.
            ownerNodeId={selectedNodeId ?? undefined}
          />
        )
      })}
    </>
  )
}

function isPromotedFormProperty(selectedNode: PageNode, key: string): boolean {
  return selectedNode.moduleId === 'base.form' && PROMOTED_FORM_PROPERTY_KEYS.has(key)
}

/**
 * Whether a gated control's row should show, given the instance's CURRENT
 * props — see `PropertyApplicability`'s own doc for why this is a separate
 * check from `evaluateCondition`/`control.condition`.
 *
 * Two ways a row shows: the sibling gating prop's own resolved value is one
 * of the documented `values` (the ordinary case), OR — checked first,
 * because it must win regardless of the gate — the gated prop `key` ITSELF
 * already carries a real value in this instance's props. A `Button` someone
 * hand-wrote (or an agent wrote) as `variant="primary" cardArt="/x.png"`
 * has a real, live `cardArt` in its source; hiding that row would make a
 * value the user can see on the canvas silently un-editable and
 * un-discoverable in the panel — worse than showing an occasionally-dead
 * row. See CLAUDE.md's own "nothing rendered that lies" rule, which cuts
 * both ways: never inventing an inapplicable control, and never hiding one
 * that is already live.
 */
export function propAppliesToInstance(
  gate: PropertyApplicability,
  key: string,
  resolvedProps: Record<string, unknown>,
): boolean {
  if (resolvedProps[key] !== undefined) return true
  return gate.values.includes(resolvedProps[gate.prop] as string)
}

