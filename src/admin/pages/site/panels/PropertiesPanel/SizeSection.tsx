/**
 * SizeSection — Figma-style visual editor for the `size` CSS section.
 *
 * Replaces the six stacked full-width rows (width / height / min / max) with
 * three paired-column rows, each field carrying its label inside the leading
 * edge (W · H, Min W · Min H, Max W · Max H) — the compact "W 1440 / H 732"
 * shape from Figma's design panel. `aspectRatio` and `boxSizing` keep their
 * generic ClassPropertyRow treatment below the grid since they don't pair.
 *
 * Cells build on the shared nudge-enabled TokenAwareInput, so arrow-key
 * nudging (±1 / ±8 Shift / ±0.1 Alt, empty starts from 0) works here too.
 * Emptying a field clears the property; the hover-revealed clear button is
 * a discoverable shortcut for the same.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { ClassPropertyRow } from './ClassPropertyRow'
import { ScrubInput } from '@ui/components/ScrubInput'
import { getCSSPropertyDefaultValue } from './cssControlTypes'
import { hasStyleValue } from './styleValueUtils'
import styles from './SizeSection.module.css'

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
  // Per-property adapter over the patch-shaped preview channel, used by the
  // dimension cells and the aspect-ratio / box-sizing rows below.
  const previewProperty = onPreview
    ? (property: keyof CSSPropertyBag, value: string | number | undefined) =>
        onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)
    : undefined

  return (
    <>
      <div className={styles.sizeGrid}>
        <DimensionCell
          property="width"
          label="W"
          ariaLabel="Width"
          storedValue={storedStyles.width}
          currentValue={currentStyles.width}
          onChange={onChange}
          onClear={onClearProperty}
          onPreview={previewProperty}
          onClearPreview={onClearPreview}
        />
        <DimensionCell
          property="height"
          label="H"
          ariaLabel="Height"
          storedValue={storedStyles.height}
          currentValue={currentStyles.height}
          onChange={onChange}
          onClear={onClearProperty}
          onPreview={previewProperty}
          onClearPreview={onClearPreview}
        />
        <DimensionCell
          property="minWidth"
          label="Min W"
          ariaLabel="Minimum width"
          storedValue={storedStyles.minWidth}
          currentValue={currentStyles.minWidth}
          onChange={onChange}
          onClear={onClearProperty}
          onPreview={previewProperty}
          onClearPreview={onClearPreview}
        />
        <DimensionCell
          property="minHeight"
          label="Min H"
          ariaLabel="Minimum height"
          storedValue={storedStyles.minHeight}
          currentValue={currentStyles.minHeight}
          onChange={onChange}
          onClear={onClearProperty}
          onPreview={previewProperty}
          onClearPreview={onClearPreview}
        />
        <DimensionCell
          property="maxWidth"
          label="Max W"
          ariaLabel="Maximum width"
          storedValue={storedStyles.maxWidth}
          currentValue={currentStyles.maxWidth}
          onChange={onChange}
          onClear={onClearProperty}
          onPreview={previewProperty}
          onClearPreview={onClearPreview}
        />
        <DimensionCell
          property="maxHeight"
          label="Max H"
          ariaLabel="Maximum height"
          storedValue={storedStyles.maxHeight}
          currentValue={currentStyles.maxHeight}
          onChange={onChange}
          onClear={onClearProperty}
          onPreview={previewProperty}
          onClearPreview={onClearPreview}
        />
      </div>
      {/* aspectRatio (free-form text) and boxSizing (enum) don't pair into the
          W/H columns — keep them as generic labelled rows below the grid. */}
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
    </>
  )
}

// ---------------------------------------------------------------------------
// DimensionCell — in-field-labelled numeric input for one size property
// ---------------------------------------------------------------------------

interface DimensionCellProps {
  property: keyof CSSPropertyBag
  /** In-field leading label (e.g. `W`, `Min H`). */
  label: string
  ariaLabel: string
  storedValue: unknown
  currentValue: unknown
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClear: (property: keyof CSSPropertyBag) => void
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
}

function DimensionCell({
  property,
  label,
  ariaLabel,
  storedValue,
  currentValue,
  onChange,
  onClear,
  onPreview,
  onClearPreview,
}: DimensionCellProps) {
  const isSet = hasStyleValue(storedValue)
  const placeholder = !isSet
    ? hasStyleValue(currentValue)
      ? String(currentValue)
      : String(getCSSPropertyDefaultValue(property))
    : undefined

  return (
    <div
      className={styles.dimCell}
      data-state={isSet ? 'set' : 'unset'}
      data-testid={`css-size-input-${String(property)}`}
    >
      <ScrubInput
        aria-label={ariaLabel}
        label={label}
        value={isSet ? String(storedValue) : undefined}
        placeholder={placeholder}
        onChange={(resolved) => onChange(property, resolved)}
        onPreview={onPreview ? (resolved) => onPreview(property, resolved) : undefined}
        onClearPreview={onClearPreview}
        className={styles.dimInput}
        data-testid={`css-size-scrub-${String(property)}`}
      />
      {isSet && (
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          aria-label={`Clear ${ariaLabel.toLowerCase()}`}
          tooltip={`Clear ${ariaLabel.toLowerCase()}`}
          onClick={() => onClear(property)}
          className={styles.dimClearBtn}
        >
          <CloseIcon size={12} color="currentColor" />
        </Button>
      )}
    </div>
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
  const isSet = hasStyleValue(storedValue)
  const currentValue = currentStyles[property]
  const fallbackValue = hasStyleValue(currentValue)
    ? currentValue
    : getCSSPropertyDefaultValue(property)

  return (
    <ClassPropertyRow
      key={`${activeTab}-${String(property)}`}
      property={property}
      value={isSet ? (storedValue as string | number) : undefined}
      placeholder={!isSet ? fallbackValue : undefined}
      isSet={isSet}
      onChange={onChange}
      onRemove={onRemove}
      onPreview={onPreview}
      onClearPreview={onClearPreview}
    />
  )
}
