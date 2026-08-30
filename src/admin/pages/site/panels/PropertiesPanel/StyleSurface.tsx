/**
 * StyleSurface — unified properties editor surface.
 *
 * Layout: one continuous scrollable column with a sticky icon-rail on the
 * right and a sticky search bar pinned to the top.
 *
 * All sections render together in one scroll:
 *   1. Module settings — wrapped in a Section accordion, always first.
 *   2. CSS area — Element (inline) and Class composers, shown TOGETHER when
 *      both are reachable (Track F1 / S6 — see below), or a locked preview.
 *
 * The search bar is bound to the active editable class and filters across
 * module settings (by prop key/label) and the class's CSS properties
 * simultaneously. It is hidden when there is no active class (locked
 * preview) or when the active class is a locked generated utility — neither
 * state has editable CSS rows to search.
 *
 * Rail icons are scroll-anchor shortcuts; the active icon is derived from
 * scroll position.
 *
 * Global selector mode (definition === null):
 *   Module section and Module rail button are hidden.
 *
 * ## Track F1 / S6 — inline and class are no longer exclusive
 *
 * Before this pass, `activeClassId` and `inlineStyleEditing` were mutually
 * exclusive by STORE INVARIANT (`uiStateActions.ts`) — picking a class
 * force-cleared inline-edit mode, and vice versa, so a user had to delete a
 * class just to see whether the element also carried inline styles. That
 * invariant was the audit's S6 finding stated as a user-visible bug: "as
 * close to Figma's right panel as possible" — Figma edits one object;
 * Studio has two live style layers on ONE element (a `style=""` attribute
 * AND however many classes), and hiding one to show the other actively lied
 * about what the element renders.
 *
 * The store no longer couples the two flags (see `uiStateActions.ts`'s
 * updated `setActiveClass`/`setInlineStyleEditing`). This component renders
 * the Element (inline) block and the Class block as INDEPENDENT sections —
 * both visible whenever both are reachable — instead of an if/else chain
 * that could only ever show one. `StyleTargetChip` (now a small write-target
 * menu, not an exclusive toggle) states each target's honest disk outcome;
 * `stylePropertyProvenance.ts` computes, per curated CSS property, which of
 * the element's declared sources (every assigned class, plus inline) is
 * actually winning on the canvas — struck-through for the ones that lose.
 *
 * ## Track F1 — the frame is the source of truth, not a spec-default table
 *
 * `useFrameComputedStyleValues` reads the SAME real `getComputedStyle` the
 * (read-only, left-sidebar) Inspect panel already reads — this component
 * folds it in as the base layer beneath each composer's own stored values
 * (`StyleRuleComposer`/`InlineStyleComposer`'s `currentStyles`), so an unset
 * row's placeholder is the element's actual rendered value, not a guess from
 * `getCSSPropertyDefaultValue`'s hand-written table. `null` (no canvas frame
 * mounted — every existing panel test, or a not-yet-rendered node) degrades
 * to exactly the pre-F1 behaviour.
 */

import { useState, useRef, type ReactNode } from 'react'
import { useEditorStore } from '@site/store/store'
import type { AnyModuleDefinition } from '@core/module-engine'
import type { StyleRule, CSSPropertyBag } from '@core/page-tree'
import { canWriteInlineStyleForModule, isGeneratedClassLocked, styleRuleSelector } from '@core/page-tree'
import { classifyStylesheetEditability } from '@core/css-codemods'
import { getStudioStyleRuleSources, resolveCssInsertDestination } from '@site/studio/styleRuleWriteback'
import { Button } from '@ui/components/Button'
import { SearchBar } from '@ui/components/SearchBar'
import { Section } from '@ui/components/Section'
import { StyleRuleComposer } from './StyleRuleComposer'
import { InlineStyleComposer } from './InlineStyleComposer'
import { ClassPropertyRow } from './ClassPropertyRow'
import { StyleCategoryRail, MODULE_CATEGORY_ID } from './StyleCategoryRail'
import { StyleTargetChip, type ClassCssEditability } from './StyleTargetChip'
import { useScrollSpy } from './useScrollSpy'
import {
  ALL_CURATED_CSS_PROPERTIES,
  CLASS_STYLE_SECTIONS,
  getCSSPropertyDefaultValue,
  getClassStyleSectionSetCounts,
  getActiveStyleTab,
} from './cssControlTypes'
import { buildClassChain, resolvePropertyProvenance, type PropertyProvenance } from './stylePropertyProvenance'
import { useFrameComputedStyleValues } from '@site/panels/InspectPanel/useInspectComputedStyle'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { EmptyState } from '@ui/components/EmptyState'
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
  activeClass: StyleRule | null
  activeClassId: string | null
  /**
   * Track F1 — EVERY class assigned to the node (not just `activeClass`),
   * in `classIds` order. Needed to compute per-property provenance across
   * every declared source, not just the one class currently open for
   * editing. See `usePropertiesPanelData.ts`.
   */
  assignedClassRules: StyleRule[]
  activeBreakpointId: string | undefined
  /** Node id — triggers scroll reset when it changes. */
  nodeId: string | null
  /**
   * The selected node's inline styles (`node.inlineStyles`). Shown in its
   * own Element block whenever inline-editing is toggled on — see this
   * file's module doc (Track F1 / S6) for why this is no longer exclusive
   * with a class.
   */
  inlineStyles?: Record<string, unknown>
  /**
   * `PageNode.lockReason` when the selected node is source-locked. Inline styles
   * on such a node are unwritable — `setNodeInlineStyles` returns early — so the
   * inline composer must not be offered. Classes are NOT affected: assigning one
   * writes `node.classIds`, which the lock does not gate.
   */
  sourceLockReason?: string
  /**
   * `PageNode.moduleId`. `canWriteInlineStyleForModule` gates the inline
   * composer on it: a `pkg.*`/`alm.*`/`studio.instance` node's `style=""` (if
   * any) is written by its OWN source, not this page's, so
   * `fsCodemodAdapter.saveSite` never emits a `kind:'style'` edit for it — the
   * inline editor must say so instead of quietly discarding every keystroke
   * (finding S4). Optional because global-selector mode has no node at all.
   */
  nodeModuleId?: string
  /**
   * `PageNode.codeProps` — forwarded to `InlineStyleComposer` so it can flag
   * the individual `style:<prop>` entries that resolved from an expression
   * (see that component's doc comment). Not consulted here beyond threading;
   * the whole-node/whole-module locks above are the only ones this surface
   * itself branches on.
   */
  codeProps?: string[]
  /** Pre-rendered module prop rows shown in the Module section. */
  moduleContent?: ReactNode
  /** Called when 'Add class' is clicked in the locked preview. */
  onFocusClassPicker?: () => void
}

// ---------------------------------------------------------------------------
// StyleSurface
// ---------------------------------------------------------------------------

export function StyleSurface({
  definition,
  activeClass,
  activeClassId,
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
  // scrollRef → outer grid which is also the scroll container
  const scrollRef = useRef<HTMLDivElement>(null)
  const [styleQuery, setStyleQuery] = useState('')

  // Active section + click-to-scroll behaviour (shared with SelectorInspector).
  // The Module anchor is both the initial active section and the "scroll to
  // absolute top" target (so the sticky search bar above it is revealed); the
  // active anchor resets to it whenever the selected node changes.
  const { activeId: activeAnchorId, scrollTo: handleSectionClick } = useScrollSpy(scrollRef, {
    initialId: MODULE_CATEGORY_ID,
    scrollTopId: MODULE_CATEGORY_ID,
    resetKey: nodeId,
  })

  // Reset search query when active class changes (no state leak between pills).
  const [lastActiveClassId, setLastActiveClassId] = useState<string | null>(null)
  if (lastActiveClassId !== activeClassId) {
    setLastActiveClassId(activeClassId)
    if (styleQuery !== '') setStyleQuery('')
  }

  // Track F1 / S6 — independent flags now (see module doc): which class is
  // open for editing, and whether the Element (inline) block is expanded.
  const inlineIntent = useEditorStore((s) => s.inlineStyleEditing)
  const setInlineStyleEditing = useEditorStore((s) => s.setInlineStyleEditing)

  // Default open/closed state for every property section (Module + CSS), driven
  // by the `propertiesSectionsExpanded` preference. Read once here; the CSS
  // sections receive it through StyleRuleComposer → StyleSectionsEditor.
  const sectionsExpanded = useEditorPreference('propertiesSectionsExpanded')

  const clearStyleQuery = () => setStyleQuery('')

  // Rail dot badges from stored styles at the active editing context. The
  // context switcher (canvas toolbar) can target a custom condition, which
  // wins over the viewport breakpoint; otherwise we fall back to the
  // base/breakpoint resolved by the active viewport.
  const activeTab = getActiveStyleTab(activeBreakpointId)
  // Validated active condition id (or null) — stale ids fall back to viewport.
  const activeConditionId = useEditorStore((s) => {
    const id = s.activeConditionId
    if (id === null) return null
    const cs = s.site?.conditions
    return cs && cs.some((c) => c.id === id) ? id : null
  })
  const activeContextId = activeConditionId ?? (activeTab !== 'base' ? activeTab : null)

  const permissions = useEditorPermissions()
  const canEditStyleHere = permissions.canEditStyle

  // S4 — a `pkg.*`/`alm.*`/`studio.instance` node's `style=""` is written by
  // its OWN source, so `fsCodemodAdapter.saveSite` never emits a write for
  // it here. Undefined `nodeModuleId` (global-selector mode has no node)
  // reads as writable — this gate only narrows the node-editing case.
  const inlineModuleUnwritable =
    nodeModuleId !== undefined && !canWriteInlineStyleForModule(nodeModuleId)

  // Track F1 / S6 — reachability of the Element target no longer depends on
  // whether a class is also assigned (the old `activeClass == null` gate is
  // gone). It depends only on role permission, having a node at all, and the
  // module actually owning its own `style=""` attribute.
  const canToggleElement = canEditStyleHere && nodeId != null && !inlineModuleUnwritable
  const showInlineComposer = canToggleElement && inlineIntent && sourceLockReason === undefined
  const showInlineModuleLockedNotice = canEditStyleHere && nodeId != null && inlineIntent && inlineModuleUnwritable
  const showInlineSourceLockedNotice = canToggleElement && inlineIntent && sourceLockReason !== undefined
  // Whichever of the three above is showing — used by the target chip's
  // pressed state and by the rail's `editingInline` prop.
  const elementBlockVisible = canEditStyleHere && nodeId != null && inlineIntent

  const showClassBlock = activeClass != null

  // Track F1 — every declared source for per-property provenance (winner +
  // struck-through losers). `assignedClassRules` is the WHOLE list the node
  // carries, not just `activeClass` — the bug this fixes: only one active
  // class was ever consulted before (`usePropertiesPanelData.ts`'s old
  // single-class `activeClass` derivation).
  const classChain = buildClassChain(assignedClassRules, activeContextId)

  /*
   * Target for the section-header STYLE buttons. This is the one place that
   * knows both facts a style-apply needs — which node is selected, and what is
   * already on it — so it is assembled here and threaded down rather than
   * re-derived from the store inside each menu. `null` in global-selector
   * mode (no node at all), which is what hides the buttons there.
   */
  const styleTarget = nodeId
    ? { nodeId, assignedClassIds: assignedClassRules.map((rule) => rule.id) }
    : undefined
  const computedValues = useFrameComputedStyleValues(
    nodeId,
    activeBreakpointId ?? 'desktop',
    ALL_CURATED_CSS_PROPERTIES,
  )
  const provenanceByProperty = new Map<string, PropertyProvenance>(
    ALL_CURATED_CSS_PROPERTIES.map((prop) => [
      prop,
      resolvePropertyProvenance(prop as keyof CSSPropertyBag, {
        classChain,
        inlineStyles: inlineStyles ?? {},
        computedValue: computedValues?.[prop],
      }),
    ]),
  )

  // `panel-02` / Track B1/B1b (WS-6.3) — whether the active class's
  // declarations reach disk on save, and if not yet, whether they WOULD on
  // the first edit. `getStudioStyleRuleSources()` is `{}` outside Studio
  // (the DB-backed CMS editor never populates it), so this correctly falls
  // back to `unmapped` there — unchanged from this chip's pre-F1 default.
  const classCssEditability: ClassCssEditability | undefined = activeClass
    ? resolveClassCssEditability(activeClass)
    : undefined

  // Rail dot badges reflect the UNION of what's actually set across every
  // block currently visible — a property set via the class OR via inline
  // both count as "this section has content".
  const classStoredStyles: Record<string, unknown> =
    showClassBlock && !isGeneratedClassLocked(activeClass!)
      ? (activeContextId ? (activeClass!.contextStyles[activeContextId] ?? {}) : activeClass!.styles)
      : {}
  const inlineStoredStyles: Record<string, unknown> = showInlineComposer ? (inlineStyles ?? {}) : {}
  const sectionSetCounts = getClassStyleSectionSetCounts({ ...classStoredStyles, ...inlineStoredStyles })

  // Module section visibility: always visible unless search has no match.
  const hasModuleContent = definition != null && moduleContent != null
  const moduleVisible = hasModuleContent && (!styleQuery || moduleMatchesQuery(styleQuery, definition!))

  // The search bar is bound to the active class — both its placeholder and
  // the rows it filters belong to that class. It only renders when the class
  // exists and is editable.
  //   - no active class selected → LockedStylePreview teaser is shown instead
  //   - active class is a locked generated utility → GeneratedUtilityLockedState
  //     is shown instead (no editable CSS rows to search)
  const searchableClass = activeClass != null && !isGeneratedClassLocked(activeClass)
    ? activeClass
    : null

  // ── Element (inline) block ────────────────────────────────────────────
  let elementBlock: ReactNode = null
  if (showInlineModuleLockedNotice) {
    elementBlock = (
      <div className={styles.lockedContent}>
        <EmptyState
          variant="centered"
          title="Inline styles come from this component's own source"
          description={`This element is a ${nodeModuleId} component. Its style="" attribute (if any) is written in that component's own file, not this page's — nothing typed here would save. Assign a CSS class above to style it from this page instead.`}
        />
      </div>
    )
  } else if (showInlineSourceLockedNotice) {
    elementBlock = (
      <div className={styles.lockedContent}>
        <EmptyState
          variant="centered"
          title="Inline styles come from the source file"
          description={`This element is ${sourceLockReason}, so its style="" layer is written in code. Assign a CSS class above to style it from here.`}
        />
      </div>
    )
  } else if (showInlineComposer) {
    elementBlock = (
      <InlineStyleComposer
        key={`${nodeId}-inline`}
        nodeId={nodeId!}
        inlineStyles={inlineStyles}
        styleQuery={styleQuery}
        codeProps={codeProps}
        computedValues={computedValues}
        provenanceByProperty={provenanceByProperty}
        styleTarget={styleTarget}
      />
    )
  }

  // ── Class block ──────────────────────────────────────────────────────
  let classBlock: ReactNode = null
  if (showClassBlock) {
    classBlock = isGeneratedClassLocked(activeClass!) ? (
      <div className={styles.lockedContent}>
        <GeneratedUtilityLockedState cls={activeClass!} />
      </div>
    ) : (
      <StyleRuleComposer
        key={`${activeClassId}-${activeTab}`}
        classId={activeClassId!}
        cls={activeClass!}
        styleQuery={styleQuery}
        computedValues={computedValues}
        provenanceByProperty={provenanceByProperty}
        styleTarget={styleTarget}
      />
    )
  }

  // CSS area — Element block, Class block, both (Track F1 / S6), or the
  // locked/empty states when neither has anything to show.
  let cssContent: ReactNode
  if (!canEditStyleHere) {
    cssContent = (
      <div className={styles.lockedContent}>
        <EmptyState
          variant="centered"
          title="Styles are read-only for your role"
          description="Your role can edit page copy but not classes or style overrides. Ask an editor to make visual changes."
        />
      </div>
    )
  } else if (elementBlock || classBlock) {
    cssContent = (
      <>
        {elementBlock && (
          <div className={styles.targetBlock} data-testid="style-target-block-element">
            <div className={styles.targetBlockLabel}>Element</div>
            {elementBlock}
          </div>
        )}
        {classBlock && (
          <div className={styles.targetBlock} data-testid="style-target-block-class">
            <div className={styles.targetBlockLabel}>{styleRuleSelector(activeClass!)}</div>
            {classBlock}
          </div>
        )}
      </>
    )
  } else {
    cssContent = (
      <LockedStylePreview
        onFocusClassPicker={onFocusClassPicker ?? noop}
        onStyleInline={canToggleElement ? () => setInlineStyleEditing(true) : undefined}
      />
    )
  }

  // definition.icon is an IconComponent — must assign to PascalCase var.
  const ModuleIcon = definition?.icon

  return (
    <div ref={scrollRef} className={styles.surface}>
      {/* ── Left column: search + module section + CSS area ─────────── */}
      <div className={styles.surfaceContent}>

        {/* Track F1 — write-target menu. Node mode only (nodeId != null); the
            global selector surface (SelectorInspector) always edits a class
            and has no "Element" concept to switch to. */}
        {nodeId != null && (
          <StyleTargetChip
            elementVisible={elementBlockVisible}
            classSelector={activeClass ? styleRuleSelector(activeClass) : undefined}
            classCssEditability={classCssEditability}
            onToggleElement={canToggleElement ? () => setInlineStyleEditing(!inlineIntent) : undefined}
          />
        )}

        {/* Search bar — sticky at the top, searches both module and CSS.
            Hidden when no class is selected or the active class is a locked
            generated utility (no CSS rows to search in either state). */}
        {searchableClass && (
          <div className={styles.searchBarRow}>
            <SearchBar
              value={styleQuery}
              onValueChange={setStyleQuery}
              onClear={clearStyleQuery}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  clearStyleQuery()
                }
              }}
              placeholder={`Search styles in ${styleRuleSelector(searchableClass)}...`}
              aria-label="Search class style properties to add"
            />
          </div>
        )}

        {/* Module section — same Section accordion as CSS sections */}
        {moduleVisible && (
          <div data-style-section={MODULE_CATEGORY_ID}>
            <Section
              title={definition!.name}
              icon={ModuleIcon}
              defaultOpen={sectionsExpanded}
              flush
            >
              {/* sectionBody gives the same display:grid + gap as CSS sections.
                  key={nodeId} remounts on node change (replaces the old div wrapper). */}
              <div key={nodeId} className={sectionStyles.sectionBody}>
                {moduleContent}
              </div>
            </Section>
          </div>
        )}

        {/* CSS area — Element block, Class block, locked preview, or generated lock */}
        {cssContent}
      </div>

      {/* ── Right column: sticky rail ────────────────────────────── */}
      <div className={styles.railSticky}>
        <StyleCategoryRail
          activeAnchorId={activeAnchorId}
          sectionSetCounts={sectionSetCounts}
          onSectionClick={handleSectionClick}
          definition={definition ?? null}
          activeClass={activeClass}
          editingInline={elementBlockVisible}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// LockedStylePreview — teaser shown when no class is set on the element
// ---------------------------------------------------------------------------

interface LockedStylePreviewProps {
  onFocusClassPicker: () => void
  /** When provided, shows a "Style inline" button that edits the node's
   *  `style=""` layer directly (no class). Omitted in selector/global mode. */
  onStyleInline?: () => void
}

const TEASER_SECTION = CLASS_STYLE_SECTIONS.find((s) => s.id === 'layout')!

function LockedStylePreview({ onFocusClassPicker, onStyleInline }: LockedStylePreviewProps) {
  const noopChange = () => {}
  const noopRemove = () => {}

  return (
    <div className={styles.lockedPreview}>
      {/* Teaser wrapper: capped height with gradient fade */}
      <div className={styles.lockedPreviewTeaserWrapper} aria-hidden="true">
        <div className={styles.lockedPreviewTeaser}>
          {TEASER_SECTION.properties.map((prop) => (
            <ClassPropertyRow
              key={String(prop)}
              property={prop}
              value={undefined}
              placeholder={getCSSPropertyDefaultValue(prop)}
              isSet={false}
              onChange={noopChange as (p: keyof CSSPropertyBag, v: string | number | undefined) => void}
              onRemove={noopRemove as (p: keyof CSSPropertyBag) => void}
            />
          ))}
        </div>
        <div className={styles.lockedPreviewGradient} aria-hidden="true" />
      </div>

      {/* CTA — always visible below the teaser */}
      <div className={styles.lockedPreviewCta}>
        <p className={styles.lockedPreviewCtaText}>
          Add a class to start styling this element
        </p>
        <div className={styles.lockedPreviewCtaActions}>
          <Button
            variant="secondary"
            size="sm"
            onClick={onFocusClassPicker}
          >
            Add class
          </Button>
          {onStyleInline && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onStyleInline}
              tooltip="Style just this element with an inline style attribute (no reusable class)"
            >
              Style inline
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// GeneratedUtilityLockedState
// ---------------------------------------------------------------------------

function GeneratedUtilityLockedState({ cls }: { cls: StyleRule }) {
  const colorGenerated = cls.generated?.family === 'color' ? cls.generated : undefined
  const utility = colorGenerated?.utility
  const tokenName = cls.generated?.tokenName

  return (
    <div className={styles.generatedUtilityState}>
      <div className={styles.generatedUtilityHeader}>
        <span className={styles.generatedUtilityKicker}>Generated utility</span>
        <span className={styles.generatedUtilityName}>.{cls.name}</span>
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

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the search query matches the module definition name or any
 * of its schema prop keys / labels. Used to show/hide the module section.
 */
function moduleMatchesQuery(query: string, definition: AnyModuleDefinition): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (definition.name.toLowerCase().includes(q)) return true
  return Object.keys(definition.schema).some((key) => {
    const label = key.replace(/([A-Z])/g, ' $1').trim().toLowerCase()
    return key.toLowerCase().includes(q) || label.includes(q)
  })
}

function noop() {}

/**
 * Track B1/B1b's `resolveCssInsertDestination` gates a brand-new rule's
 * insert destination on the rule having been AUTHORED in the editor
 * (`createClass`/`applyCssRules`, `nanoid()` ids) rather than parsed from an
 * import (`sc-`-prefixed, deterministic ids — `studioCss.ts`'s "Stable
 * ids"). That gate function (`isEditorAuthoredRuleId`) is intentionally
 * private to `styleRuleWriteback.ts` (not part of its public surface); this
 * mirrors the exact same one-line invariant so the chip's "will create" claim
 * can never diverge from what `collectStyleRuleEdits` actually attempts —
 * see that module's own doc for why the distinction matters (an unmapped
 * IMPORTED rule — Tailwind/Sass/PostCSS output — has a real reason to stay
 * unmapped and must never appear to gain a fabricated write target).
 */
function isEditorAuthoredClassId(classId: string): boolean {
  return !classId.startsWith('sc-')
}

/**
 * Track F1 — the `StyleTargetChip`'s per-class write-back tier, resolved
 * from the current project's `styleRuleSources` map (§6.3's `StyleRule.id ->
 * (file, selector)`) plus `classifyStylesheetEditability` (`@core/css-
 * codemods`) and, when no source exists yet, `resolveCssInsertDestination`
 * (Track B1/B1b) — shared verbatim with the server-side write dispatcher so
 * the chip's claim and the actual save outcome can never diverge.
 */
function resolveClassCssEditability(cls: StyleRule): ClassCssEditability {
  const source = getStudioStyleRuleSources()[cls.id]
  if (source) {
    const editability = classifyStylesheetEditability(source.file)
    return editability.kind === 'plain-css'
      ? { kind: 'plain-css', file: source.file }
      : { kind: 'compiled', reason: editability.reason }
  }
  if (!isEditorAuthoredClassId(cls.id)) return { kind: 'unmapped' }
  const destination = resolveCssInsertDestination(cls)
  if (!destination.ok) return { kind: 'unmapped', reason: destination.message }
  return destination.kind === 'existing'
    ? { kind: 'will-create-existing', file: destination.file }
    : { kind: 'will-create-new-stylesheet', pageFile: destination.pageFile }
}
