/**
 * SizeSection — Figma-style visual editor for the `size` CSS section.
 *
 * docs/features/inspector-disclosure.md, G2 (F30/F31): width and height are
 * `AddablePropertyField`s that fold their own sizing intent — `Fixed` /
 * `Hug contents` / `Fill container`, resolved through `elementSizing.ts` —
 * into their own dropdown, rather than a separate always-on segmented row.
 * `min`/`max` width and height are not fields at all until asked for (Law 3,
 * `docs/features/inspector-disclosure.md` §1): each starts life as an
 * `Add minimum width…` / `Add maximum width…` menu item on the field it
 * constrains, and `onAdd` REVEALS the row without writing any CSS — the
 * property is only written the first time the user commits a value into it.
 * A revealed row is a `RevealedField`; its `−` clears the property AND drops
 * the row, returning the `Add …` item to the menu. A property that already
 * carries a value (set in an earlier session, or on a different breakpoint)
 * is revealed automatically — reveal state only matters for the empty case.
 *
 * W and H are two equal halves of one `1fr 1fr` row, and the mode chevron is
 * drawn INSIDE each field's trailing edge rather than beside it
 * (`AddablePropertyField.module.css`) — an in-flow chevron spent ~20px of an
 * ~82px cell on chrome, which is what made these read as unequal against the
 * padding row Layout draws directly underneath.
 *
 * Mode legibility without a menu (F4's `H 325 Hug`): while an axis's mode is
 * `Hug` or `Fill` the field shows the mode's word instead of a number
 * (`AddablePropertyField`'s own `word` behaviour) AND a small `Fixed / Hug /
 * Fill` `SegmentedControl` appears directly under that field, so the mode
 * stays visible without opening the chevron menu. Switching to `Fixed`
 * removes the segmented row and freezes the field's last MEASURED size
 * (`currentStyles`, the frame's real computed value) as a literal length,
 * rather than resetting it to nothing.
 *
 * `aspectRatio` and `boxSizing` are both rare — G3
 * (`docs/features/inspector-disclosure.md` §6) moves them into a small `⚙`
 * popover on the Size section itself (the Layout ⚙ is a different
 * component, `LayoutSection/LayoutSettingsButton.tsx`, scoped to
 * layout-only properties), reusing `InspectorPopover` — the same
 * presence-mounted, no-`open`-prop shape `LayoutSettingsButton` already
 * established. Both fields stay paired into one uncaptioned row exactly as
 * before; only where that row lives moved.
 */

import { useRef, useState, type ReactNode } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { isMixed, MIXED, MIXED_PLACEHOLDER, type Mixed } from '@ui/components/MixedValue'
import {
  AddablePropertyField,
  RevealedField,
  type AddablePropertyFieldAddition,
  type AddablePropertyFieldMode,
} from '@ui/components/AddablePropertyField'
import { Button } from '@ui/components/Button'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import {
  MinWidthIcon,
  MaxWidthIcon,
  MinHeightIcon,
  MaxHeightIcon,
} from '@ui/components/InspectorIcons'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { ClassPropertyRow } from './ClassPropertyRow'
import { getCSSPropertyDefaultValue } from './cssControlTypes'
import { hasStyleValue } from './styleValueUtils'
import { SIZING_OPTIONS, currentSizingMode, sizingPatch, type SizingMode } from './elementSizing'
import styles from './SizeSection.module.css'

/** Marks are 13px to match the in-field glyphs the generic rows draw. */
const GLYPH_SIZE = 13

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface SizeSectionProps {
  currentStyles: Record<string, unknown>
  storedStyles: Record<string, unknown>
  /** Active breakpoint tab id — keys sub-controls so they re-mount on tab change. */
  activeTab: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  /** Fully clear a property — see StyleRuleComposer.handleClearProperty. */
  onClearProperty: (property: keyof CSSPropertyBag) => void
  /** Patch-shaped hover / as-you-type preview channel. */
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

// ---------------------------------------------------------------------------
// Constraint spec — one entry per min/max property, shared by the addition
// menu items and the revealed rows so the two never drift apart.
// ---------------------------------------------------------------------------

interface ConstraintSpec {
  prop: keyof CSSPropertyBag
  axis: 'width' | 'height'
  ariaLabel: string
  addLabel: string
  icon: ReactNode
}

const CONSTRAINTS: ReadonlyArray<ConstraintSpec> = [
  {
    prop: 'minWidth',
    axis: 'width',
    ariaLabel: 'Minimum width',
    addLabel: 'Add minimum width…',
    icon: <MinWidthIcon size={GLYPH_SIZE} aria-hidden="true" />,
  },
  {
    prop: 'maxWidth',
    axis: 'width',
    ariaLabel: 'Maximum width',
    addLabel: 'Add maximum width…',
    icon: <MaxWidthIcon size={GLYPH_SIZE} aria-hidden="true" />,
  },
  {
    prop: 'minHeight',
    axis: 'height',
    ariaLabel: 'Minimum height',
    addLabel: 'Add minimum height…',
    icon: <MinHeightIcon size={GLYPH_SIZE} aria-hidden="true" />,
  },
  {
    prop: 'maxHeight',
    axis: 'height',
    ariaLabel: 'Maximum height',
    addLabel: 'Add maximum height…',
    icon: <MaxHeightIcon size={GLYPH_SIZE} aria-hidden="true" />,
  },
]

/** Per-axis mode menu — `SIZING_OPTIONS` plus an axis-worded, value-quoting
 *  `activeLabel` on `fixed` (F30's "Fixed width (54)"). */
function sizingModes(axisNoun: 'width' | 'height'): AddablePropertyFieldMode[] {
  return SIZING_OPTIONS.map((option) => {
    if (option.value !== 'fixed') {
      return { value: option.value, label: option.label, word: option.word }
    }
    return {
      value: option.value,
      label: `Fixed ${axisNoun}`,
      activeLabel: (value: string | Mixed | undefined) =>
        `Fixed ${axisNoun} (${isMixed(value) ? MIXED_PLACEHOLDER : typeof value === 'string' && value !== '' ? value : '—'})`,
    }
  })
}

const MODE_SEGMENTS: ReadonlyArray<{ value: SizingMode; label: string }> = [
  { value: 'fixed', label: 'Fixed' },
  { value: 'hug', label: 'Hug' },
  { value: 'fill', label: 'Fill' },
]

// ---------------------------------------------------------------------------
// SizeSection
// ---------------------------------------------------------------------------

export function SizeSection({
  currentStyles,
  storedStyles,
  activeTab,
  onChange,
  onRemove,
  onClearProperty,
  onPreview,
  onClearPreview,
}: SizeSectionProps) {
  // Law 3 reveal state — a constraint the user asked for via "Add …" but
  // hasn't necessarily committed a value into yet. A constraint that already
  // HAS a stored value renders regardless of this set (see `isRevealed`).
  const [addedConstraints, setAddedConstraints] = useState<ReadonlySet<keyof CSSPropertyBag>>(
    () => new Set(),
  )

  // G3 — `aspectRatio`/`boxSizing` popover (Law 2: rare options live behind a
  // settings affordance, not a permanent row). Mirrors
  // `LayoutSection/LayoutSettingsButton.tsx`'s trigger shape exactly.
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsTriggerRef = useRef<HTMLButtonElement>(null)
  const settingsAnySet = hasStyleValue(storedStyles.aspectRatio) || hasStyleValue(storedStyles.boxSizing)

  function revealConstraint(prop: keyof CSSPropertyBag) {
    setAddedConstraints((prev) => (prev.has(prop) ? prev : new Set(prev).add(prop)))
  }

  function removeConstraint(prop: keyof CSSPropertyBag) {
    onClearProperty(prop)
    setAddedConstraints((prev) => {
      if (!prev.has(prop)) return prev
      const next = new Set(prev)
      next.delete(prop)
      return next
    })
  }

  function isRevealed(prop: keyof CSSPropertyBag): boolean {
    return hasStyleValue(storedStyles[prop]) || addedConstraints.has(prop)
  }

  // Per-property adapter over the patch-shaped preview channel, used by the
  // W/H fields, the revealed constraint rows, and the aspect-ratio /
  // box-sizing rows below.
  const previewProperty = onPreview
    ? (property: keyof CSSPropertyBag, value: string | number | undefined) =>
        onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)
    : undefined

  function handleModeChange(property: 'width' | 'height', nextMode: SizingMode) {
    onChange(property, sizingPatch(nextMode, currentStyles[property]))
  }

  const axisField = (
    property: 'width' | 'height',
    fieldMark: string,
    ariaLabel: string,
    axisNoun: 'width' | 'height',
  ) => {
    const storedValue = storedStyles[property]
    const currentValue = currentStyles[property]
    // W8-3 — `hasStyleValue` is true for the MIXED Symbol, so a selection
    // that disagrees must be caught before `String(storedValue)` prints the
    // sentinel into the field. `AddablePropertyField` takes `MIXED` directly.
    const mixed = isMixed(storedValue) || (!hasStyleValue(storedValue) && isMixed(currentValue))
    const mode = mixed ? 'fixed' : currentSizingMode(storedValue)
    const isSet = !mixed && hasStyleValue(storedValue)
    const placeholder =
      mixed || isSet
        ? undefined
        : hasStyleValue(currentValue)
          ? String(currentValue)
          : String(getCSSPropertyDefaultValue(property))

    const additions: AddablePropertyFieldAddition[] = CONSTRAINTS.filter(
      (c) => c.axis === property && !isRevealed(c.prop),
    ).map((c) => ({ key: c.prop, label: c.addLabel, icon: c.icon }))

    return (
      <div className={styles.axisCell}>
        <AddablePropertyField
          name={ariaLabel}
          label={fieldMark}
          aria-label={ariaLabel}
          value={mixed ? MIXED : isSet ? String(storedValue) : undefined}
          placeholder={placeholder}
          onChange={(next) => onChange(property, next)}
          onPreview={previewProperty ? (next) => previewProperty(property, next) : undefined}
          onClearPreview={onClearPreview}
          modes={sizingModes(axisNoun)}
          mode={mode}
          onModeChange={(next) => handleModeChange(property, next as SizingMode)}
          numericMode="fixed"
          additions={additions}
          onAdd={(key) => revealConstraint(key as keyof CSSPropertyBag)}
          data-testid={`css-size-input-${property}`}
        />
        {mode !== 'fixed' && (
          <SegmentedControl
            fullWidth
            size="xs"
            aria-label={`${ariaLabel} sizing mode`}
            value={mode}
            onChange={(next) => handleModeChange(property, next)}
            options={MODE_SEGMENTS}
            className={styles.modeRow}
            data-testid={`css-size-mode-${property}`}
          />
        )}
      </div>
    )
  }

  const revealedRow = (spec: ConstraintSpec) => {
    const storedValue = storedStyles[spec.prop]
    const currentValue = currentStyles[spec.prop]
    const mixed = isMixed(storedValue) || (!hasStyleValue(storedValue) && isMixed(currentValue))
    const isSet = !mixed && hasStyleValue(storedValue)
    const placeholder =
      mixed || isSet
        ? undefined
        : hasStyleValue(currentValue)
          ? String(currentValue)
          : String(getCSSPropertyDefaultValue(spec.prop))

    return (
      <RevealedField
        key={spec.prop}
        label={spec.icon}
        ariaLabel={spec.ariaLabel}
        value={mixed ? MIXED : isSet ? String(storedValue) : undefined}
        placeholder={placeholder}
        onChange={(resolved) => onChange(spec.prop, resolved)}
        onPreview={previewProperty ? (resolved) => previewProperty(spec.prop, resolved) : undefined}
        onClearPreview={onClearPreview}
        onRemove={() => removeConstraint(spec.prop)}
        className={styles.revealedRow}
        data-testid={`css-size-input-${spec.prop}`}
      />
    )
  }

  return (
    <>
      {/* W/H, one row — the settings trigger sits beside the pair rather
          than under it, so the fixed/hug/fill segmented row (when an axis
          shows one) grows the FIELD's own column, not a whole extra row. */}
      <div className={styles.sizeRow}>
        <div className={styles.sizeGrid}>
          {axisField('width', 'W', 'Width', 'width')}
          {axisField('height', 'H', 'Height', 'height')}
        </div>
        <Button
          ref={settingsTriggerRef}
          variant="ghost"
          size="xs"
          iconOnly
          pressed={settingsAnySet}
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          aria-label="Size settings"
          tooltip="Aspect ratio & box sizing"
          className={styles.sizeSettingsTrigger}
          data-testid="size-settings-trigger"
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <SlidersHorizontalIcon size={14} aria-hidden="true" />
        </Button>
      </div>
      {CONSTRAINTS.filter((c) => isRevealed(c.prop)).map(revealedRow)}
      {settingsOpen && (
        <InspectorPopover
          id="size-settings"
          anchorRef={settingsTriggerRef}
          onClose={() => setSettingsOpen(false)}
          title="Size settings"
        >
          {/* aspectRatio (free-form text, carries a frame glyph) and
              boxSizing (enum whose values name themselves) pair into one
              uncaptioned row — same shape they had resident on the section,
              just relocated behind this trigger (Law 2: rare options live
              behind a settings affordance, not a permanent row). */}
          <div className={styles.sizeGrid}>
            <GenericSizeRow
              activeTab={activeTab}
              property="aspectRatio"
              storedStyles={storedStyles}
              currentStyles={currentStyles}
              onChange={onChange}
              onRemove={onRemove}
              onPreview={previewProperty}
              onClearPreview={onClearPreview}
            />
            <GenericSizeRow
              activeTab={activeTab}
              property="boxSizing"
              storedStyles={storedStyles}
              currentStyles={currentStyles}
              onChange={onChange}
              onRemove={onRemove}
              onPreview={previewProperty}
              onClearPreview={onClearPreview}
            />
          </div>
        </InspectorPopover>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// GenericSizeRow — aspectRatio / boxSizing via the shared ClassPropertyRow
// ---------------------------------------------------------------------------

interface GenericSizeRowProps {
  activeTab: string
  property: keyof CSSPropertyBag
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
}

function GenericSizeRow({
  activeTab,
  property,
  storedStyles,
  currentStyles,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
}: GenericSizeRowProps) {
  const storedValue = storedStyles[property]
  const currentValue = currentStyles[property]
  // W8-3 — MIXED reaches `ClassPropertyRow` as a value (it renders the word);
  // it must never reach `placeholder`, which would stringify the Symbol.
  const mixed = isMixed(storedValue) || (!hasStyleValue(storedValue) && isMixed(currentValue))
  const isSet = !mixed && hasStyleValue(storedValue)
  const fallbackValue =
    !mixed && hasStyleValue(currentValue) ? currentValue : getCSSPropertyDefaultValue(property)

  return (
    <ClassPropertyRow
      key={`${activeTab}-${String(property)}`}
      property={property}
      value={mixed ? MIXED : isSet ? (storedValue as string | number) : undefined}
      placeholder={!isSet && !mixed ? fallbackValue : undefined}
      isSet={isSet}
      onChange={onChange}
      onRemove={onRemove}
      onPreview={onPreview}
      onClearPreview={onClearPreview}
    />
  )
}
