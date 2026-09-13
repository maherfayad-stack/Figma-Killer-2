/**
 * usePropertiesPanelData — single store-binding + derivation hook for the
 * Properties Panel. Owns every editor-store subscription, every derived value
 * (active VC, active class, override keys, enclosing-loop chain, dynamic-
 * binding context) and the breakpoint-aware change handlers. PropertiesPanel
 * itself reads one bundle and renders JSX — no logic.
 *
 * Why a single bundle: the panel function previously juggled 18 separate
 * `useEditorStore(...)` calls plus a dozen derivations, which pushed its
 * cyclomatic + cognitive complexity into the hotspot top-five. Moving all of
 * that into a dedicated hook drops the panel's own complexity to single
 * digits and gives every future "add another derived prop / store field"
 * change a single place to land.
 *
 * P4 (`STATE.md` `panel-23`) removed this hook's `const site = useEditorStore
 * ((s) => s.site)` line — the site document's ROOT object, replaced wholesale
 * by Mutative on every mutation anywhere in the project, which forced this
 * hook (and everything reading its bundle) to re-render on every keystroke
 * typed ANYWHERE, not just on the selected node. `activeVc`/`activePage` and
 * the style-rule lookups below now read `s.site?.visualComponents`/
 * `s.site?.pages`/`s.site?.styleRules` as their OWN narrow selectors, never
 * `s.site` itself — Mutative's structural sharing keeps each of those
 * references stable across a mutation that doesn't touch that branch. The
 * style/class/provenance slice this hook used to own for the single-node
 * composer (`assignedClassRules`, write-target resolution, provenance) moved
 * to `@site/inspector/selectionModel.ts`'s `useSelectionModel()` — this hook
 * keeps only module/prop resolution and panel-chrome state.
 */
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useEditorStore, selectActiveCanvasPage, selectSelectedNode } from '@site/store/store'
import { registry } from '@core/module-engine'
import { resolveProps } from '@core/page-tree'
import { NO_CLASS_TOKEN_USAGE, buildClassTokenUsageMap, resolveSelectorUsage } from '../selectorUsage'
import type {
  AnyModuleDefinition,
} from '@core/module-engine'
import type { StyleRule, Page, PageNode } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import type { ActiveDocument, PanelState, FocusedPanel, PropertiesPanelMode } from '../../store/slices/uiSlice'

const DEFAULT_WIDTH = 360
const MIN_WIDTH = 280

/**
 * Everything PropertiesPanel needs to render. Field order intentionally
 * mirrors the panel's render flow (selection → context → module data → class
 * data → loop context → panel chrome → actions) to make it cheap to scan.
 */
interface PropertiesPanelData {
  // ─── Selection ─────────────────────────────────────────────────────────
  selectedNode: PageNode | null
  selectedNodeId: string | null
  selectedNodeIds: string[]
  isMultiSelect: boolean

  // ─── Canvas context ────────────────────────────────────────────────────
  activeDocument: ActiveDocument | null
  activeVc: VisualComponent | null
  activePage: Page | null
  activeBreakpointId: string | undefined

  // ─── Module + props ────────────────────────────────────────────────────
  definition: AnyModuleDefinition | null
  resolvedPropsForBreakpoint: Record<string, unknown> | null
  overrideKeys: Set<string>

  // ─── Class context ─────────────────────────────────────────────────────
  activeClass: StyleRule | null
  activeClassId: string | null
  selectedSelectorClass: StyleRule | null
  selectedSelectorClassId: string | null
  selectedSelectorClassIds: string[]
  isSelectorMultiSelect: boolean
  selectedSelectorUsage: string | null

  // ─── Loop / dynamic-binding context ────────────────────────────────────

  // ─── Panel chrome state ────────────────────────────────────────────────
  panelState: PanelState
  collapsed: boolean
  width: number
  focusedPanel: FocusedPanel
  statusMessage: string

  // ─── Panel chrome actions ──────────────────────────────────────────────
  setStatusMessage: (msg: string) => void
  togglePropertiesPanel: () => void
  setPropertiesPanelMode: (mode: PropertiesPanelMode) => void
  setFocusedPanel: (panel: FocusedPanel) => void
  renameClass: (classId: string, name: string) => void
  deleteClass: (classId: string) => void
  renameNode: (nodeId: string, label: string) => void

  // ─── Prop change handlers ──────────────────────────────────────────────
  handleChange: (propKey: string, value: unknown) => void
  handlePatch: (patch: Record<string, unknown>) => void
}

export function usePropertiesPanelData(): PropertiesPanelData {
  // ─── Store subscriptions ────────────────────────────────────────────────
  const selectedNode = useEditorStore(selectSelectedNode)
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const selectedNodeIds = useEditorStore(useShallow((s) => s.selectedNodeIds))
  const updateNodeProps = useEditorStore((s) => s.updateNodeProps)
  const setBreakpointOverride = useEditorStore((s) => s.setBreakpointOverride)
  const renameClass = useEditorStore((s) => s.renameClass)
  const deleteClass = useEditorStore((s) => s.deleteClass)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  const renameNode = useEditorStore((s) => s.renameNode)
  const activeClassId = useEditorStore((s) => s.activeClassId)
  const selectedSelectorClassId = useEditorStore((s) => s.selectedSelectorClassId)
  const selectedSelectorClassIds = useEditorStore(useShallow((s) => s.selectedSelectorClassIds))
  const panelState = useEditorStore((s) => s.propertiesPanel)
  const setPropertiesPanelMode = useEditorStore((s) => s.setPropertiesPanelMode)
  const togglePropertiesPanel = useEditorStore((s) => s.togglePropertiesPanel)
  const focusedPanel = useEditorStore((s) => s.focusedPanel)
  const setFocusedPanel = useEditorStore((s) => s.setFocusedPanel)
  const activeDocument = useEditorStore((s) => s.activeDocument)
  // Narrow, per-branch selectors — never `s.site` itself (`no-full-site-scan-
  // in-selectors.test.ts`'s `WHOLE_SITE_SELECTOR_RE` gate would only catch
  // this under `inspector/`, but the fix is the same rule everywhere: read
  // the branch each fact actually lives on, so Mutative's structural sharing
  // keeps the reference stable across an unrelated mutation).
  const styleRules = useEditorStore((s) => s.site?.styleRules)
  const activeVc = useEditorStore((s) =>
    activeDocument?.kind === 'visualComponent'
      ? (s.site?.visualComponents?.find((v) => v.id === activeDocument.vcId) ?? null)
      : null,
  )
  // `selectActiveCanvasPage`, not a raw `s.site?.pages.find(...)` — the raw
  // pattern only searches the page tree and silently returns null for a
  // node that lives inside a VC's own tree (`canvas-aware-selectors.test.ts`
  // Gate 2). Memoised via WeakMap in `store.ts`, so its reference is stable
  // across renders that don't touch the active VC/page.
  const activePage = useEditorStore(selectActiveCanvasPage)
  // The site-slice class-usage index (see `nodeIndex.ts`). Its Map identity
  // changes only when a class assignment actually changes, so subscribing to
  // it re-renders the usage badge when it must and never on a prop keystroke.
  const classUsageById = useEditorStore((s) => s._classIdToNodeCount)

  const [statusMessage, setStatusMessage] = useState('')

  // ─── Derivations ────────────────────────────────────────────────────────
  const isMultiSelect = selectedNodeIds.length > 1
  // A MULTI-selection needs two members, the same bar `isMultiSelect` above
  // has always applied to layers. Ticking one checkbox in the Selectors panel
  // used to hand a one-item set to `MultiSelectorInspector`, whose whole
  // surface is bulk actions ("Delete classes? 1 class will be removed…") plus
  // a one-row list — a worse inspector for that selector than the ordinary
  // single-selector one, reachable for the identical selection by clicking
  // the row instead of its checkbox.
  const isSelectorMultiSelect = selectedSelectorClassIds.length > 1

  const definition: AnyModuleDefinition | null = selectedNode
    ? registry.get(selectedNode.moduleId) ?? null
    : null
  const resolvedPropsForBreakpoint = selectedNode
    ? resolveProps(
        selectedNode,
        activeBreakpointId !== 'desktop' ? activeBreakpointId : undefined,
        definition?.schema,
      )
    : null

  // Only props the module marks `breakpointOverridable: true` may carry a
  // per-breakpoint override; everything else is content (single value across
  // all breakpoints). Filter the override-indicator set the same way so the
  // UI never claims a content prop has a per-breakpoint variant — even if
  // stale data on disk technically does.
  const overrideKeys = resolveOverrideKeys(selectedNode, definition, activeBreakpointId)

  // `toggleSelectorMultiSelect` clears `selectedSelectorClassId` when it
  // checks a box, so the lone checked selector has to resolve from the
  // checkbox set — otherwise raising the multi bar to 2 (above) would drop a
  // one-checkbox selection through to "nothing selected". One checked box and
  // one clicked row now open the same inspector, which is the point.
  const soleSelectorClassId =
    selectedSelectorClassId ??
    (selectedSelectorClassIds.length === 1 ? selectedSelectorClassIds[0] : null)
  const selectedSelectorClass = soleSelectorClassId
    ? styleRules?.[soleSelectorClassId] ?? null
    : null
  // Ambient rules report "Unused" only when provably dead; class rules report
  // an exact reference count. `null` means "no badge" (unassessable ambient).
  //
  // The count comes from the store's `_classIdToNodeCount` index — an O(1)
  // read. It used to come from `buildSelectorUsageMap(site)`, a walk of every
  // node of every page run from THIS render body, i.e. once per keystroke
  // (store-01b). The ambient token rollup is O(rules) and only an ambient
  // selector can need it, so it is built only in that branch.
  const selectedSelectorUsage = selectedSelectorClass
    ? resolveSelectorUsage(
        selectedSelectorClass,
        classUsageById,
        selectedSelectorClass.kind === 'ambient'
          ? buildClassTokenUsageMap(styleRules ?? {}, classUsageById)
          : NO_CLASS_TOKEN_USAGE,
      ).label
    : null
  const activeClass =
    !selectedSelectorClass && activeClassId && selectedNode
      ? styleRules?.[activeClassId] ?? null
      : null

  // ─── Prop change handler ────────────────────────────────────────────────
  //
  // A non-default breakpoint frame routes writes through
  // `setBreakpointOverride` ONLY when the module schema marks the prop
  // `breakpointOverridable: true`. For everything else (the default — content
  // props like text, tag, src, alt) the edit always lands on base props,
  // because the published page is one HTML document and content cannot
  // meaningfully differ per viewport. Visual responsive variation lives in
  // class breakpoint styles, not in module props.
  //
  // The schema lookup is intentionally performed via `registry.get()` inside
  // the handler rather than closing over the `definition` object, so it always
  // reflects the current selection without depending on a recomputed value.
  const moduleId = selectedNode?.moduleId
  const handleChange = (propKey: string, value: unknown) => {
    if (!selectedNodeId) return
    const def = moduleId ? registry.get(moduleId) : null
    const isOverridable = def?.schema[propKey]?.breakpointOverridable === true
    if (activeBreakpointId && activeBreakpointId !== 'desktop' && isOverridable) {
      setBreakpointOverride(selectedNodeId, activeBreakpointId, { [propKey]: value })
    } else {
      updateNodeProps(selectedNodeId, { [propKey]: value })
    }
    setStatusMessage(`${propKey} updated`)
  }

  const handlePatch = (patch: Record<string, unknown>) => {
    if (!selectedNodeId) return
    updateNodeProps(selectedNodeId, patch)
    setStatusMessage('Form settings updated')
  }

  const collapsed = panelState.collapsed
  const width = Math.max(panelState.width || DEFAULT_WIDTH, MIN_WIDTH)

  return {
    selectedNode,
    selectedNodeId,
    selectedNodeIds,
    isMultiSelect,

    activeDocument,
    activeVc,
    activePage,
    activeBreakpointId,

    definition,
    resolvedPropsForBreakpoint,
    overrideKeys,

    activeClass,
    activeClassId,
    selectedSelectorClass,
    selectedSelectorClassId: soleSelectorClassId,
    selectedSelectorClassIds,
    isSelectorMultiSelect,
    selectedSelectorUsage,


    panelState,
    collapsed,
    width,
    focusedPanel,
    statusMessage,

    setStatusMessage,
    togglePropertiesPanel,
    setPropertiesPanelMode,
    setFocusedPanel,
    renameClass,
    deleteClass,
    renameNode,

    handleChange,
    handlePatch,
  }
}

// ---------------------------------------------------------------------------
// Helpers — pulled out so the hook body stays readable. Each helper has one
// reason to change.
// ---------------------------------------------------------------------------

function resolveOverrideKeys(
  selectedNode: PageNode | null,
  definition: AnyModuleDefinition | null,
  activeBreakpointId: string | undefined,
): Set<string> {
  if (!selectedNode || !definition || !activeBreakpointId || activeBreakpointId === 'desktop') {
    return new Set()
  }
  const overrides = selectedNode.breakpointOverrides[activeBreakpointId] ?? {}
  return new Set(
    Object.keys(overrides).filter(
      (key) => definition.schema[key]?.breakpointOverridable === true,
    ),
  )
}

