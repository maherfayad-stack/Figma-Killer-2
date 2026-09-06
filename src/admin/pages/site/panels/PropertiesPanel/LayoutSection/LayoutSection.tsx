/**
 * LayoutSection — visual editor for the `layout-position` CSS section.
 *
 * STUDIO-INSPECTOR-DISCLOSURE-PLAN.md G3 (layout) + G4 (padding). Figma's
 * F3/F4/F6/F7 shape: mode buttons always resident; flex/grid reveal their own
 * fields (Law 5, unchanged from before this pass); rare item-level /
 * split-axis properties move behind a ⚙ (Law 2); padding lives here, not in
 * the Spacing section, because it's a property of how THIS element lays out
 * its own box, the same category as display/gap/align (Spacing keeps only
 * margin — a relationship with siblings).
 *
 *   • DropdownSwitcher      — connected segmented control [Flex | Grid | ▼ more].
 *   • FlexDirectionControl  — 4 connected icon buttons (row, column, reverses).
 *   • WrapToggleButton      — `flex-wrap` collapsed to one nowrap↔wrap toggle,
 *                             sitting in the direction row's header per F6
 *                             (`wrap-reverse` moved to LayoutSettingsButton).
 *   • AlignGrid             — G3.3's 3×3 pad; ONE gesture writes BOTH
 *                             alignItems + justifyContent (flex mode) or
 *                             alignItems + justifyItems (grid mode), replacing
 *                             the old two stacked AlignmentControl /
 *                             GridAxisControl rows.
 *   • GapInput              — token-aware text input for `gap`.
 *   • PaddingCluster        — G4: `[⊓][⊐][⊞]` → four sides, resident
 *                             regardless of display (see its own doc for why
 *                             that's a deliberate divergence from F3).
 *   • GridTrackControl      — column / row count picker for grid-template-*.
 *   • ClipContentRow        — `overflow` promoted to a "Clip content"
 *                             checkbox, resident regardless of display
 *                             (F3/F4/F6/F7 all show it); overflowX/overflowY
 *                             live behind its own small ⚙; ALSO hosts the
 *                             resident `LayoutSettingsButton` (see that
 *                             file's doc) — item-level properties like
 *                             `alignSelf`/`flex`/`gridColumn` depend on the
 *                             PARENT's display, not this element's own, so
 *                             their ⚙ must be reachable regardless of THIS
 *                             element's display. `rowGap`/`columnGap`/
 *                             `flexWrap` inside that same popover stay
 *                             mode-filtered on this element's own display.
 *
 * `zIndex`, `position`, `top/right/bottom/left` stay in `PositionSection`
 * (a different curated section) — never duplicated here.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import { Grid2x22SolidIcon } from 'pixel-art-icons/icons/grid-2x2-2-solid'
import { AlignGrid } from '@ui/components/AlignGrid'
import { DropdownSwitcher } from '../DropdownSwitcher'
import { getEnumOptions } from '../cssControlTypes'
import { hasStyleValue, readString } from '../styleValueUtils'
import { useSpacingTokens } from '@site/property-controls/tokenUtils'
import { FlexDirectionControl } from './FlexDirectionControl'
import { WrapToggleButton } from './WrapToggleButton'
import { GapInput } from './GapInput'
import { GridTrackControl } from './GridTrackControl'
import { LayoutSettingsButton } from './LayoutSettingsButton'
import { PaddingCluster } from './PaddingCluster'
import { ClipContentRow } from './ClipContentRow'
import styles from '../LayoutSection.module.css'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface LayoutSectionProps {
  currentStyles: Record<string, unknown>
  storedStyles: Record<string, unknown>
  /** Active breakpoint tab id — used to key sub-controls so they re-mount on tab change. */
  activeTab: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  /**
   * Fully clear a property — removes it from base styles AND from every
   * viewport-context override. Used by the X / clear affordances on the visual
   * switchers so "clear" is unconditional regardless of which viewport
   * tab the user is on. Without this, clearing a viewport-only override
   * would let the inherited base value bleed back through and the switcher
   * segment would stay pressed.
   */
  onClearProperty: (property: keyof CSSPropertyBag) => void
  /**
   * Clear several properties in one undo step. Used when clearing `display`
   * must also prune the flex/grid container properties it governed — otherwise
   * they linger as invisible orphans (their controls only render while the
   * matching display is active), leaving the section badge stuck on "N set".
   */
  onClearProperties: (properties: ReadonlyArray<keyof CSSPropertyBag>) => void
  /**
   * Patch-shaped hover-preview channel (see StyleRuleComposer.handlePreview).
   * Forwarded to the display dropdown, the gap token input, and the generic
   * fallback rows so hovering a suggestion previews on the canvas.
   */
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

/**
 * Container properties whose visual controls only render while `display` is
 * `flex` or `grid`. When `display` is cleared they would otherwise become
 * invisible orphans — still stored, still counted, but with no row to clear
 * them. Clearing `display` prunes these alongside it.
 *
 * `alignSelf` / `justifySelf` / `flex` / `gridColumn` / `gridRow` are
 * DELIBERATELY EXCLUDED from this list and must stay excluded: they depend
 * on the PARENT's display, not this element's own, so clearing THIS
 * element's `display` must never touch them — they live in the resident
 * `LayoutSettingsButton` (mounted in `ClipContentRow`, reachable regardless
 * of `display`), not inside the flex/grid block this pruning governs.
 */
const DISPLAY_DEPENDENT_PROPS: ReadonlyArray<keyof CSSPropertyBag> = [
  'flexDirection',
  'flexWrap',
  'alignItems',
  'justifyContent',
  'justifyItems',
  'gap',
  'rowGap',
  'columnGap',
  'gridTemplateColumns',
  'gridTemplateRows',
]

// ---------------------------------------------------------------------------
// Display switcher config — Flex | Grid + dropdown of every other value
// ---------------------------------------------------------------------------

const DISPLAY_OPTIONS = getEnumOptions('display') ?? ['block']

const DISPLAY_PRIMARY_SEGMENTS = [
  {
    value: 'flex',
    label: 'Flex',
    icon: <LayoutSolidIcon size={14} />,
    ariaLabel: 'Flex layout',
    tooltip: 'display: flex',
  },
  {
    value: 'grid',
    label: 'Grid',
    icon: <Grid2x22SolidIcon size={14} />,
    ariaLabel: 'Grid layout',
    tooltip: 'display: grid',
  },
] as const

// ---------------------------------------------------------------------------
// LayoutSection
// ---------------------------------------------------------------------------

export function LayoutSection({
  currentStyles,
  storedStyles,
  activeTab,
  onChange,
  onRemove,
  onClearProperty,
  onClearProperties,
  onPreview,
  onClearPreview,
}: LayoutSectionProps) {
  const display = readString(currentStyles, 'display')
  const spacingTokens = useSpacingTokens()

  // Clearing display prunes the flex/grid container properties it governed, in
  // one undo step, so the section never reports phantom "N set" orphans.
  const clearDisplayAndDeps = () => onClearProperties(['display', ...DISPLAY_DEPENDENT_PROPS])
  const flexDirection = readString(currentStyles, 'flexDirection') ?? 'row'
  const flexWrap = readString(currentStyles, 'flexWrap')
  const alignItems = readString(currentStyles, 'alignItems')
  const justifyContent = readString(currentStyles, 'justifyContent')
  const justifyItems = readString(currentStyles, 'justifyItems')

  return (
    <div className={styles.layoutSection}>
      {/* Display switcher — unlabeled, full width */}
      <DropdownSwitcher
        property="display"
        value={display}
        primarySegments={DISPLAY_PRIMARY_SEGMENTS}
        allOptions={DISPLAY_OPTIONS}
        onChange={(v) => onChange('display', v)}
        onClear={clearDisplayAndDeps}
        onPreview={onPreview ? (v) => onPreview({ display: v } as Partial<CSSPropertyBag>) : undefined}
        onClearPreview={onClearPreview}
      />

      {/* Flex-only fields, revealed when display === 'flex' */}
      {display === 'flex' && (
        <div className={styles.flexBlock}>
          {/* Direction + the wrap toggle share a header row (F6: wrap sits
              top-right of the auto-layout block, not inline as a 3rd caption). */}
          <div className={styles.flexHeaderRow}>
            <FlexDirectionControl
              value={flexDirection}
              isSet={hasStyleValue(storedStyles.flexDirection)}
              onChange={(v) => onChange('flexDirection', v)}
              onClear={() => onClearProperty('flexDirection')}
            />
            <WrapToggleButton
              value={flexWrap}
              onChange={(v) => onChange('flexWrap', v)}
              onClear={() => onClearProperty('flexWrap')}
            />
          </div>
          <div className={styles.alignGapRow}>
            <AlignGrid
              mode="flex"
              flexDirection={flexDirection}
              align={{ value: alignItems, isSet: hasStyleValue(storedStyles.alignItems) }}
              justify={{ value: justifyContent, isSet: hasStyleValue(storedStyles.justifyContent) }}
              onChange={(patch) => {
                onChange('alignItems', patch.align)
                onChange('justifyContent', patch.justify)
              }}
              onClear={() => {
                onClearProperty('alignItems')
                onClearProperty('justifyContent')
              }}
              aria-label="Alignment"
              data-testid="css-align-grid"
            />
            <GapInput
              value={readString(currentStyles, 'gap')}
              isSet={hasStyleValue(storedStyles.gap)}
              onChange={(v) => onChange('gap', v)}
              onPreview={onPreview ? (v) => onPreview({ gap: v ?? null } as Partial<CSSPropertyBag>) : undefined}
              onClearPreview={onClearPreview}
            />
          </div>
        </div>
      )}

      {/* Grid-only fields, revealed when display === 'grid' */}
      {display === 'grid' && (
        <div className={styles.flexBlock}>
          <GridTrackControl
            label="Columns"
            ariaLabel="Grid template columns"
            value={readString(currentStyles, 'gridTemplateColumns')}
            isSet={hasStyleValue(storedStyles.gridTemplateColumns)}
            onChange={(v) => onChange('gridTemplateColumns', v)}
            onClear={() => onClearProperty('gridTemplateColumns')}
          />
          <GridTrackControl
            label="Rows"
            ariaLabel="Grid template rows"
            value={readString(currentStyles, 'gridTemplateRows')}
            isSet={hasStyleValue(storedStyles.gridTemplateRows)}
            onChange={(v) => onChange('gridTemplateRows', v)}
            onClear={() => onClearProperty('gridTemplateRows')}
          />
          <div className={styles.alignGapRow}>
            <AlignGrid
              mode="grid"
              flexDirection={flexDirection}
              align={{ value: alignItems, isSet: hasStyleValue(storedStyles.alignItems) }}
              justify={{ value: justifyItems, isSet: hasStyleValue(storedStyles.justifyItems) }}
              onChange={(patch) => {
                onChange('alignItems', patch.align)
                onChange('justifyItems', patch.justify)
              }}
              onClear={() => {
                onClearProperty('alignItems')
                onClearProperty('justifyItems')
              }}
              aria-label="Alignment"
              data-testid="css-align-grid"
            />
            <GapInput
              value={readString(currentStyles, 'gap')}
              isSet={hasStyleValue(storedStyles.gap)}
              onChange={(v) => onChange('gap', v)}
              onPreview={onPreview ? (v) => onPreview({ gap: v ?? null } as Partial<CSSPropertyBag>) : undefined}
              onClearPreview={onClearPreview}
            />
          </div>
        </div>
      )}

      {/* Padding — resident regardless of display; see PaddingCluster's doc
          for why this deliberately diverges from Figma's F3 (no auto-layout
          ⇒ no padding row at all), which is a Figma engine fact, not a CSS
          one. */}
      <PaddingCluster
        key={activeTab}
        storedStyles={storedStyles}
        currentStyles={currentStyles}
        tokens={spacingTokens}
        onChange={onChange}
        onPreview={onPreview}
        onClearPreview={onClearPreview}
      />

      {/* Clip content — the promoted `overflow` checkbox, resident regardless
          of display (F3/F4/F6/F7 all show it). The Layout settings ⚙ mounts
          HERE, not inside the flex/grid block — see `LayoutSettingsButton`'s
          doc: alignSelf/justifySelf/flex/gridColumn/gridRow are item-level
          properties governed by the PARENT's display, so they must stay
          reachable regardless of THIS element's own display. This is also
          the one row guaranteed to render on a plain, non-flex/grid element,
          so it is where every "must always be reachable" layout control
          lives — one row, not two. */}
      <ClipContentRow
        key={`${activeTab}-overflow`}
        activeTab={activeTab}
        storedStyles={storedStyles}
        currentStyles={currentStyles}
        onChange={onChange}
        onRemove={onRemove}
        onPreview={onPreview}
        onClearPreview={onClearPreview}
        extraTrigger={
          <LayoutSettingsButton
            display={display}
            activeTab={activeTab}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            onChange={onChange}
            onRemove={onRemove}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        }
      />
    </div>
  )
}
