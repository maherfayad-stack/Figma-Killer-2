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
 * ## Multi-select goes through THIS model (S5)
 *
 * `panel-23` scoped multi-select out and left it on a parallel surface
 * (`MultiSelectionInspector.tsx` -> `MultiSelectionStyleArea.tsx` ->
 * `MultiInlineStyleComposer.tsx`). That surface could render exactly one
 * editing section — `CustomPropertiesSection` — because every OTHER section
 * had migrated to `INSPECTOR_SECTIONS`, which reads this hook, which assumed
 * one node. Selecting two layers therefore *lost* Fill, Stroke, Text,
 * Measures and the rest. S5 closes that by widening the model instead of
 * widening the parallel surface, so there is one paradigm again.
 *
 * The widening is deliberately shaped so **no section file changes**. Every
 * section reads `selectedNode.inlineStyles` + `assignedClassRules` and builds
 * its bags with `collapsedStyleBag.ts`. So for N nodes this hook hands them:
 *
 *   - **`selectedNode`** — the anchor node with its `inlineStyles` replaced by
 *     the selection's COLLAPSED inline bag: the shared value where every
 *     selected layer agrees, the `MIXED` sentinel where they do not
 *     (`buildMultiSelectStyleBags`, `@ui/components/MixedValue`). "Set on one,
 *     absent on another" is a disagreement, not a value to prefer.
 *   - **`codeProps`** — only the `style:<prop>` locks present on EVERY
 *     selected node. A property one layer computes in code is still writable
 *     to the other four; `setNodesInlineStyles` skips the refusers per node,
 *     and `StyleSurface` names them above the sections so the partial write
 *     is never silent. Blocking the control for all five would be the lie.
 *   - **`computedValues: null`** — `useFrameComputedStyleValues` reads ONE
 *     mounted element. There is no N-node form, and showing the anchor's
 *     computed value as the whole selection's placeholder would claim
 *     agreement the panel never measured. Provenance runs without it, which
 *     is a degradation it already supports (declared sources still resolve;
 *     an ambiguous multi-class cascade crowns nobody).
 *   - **`assignedClassRules`** — `[]` by default, because inline is the only
 *     target with no ambiguity: `style=""` belongs to exactly one element, so
 *     N inline writes touch exactly the N elements selected. When the user
 *     explicitly picks the class target in `MultiSelectTargetBar` (and clears
 *     its blast-radius gate), `MultiSelectTargetContext` names that class id
 *     and this hook hands back just that rule with `inlineWritable: false`,
 *     so `resolveWriteTarget` lands every commit on the class. See
 *     `docs/features/inspector.md` §9.4.
 *
 * `commitApi.ts` is the other half: it dispatches an inline write for N to
 * `setNodesInlineStyles` (one history entry for the whole selection) instead
 * of `setNodeInlineStyles`.
 */
import { useEditorStore, selectActiveCanvasPage, selectSelectedNode } from '@site/store/store'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { useMutableBox } from '@site/hooks/useMutableBox'
import { useFrameComputedStyleValues } from '@site/panels/InspectPanel/useInspectComputedStyle'
import { ALL_CURATED_CSS_PROPERTIES, isCuratedProperty } from '../panels/PropertiesPanel/cssControlTypes'
import { getActiveStyleTab } from '../panels/PropertiesPanel/classStyleSections'
import { buildMultiSelectStyleBags } from '../panels/PropertiesPanel/multiSelectStyleBags'
import { resolveSelectedNodes } from '../panels/PropertiesPanel/multiSelectNodes'
import { useMultiSelectTarget } from './multiSelectTarget'
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
const EMPTY_BLOCKED_COUNTS: ReadonlyMap<string, number> = new Map()
/** Stable empty bag so a node without inline styles doesn't allocate one per render. */
const EMPTY_STYLES: Record<string, unknown> = {}

// ---------------------------------------------------------------------------
// The multi-selection collapse (S5) — see this file's own doc header.
// ---------------------------------------------------------------------------

/** Class ids carried by EVERY node, in the anchor's own order (cascade order). */
function sharedClassIds(nodes: ReadonlyArray<PageNode>): string[] {
  if (nodes.length === 0) return []
  const anchor = nodes[nodes.length - 1]
  return anchor.classIds.filter((id) => nodes.every((node) => node.classIds.includes(id)))
}

/** `style:<prop>` keys on one node, with the `style:` prefix sliced off. */
function lockedStyleKeys(node: PageNode): string[] {
  return (node.codeProps ?? EMPTY_CODE_PROPS)
    .filter((name) => name.startsWith(STYLE_KEY_PREFIX))
    .map((name) => name.slice(STYLE_KEY_PREFIX.length))
}

interface CollapsedMultiSelection {
  /** The anchor, wearing the whole selection's collapsed inline bag and locks. */
  node: PageNode | null
  blockedPropertyCounts: ReadonlyMap<string, number>
}

/**
 * Collapse N nodes into the ONE node shape every `INSPECTOR_SECTIONS` entry
 * already knows how to read, so multi-select needs no second section tree.
 *
 * `codeProps` keeps only the locks EVERY node carries: `setNodesInlineStyles`
 * skips a refusing node per property and writes the rest, so a lock on one of
 * five layers must not disable a control that works for four. The per-property
 * counts come back separately, for the notice that keeps that partial write
 * from being silent.
 */
function collapseMultiSelection(
  nodes: ReadonlyArray<PageNode>,
  anchor: PageNode | null,
  styleRules: Record<string, StyleRule> | undefined,
  activeContextId: string | null,
): CollapsedMultiSelection {
  if (anchor === null || nodes.length === 0) {
    return { node: anchor, blockedPropertyCounts: EMPTY_BLOCKED_COUNTS }
  }

  const styleNodes = nodes.map((node) => ({
    inlineStyles: node.inlineStyles ?? EMPTY_STYLES,
    classChain: buildClassChain(
      node.classIds.map((id) => styleRules?.[id]).filter((rule): rule is StyleRule => rule != null),
      activeContextId,
    ),
  }))

  // `buildMultiSelectStyleBags` only returns keys from the list it is handed,
  // so the curated set alone would starve `CustomPropertiesSection` — union in
  // every uncurated key actually set on at least one selected node, the same
  // "what's present" question that section asks for a single node.
  const uncuratedPresent = [
    ...new Set(
      styleNodes.flatMap((node) => Object.keys(node.inlineStyles).filter((key) => !isCuratedProperty(key))),
    ),
  ]
  const { storedStyles } = buildMultiSelectStyleBags(styleNodes, [
    ...ALL_CURATED_CSS_PROPERTIES,
    ...uncuratedPresent,
  ])

  const blockedPropertyCounts = new Map<string, number>()
  for (const node of nodes) {
    for (const key of lockedStyleKeys(node)) {
      blockedPropertyCounts.set(key, (blockedPropertyCounts.get(key) ?? 0) + 1)
    }
  }
  const lockedOnEveryNode = [...blockedPropertyCounts.entries()]
    .filter(([, count]) => count === nodes.length)
    .map(([key]) => styleValueKey(key))

  return {
    node: { ...anchor, inlineStyles: storedStyles, codeProps: lockedOnEveryNode },
    blockedPropertyCounts,
  }
}

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
  /** The anchor id — `selectedNodeIds`'s last entry, the store's own convention. */
  selectedNodeId: string | null
  /**
   * The anchor node for one selection; for N, the anchor with its
   * `inlineStyles`/`codeProps` collapsed across the whole selection. See this
   * file's own "Multi-select" doc — a section reads this and gets Mixed for
   * free.
   */
  selectedNode: PageNode | null
  /** `selectedNodeIds.length > 1`. */
  isMultiSelect: boolean
  /** The whole selection, in selection order (anchor last). */
  selectedNodeIds: ReadonlyArray<string>
  /** Every selected id that still resolves to a live node, in selection order. */
  selectedNodes: ReadonlyArray<PageNode>
  /**
   * The selected nodes that take an inline write at all — a `pkg.*`/
   * `studio.instance` node's `style=""` is written by its OWN source, so a
   * patch aimed at it would render on canvas and then be dropped at save.
   * `commitApi` writes to exactly these ids; `StyleSurface` names the rest.
   */
  inlineWritableNodeIds: ReadonlyArray<string>
  /** Selected nodes whose module takes no inline style of its own. */
  inlineUnwritableNodes: ReadonlyArray<PageNode>
  /**
   * `style:<prop>` properties, and how many selected layers refuse each —
   * the count a row states instead of a boolean ("writes to 3 of 5"). Empty
   * for a single selection, which uses `codeProps` directly.
   */
  blockedPropertyCounts: ReadonlyMap<string, number>
  /**
   * The classes EVERY selected node carries, for the multi-selection target
   * chip. Empty for a single selection (which uses `assignedClassRules`).
   */
  sharedClassRules: ReadonlyArray<StyleRule>

  /** Active breakpoint tab or condition, whichever wins — condition beats breakpoint. */
  activeContextId: string | null

  /** Every class assigned to the node, mapped through `s.site?.styleRules` — NOT `s.site`. */
  assignedClassRules: StyleRule[]
  writableClasses: ReadonlyArray<SelectionModelWritableClass>
  inlineWritable: boolean
  inlineLockReason: string | null

  provenanceByProperty: ReadonlyMap<string, PropertyProvenance>
  computedValues: Record<string, string> | null
  /** True while a Tier 2 bridge-mode measurement for `computedValues` is in flight — always `false` on a Tier 0/1 (portal) board. P5, STATE.md `panel-26`. Additive-only: existing readers that don't destructure this field are unaffected. */
  computedValuesLoading: boolean

  /** The P1 rule, exposed per-property so a section never calls `resolveWriteTarget` itself. */
  writeTargetFor(property: string, opts?: { existing?: boolean }): WriteTarget
}

// ---------------------------------------------------------------------------
// useSelectionModel
// ---------------------------------------------------------------------------

export function useSelectionModel(): SelectionModel {
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const anchorNode = useEditorStore(selectSelectedNode)
  // The array itself, not a derived count: a multi-selection has to resolve
  // every id. Mutative keeps this reference stable across any store change
  // that doesn't touch the selection, so a single selection re-renders no
  // more often than it did when this read a primitive boolean.
  const selectedNodeIds = useEditorStore((s) => s.selectedNodeIds)
  const isMultiSelect = selectedNodeIds.length > 1

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

  // ── The multi-selection widening (S5) ────────────────────────────────────
  // Three narrow reads, all stable under Mutative unless the thing they name
  // actually changed: the active tree (the overwhelmingly common home for
  // every selected id), the pages array (a board multi-selection can span
  // frames), and the O(1) id->page index. Never a walk of every node of every
  // page (`no-full-site-scan-in-selectors`).
  const activeTree = useEditorStore(selectActiveCanvasPage)
  const sitePages = useEditorStore((s) => s.site?.pages)
  const nodeIdToPageIds = useEditorStore((s) => s._nodeIdToPageIds)
  const multiTarget = useMultiSelectTarget()

  const selectedNodes: PageNode[] = isMultiSelect
    ? resolveSelectedNodes(selectedNodeIds, {
        activeTree: activeTree ?? null,
        site: sitePages ? { pages: sitePages } : null,
        nodeIdToPageIds,
      })
    : anchorNode
      ? [anchorNode]
      : []

  const inlineUnwritableNodes = selectedNodes.filter(
    (node) => !canWriteInlineStyleForModule(node.moduleId),
  )
  const inlineWritableNodeIds = selectedNodes
    .filter((node) => canWriteInlineStyleForModule(node.moduleId))
    .map((node) => node.id)

  const sharedClassRules: StyleRule[] = isMultiSelect
    ? sharedClassIds(selectedNodes)
        .map((id) => styleRules?.[id])
        .filter((rule): rule is StyleRule => rule != null)
    : []

  const multi = isMultiSelect ? collapseMultiSelection(selectedNodes, anchorNode, styleRules, activeContextId) : null
  const selectedNode = multi?.node ?? anchorNode
  const blockedPropertyCounts: ReadonlyMap<string, number> =
    multi?.blockedPropertyCounts ?? EMPTY_BLOCKED_COUNTS

  // The class target, when the user explicitly picked one for a
  // multi-selection and cleared its gate. A target the selection stopped
  // sharing (a layer added, a class removed) silently falls back to Element
  // rather than editing a class the chip no longer names.
  const multiTargetRule = isMultiSelect
    ? (sharedClassRules.find((rule) => rule.id === multiTarget.classId) ?? null)
    : null

  const assignedClassRules: StyleRule[] = isMultiSelect
    ? multiTargetRule
      ? [multiTargetRule]
      : []
    : selectedNode
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
  // OWN source, so nothing typed here would save for it. For N nodes the
  // question is whether ANY of them takes an inline write — the ones that
  // don't are skipped by the write and named above the sections, which is a
  // different fact from "this control does nothing".
  const inlineModuleUnwritable = isMultiSelect
    ? inlineWritableNodeIds.length === 0
    : nodeModuleId !== undefined && !canWriteInlineStyleForModule(nodeModuleId)
  const canToggleElement = canEditStyleHere && selectedNodeId != null && !inlineModuleUnwritable
  const sourceLockReason =
    !isMultiSelect && selectedNode && !hasWritableSourceLocation(selectedNode.id)
      ? selectedNode.lockReason
      : undefined
  // Element is the default multi target; picking the class turns inline OFF
  // so `resolveWriteTarget`'s single-writable-class branch lands every commit
  // on it (see this file's own "Multi-select" doc).
  const inlineWritable = canToggleElement && sourceLockReason === undefined && multiTargetRule == null
  const inlineLockReason = !canToggleElement
    ? inlineModuleUnwritable
      ? "Inline styles come from this component's own source."
      : 'Styles are read-only for your role.'
    : sourceLockReason !== undefined
      ? `This element is ${sourceLockReason}, so its style="" layer is written in code.`
      : null

  const classChain = buildClassChain(assignedClassRules, activeContextId)
  // One mounted element, one reading — so a multi-selection deliberately has
  // none rather than the anchor's, which would claim agreement nobody
  // measured. Passing `null` keeps the hook's own subscription inert.
  const { value: singleComputedValues, isLoading: computedValuesLoading } = useFrameComputedStyleValues(
    isMultiSelect ? null : selectedNodeId,
    activeBreakpointId ?? 'desktop',
    ALL_CURATED_CSS_PROPERTIES,
  )
  const computedValues = isMultiSelect ? null : singleComputedValues
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
    selectedNodeIds,
    selectedNodes,
    inlineWritableNodeIds,
    inlineUnwritableNodes,
    blockedPropertyCounts,
    sharedClassRules,

    activeContextId,

    assignedClassRules,
    writableClasses,
    inlineWritable,
    inlineLockReason,

    provenanceByProperty,
    computedValues,
    computedValuesLoading,

    writeTargetFor,
  }
}
