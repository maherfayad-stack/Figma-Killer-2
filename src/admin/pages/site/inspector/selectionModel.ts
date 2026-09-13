/**
 * selectionModel — the single narrow-selector surface the Properties panel's
 * style-editing path reads from (`STUDIO-LIVE-CANVAS-PLAN.md` §P4).
 *
 * ## Why this file exists
 *
 * `usePropertiesPanelData.ts:106` used to read `const site = useEditorStore((s)
 * => s.site)` — the site document's ROOT object, replaced wholesale by
 * Mutative on every mutation anywhere in the document. That single line was
 * why the Properties panel re-rendered on every keystroke typed ANYWHERE in
 * the project, not just on the selected node. `useSelectionModel` replaces
 * the style/class/provenance slice of that hook's job with selectors that
 * read only the narrow branch each fact actually lives on
 * (`s.site?.styleRules`, never `s.site` itself) — Mutative's structural
 * sharing means `site.styleRules` keeps its OLD reference across any
 * mutation that doesn't touch the style-rule registry, so a keystroke on an
 * unrelated text node does not re-render this hook's consumers.
 *
 * Module/prop resolution and panel-chrome state (width, collapsed,
 * focusedPanel, statusMessage) are NOT this file's job — they stay on
 * `usePropertiesPanelData.ts` (see `STATE.md` `panel-23`'s Decisions: those
 * concerns feed `SelectorHeader`/`ComponentParamsOverview`, not the style
 * composer this model exists for).
 *
 * ## What this reuses, unchanged
 *
 * `resolveWriteTarget.ts` (the P1 rule — genuinely reusable, its own doc
 * comment's "P4 replaces it wholesale" turned out to describe the disposable
 * WIRING around it, not the rule itself), `stylePropertyProvenance.ts`'s
 * `buildClassChain`/`resolvePropertyProvenance`/`buildStableProvenanceMap`,
 * `classCssWritability.ts`'s `resolveClassCssEditability`/
 * `classCssWriteLockReason`. `writeTargetFor` calls the P1 rule PER PROPERTY
 * (fixing `WriteTargetStyleComposer.tsx`'s "resolved once from the first
 * key" landmine for a multi-property patch) instead of reinventing it.
 *
 * ## Multi-select is out of scope
 *
 * `isMultiSelect` is exposed so a consumer can branch away from this model,
 * but nothing here builds a Mixed-value-aware multi-node shape —
 * `MultiInlineStyleComposer.tsx`/`MultiSelectorInspector.tsx` stay on their
 * pre-existing, separate path this pass (`STATE.md` `panel-23`'s own
 * "Explicit scope boundary" section).
 */
import { useEditorStore, selectActiveCanvasPage, selectSelectedNode } from '@site/store/store'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { useMutableBox } from '@site/hooks/useMutableBox'
import { useFrameComputedStyleValues } from '@site/panels/InspectPanel/useInspectComputedStyle'
import { ALL_CURATED_CSS_PROPERTIES } from '../panels/PropertiesPanel/cssControlTypes'
import { getActiveStyleTab } from '../panels/PropertiesPanel/classStyleSections'
import {
  buildClassChain,
  buildStableProvenanceMap,
  resolvePropertyProvenance,
  type PropertyProvenance,
} from '../panels/PropertiesPanel/stylePropertyProvenance'
import { classCssWriteLockReason, resolveClassCssEditability } from '../panels/PropertiesPanel/classCssWritability'
import {
  canWriteInlineStyleForModule,
  hasWritableSourceLocation,
  isGeneratedClassLocked,
  isStudioPageRootId,
  styleRuleSelector,
  styleValueKey,
  type CSSPropertyBag,
  type PageNode,
  type StyleRule,
} from '@core/page-tree'
import {
  resolveExistingWriteTarget,
  resolveWriteTarget,
  type WriteTarget,
  type WriteTargetClassCandidate,
} from './resolveWriteTarget'

const EMPTY_CODE_PROPS: readonly string[] = []
const STYLE_KEY_PREFIX = styleValueKey('')

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface SelectionModelWritableClass {
  classId: string
  /** Human-readable selector, e.g. `.card` — for chip/notice copy. */
  selector: string
  /** Null when a NEW declaration in this class would reach disk. */
  lockReason: string | null
}

export interface SelectionModel {
  selectedNodeId: string | null
  selectedNode: PageNode | null
  /** `selectedNodeIds.length > 1` — multi-select stays on its own path this pass. */
  isMultiSelect: boolean

  /** Active breakpoint tab or condition, whichever wins — condition beats breakpoint. */
  activeContextId: string | null

  /** Every class assigned to the node, mapped through `s.site?.styleRules` — NOT `s.site`. */
  assignedClassRules: StyleRule[]
  writableClasses: ReadonlyArray<SelectionModelWritableClass>
  inlineWritable: boolean
  inlineLockReason: string | null

  provenanceByProperty: ReadonlyMap<string, PropertyProvenance>
  computedValues: Record<string, string> | null

  /** The P1 rule, exposed per-property so a section never calls `resolveWriteTarget` itself. */
  writeTargetFor(property: string, opts?: { existing?: boolean }): WriteTarget
}

// ---------------------------------------------------------------------------
// useSelectionModel
// ---------------------------------------------------------------------------

export function useSelectionModel(): SelectionModel {
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const selectedNode = useEditorStore(selectSelectedNode)
  // A primitive boolean return — never the `selectedNodeIds` array itself —
  // so this re-renders only when the multi/single boundary actually flips.
  const isMultiSelect = useEditorStore((s) => s.selectedNodeIds.length > 1)

  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  // Narrowed to `s.site?.conditions` (a small, rarely-touched array), never
  // `s.site` — mirrors `StyleSurface.tsx`'s pre-existing pattern.
  const activeConditionId = useEditorStore((s) => {
    const id = s.activeConditionId
    if (id === null) return null
    const conditions = s.site?.conditions
    return conditions && conditions.some((c) => c.id === id) ? id : null
  })
  const activeTab = getActiveStyleTab(activeBreakpointId)
  const activeContextId = activeConditionId ?? (activeTab !== 'base' ? activeTab : null)

  // The load-bearing change: `s.site?.styleRules` as its OWN selector, never
  // `s.site`. Mutative keeps this reference stable across any mutation that
  // doesn't touch the style-rule registry.
  const styleRules = useEditorStore((s) => s.site?.styleRules)
  const assignedClassRules: StyleRule[] = selectedNode
    ? selectedNode.classIds
        .map((id) => styleRules?.[id])
        .filter((rule): rule is StyleRule => rule != null)
    : []

  // Whether the active canvas page is a Studio-parsed page — gates
  // `classCssWriteLockReason`'s "unmapped means unwritable" rule. Returns a
  // primitive boolean, so this selector body reading `s.site` internally
  // (via `selectActiveCanvasPage`) never leaks a whole-site reference out.
  const studioSession = useEditorStore((s) => {
    const page = selectActiveCanvasPage(s)
    return page != null && isStudioPageRootId(page.rootNodeId)
  })

  const writableClasses: SelectionModelWritableClass[] = assignedClassRules.map((cls) => {
    if (isGeneratedClassLocked(cls)) {
      return {
        classId: cls.id,
        selector: styleRuleSelector(cls),
        lockReason: 'Generated utility class — not meant to be edited.',
      }
    }
    const lockReason = classCssWriteLockReason(resolveClassCssEditability(cls), { studioSession })
    return { classId: cls.id, selector: styleRuleSelector(cls), lockReason }
  })

  const permissions = useEditorPermissions()
  const canEditStyleHere = permissions.canEditStyle
  const nodeModuleId = selectedNode?.moduleId
  // A `pkg.*`/`alm.*`/`studio.instance` node's `style=""` is written by its
  // OWN source, so nothing typed here would save for it.
  const inlineModuleUnwritable =
    nodeModuleId !== undefined && !canWriteInlineStyleForModule(nodeModuleId)
  const canToggleElement = canEditStyleHere && selectedNodeId != null && !inlineModuleUnwritable
  const sourceLockReason =
    selectedNode && !hasWritableSourceLocation(selectedNode.id) ? selectedNode.lockReason : undefined
  const inlineWritable = canToggleElement && sourceLockReason === undefined
  const inlineLockReason = !canToggleElement
    ? inlineModuleUnwritable
      ? "Inline styles come from this component's own source."
      : 'Styles are read-only for your role.'
    : sourceLockReason !== undefined
      ? `This element is ${sourceLockReason}, so its style="" layer is written in code.`
      : null

  const classChain = buildClassChain(assignedClassRules, activeContextId)
  const computedValues = useFrameComputedStyleValues(
    selectedNodeId,
    activeBreakpointId ?? 'desktop',
    ALL_CURATED_CSS_PROPERTIES,
  )
  const previousProvenanceBox = useMutableBox<Map<string, PropertyProvenance>>()
  const provenanceByProperty = buildStableProvenanceMap(
    previousProvenanceBox,
    ALL_CURATED_CSS_PROPERTIES,
    (prop) =>
      resolvePropertyProvenance(prop as keyof CSSPropertyBag, {
        classChain,
        inlineStyles: selectedNode?.inlineStyles ?? {},
        computedValue: computedValues?.[prop],
      }),
  )

  // A `style:<prop>` entry resolved from an expression in code — the ONLY
  // per-property gate `writeTargetFor` folds into the inline branch of the
  // P1 rule itself (matching `WriteTargetStyleComposer.tsx`'s prior
  // `inlineWritableFor`). The all-or-nothing REFUSAL of the whole write for
  // a locked property is the commit API's job (`commitApi.ts`), not this
  // resolution rule's — `resolveWriteTarget` never knew about code-valued
  // props and still doesn't.
  const lockedProperties = (selectedNode?.codeProps ?? EMPTY_CODE_PROPS)
    .filter((name) => name.startsWith(STYLE_KEY_PREFIX))
    .map((name) => name.slice(STYLE_KEY_PREFIX.length))
  const lockedPropertySet = new Set(lockedProperties)

  const writableClassCandidates: WriteTargetClassCandidate[] = writableClasses
    .filter((entry) => entry.lockReason === null)
    .map((entry) => ({ classId: entry.classId, selector: entry.selector }))

  function writeTargetFor(property: string, opts?: { existing?: boolean }): WriteTarget {
    const provenance = provenanceByProperty.get(property)
    const inlineWritableForProperty = inlineWritable && !lockedPropertySet.has(property)
    const params = {
      provenance,
      inlineWritable: inlineWritableForProperty,
      writableClasses: writableClassCandidates,
    }
    return opts?.existing ? resolveExistingWriteTarget(params) : resolveWriteTarget(params)
  }

  return {
    selectedNodeId,
    selectedNode,
    isMultiSelect,

    activeContextId,

    assignedClassRules,
    writableClasses,
    inlineWritable,
    inlineLockReason,

    provenanceByProperty,
    computedValues,

    writeTargetFor,
  }
}
