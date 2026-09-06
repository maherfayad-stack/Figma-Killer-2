/**
 * StyleSectionsEditor — the target-agnostic CSS section renderer.
 *
 * This is the shared rendering core behind both `StyleRuleComposer` (edits a
 * StyleRule's `styles` / `contextStyles`) and `InlineStyleComposer` (edits a
 * node's `inlineStyles`). It knows nothing about WHERE the styles live: it
 * takes the resolved style bags plus a set of handlers and renders the curated
 * style sections (spacing / layout / position / border / …) followed by the
 * custom-properties editor.
 *
 * Keeping this seam in one place means the two editing targets can never drift
 * in which controls they expose.
 */

import { useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { ClassPropertyRow } from './ClassPropertyRow'
import { Section } from '@ui/components/Section'
import { Button } from '@ui/components/Button'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { SpacingSection } from './SpacingBoxControl/SpacingSection'
import { BorderControl } from './BorderControl/BorderControl'
import { CustomPropertiesSection } from './CustomPropertiesSection'
import { LayoutSection } from './LayoutSection'
import { PositionSection } from './PositionSection'
import { SizeSection } from './SizeSection'
import { TypographySection } from './TypographySection'
import { AppearanceSection, AppearanceSectionActions } from './AppearanceSection'
import { BackgroundSection } from './BackgroundSection'
import { EffectsSection } from './EffectsSection'
import { InteractionSection } from './InteractionSection'
import { SectionStylesMenu } from './SectionStylesMenu'
import { cssPropertyLabel } from './cssControlTypes'
import { CLASS_STYLE_SECTIONS, type ClassStyleSectionDefinition } from './classStyleSections'
import { resolveStylePlaceholder } from './stylePlaceholder'
import { hasStyleValue } from './styleValueUtils'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import type { PropertyProvenance } from './stylePropertyProvenance'
import styles from './StyleRuleComposer.module.css'
import sectionStyles from '@ui/components/Section/Section.module.css'

const SPACING_SECTION_ID = 'spacing'
const LAYOUT_SECTION_ID = 'layout'
const POSITION_SECTION_ID = 'position'
const SIZE_SECTION_ID = 'size'
const TYPOGRAPHY_SECTION_ID = 'typography'
const APPEARANCE_SECTION_ID = 'appearance'
const BACKGROUND_SECTION_ID = 'background'
const INTERACTION_SECTION_ID = 'interaction'
const EFFECTS_SECTION_ID = 'effects'
const BORDER_SECTION_ID = 'border'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface StyleSectionsEditorProps {
  /** The bag whose set/unset state drives the rows (the active editing target). */
  storedStyles: Record<string, unknown>
  /** Base-merged bag used for placeholder / inherited values. */
  currentStyles: Record<string, unknown>
  /**
   * Every style bag for this rule across every context — base plus each
   * breakpoint/condition override — independent of which tab is active.
   * `StyleSectionGroup` reads this ONLY to decide whether a
   * `collapsedWhenEmpty` section (STUDIO-INSPECTOR-DISCLOSURE-PLAN §4 G1)
   * may collapse to its one-line "+" state: a property set on an inactive
   * tab is still the user's own work and must never disappear behind it.
   * `undefined` for inline styles, which have no context axis — `storedStyles`
   * alone is already authoritative there.
   */
  crossContextStyles?: ReadonlyArray<Record<string, unknown>>
  /** Re-key controls on editing-context change (base / breakpoint / condition). */
  sectionKey: string
  /** Search query — filters visible properties across all categories. */
  styleQuery: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onClearProperty: (property: keyof CSSPropertyBag) => void
  /** Clear several properties in one undo step (e.g. display + its flex/grid deps). */
  onClearProperties: (properties: ReadonlyArray<keyof CSSPropertyBag>) => void
  onPreview: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview: () => void
  /**
   * Track F1 — per-property winner/loser provenance, keyed by the SAME
   * string keys `ALL_CURATED_CSS_PROPERTIES` uses. Optional and purely
   * additive (see `ClassPropertyRow`'s doc) — only reaches the generic
   * fallback rows (Effects section, Border's Advanced disclosure, this
   * editor's own generic branch); the 7 bespoke visual section components
   * (Spacing/Layout/Position/Size/Typography/Background/Border's primary
   * controls) are unchanged by this pass — see `StyleSurface`'s doc for why.
   */
  provenanceByProperty?: ReadonlyMap<string, PropertyProvenance>
  /**
   * The node a section-header STYLE applies to, and the classes already on it.
   *
   * Deliberately separate from the style bags above. Everything else in this
   * component is target-agnostic — it edits whatever bag it was handed, class
   * or inline. Applying a generated utility class is a different kind of
   * write: it touches `node.classIds`, never the active bag, and it means the
   * same thing whichever bag happens to be open. Omitted in global-selector
   * mode, where there is no node, and the buttons then don't render.
   */
  styleTarget?: { nodeId: string; assignedClassIds: ReadonlyArray<string> }
}

// ---------------------------------------------------------------------------
// StyleSectionsEditor
// ---------------------------------------------------------------------------

export function StyleSectionsEditor({
  storedStyles,
  currentStyles,
  crossContextStyles,
  sectionKey,
  styleQuery,
  onChange,
  onRemove,
  onClearProperty,
  onClearProperties,
  onPreview,
  onClearPreview,
  provenanceByProperty,
  styleTarget,
}: StyleSectionsEditorProps) {
  const visibleStyleSections = getVisibleStyleSections(styleQuery)
  const hasActiveQuery = styleQuery.trim().length > 0

  // Default open/closed state for every section, from the user preference.
  // NOTE: this no longer decides whether a `collapsedWhenEmpty` section
  // shows its body — an empty collapsible section is one line regardless of
  // this preference (STUDIO-INSPECTOR-DISCLOSURE-PLAN §4 G1). It still
  // decides the resting open/closed state of the always-present sections
  // (Position/Size/Layout/Spacing) and of any collapsible section once it
  // has real content.
  const sectionsExpanded = useEditorPreference('propertiesSectionsExpanded')

  // Law 1's "+" reveal is per-selection, local UI state: which otherwise-
  // empty `collapsedWhenEmpty` sections has the user explicitly opened for
  // THIS node/class. Both callers (`StyleRuleComposer`, `InlineStyleComposer`)
  // key their instance of this component by node/class identity (and, for
  // class rules, by the active breakpoint/condition tab too), so React
  // remounts this component — and resets this state — whenever the
  // selection changes. Nothing further to track here.
  const [revealedSectionIds, setRevealedSectionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const revealSection = (sectionId: string) => {
    setRevealedSectionIds((prev) => {
      if (prev.has(sectionId)) return prev
      const next = new Set(prev)
      next.add(sectionId)
      return next
    })
  }

  return (
    <div className={styles.styleSections}>
      {visibleStyleSections.map((section) => (
        <div key={section.id} data-style-section={section.id}>
          <StyleSectionGroup
            section={section}
            currentStyles={currentStyles}
            storedStyles={storedStyles}
            crossContextStyles={crossContextStyles}
            activeTab={sectionKey}
            defaultOpen={sectionsExpanded}
            hasActiveQuery={hasActiveQuery}
            revealed={revealedSectionIds.has(section.id)}
            onReveal={revealSection}
            onChange={onChange}
            onRemove={onRemove}
            onClearProperty={onClearProperty}
            onClearProperties={onClearProperties}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
            provenanceByProperty={provenanceByProperty}
            styleTarget={styleTarget}
          />
        </div>
      ))}
      {/* Custom properties — generic editor for the long tail of CSS the curated
          sections don't claim. Hidden while a style search is active. */}
      {!styleQuery.trim() && (
        <div data-style-section="custom">
          <CustomPropertiesSection
            key={sectionKey}
            storedStyles={storedStyles}
            defaultOpen={sectionsExpanded}
            onChange={onChange}
            onRemove={onRemove}
          />
        </div>
      )}
      {visibleStyleSections.length === 0 && styleQuery.trim() && (
        <div className={styles.noStyleMatches}>No matching styles.</div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// StyleSectionGroup — one curated section (spacing / layout / … / generic rows)
// ---------------------------------------------------------------------------

interface StyleSectionGroupProps {
  section: ClassStyleSectionDefinition
  currentStyles: Record<string, unknown>
  storedStyles: Record<string, unknown>
  /** See `StyleSectionsEditorProps.crossContextStyles`. */
  crossContextStyles?: ReadonlyArray<Record<string, unknown>>
  activeTab: string
  /** Initial open/closed state, from the `propertiesSectionsExpanded` preference. */
  defaultOpen: boolean
  /** An active style search — forces the section open regardless of empty state. */
  hasActiveQuery: boolean
  /** Whether the user has clicked "+" to reveal this otherwise-empty section. */
  revealed: boolean
  onReveal: (sectionId: string) => void
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onClearProperty: (property: keyof CSSPropertyBag) => void
  onClearProperties: (properties: ReadonlyArray<keyof CSSPropertyBag>) => void
  onPreview: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview: () => void
  provenanceByProperty?: ReadonlyMap<string, PropertyProvenance>
  styleTarget?: { nodeId: string; assignedClassIds: ReadonlyArray<string> }
}

function StyleSectionGroup({
  section,
  currentStyles,
  storedStyles,
  crossContextStyles,
  activeTab,
  defaultOpen,
  hasActiveQuery,
  revealed,
  onReveal,
  onChange,
  onRemove,
  onClearProperty,
  onClearProperties,
  onPreview,
  onClearPreview,
  provenanceByProperty,
  styleTarget,
}: StyleSectionGroupProps) {
  const setCount = section.properties.filter((prop) => hasStyleValue(storedStyles[prop])).length

  // Law 1 (STUDIO-INSPECTOR-DISCLOSURE-PLAN §4 G1): whether this section has
  // ANYTHING set, on the active tab OR any other breakpoint/condition. A
  // property set only on an inactive tab is still the user's own work, so
  // this — not `setCount` above — is what a `collapsedWhenEmpty` section
  // checks before collapsing to its one-line "+" state.
  const setCountEverywhere = crossContextStyles
    ? section.properties.filter(
        (prop) =>
          hasStyleValue(storedStyles[prop]) ||
          crossContextStyles.some((bag) => hasStyleValue(bag[prop])),
      ).length
    : setCount

  const isCollapsible = section.collapsedWhenEmpty === true
  // The count driven into the indicator dot / "N set" meta — cross-context
  // for a collapsible section (so a value living on another tab isn't
  // silently unmarked once the body is showing for some other reason, e.g.
  // an active search), unchanged (active-tab-only) for the always-present
  // sections, whose behaviour this work order does not touch.
  const displaySetCount = isCollapsible ? setCountEverywhere : setCount

  const stylesMenu = styleTarget && (
    <SectionStylesMenu
      sectionId={section.id}
      nodeId={styleTarget.nodeId}
      assignedClassIds={styleTarget.assignedClassIds}
    />
  )

  // Appearance's header carries two extra icons ahead of the styles menu —
  // the eye (F10's `visibility` toggle) and the droplet (F12's blend-mode
  // menu). Both read/write the same `storedStyles`/`onChange` this group
  // already has; see `AppearanceSection.tsx`'s doc for why they live in the
  // header instead of the body.
  const sectionActions =
    section.id === APPEARANCE_SECTION_ID ? (
      <>
        <AppearanceSectionActions storedStyles={storedStyles} onChange={onChange} />
        {stylesMenu}
      </>
    ) : (
      stylesMenu
    )

  // Law 1's empty state: nothing set anywhere, no active search, and the
  // user hasn't clicked "+" yet for this selection — one header line, no
  // body. This is independent of the `propertiesSectionsExpanded`
  // preference: an empty collapsible section stays one line either way.
  const showsAsEmptyHeader =
    isCollapsible && setCountEverywhere === 0 && !hasActiveQuery && !revealed

  if (showsAsEmptyHeader) {
    return (
      <Section
        title={section.title}
        icon={section.icon}
        defaultOpen={false}
        flush
        children={null}
        actions={
          <>
            {stylesMenu}
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              aria-label={`Add ${section.title.toLowerCase()}`}
              onClick={() => onReveal(section.id)}
              data-testid={`class-style-section-add-${section.id}`}
            >
              <PlusIcon size={12} />
            </Button>
          </>
        }
      />
    )
  }

  // Per-property adapter over the patch-shaped section preview channel.
  const previewProperty = (
    property: keyof CSSPropertyBag,
    value: string | number | undefined,
  ) => onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)

  return (
    <Section
      title={section.title}
      icon={section.icon}
      defaultOpen={defaultOpen}
      // An active search must always show what it found (Law 1's collapse
      // would otherwise make search silently useless); a just-revealed
      // empty section must show the body it was revealed for.
      forceOpen={hasActiveQuery || (isCollapsible && revealed)}
      flush
      indicator={displaySetCount > 0}
      indicatorTestId={`class-style-section-dot-${section.id}`}
      meta={displaySetCount > 0 ? `${displaySetCount} set` : undefined}
      actions={sectionActions}
    >
      <div className={sectionStyles.sectionBody}>
        {section.id === SPACING_SECTION_ID ? (
          <SpacingSection
            key={activeTab}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            onChange={onChange}
            onRemove={onRemove}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        ) : section.id === LAYOUT_SECTION_ID ? (
          <LayoutSection
            key={activeTab}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            activeTab={activeTab}
            onChange={onChange}
            onRemove={onRemove}
            onClearProperty={onClearProperty}
            onClearProperties={onClearProperties}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        ) : section.id === POSITION_SECTION_ID ? (
          <PositionSection
            key={activeTab}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            activeTab={activeTab}
            onChange={onChange}
            onRemove={onRemove}
            onClearProperty={onClearProperty}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        ) : section.id === SIZE_SECTION_ID ? (
          <SizeSection
            key={activeTab}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            activeTab={activeTab}
            onChange={onChange}
            onRemove={onRemove}
            onClearProperty={onClearProperty}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        ) : section.id === TYPOGRAPHY_SECTION_ID ? (
          <TypographySection
            key={activeTab}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            visibleProperties={section.properties}
            activeTab={activeTab}
            onChange={onChange}
            onRemove={onRemove}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
            provenanceByProperty={provenanceByProperty}
          />
        ) : section.id === APPEARANCE_SECTION_ID ? (
          <AppearanceSection
            key={activeTab}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            activeTab={activeTab}
            onChange={onChange}
            onRemove={onRemove}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
            provenanceByProperty={provenanceByProperty}
          />
        ) : section.id === BACKGROUND_SECTION_ID ? (
          <BackgroundSection
            key={activeTab}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            visibleProperties={section.properties}
            activeTab={activeTab}
            onChange={onChange}
            onRemove={onRemove}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
            provenanceByProperty={provenanceByProperty}
          />
        ) : section.id === EFFECTS_SECTION_ID ? (
          <EffectsSection
            key={activeTab}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            visibleProperties={section.properties}
            activeTab={activeTab}
            onChange={onChange}
            onRemove={onRemove}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
            provenanceByProperty={provenanceByProperty}
          />
        ) : section.id === INTERACTION_SECTION_ID ? (
          <InteractionSection
            key={activeTab}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            visibleProperties={section.properties}
            activeTab={activeTab}
            onChange={onChange}
            onRemove={onRemove}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
            provenanceByProperty={provenanceByProperty}
          />
        ) : section.id === BORDER_SECTION_ID ? (
          <>
            <BorderControl
              key={activeTab}
              storedStyles={storedStyles}
              currentStyles={currentStyles}
              onChange={onChange}
              onClearProperty={onClearProperty}
              onPreview={onPreview}
              onClearPreview={onClearPreview}
            />
            <AdvancedRows
              activeTab={activeTab}
              properties={BORDER_ADVANCED_PROPERTIES}
              storedStyles={storedStyles}
              currentStyles={currentStyles}
              onChange={onChange}
              onRemove={onRemove}
              onPreview={previewProperty}
              onClearPreview={onClearPreview}
              provenanceByProperty={provenanceByProperty}
            />
          </>
        ) : (
          section.properties.map((prop) => {
            const storedValue = storedStyles[prop]
            const isSet = hasStyleValue(storedValue)
            const provenance = provenanceByProperty?.get(String(prop))

            return (
              <ClassPropertyRow
                key={`${activeTab}-${String(prop)}`}
                property={prop}
                value={isSet ? (storedValue as string | number) : undefined}
                placeholder={
                  isSet
                    ? undefined
                    : resolveStylePlaceholder({
                        property: prop,
                        provenance,
                        currentValue: currentStyles[prop],
                      })
                }
                fontFamilyValue={currentStyles.fontFamily}
                isSet={isSet}
                onChange={onChange}
                onRemove={onRemove}
                onPreview={previewProperty}
                onClearPreview={onClearPreview}
                provenance={provenance}
              />
            )
          })
        )}
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Border advanced rows — raw CSS shorthand props the visual BorderControl
// deliberately doesn't surface, kept available behind a disclosure.
// ---------------------------------------------------------------------------

const BORDER_ADVANCED_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = [
  'border',
  'borderTop',
  'borderRight',
  'borderBottom',
  'borderLeft',
  'borderWidth',
  'borderStyle',
  'borderColor',
  'borderRadius',
  'appearance',
]

interface AdvancedRowsProps {
  activeTab: string
  properties: ReadonlyArray<keyof CSSPropertyBag>
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
  provenanceByProperty?: ReadonlyMap<string, PropertyProvenance>
}

function AdvancedRows({
  activeTab,
  properties,
  storedStyles,
  currentStyles,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
  provenanceByProperty,
}: AdvancedRowsProps) {
  const anySet = properties.some((prop) => hasStyleValue(storedStyles[prop]))

  return (
    <details className={styles.advanced} open={anySet}>
      <summary className={styles.advancedSummary}>Advanced</summary>
      <div className={styles.advancedBody}>
        {properties.map((prop) => {
          const storedValue = storedStyles[prop]
          const isSet = hasStyleValue(storedValue)
          const provenance = provenanceByProperty?.get(String(prop))
          return (
            <ClassPropertyRow
              key={`${activeTab}-${String(prop)}`}
              property={prop}
              value={isSet ? (storedValue as string | number) : undefined}
              placeholder={
                isSet
                  ? undefined
                  : resolveStylePlaceholder({
                      property: prop,
                      provenance,
                      currentValue: currentStyles[prop],
                    })
              }
              fontFamilyValue={currentStyles.fontFamily}
              isSet={isSet}
              onChange={onChange}
              onRemove={onRemove}
              onPreview={onPreview}
              onClearPreview={onClearPreview}
              provenance={provenance}
            />
          )
        })}
      </div>
    </details>
  )
}

// ---------------------------------------------------------------------------
// Section filtering by search query
// ---------------------------------------------------------------------------

function getVisibleStyleSections(query: string): ReadonlyArray<ClassStyleSectionDefinition> {
  const normalizedQuery = query.trim().toLowerCase()

  return CLASS_STYLE_SECTIONS.map((section) => ({
    ...section,
    properties: section.properties.filter(
      (prop) =>
        !normalizedQuery ||
        sectionMatchesQuery(section, normalizedQuery) ||
        propertyMatchesQuery(prop, normalizedQuery),
    ),
  })).filter((section) => section.properties.length > 0)
}

function sectionMatchesQuery(section: ClassStyleSectionDefinition, query: string): boolean {
  return section.id.toLowerCase().includes(query) || section.title.toLowerCase().includes(query)
}

function propertyMatchesQuery(prop: keyof CSSPropertyBag, query: string): boolean {
  const raw = String(prop).toLowerCase()
  const label = cssPropertyLabel(String(prop)).toLowerCase()
  return raw.includes(query) || label.includes(query)
}
