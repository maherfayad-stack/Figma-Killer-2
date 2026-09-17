/**
 * StrokeSection — Penpot's Stroke section (`STATE.md` `panel-25`, item 6 of
 * the P3 mapping table — `STUDIO-LIVE-CANVAS-PLAN.md` §P3). Migrated out of
 * the legacy `StyleSectionsEditor`/`classStyleSections.ts` registry onto its
 * own `INSPECTOR_SECTIONS` manifest entry, the same pattern Layer/Align/
 * Measures/Layout/Fill (items 1-5) already established: reads/writes
 * exclusively through `useSelectionModel()`/`useInspectorCommit(model)`,
 * takes no props, and renders `null` on no selection.
 *
 * FLAGGED IN ADVANCE AS THE LOWEST-RISK RE-SKIN AFTER LAYER — and it was:
 * the pre-migration `StrokeSection.tsx`'s own doc already stated "colour and
 * style are uniform, only weight is per-side," which already matches
 * Penpot's own stroke model closely. This pass is a geometry/plumbing port,
 * not a redesign — the two-row shape (a `PropertyList` colour entry, then a
 * resident position/weight/settings/sides controls row) is unchanged.
 *
 * ## What the real screenshot adds beyond the pre-migration file
 *
 * `screenshots/f1-rectangle/dark/design.png` (a bare rectangle with a real
 * `1px solid #000000` stroke) shows: a plain-text "STROKE" header (no
 * leading icon glyph — same as `LayoutSection.tsx`'s own choice, and unlike
 * `FillSection.tsx`'s icon, which this section deliberately does NOT copy;
 * `02-measurements.md`'s own "Section headers" table names no icon either),
 * and — the one real, honest geometry gap the pre-migration file had — the
 * SAME "Color field chrome" `02-measurements.md` documents for Fill: one row
 * of swatch → hex → `%` opacity → remove. The pre-migration file's colour
 * entry had a swatch+hex (via `ColorValueInput`, embedded directly as the
 * `PropertyList` entry's `summary` — unchanged here) but no opacity field at
 * all. `ColorOpacityField` (`FillSectionParts.tsx`) is reused VERBATIM as
 * this row's `value` slot — the exact same alpha-channel-of-the-colour-value
 * mechanism Fill already built, applying it here closes the same gap for
 * Stroke that Fill's own doc already flagged applies to "each fill/stroke
 * entry."
 *
 * The screenshot's own STROKE row ALSO shows a `+` that stays visible once
 * populated (Penpot's vector stroke model supports a STACK of strokes). CSS
 * `border` is not a stack — there is exactly one — so this section does NOT
 * add a persistent "add another stroke" affordance once populated; adding
 * one would be a control that lies about a distinction Studio's CSS model
 * does not have (the same posture `MeasuresSection.tsx`'s own doc takes for
 * Penpot's undecoded FLEX ELEMENT icon row, and `AlignSection.tsx`'s doc
 * takes for hiding a row entirely rather than showing a disabled one).
 *
 * Row 2's own three controls in the screenshot (weight, an icon-only
 * position/alignment dropdown, a line-style dropdown) are NOT a 1:1 shape
 * this section copies literally — Penpot's vector alignment (Inside /
 * Center / Outside) has no CSS equivalent beyond two of its three values
 * (see the original file's own "STROKE POSITION HONESTY" reasoning, ported
 * unchanged below), and CSS additionally needs an `outline`/shorthand
 * escape hatch Penpot's model has no reason to expose. The pre-migration
 * file's own settings-gear popover + sides-menu shape already covers this
 * honestly and is kept, not rebuilt to chase an icon-only affordance P0
 * never decoded (`03-operating-behaviors.md`'s own "Picker chrome: what was
 * and wasn't captured" note — the full swatch popover chrome was never
 * reliably screenshotted either).
 *
 * ## LAW 1 — EMPTY vs. POPULATED, RULE 2 COMPLIANCE
 *
 * Nothing set anywhere (base or any breakpoint/condition, across every
 * property this section claims — the per-side longhands AND the outline/
 * shorthand escape hatches) renders `Section`'s `empty` state: title + a
 * single "+", no chevron, no body — matches Penpot's own measured
 * collapsed-empty convention (`02-measurements.md`: "one `32px` row: title +
 * trailing `+`, no chevron"). Per `03-operating-behaviors.md`'s own explicit
 * note, clicking Penpot's own Stroke `+` writes a real default stroke
 * immediately — Studio's existing `AddablePropertyField` contract (Law 3,
 * `docs/features/inspector-disclosure.md`) deliberately does NOT copy that:
 * writing a value from a bare reveal click would show up as an unexplained
 * diff in the user's real source file. Clicking "+" here only REVEALS the
 * resident Row 2 (position/weight/settings/sides) — exactly the pre-
 * migration file's own contract, where Row 2 is "what a totally-empty
 * Stroke section shows the instant the header's + reveals the body." No
 * value is written until the user actually edits a field. Once anything IS
 * set (or once revealed), this section passes `forceOpen` — no manual
 * collapse of a populated section (`STATE.md` `panel-25`'s Rule-2 gap, the
 * same posture every migrated section takes).
 *
 * ## Locked (code-valued) properties
 *
 * Every property this section claims is filtered through
 * `selectedNode.codeProps`'s `style:<prop>` keys, the same per-section slice
 * of `StyleSectionsComposer.tsx`'s top-level check every migrated section
 * reproduces (no composer aggregates the whole bag anymore). Matches the
 * pre-migration file's own posture — no visible per-field disable UI beyond
 * what `StackedPropertyGrid`'s own `provenanceByProperty`-driven lock icon
 * already provides in the settings popover; the write is silently refused
 * for the resident weight/colour/style/position controls, same as before.
 *
 * ## MULTI-SELECT
 *
 * Supported, with no code of its own (S5). `useSelectionModel()` describes
 * N nodes now — it hands this section the anchor wearing the selection's
 * COLLAPSED inline bag, `MIXED` wherever the layers disagree — so this file
 * renders and commits for a multi-selection through exactly the same reads
 * and `useInspectorCommit` calls it uses for one. See `selectionModel.ts`'s
 * own "Multi-select" doc.
 */
import { useRef, useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { styleValueKey } from '@core/page-tree'
import { PropertyList, type PropertyListEntry } from '@ui/components/PropertyList'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { ExpandableFieldCluster } from '@ui/components/ExpandableFieldCluster'
import { Section } from '@ui/components/Section'
import { ScrubInput } from '@ui/components/ScrubInput'
import { Select } from '@ui/components/Select'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { ColorValueInput } from '@site/property-controls/ColorValueInput'
import { StrokeWeightIcon } from '@ui/components/InspectorIcons'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { BoxSolidIcon } from 'pixel-art-icons/icons/box-solid'
import { StackedPropertyGrid, type StackedGridEntry } from '../../panels/PropertiesPanel/StackedPropertyGrid'
import { getEnumOptions } from '../../panels/PropertiesPanel/cssControlTypes'
import { hasStyleValue, pickMixedString, plainString } from '../../panels/PropertiesPanel/styleValueUtils'
import { resolveStyleFieldDisplay } from '../../panels/PropertiesPanel/styleFieldDisplay'
import { isMixed, type Mixed } from '@ui/components/MixedValue'
import { ColorOpacityField } from './FillSectionParts'
import { useSelectionModel } from '../selectionModel'
import { useInspectorCommit } from '../commitApi'
import { buildContextOnlyClassChain, buildCollapsedCurrentStyles, buildCollapsedStoredStyles } from '../collapsedStyleBag'
import { buildClassChain } from '../../panels/PropertiesPanel/stylePropertyProvenance'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import styles from './StrokeSection.module.css'

const STYLE_KEY_PREFIX = styleValueKey('')
const EMPTY_CODE_PROPS: readonly string[] = []

// ---------------------------------------------------------------------------
// Per-side longhand keys + readers — ported verbatim from the pre-migration
// `panels/PropertiesPanel/StrokeSection.tsx`.
// ---------------------------------------------------------------------------

const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const
type Side = (typeof SIDES)[number]
type SideField = 'Width' | 'Style' | 'Color'

function sideKey(side: Side, field: SideField): keyof CSSPropertyBag {
  return `border${side}${field}` as keyof CSSPropertyBag
}

interface SideFieldState {
  perSide: Record<Side, string | Mixed>
  uniform: boolean
  anySet: boolean
}

/** Read every side's value for one field; report whether all four agree. */
function readSideField(bag: Record<string, unknown>, field: SideField): SideFieldState {
  const perSide = {} as Record<Side, string | Mixed>
  for (const side of SIDES) perSide[side] = pickMixedString(bag[sideKey(side, field)])
  const values = SIDES.map((s) => perSide[s])
  const anySet = values.some((v) => v !== '')
  const uniform = anySet && values.every((v) => v === values[0])
  return { perSide, uniform, anySet }
}

// ---------------------------------------------------------------------------
// The raw shorthand escape hatches — the ⚙ settings popover.
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

/** Every property this section renders a control for. */
const STROKE_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = [
  'borderTopWidth',
  'borderTopStyle',
  'borderTopColor',
  'borderRightWidth',
  'borderRightStyle',
  'borderRightColor',
  'borderBottomWidth',
  'borderBottomStyle',
  'borderBottomColor',
  'borderLeftWidth',
  'borderLeftStyle',
  'borderLeftColor',
  ...SETTINGS_PROPERTIES,
]

// Stroke position — only the two CSS-honest values. See the file doc for why
// "Center" is omitted rather than faked.
const POSITION_OPTIONS = [
  { label: '—', value: '' },
  { label: 'Inside', value: 'border-box' },
  { label: 'Outside', value: 'content-box' },
]

// ---------------------------------------------------------------------------
// StrokeSection — the manifest section
// ---------------------------------------------------------------------------

export function StrokeSection() {
  const model = useSelectionModel()
  const commit = useInspectorCommit(model)
  const { selectedNodeId, selectedNode, assignedClassRules, activeContextId, computedValues, provenanceByProperty } = model
  const hoverPreviewEnabled = useEditorPreference('hoverPreview')

  // Law 1's "+" reveal is per-NODE: `revealedFor === selectedNodeId` so
  // switching to a different, genuinely empty node doesn't inherit a reveal
  // click made for a previous node (this section isn't remounted on
  // selection change — `sections/index.ts` mounts it once, keyed only by
  // section id — so this can't rely on React unmount/remount the way the
  // pre-migration file's OUTER caller used to).
  const [revealedFor, setRevealedFor] = useState<string | null>(null)

  const [customSidesRequested, setCustomSidesRequested] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsTriggerRef = useRef<HTMLButtonElement>(null)
  const [sidesMenuOpen, setSidesMenuOpen] = useState(false)
  const sidesMenuTriggerRef = useRef<HTMLButtonElement>(null)

  if (!selectedNodeId || !selectedNode) return null

  const contextKey = activeContextId ?? 'base'

  // Ported verbatim from every other migrated section's own per-section
  // code-lock check — this section's own slice of
  // `StyleSectionsComposer.tsx`'s top-level banner.
  const lockedProperties = new Set(
    (selectedNode.codeProps ?? EMPTY_CODE_PROPS)
      .filter((name) => name.startsWith(STYLE_KEY_PREFIX))
      .map((name) => name.slice(STYLE_KEY_PREFIX.length)),
  )

  // The same collapsed-bag pair every migrated section builds
  // (`collapsedStyleBag.ts`), scoped to Stroke's own claimed properties.
  const inlineStyles = selectedNode.inlineStyles ?? {}
  const contextOnlyClassChain = buildContextOnlyClassChain(assignedClassRules, activeContextId)
  const { storedStyles } = buildCollapsedStoredStyles(STROKE_PROPERTIES, contextOnlyClassChain, inlineStyles)
  const effectiveClassChain = buildClassChain(assignedClassRules, activeContextId)
  const currentStyles = buildCollapsedCurrentStyles(computedValues, effectiveClassChain, inlineStyles, storedStyles)

  // Law 1 (`docs/features/inspector-disclosure.md` §4 G1): whether ANYTHING
  // Stroke claims is set, on the active tab OR any other breakpoint/
  // condition — mirrors every other migrated section's own
  // `crossContextStyles` construction. This drives the SECTION's own empty
  // vs. populated header state; `anyStrokeSet` below (active-tab-only, per-
  // side longhands only) drives just the colour entry row inside the body,
  // exactly the pre-migration file's own two different checks.
  const crossContextStyles = [
    ...assignedClassRules.flatMap((rule) => [rule.styles, ...Object.values(rule.contextStyles)]),
    inlineStyles,
  ]
  const setAnywhere = STROKE_PROPERTIES.some(
    (prop) => hasStyleValue(storedStyles[prop]) || crossContextStyles.some((bag) => hasStyleValue(bag[prop])),
  )

  const revealed = revealedFor === selectedNodeId

  // -------------------------------------------------------------------------
  // Adapters — the pre-migration `StrokeSectionProps` callback shape, mapped
  // onto `commitApi`'s `commitStyle`/`commitStyleMany`. Mirrors
  // `MeasuresSection.tsx`'s own `onChange`/`onRemove`/`onClearProperty`
  // adapters exactly.
  // -------------------------------------------------------------------------

  function onChange(property: keyof CSSPropertyBag, value: string | number | undefined) {
    if (lockedProperties.has(String(property))) return
    commit.commitStyle(property, value ?? null)
  }

  function onRemove(property: keyof CSSPropertyBag) {
    onChange(property, undefined)
  }

  /**
   * Fully clear a property across base + all breakpoints. Removing the
   * stroke entry uses this (not the lighter `onRemove`) so it really removes
   * the longhands everywhere — the pre-migration file's own
   * `onClearProperty` contract.
   */
  function onClearProperty(property: keyof CSSPropertyBag) {
    if (lockedProperties.has(String(property))) return
    commit.commitStyleMany({ [property]: null } as Partial<Record<keyof CSSPropertyBag, string | number | null>>, {
      mode: 'clear',
    })
  }

  function onPreview(patch: Partial<CSSPropertyBag>) {
    const filtered: Record<string, string | number | null> = {}
    for (const [key, value] of Object.entries(patch)) {
      if (lockedProperties.has(key)) continue
      filtered[key] = (value as string | number | null | undefined) ?? null
    }
    if (Object.keys(filtered).length === 0) return
    commit.commitStyleMany(filtered as Partial<Record<keyof CSSPropertyBag, string | number | null>>, {
      preview: true,
    })
  }

  const onClearPreview = commit.clearStylePreview

  const widthState = readSideField(storedStyles, 'Width')
  const styleState = readSideField(storedStyles, 'Style')
  const colorState = readSideField(storedStyles, 'Color')
  const widthFallback = readSideField(currentStyles, 'Width')

  const anyStrokeSet = widthState.anySet || styleState.anySet || colorState.anySet

  // Law 1's empty header — nothing set anywhere and the user hasn't clicked
  // "+" yet for this node.
  if (!setAnywhere && !revealed) {
    return (
      <Section
        title="Stroke"
        empty
        flush
        actions={
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            aria-label="Add stroke"
            tooltip="Add stroke"
            onClick={() => setRevealedFor(selectedNodeId)}
            data-testid="stroke-section-add"
          >
            <PlusIcon size={12} aria-hidden="true" />
          </Button>
        }
      />
    )
  }

  // Law 4: linked purely from the data — every side equal (or nothing set,
  // trivially uniform). Mirrors `RadiusCluster`'s radius cluster exactly.
  const widthLinked = widthState.uniform || !widthState.anySet

  // Explicit "show me all four" request from the sides menu — see the file
  // doc's SIDES MENU section for why this exists alongside `widthLinked`.
  const showCustomSides = customSidesRequested || !widthLinked

  // A width WRITTEN to every side has to be one real value — never the
  // sentinel — so a mixed top width falls through to the effective one.
  const representativeWidth =
    plainString(widthState.perSide.Top) ||
    plainString(pickMixedString(currentStyles[sideKey('Top', 'Width')])) ||
    '1px'

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
  const colorMixed = isMixed(colorValue)
  const colorPlainValue = plainString(colorValue)
  const colorPlaceholder =
    plainString(pickMixedString(currentStyles[sideKey('Top', 'Color')])) || 'transparent'

  const entries: PropertyListEntry[] = anyStrokeSet
    ? [
        {
          id: 'stroke',
          label: 'Stroke',
          summary: (
            <ColorValueInput
              id="stroke-color"
              value={colorPlainValue}
              mixed={colorMixed}
              ariaLabel="Stroke color"
              swatchLabel="Stroke color swatch"
              placeholder={colorPlaceholder}
              onChange={(v) => writeAllColors(v || undefined)}
              onPreview={
                hoverPreviewEnabled
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
          // `02-measurements.md`'s "Color field chrome": swatch → hex → `%`
          // opacity → remove, one row per fill/stroke entry — the same
          // inline field `FillSection.tsx` already built for its own colour
          // rows, reused verbatim here rather than a second implementation.
          // Only rendered once a REAL colour is stored (not just a
          // placeholder-derived one, and not the multi-node MIXED sentinel —
          // `ColorOpacityField` has no separate placeholder concept of its
          // own, unlike `ColorValueInput` above, so it must never be handed
          // anything but a real, parseable value).
          value: !colorMixed && colorPlainValue !== '' ? (
            <ColorOpacityField
              value={colorPlainValue}
              ariaLabel="Stroke color opacity"
              onChange={(next) => writeAllColors(next)}
            />
          ) : undefined,
          data: null,
        },
      ]
    : []

  // ── Row 2 controls ───────────────────────────────────────────────────────
  const boxSizingCell = pickMixedString(storedStyles.boxSizing)
  const boxSizingValue = plainString(boxSizingCell)

  const weightField = (
    <ScrubInput
      key="stroke-weight-all"
      label={<StrokeWeightIcon size={13} aria-hidden="true" />}
      aria-label="Stroke weight, all sides"
      {...strokeWeightDisplay(widthState.perSide.Top, widthFallback.perSide.Top)}
      data-testid="stroke-weight-all"
      onChange={(next) => writeAllWidths(next || undefined)}
    />
  )

  const expandedWeightFields = SIDES.map((side) => (
    <ScrubInput
      key={side}
      label={<StrokeWeightIcon size={13} aria-hidden="true" />}
      aria-label={`Stroke weight, ${side.toLowerCase()}`}
      {...strokeWeightDisplay(widthState.perSide[side], widthFallback.perSide[side])}
      data-testid={`stroke-weight-${side.toLowerCase()}`}
      onChange={(next) => onChange(sideKey(side, 'Width'), next || undefined)}
    />
  ))

  const settingsAnySet = SETTINGS_PROPERTIES.some((prop) => hasStyleValue(storedStyles[prop]))

  const styleCell = styleState.perSide.Top
  const styleValue = plainString(styleCell)
  const styleOptions = getEnumOptions('borderStyle') ?? []

  return (
    <Section title="Stroke" forceOpen flush>
      <div className={styles.root} data-testid="inspector-stroke-section" key={contextKey}>
        <PropertyList listLabel="Stroke" entries={entries} onRemove={clearStroke} />

        <div className={styles.controlsRow} data-testid="stroke-controls-row">
          <Select
            fieldSize="sm"
            className={styles.position}
            value={boxSizingValue}
            mixed={isMixed(boxSizingCell)}
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
                  mixed={isMixed(styleCell)}
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
                activeTab={contextKey}
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
    </Section>
  )
}

/**
 * The `value` / `placeholder` / `inherited` trio for one stroke-weight field,
 * from the one display rule (`styleFieldDisplay.ts`): the declared width,
 * else the width the element actually renders (muted), else `0px` as a hint.
 */
function strokeWeightDisplay(stored: string | Mixed, current: string | Mixed): { value: string | Mixed | undefined; placeholder: string | undefined; inherited: boolean } {
  const display = resolveStyleFieldDisplay({
    storedValue: plainString(stored),
    currentValue: plainString(current),
    fallback: '0px',
  })
  return {
    value: isMixed(stored) ? stored : display.value,
    placeholder: display.placeholder,
    inherited: display.inherited,
  }
}
