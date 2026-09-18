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
import { ModuleBlock } from './ModuleBlock'
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
  if (selectedNode?.moduleId === 'base.loop' && selectedNodeId && definition) {
    return (
      <ModuleBlock
        definition={definition}
        resident={
          <LoopPropertiesView
            nodeId={selectedNodeId}
            props={selectedNode.props as Record<string, unknown>}
          />
        }
        folded={null}
        foldedCount={0}
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

  // The schema walk, partitioned by whether the USER'S SOURCE sets the prop
  // (panel-41 / Law 3). A row whose key is absent from `selectedNode.props`
  // and carries no breakpoint override is a pre-drawn default, not a value —
  // it goes behind one disclosure instead of costing a resident row.
  //
  // `selectedNode.props`, deliberately, not `resolvedPropsForBreakpoint`: the
  // resolved bag folds in the module's own `defaults`, so every key in a
  // schema is "present" there and the partition would be a no-op. A node
  // INSERTED in the editor is seeded with those same defaults in its own
  // `props` (`mutations.ts`'s `props: { ...defaults }`), so its rows stay
  // resident — the fold is a fact about parsed source, which is exactly where
  // the pre-drawn rows come from.
  const residentRows: React.ReactNode[] = []
  const foldedRows: React.ReactNode[] = []

  for (const [key, control] of Object.entries(definition.schema) as Array<[string, PropertyControl]>) {
    // Hidden controls carry a type for the engine (escaping dispatch) but
    // render no editor surface — e.g. base.outlet.html, a publisher-filled
    // binding target the author never edits.
    if (control.hidden) continue
    if (isPromotedFormProperty(selectedNode, key)) continue
    // Already rendered above as the dedicated Studio image picker.
    if (showImageSource && key === imageEditProp) continue
    if (control.condition && !evaluateCondition(control.condition, resolvedPropsForBreakpoint)) {
      continue
    }
    if (control.appliesWhen && !propAppliesToInstance(control.appliesWhen, key, resolvedPropsForBreakpoint)) {
      continue
    }

    const row =
      inVisualComponent && activeDocument?.kind === 'visualComponent' && selectedNodeId ? (
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
      ) : (
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

    if (isPropSetOnNode(selectedNode, key, overrideKeys)) residentRows.push(row)
    else foldedRows.push(row)
  }

  return (
    <ModuleBlock
      definition={definition}
      resident={
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

          {residentRows}
        </>
      }
      folded={<>{foldedRows}</>}
      foldedCount={foldedRows.length}
    />
  )
}

/**
 * Whether this instance's own source (or a breakpoint override the user made)
 * sets `key` — the resident/folded partition above.
 *
 * A breakpoint override counts as set even when the base value is absent: the
 * user wrote it, and hiding the only row that shows it would hide their edit.
 */
function isPropSetOnNode(node: PageNode, key: string, overrideKeys: Set<string>): boolean {
  return overrideKeys.has(key) || (node.props as Record<string, unknown>)[key] !== undefined
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

