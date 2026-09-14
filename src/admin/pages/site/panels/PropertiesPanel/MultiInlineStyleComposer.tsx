/**
 * MultiInlineStyleComposer — the CSS section editor bound to N selected nodes
 * at once (W8-3 phase 1).
 *
 * P3 is complete (`STATE.md` `panel-25`, item 11 — Studio extras): every
 * curated CSS category this file used to render through
 * `StyleSectionsEditor.tsx` migrated to its own node-selection-scoped
 * `INSPECTOR_SECTIONS` manifest entry, which all read through
 * `useSelectionModel()` — a SINGLE selected node. A multi-selection has no
 * one node to hand them, so (mirroring `StyleRuleComposer.tsx`'s own,
 * identical narrowing) this file's only remaining editing surface is
 * `CustomPropertiesSection`, fed by `buildMultiSelectStyleBags`'s collapsed
 * stored bag, writing through `setNodesInlineStyles` so the whole selection
 * moves in ONE undo step.
 *
 * ## Why inline-only, and why the target chip says so
 *
 * A class edit made from a multi-selection has a blast radius the panel
 * cannot state honestly yet: the N selected nodes rarely share one class, the
 * classes they do share are usually also on elements OUTSIDE the selection,
 * and several of them are compiled/unmapped so the write would not reach disk
 * at all. Writing a class from here would silently restyle elements the user
 * never selected — the exact failure the "one honest target" invariant
 * exists to prevent.
 *
 * Inline styles have no such ambiguity: `style=""` belongs to exactly one
 * element, so N inline writes touch exactly the N elements selected. Phase 1
 * therefore pins the editing target to Element and SAYS SO in the target chip
 * rather than offering a class target that would have to refuse later
 * (`MultiSelectionInspector` renders the chip with its bulk reason). Class-
 * target bulk editing, behind an explicit "this class is used by N other
 * elements — continue?" gate, is phase 3.
 */

import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import type { CSSPropertyBag } from '@core/page-tree'
import { canWriteInlineStyleForModule, styleValueKey } from '@core/page-tree'
import { TokenCatalogProvider } from '@site/property-controls/TokenCatalogProvider'
import { ALL_CURATED_CSS_PROPERTIES, cssPropertyLabel, isCuratedProperty } from './cssControlTypes'
import { getActiveStyleTab } from './classStyleSections'
import { CustomPropertiesSection } from './CustomPropertiesSection'
import { buildClassChain } from './stylePropertyProvenance'
import { buildMultiSelectStyleBags, type MultiSelectStyleNode } from './multiSelectStyleBags'
import { resolveSelectedNodes } from './multiSelectNodes'
import { StyleWriteLockContext } from './StyleWriteLockContext'
import { blockedProperties, buildInlineStyleWriteReach } from './styleWriteReach'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import noticeStyles from './SharedComponentNotice.module.css'

const STYLE_KEY_PREFIX = styleValueKey('')

/**
 * The noun phrase completing "N are …" for the inline target. Phase 3's class
 * target passes its own ("compiled"); see `styleWriteReach.ts`.
 */
const INLINE_BLOCK_REASON = 'set from an expression in code'

/** Stable empty bag so a node without inline styles doesn't allocate one per render. */
const EMPTY_STYLES: Record<string, unknown> = {}

interface MultiInlineStyleComposerProps {
  /** The multi-selection, in selection order. Meaningful for 2+ ids. */
  nodeIds: string[]
}

export function MultiInlineStyleComposer({
  nodeIds,
}: MultiInlineStyleComposerProps) {
  const setNodesInlineStyles = useEditorStore((s) => s.setNodesInlineStyles)
  const sectionsExpanded = useEditorPreference('propertiesSectionsExpanded')
  const activeTree = useEditorStore(selectActiveCanvasPage)
  const site = useEditorStore((s) => s.site)
  const nodeIdToPageIds = useEditorStore((s) => s._nodeIdToPageIds)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  // Validated active condition id (or null) — stale ids fall back to the
  // viewport breakpoint. Same derivation `StyleSurface` uses, so the
  // placeholder layer means the same thing in both surfaces.
  const activeConditionId = useEditorStore((s) => {
    const id = s.activeConditionId
    if (id === null) return null
    const conditions = s.site?.conditions
    return conditions && conditions.some((c) => c.id === id) ? id : null
  })

  const activeTab = getActiveStyleTab(activeBreakpointId)
  const activeContextId = activeConditionId ?? (activeTab !== 'base' ? activeTab : null)

  const styleRules = site?.styleRules
  const nodes = resolveSelectedNodes(nodeIds, { activeTree, site, nodeIdToPageIds })

  const styleNodes: MultiSelectStyleNode[] = nodes.map((node) => ({
    inlineStyles: node.inlineStyles ?? EMPTY_STYLES,
    classChain: buildClassChain(
      node.classIds
        .map((id) => styleRules?.[id])
        .filter((rule): rule is NonNullable<typeof rule> => rule != null),
      activeContextId,
    ),
  }))

  // `buildMultiSelectStyleBags` only ever returns keys from the `properties`
  // list it's handed — unlike `collapsedStyleBag.ts`'s single-node bag, it
  // does not naively merge every key present. Now that this composer renders
  // ONLY `CustomPropertiesSection` (P3 item 11, `STATE.md` `panel-25`),
  // `ALL_CURATED_CSS_PROPERTIES` alone would starve it: every returned key
  // would be curated, so `getCustomProperties`'s `!isCuratedProperty` filter
  // would always yield `[]` and no uncurated property could ever be bulk-
  // edited. Union in every uncurated key actually SET on at least one
  // selected node's own inline bag — the same "what's present" question
  // `getCustomProperties` itself answers for a single node.
  const uncuratedPropertiesPresent = Array.from(
    new Set(
      styleNodes.flatMap((node) => Object.keys(node.inlineStyles).filter((key) => !isCuratedProperty(key))),
    ),
  )

  const { storedStyles } = buildMultiSelectStyleBags(
    styleNodes,
    [...ALL_CURATED_CSS_PROPERTIES, ...uncuratedPropertiesPresent],
  )

  // W8-3 phase 2 — the `style:<prop>` locks across the selection, COUNTED
  // rather than merely listed. `setNodesInlineStyles` already skips those
  // nodes property-by-property; the reach is what stops that refusal from
  // being silent, and what lets each row say how far its own edit lands
  // ("Writes to 3 of 5 selected layers — 2 are set from an expression in
  // code") instead of the panel claiming a clean write to all five.
  //
  // `STYLE_KEY_PREFIX` is `styleValueKey('')`, i.e. the same `style:` prefix
  // the parser writes into `codeProps`; the reach builder slices it back off.
  /*
   * `font-revert` — a node whose MODULE has no `style=""` target at all
   * (`pkg.*`, a third-party package Studio knows nothing about;
   * `studio.instance`, a Fragment call site with no box of its own).
   * `canWriteInlineStyleForModule` is the one predicate the OFFER and the
   * WRITE must agree on, and this composer was the surface that never asked
   * it: it wrote the patch into every selected node, the canvas rendered it,
   * and `fsCodemodAdapter.saveSite` then dropped exactly those nodes' edits —
   * so the value came back on the next reload with nothing said. Excluded
   * from the write here and NAMED in the notice below, rather than written
   * and silently discarded three layers later.
   *
   * Per-property `codeProps` locks are a DIFFERENT fact and stay where they
   * were (`reach`): those block one property on one node, this blocks the
   * whole element.
   */
  const unwritableNodes = nodes.filter((node) => !canWriteInlineStyleForModule(node.moduleId))
  const writableNodeIds = nodes
    .filter((node) => canWriteInlineStyleForModule(node.moduleId))
    .map((node) => node.id)

  const reach = buildInlineStyleWriteReach(
    nodes.map((node) => ({
      codeProps: (node.codeProps ?? []).filter((name) => name.startsWith(STYLE_KEY_PREFIX)),
    })),
    INLINE_BLOCK_REASON,
  )
  const lockedProperties = blockedProperties(reach)

  const writePatch = (patch: Record<string, string | number | null>) => {
    if (writableNodeIds.length === 0) return
    setNodesInlineStyles(writableNodeIds, patch)
  }

  const handleChange = (key: keyof CSSPropertyBag, value: string | number | undefined) => {
    writePatch({ [String(key)]: value ?? null })
  }
  const handleRemove = (key: keyof CSSPropertyBag) => {
    writePatch({ [String(key)]: null })
  }

  return (
    <TokenCatalogProvider>
      {unwritableNodes.length > 0 && (
        <div
          className={noticeStyles.notice}
          role="note"
          data-testid="multi-inline-style-unwritable-modules-notice"
        >
          <LockSolidIcon size={14} className={noticeStyles.icon} />
          <p className={noticeStyles.text}>
            <strong>{unwritableNodes.map((node) => node.label ?? node.id).join(', ')}</strong>{' '}
            {unwritableNodes.length === 1 ? 'takes' : 'take'} no style of{' '}
            {unwritableNodes.length === 1 ? 'its' : 'their'} own here — the style comes from that
            component&apos;s own source, not this page&apos;s. Edits below skip{' '}
            {unwritableNodes.length === 1 ? 'it' : 'them'}; assign a CSS class or change the
            design-system token instead.
          </p>
        </div>
      )}
      {lockedProperties.length > 0 && (
        <div
          className={noticeStyles.notice}
          role="note"
          data-testid="multi-inline-style-locked-properties-notice"
        >
          <LockSolidIcon size={14} className={noticeStyles.icon} />
          <p className={noticeStyles.text}>
            <strong>{lockedProperties.map(cssPropertyLabel).join(', ')}</strong>{' '}
            {lockedProperties.length === 1 ? 'is' : 'are'} set from an expression in code on{' '}
            {describeBlockedSpread(lockedProperties, reach)}. Those layers keep their current
            value; the rest of the selection still updates.
          </p>
        </div>
      )}
      {/* W8-3 phase 2 — every row beneath reads this and states how far its
          own edit reaches. `partial` never disables a control. */}
      <StyleWriteLockContext.Provider value={{ kind: 'partial', reach }}>
        <CustomPropertiesSection
          storedStyles={storedStyles}
          defaultOpen={sectionsExpanded}
          onChange={handleChange}
          onRemove={handleRemove}
        />
      </StyleWriteLockContext.Provider>
    </TokenCatalogProvider>
  )
}

/**
 * "2 of these 5 layers" / "some of these 5 layers" — the header sentence for
 * the notice. One blocked property has one honest count; several properties
 * blocked on different subsets do not share one, and inventing a union count
 * would overstate every individual row (each row states its own exact count
 * through the partial write lock).
 */
function describeBlockedSpread(
  properties: ReadonlyArray<string>,
  reach: { total: number; blockedByProperty: ReadonlyMap<string, number> },
): string {
  const layers = reach.total === 1 ? 'layer' : 'layers'
  if (properties.length !== 1) return `some of these ${reach.total} ${layers}`
  const blocked = reach.blockedByProperty.get(properties[0]) ?? 0
  return `${blocked} of these ${reach.total} ${layers}`
}
