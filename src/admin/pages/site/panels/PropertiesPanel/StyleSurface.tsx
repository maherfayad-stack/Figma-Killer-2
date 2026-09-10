/**
 * StyleSurface — unified properties editor surface (Track P, P1 rewrite).
 *
 * `STUDIO-LIVE-CANVAS-PLAN.md` §P1 names three things "gone from day one":
 * the module-settings accordion, the inline/class composers drawn as CSS
 * property LISTS, and the sticky search bar + icon rail chrome around them.
 * All three are gone from this file. What survives, unchanged in shape, is
 * the SECTION CONTENT — `StyleSectionsEditor` and everything under it
 * (`docs/features/inspector-disclosure.md`'s laws, the field model, token
 * autocomplete, provenance) — now called exactly ONCE per selection, over
 * one collapsed style bag (`../../inspector/collapsedStyleBag.ts`) instead
 * of two independent Element/Class renders. `WriteTargetStyleComposer`
 * (`../../inspector/`) is the component that does the collapsing;
 * `resolveWriteTarget.ts` is the rule that decides, per property, per
 * commit, where a value lands — "the write target is a rule, not a mode."
 *
 * ## What this file still owns
 *
 *   - Computing PER-PROPERTY provenance across every source the node
 *     carries (`stylePropertyProvenance.ts`) — unchanged from before P1.
 *   - Computing, per assigned class, whether Studio can actually write a
 *     NEW declaration into it (`classCssWritability.ts`) — now for EVERY
 *     assigned class, not just one "active" one, because any of them can be
 *     `resolveWriteTarget`'s pick.
 *   - The `WriteTargetRow` informational chip strip, the Module section (no
 *     longer an accordion — a fixed block, matching P2 rule 2's "everything
 *     is at rest"), and the Export section at the bottom of the column.
 *   - The one full-column notice for the genuine "nothing here is writable"
 *     case — role permission, or every reachable target locked.
 */

import type { ReactNode } from 'react'
import { useEditorStore, selectActiveCanvasPage, selectSelectedNode } from '@site/store/store'
import type { AnyModuleDefinition } from '@core/module-engine'
import type { StyleRule, CSSPropertyBag } from '@core/page-tree'
import { canWriteInlineStyleForModule, isGeneratedClassLocked, isStudioPageRootId, styleRuleDisplayName, styleRuleSelector } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { ExportSection } from './ExportSection'
import { classCssWriteLockReason, resolveClassCssEditability } from './classCssWritability'
import { ALL_CURATED_CSS_PROPERTIES } from './cssControlTypes'
import { isTextNode } from './styleSectionOrder'
import { buildClassChain, buildStableProvenanceMap, resolvePropertyProvenance, type PropertyProvenance } from './stylePropertyProvenance'
import { getActiveStyleTab } from './classStyleSections'
import { useFrameComputedStyleValues } from '@site/panels/InspectPanel/useInspectComputedStyle'
import { useMutableBox } from '@site/hooks/useMutableBox'
import { TokenCatalogProvider } from '@site/property-controls/TokenCatalogProvider'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { EmptyState } from '@ui/components/EmptyState'
import { WriteTargetRow, type WriteTargetChipInfo } from '@site/inspector/WriteTargetRow'
import { WriteTargetStyleComposer } from '@site/inspector/WriteTargetStyleComposer'
import type { WriteTargetClassCandidate } from '@site/inspector/resolveWriteTarget'
import styles from './StyleSurface.module.css'
import sectionStyles from '@ui/components/Section/Section.module.css'

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

export { GeneratedUtilityLockedState }

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface StyleSurfaceProps {
  definition?: AnyModuleDefinition | null
  /** Every class assigned to the node (not just one "active" one). */
  assignedClassRules: StyleRule[]
  activeBreakpointId: string | undefined
  /** Node id — triggers scroll reset when it changes. */
  nodeId: string | null
  inlineStyles?: Record<string, unknown>
  /**
   * `PageNode.lockReason` when the selected node is source-locked. Inline styles
   * on such a node are unwritable — `setNodeInlineStyles` returns early — so the
   * inline composer must not be offered. Classes are NOT affected: assigning one
   * writes `node.classIds`, which the lock does not gate.
   */
  sourceLockReason?: string
  /**
   * `PageNode.moduleId`. Gates the inline target: a `pkg.*`/`alm.*`/
   * `studio.instance` node's `style=""` (if any) is written by its OWN
   * source, not this page's.
   */
  nodeModuleId?: string
  /** `PageNode.codeProps` — flags individual `style:<prop>` entries resolved from an expression. */
  codeProps?: string[]
  /** Pre-rendered module prop rows shown in the Module section. */
  moduleContent?: ReactNode
  /** Called when 'Add class' is clicked in the fully-locked notice. */
  onFocusClassPicker?: () => void
}

// ---------------------------------------------------------------------------
// StyleSurface
// ---------------------------------------------------------------------------

export function StyleSurface({
  definition,
  assignedClassRules,
  activeBreakpointId,
  nodeId,
  inlineStyles,
  sourceLockReason,
  nodeModuleId,
  codeProps,
  moduleContent,
  onFocusClassPicker,
}: StyleSurfaceProps) {
  // Rail dot badges from stored styles at the active editing context. The
  // context switcher (canvas toolbar) can target a custom condition, which
  // wins over the viewport breakpoint; otherwise we fall back to the
  // base/breakpoint resolved by the active viewport.
  const activeConditionId = useEditorStore((s) => {
    const id = s.activeConditionId
    if (id === null) return null
    const cs = s.site?.conditions
    return cs && cs.some((c) => c.id === id) ? id : null
  })
  const activeTab = getActiveStyleTab(activeBreakpointId)
  const activeContextId = activeConditionId ?? (activeTab !== 'base' ? activeTab : null)

  const permissions = useEditorPermissions()
  const canEditStyleHere = permissions.canEditStyle

  // A `pkg.*`/`alm.*`/`studio.instance` node's `style=""` is written by its
  // OWN source, so nothing typed here would save for it.
  const inlineModuleUnwritable =
    nodeModuleId !== undefined && !canWriteInlineStyleForModule(nodeModuleId)

  const canToggleElement = canEditStyleHere && nodeId != null && !inlineModuleUnwritable
  const inlineWritable = canToggleElement && sourceLockReason === undefined

  // Every declared source for per-property provenance (winner + struck-
  // through losers) — every assigned class, in order, plus inline.
  const classChain = buildClassChain(assignedClassRules, activeContextId)

  const computedValues = useFrameComputedStyleValues(
    nodeId,
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
        inlineStyles: inlineStyles ?? {},
        computedValue: computedValues?.[prop],
      }),
  )

  // W4-4/panel-02 — whether a NEW declaration in each assigned class would
  // reach disk. Computed for EVERY assigned class now (not just one
  // "active" one), because `resolveWriteTarget` can pick any of them.
  const studioSession = useEditorStore((s) => {
    const page = selectActiveCanvasPage(s)
    return page != null && isStudioPageRootId(page.rootNodeId)
  })
  const classLockInfo = assignedClassRules.map((cls) => {
    if (isGeneratedClassLocked(cls)) {
      return { cls, lockReason: 'Generated utility class — not meant to be edited.' }
    }
    const lockReason = classCssWriteLockReason(resolveClassCssEditability(cls), { studioSession })
    return { cls, lockReason }
  })
  const writableClasses: WriteTargetClassCandidate[] = classLockInfo
    .filter((entry) => entry.lockReason === null)
    .map((entry) => ({ classId: entry.cls.id, selector: styleRuleSelector(entry.cls) }))

  const inlineLockReason = !canToggleElement
    ? (inlineModuleUnwritable ? "Inline styles come from this component's own source." : 'Styles are read-only for your role.')
    : sourceLockReason !== undefined
      ? `This element is ${sourceLockReason}, so its style="" layer is written in code.`
      : null

  const writeTargetChips: WriteTargetChipInfo[] = classLockInfo.map((entry) => ({
    key: entry.cls.id,
    label: styleRuleSelector(entry.cls),
    lockReason: entry.lockReason,
  }))
  // The chip `resolveWriteTarget` would reach for on a brand-new property
  // with no existing declaration anywhere — see that module's "otherwise"
  // branch, mirrored here for the informational row only.
  const defaultTargetKey =
    writableClasses.length === 1 ? writableClasses[0].classId : inlineWritable ? 'inline' : null

  const nothingWritable = !inlineWritable && writableClasses.length === 0

  // A node whose ENTIRE assigned-class story is generated utility classes
  // (framework color/spacing tokens, …) gets the same "not meant to be
  // edited" notice `SelectorInspector`'s global surface shows for one —
  // still ABOVE the merged composer, not instead of it, because the
  // element's inline layer is a real, separate, still-editable target.
  const soleGeneratedUtility =
    assignedClassRules.length > 0 && assignedClassRules.every((cls) => isGeneratedClassLocked(cls))
      ? assignedClassRules[0]
      : null

  const selectedNode = useEditorStore(selectSelectedNode)
  const activePageId = useEditorStore((s) => s.activePageId)

  // Select a heading and every edit is a type edit, so Typography leads.
  const textFirst = selectedNode != null && isTextNode(selectedNode)

  const styleTarget = nodeId
    ? { nodeId, assignedClassIds: assignedClassRules.map((rule) => rule.id) }
    : undefined

  // definition.icon is an IconComponent — must assign to PascalCase var.
  const ModuleIcon = definition?.icon
  const hasModuleContent = definition != null && moduleContent != null

  return (
    <TokenCatalogProvider>
      <div className={styles.surface}>
        <div className={styles.surfaceContent}>
          {nodeId != null && (
            <WriteTargetRow
              classChips={writeTargetChips}
              inlineReachable={canToggleElement}
              inlineLockReason={inlineLockReason}
              defaultTargetKey={defaultTargetKey}
            />
          )}

          {/* Module section — P2 rule 2 ("everything is at rest"): a fixed
              block, not an accordion. `hasModuleContent` still hides it
              entirely when there is genuinely nothing to show (global
              selector mode). */}
          {hasModuleContent && (
            <div data-style-section="module">
              <div className={styles.moduleHeader}>
                {ModuleIcon && <ModuleIcon size={14} aria-hidden="true" />}
                <span className={styles.moduleTitle}>{definition!.name}</span>
              </div>
              <div key={nodeId} className={sectionStyles.sectionBody}>
                {moduleContent}
              </div>
            </div>
          )}

          {!canEditStyleHere ? (
            <div className={styles.lockedContent}>
              <EmptyState
                variant="centered"
                title="Styles are read-only for your role"
                description="Your role can edit page copy but not classes or style overrides. Ask an editor to make visual changes."
              />
            </div>
          ) : nodeId == null ? null : nothingWritable ? (
            <NothingWritableNotice reason={inlineLockReason} onFocusClassPicker={onFocusClassPicker} />
          ) : (
            <>
              {soleGeneratedUtility && (
                <div className={styles.lockedContent}>
                  <GeneratedUtilityLockedState cls={soleGeneratedUtility} />
                </div>
              )}
              <WriteTargetStyleComposer
                nodeId={nodeId}
                assignedClassRules={assignedClassRules}
                writableClasses={writableClasses}
                inlineStyles={inlineStyles ?? {}}
                inlineWritable={inlineWritable}
                codeProps={codeProps}
                computedValues={computedValues}
                provenanceByProperty={provenanceByProperty}
                styleTarget={styleTarget}
                textFirst={textFirst}
              />
            </>
          )}

          {nodeId != null && selectedNode != null && activePageId != null && studioSession && (
            <ExportSection
              key={nodeId}
              nodeId={nodeId}
              pageId={activePageId}
              node={selectedNode}
              properties={ALL_CURATED_CSS_PROPERTIES}
              provenanceByProperty={provenanceByProperty}
              classSelectors={assignedClassRules.map((rule) => styleRuleSelector(rule))}
            />
          )}
        </div>
      </div>
    </TokenCatalogProvider>
  )
}

// ---------------------------------------------------------------------------
// NothingWritableNotice — the one full-column notice left in this file: no
// class is writable AND inline is unreachable. Rare (most nodes reach the
// merged composer above) but genuinely different from every other state.
// ---------------------------------------------------------------------------

function NothingWritableNotice({
  reason,
  onFocusClassPicker,
}: {
  /** The specific reason inline is unreachable, when there is one — module
   *  ownership, role permission, or a structural lock. Falls back to a
   *  generic "nothing writable" sentence when there isn't (no class, no
   *  node-specific reason — e.g. global-selector mode never reaches here). */
  reason?: string | null
  onFocusClassPicker?: () => void
}) {
  return (
    <div className={styles.lockedPreview}>
      <div className={styles.lockedPreviewCta}>
        <p className={styles.lockedPreviewCtaText}>
          {reason ?? 'Nothing on this element can be saved from here — add a class Studio can write to.'}
        </p>
        {onFocusClassPicker && (
          <div className={styles.lockedPreviewCtaActions}>
            <Button variant="secondary" size="sm" onClick={onFocusClassPicker}>
              Add class
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// GeneratedUtilityLockedState — kept for `SelectorInspector.tsx`'s global
// (ambient/class) editing surface, which still shows exactly ONE class at a
// time and has no merged bag to fold this into.
// ---------------------------------------------------------------------------

function GeneratedUtilityLockedState({ cls }: { cls: StyleRule }) {
  const colorGenerated = cls.generated?.family === 'color' ? cls.generated : undefined
  const utility = colorGenerated?.utility
  const tokenName = cls.generated?.tokenName

  return (
    <div className={styles.generatedUtilityState}>
      <div className={styles.generatedUtilityHeader}>
        <span className={styles.generatedUtilityKicker}>Generated utility</span>
        <span className={styles.generatedUtilityName}>.{styleRuleDisplayName(cls)}</span>
      </div>
      <p className={styles.generatedUtilityCopy}>
        This is a utility class. Utility classes have a single purpose and aren&apos;t meant to be
        edited.
      </p>
      {(utility || tokenName) && (
        <div className={styles.generatedUtilityMeta}>
          {utility && <span>{utility}</span>}
          {tokenName && <span>{tokenName}</span>}
        </div>
      )}
    </div>
  )
}
