/**
 * StrokeSection — the Stroke `PropertyList` (STUDIO-INSPECTOR-DISCLOSURE-PLAN
 * §4 G7, F16-F19). Replaces `BorderControl` (deleted in this change): the
 * per-side width/style/colour diagram + its "Advanced" shorthand disclosure
 * become a two-row Figma-shaped list entry.
 *
 * ROW 1 — the `PropertyList` colour entry. Law 1: zero entries renders
 * nothing (`PropertyList` itself returns `null`); one entry appears the
 * moment ANY border longhand is set, on any side.
 *
 * ROW 2 — position / weight / settings / sides. This is the section's own
 * permanent "one line": it is what a totally-empty Stroke section shows the
 * instant the header's `+` reveals the body (before anything is set), and it
 * stays resident afterwards — the same "revealed body keeps its resident
 * controls" idiom the sibling `collapsedWhenEmpty` sections (Background,
 * Effects, Typography) already use.
 *
 * COLOUR / STYLE ARE UNIFORM; ONLY WEIGHT IS PER-SIDE. F19 ("stroke sides
 * custom") only ever shows four WEIGHTS — Figma's stroke is one paint with
 * one style, and only its thickness can vary per edge. Colour and style are
 * therefore each a single control here that fans a write out to all four
 * `border{Side}Color` / `border{Side}Style` longhands at once; only width
 * gets the per-side `ExpandableFieldCluster` treatment.
 *
 * SIDES MENU → CUSTOM (F18/F19). `ExpandableFieldCluster` deliberately
 * exposes no externally-driven "expand now" — its own toggle is the only
 * thing that flips its internal state (see that component's doc: it
 * auto-COLLAPSES when values become uniform again, but never auto-expands,
 * by design). The sides menu's "Custom" item needs to force the four-field
 * view open from a menu click, not a click on the cluster's own toggle, so
 * this component derives `showCustomSides` itself (real non-uniform values
 * OR an explicit "Custom" pick) and keys the cluster by that boolean —
 * forcing a clean remount, which is what lets the freshly-mounted cluster's
 * own `!linked` initializer take effect. This is a deliberate, standard
 * React "force fresh initial state via `key`" — not a reach into the
 * primitive's internals, and it does not reimplement the primitive's own
 * auto-relink transition (that stays exactly where it lives, inside
 * `ExpandableFieldCluster`).
 *
 * STROKE POSITION HONESTY (F16, plan §7). Figma's Inside/Center/Outside is
 * NOT a single CSS switch. But two of its three values ARE real, honest,
 * single declarations once you look at what `box-sizing` actually does to a
 * border's paint:
 *   - `box-sizing: border-box` keeps the declared width/height as the
 *     element's OUTER edge — the border is painted INSIDE that box, exactly
 *     Figma's "Inside".
 *   - `box-sizing: content-box` (the CSS default) adds the border OUTSIDE
 *     the declared width/height, growing the element's footprint — exactly
 *     Figma's "Outside".
 *   - "Center" (half in, half out) has no CSS equivalent — synthesising it
 *     with a negative `outline-offset` trick would silently repurpose the
 *     `outline` property this section already exposes for something else
 *     entirely, which is exactly the kind of control that lies. It is
 *     omitted, not fudged.
 * So — unlike the plan's own suggestion of shipping "Inside" only — this
 * control ships BOTH real values (`Select`, bound to `boxSizing`, options
 * "Inside"/"Outside" plus a blank "unset" choice) and leaves out the one
 * that cannot be written. `boxSizing` is the same CSSPropertyBag property
 * `SizeSection` already edits — this is a second, task-shaped entry point
 * onto it, not a duplicate source of truth.
 *
 * The raw shorthand escape hatches that used to live in `StyleSectionsEditor`
 *'s Border "Advanced" `<details>` (`border`, `borderTop/Right/Bottom/Left`,
 * `borderWidth`, `borderStyle`, `borderColor`, `borderRadius`, `appearance`)
 * move into the ⚙ settings popover verbatim — Law 2 turns an in-panel
 * disclosure into a popover, it does not delete the capability behind it.
 */

import { useRef, useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { PropertyList, type PropertyListEntry } from '@ui/components/PropertyList'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { ExpandableFieldCluster } from '@ui/components/ExpandableFieldCluster'
import { ScrubInput } from '@ui/components/ScrubInput'
import { Select } from '@ui/components/Select'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { ColorValueInput } from '@site/property-controls/ColorValueInput'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import { StrokeWeightIcon } from '@ui/components/InspectorIcons'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { BoxSolidIcon } from 'pixel-art-icons/icons/box-solid'
import { StackedPropertyGrid, type StackedGridEntry } from './StackedPropertyGrid'
import { getEnumOptions } from './cssControlTypes'
import { hasStyleValue } from './styleValueUtils'
import type { PropertyProvenance } from './stylePropertyProvenance'
import styles from './StrokeSection.module.css'

// ---------------------------------------------------------------------------
// Per-side longhand keys + readers
// ---------------------------------------------------------------------------

const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const
type Side = (typeof SIDES)[number]
type SideField = 'Width' | 'Style' | 'Color'

function sideKey(side: Side, field: SideField): keyof CSSPropertyBag {
  return `border${side}${field}` as keyof CSSPropertyBag
}

function pickString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return `${value}px`
  return ''
}

interface SideFieldState {
  perSide: Record<Side, string>
  uniform: boolean
  anySet: boolean
}

/** Read every side's value for one field; report whether all four agree. */
function readSideField(bag: Record<string, unknown>, field: SideField): SideFieldState {
  const perSide = {} as Record<Side, string>
  for (const side of SIDES) perSide[side] = pickString(bag[sideKey(side, field)])
  const values = SIDES.map((s) => perSide[s])
  const anySet = values.some((v) => v !== '')
  const uniform = anySet && values.every((v) => v === values[0])
  return { perSide, uniform, anySet }
}

// ---------------------------------------------------------------------------
// The raw shorthand escape hatches — relocated verbatim into the ⚙ popover.
// ---------------------------------------------------------------------------

const SETTINGS_STACKED_SPEC: ReadonlyArray<StackedGridEntry> = [
  ['outline', 'outlineOffset'],
  ['border', 'borderWidth'],
  ['borderColor', 'borderRadius'],
  ['borderTop', 'borderRight'],
  ['borderBottom', 'borderLeft'],
  'appearance',
]

const SETTINGS_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = [
  'outline',
  'outlineOffset',
  'border',
  'borderTop',
  'borderRight',
  'borderBottom',
  'borderLeft',
  'borderWidth',
  'borderColor',
  'borderRadius',
  'appearance',
]

// Stroke position — only the two CSS-honest values. See the file doc for why
// "Center" is omitted rather than faked.
const POSITION_OPTIONS = [
  { label: '—', value: '' },
  { label: 'Inside', value: 'border-box' },
  { label: 'Outside', value: 'content-box' },
]

// ---------------------------------------------------------------------------
// StrokeSection
// ---------------------------------------------------------------------------

interface StrokeSectionProps {
  activeTab: string
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  /**
   * Fully clear a property across base + all breakpoints. Removing the
   * stroke entry uses this (not the lighter `onRemove`) so it really removes
   * the longhands everywhere, matching the LayoutSection / Position clear
   * semantics `BorderControl` already established.
   */
  onClearProperty: (property: keyof CSSPropertyBag) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
  provenanceByProperty?: ReadonlyMap<string, PropertyProvenance>
}

export function StrokeSection({
  activeTab,
  storedStyles,
  currentStyles,
  onChange,
  onRemove,
  onClearProperty,
  onPreview,
  onClearPreview,
  provenanceByProperty,
}: StrokeSectionProps) {
  const hoverPreviewEnabled = useEditorPreference('hoverPreview')

  const widthState = readSideField(storedStyles, 'Width')
  const styleState = readSideField(storedStyles, 'Style')
  const colorState = readSideField(storedStyles, 'Color')
  const widthFallback = readSideField(currentStyles, 'Width')

  const anyStrokeSet = widthState.anySet || styleState.anySet || colorState.anySet

  // Law 4: linked purely from the data — every side equal (or nothing set,
  // trivially uniform). Mirrors `AppearanceSection`'s radius cluster exactly.
  const widthLinked = widthState.uniform || !widthState.anySet

  // Explicit "show me all four" request from the sides menu — see the file
  // doc's SIDES MENU section for why this exists alongside `widthLinked`.
  const [customSidesRequested, setCustomSidesRequested] = useState(false)
  const showCustomSides = customSidesRequested || !widthLinked

  const representativeWidth =
    widthState.perSide.Top || pickString(currentStyles[sideKey('Top', 'Width')]) || '1px'

  function writeAllWidths(value: string | undefined) {
    for (const side of SIDES) onChange(sideKey(side, 'Width'), value)
  }

  function writeAllColors(value: string | undefined) {
    for (const side of SIDES) onChange(sideKey(side, 'Color'), value)
  }

  function writeAllStyles(value: string | undefined) {
    for (const side of SIDES) onChange(sideKey(side, 'Style'), value)
  }

  function clearStroke() {
    for (const side of SIDES) {
      for (const field of ['Width', 'Style', 'Color'] as SideField[]) {
        onClearProperty(sideKey(side, field))
      }
    }
  }

  function selectAllSides() {
    setCustomSidesRequested(false)
    writeAllWidths(representativeWidth)
  }

  function selectOneSide(target: Side) {
    setCustomSidesRequested(false)
    onChange(sideKey(target, 'Width'), representativeWidth)
    for (const side of SIDES) {
      if (side !== target) onChange(sideKey(side, 'Width'), undefined)
    }
  }

  // ── PropertyList entry (Row 1) ──────────────────────────────────────────
  const colorValue = colorState.perSide.Top
  const colorPlaceholder = pickString(currentStyles[sideKey('Top', 'Color')]) || 'transparent'

  const entries: PropertyListEntry[] = anyStrokeSet
    ? [
        {
          id: 'stroke',
          label: 'Stroke',
          summary: (
            <ColorValueInput
              id="stroke-color"
              value={colorValue}
              ariaLabel="Stroke color"
              swatchLabel="Stroke color swatch"
              placeholder={colorPlaceholder}
              onChange={(v) => writeAllColors(v || undefined)}
              onPreview={
                hoverPreviewEnabled && onPreview
                  ? (v) => {
                      const patch: Partial<CSSPropertyBag> = {}
                      for (const side of SIDES) {
                        ;(patch as Record<string, unknown>)[sideKey(side, 'Color')] = v
                      }
                      onPreview(patch)
                    }
                  : undefined
              }
              onClearPreview={onClearPreview}
            />
          ),
          data: null,
        },
      ]
    : []

  // ── Row 2 controls ───────────────────────────────────────────────────────
  const boxSizingValue = pickString(storedStyles.boxSizing)

  const weightField = (
    <ScrubInput
      key="stroke-weight-all"
      label={<StrokeWeightIcon size={13} aria-hidden="true" />}
      aria-label="Stroke weight, all sides"
      value={widthState.perSide.Top}
      placeholder={widthFallback.perSide.Top || '0px'}
      data-testid="stroke-weight-all"
      onChange={(next) => writeAllWidths(next || undefined)}
    />
  )

  const expandedWeightFields = SIDES.map((side) => (
    <ScrubInput
      key={side}
      label={<StrokeWeightIcon size={13} aria-hidden="true" />}
      aria-label={`Stroke weight, ${side.toLowerCase()}`}
      value={widthState.perSide[side]}
      placeholder={widthFallback.perSide[side] || '0px'}
      data-testid={`stroke-weight-${side.toLowerCase()}`}
      onChange={(next) => onChange(sideKey(side, 'Width'), next || undefined)}
    />
  ))

  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsTriggerRef = useRef<HTMLButtonElement>(null)
  const settingsAnySet = SETTINGS_PROPERTIES.some((prop) => hasStyleValue(storedStyles[prop]))

  const [sidesMenuOpen, setSidesMenuOpen] = useState(false)
  const sidesMenuTriggerRef = useRef<HTMLButtonElement>(null)

  const styleValue = styleState.perSide.Top
  const styleOptions = getEnumOptions('borderStyle') ?? []

  return (
    <div className={styles.root}>
      <PropertyList listLabel="Stroke" entries={entries} onRemove={clearStroke} />

      <div className={styles.controlsRow}>
        <Select
          fieldSize="sm"
          className={styles.position}
          value={boxSizingValue}
          aria-label="Stroke position"
          data-testid="stroke-position"
          onChange={(e) => onChange('boxSizing', e.target.value || undefined)}
          options={POSITION_OPTIONS}
        />

        <div className={styles.weight}>
          <ExpandableFieldCluster
            key={showCustomSides ? 'expanded' : 'collapsed'}
            id="stroke-sides"
            collapsed={[weightField]}
            expanded={expandedWeightFields}
            linked={!showCustomSides}
            expandLabel="Show individual side weights"
            collapseLabel="Combine to one weight"
          />
        </div>

        <div className={styles.trailingActions}>
          <Button
            ref={settingsTriggerRef}
            variant="ghost"
            size="xs"
            iconOnly
            pressed={settingsAnySet}
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            aria-label="Stroke settings"
            tooltip="Stroke settings"
            data-testid="stroke-settings-trigger"
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <SlidersHorizontalIcon size={14} aria-hidden="true" />
          </Button>

          <Button
            ref={sidesMenuTriggerRef}
            variant="ghost"
            size="xs"
            iconOnly
            pressed={!widthLinked}
            aria-haspopup="menu"
            aria-expanded={sidesMenuOpen}
            aria-label="Stroke sides"
            tooltip="Stroke sides"
            data-testid="stroke-sides-trigger"
            onClick={() => setSidesMenuOpen((v) => !v)}
          >
            <BoxSolidIcon size={14} aria-hidden="true" />
          </Button>
        </div>
      </div>

      {settingsOpen && (
        <InspectorPopover
          id="stroke-settings"
          anchorRef={settingsTriggerRef}
          onClose={() => setSettingsOpen(false)}
          title="Stroke settings"
          width={248}
        >
          <div className={styles.settingsBody}>
            <div className={styles.styleField}>
              <span className={styles.styleFieldLabel}>Style</span>
              <Select
                fieldSize="sm"
                value={styleValue}
                aria-label="Stroke style"
                data-testid="stroke-style"
                onChange={(e) => writeAllStyles(e.target.value || undefined)}
                options={[{ label: '—', value: '' }, ...styleOptions.map((o) => ({ label: o, value: o }))]}
              />
            </div>
            <StackedPropertyGrid
              spec={SETTINGS_STACKED_SPEC}
              visibleProperties={SETTINGS_PROPERTIES}
              storedStyles={storedStyles}
              currentStyles={currentStyles}
              activeTab={activeTab}
              onChange={onChange}
              onRemove={onRemove}
              onPreview={onPreview}
              onClearPreview={onClearPreview}
              provenanceByProperty={provenanceByProperty}
            />
          </div>
        </InspectorPopover>
      )}

      {sidesMenuOpen && (
        <ContextMenu
          ariaLabel="Stroke sides"
          anchorRef={sidesMenuTriggerRef}
          triggerRef={sidesMenuTriggerRef}
          align="end"
          side="bottom"
          offset={6}
          width={180}
          onClose={() => setSidesMenuOpen(false)}
        >
          <div className={styles.sidesMenuTitle}>Apply weight to</div>
          <ContextMenuItem
            selected={widthLinked && !customSidesRequested}
            onClick={() => {
              selectAllSides()
              setSidesMenuOpen(false)
            }}
          >
            All sides
          </ContextMenuItem>
          {SIDES.map((side) => (
            <ContextMenuItem
              key={side}
              onClick={() => {
                selectOneSide(side)
                setSidesMenuOpen(false)
              }}
            >
              {side}
            </ContextMenuItem>
          ))}
          <ContextMenuSeparator />
          <ContextMenuItem
            selected={showCustomSides}
            onClick={() => {
              setCustomSidesRequested(true)
              setSidesMenuOpen(false)
            }}
          >
            Custom
          </ContextMenuItem>
        </ContextMenu>
      )}
    </div>
  )
}
