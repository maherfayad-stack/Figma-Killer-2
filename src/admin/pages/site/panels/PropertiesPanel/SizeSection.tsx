/**
 * SizeSection — Figma-style visual editor for the `size` CSS section.
 *
 * Six stacked full-width rows became three paired-column rows, each field
 * carrying its own name inside its leading edge instead of in a label column
 * beside it. Width and height keep letterforms — `W` and `H` are unambiguous
 * and Figma keeps them too — but the four constraint fields do not: "Min W"
 * spelled out is five characters of a 24px-tall field that has a number to
 * show, so they carry the converging/diverging arrow marks Figma draws
 * (`MinWidthIcon` and friends). The field's `aria-label` still says
 * "Minimum width", so nothing is lost for anyone who needs the words.
 *
 * `aspectRatio` and `boxSizing` pair into a fourth row rather than owning two
 * full-width captioned rows of their own: the ratio field carries a frame
 * glyph, and `border-box` / `content-box` name themselves, so neither needs a
 * caption above it.
 *
 * Above the numeric cells sits one Fill / Hug / Fixed row per axis. Those are
 * INTENTS, not CSS values: the declaration each one needs depends on what the
 * parent is doing (`elementSizing.ts`), which is why this section reads the
 * PARENT's layout and not the node's own. The numeric cells stay, because a
 * fixed size still has to be typed somewhere and the segmented control is how
 * you say `stop being a fixed size`.
 *
 * Cells build on the shared nudge-enabled ScrubInput, so drag-to-scrub and
 * arrow-key nudging (±1 / ±8 Shift / ±0.1 Alt, empty starts from 0) work
 * here too. Emptying a field clears the property; the hover-revealed clear
 * button is a discoverable shortcut for the same.
 */

import type { ReactNode } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { useFrameParentLayout } from '@site/panels/InspectPanel/useInspectComputedStyle'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { currentSizingMode, sizingPatch, type SizingAxis, type SizingMode } from './elementSizing'
import { Button } from '@ui/components/Button'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import {
  MinWidthIcon,
  MaxWidthIcon,
  MinHeightIcon,
  MaxHeightIcon,
} from '@ui/components/InspectorIcons'
import { ClassPropertyRow } from './ClassPropertyRow'
import { ScrubInput } from '@ui/components/ScrubInput'
import { getCSSPropertyDefaultValue } from './cssControlTypes'
import { hasStyleValue } from './styleValueUtils'
import styles from './SizeSection.module.css'

/** Marks are 13px to match the in-field glyphs the generic rows draw. */
const GLYPH_SIZE = 13

/**
 * Figma's three, in Figma's order and with its words. Spelling them
 * `fit-content` / `flex: 1 1 0%` in the UI would name the MECHANISM, and the
 * mechanism is the part that changes depending on the parent - the intent is
 * the part that does not.
 */
const SIZING_OPTIONS = [
  { value: 'fixed' as const, label: 'Fixed', tooltip: 'Keep this exact size' },
  { value: 'hug' as const, label: 'Hug', tooltip: 'Shrink to fit the content' },
  { value: 'fill' as const, label: 'Fill', tooltip: 'Grow to fill the container' },
]

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

  // The PARENT decides what Fill and Hug mean. `null` (a global-selector
  // edit, or nothing rendered) degrades to the block-layout answers, which
  // are the correct ones when there is no flex container.
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  const parentLayout = useFrameParentLayout(selectedNodeId, activeBreakpointId)

  const applySizing = (axis: SizingAxis, mode: SizingMode) => {
    // Freeze what the element measures RIGHT NOW when switching to Fixed.
    // Reading `currentStyles` (computed folded under stored) rather than
    // `storedStyles` is what lets an element that never declared a width land
    // on the width it visibly has, instead of collapsing to nothing.
    const measured = currentStyles[axis]
    const fixedValue =
      typeof measured === 'string' && measured !== 'auto' ? measured : undefined
    const patch = sizingPatch(axis, mode, parentLayout, fixedValue)
    for (const [property, value] of Object.entries(patch)) {
      const key = property as keyof CSSPropertyBag
      if (value === null) onClearProperty(key)
      else onChange(key, value)
    }
  }

  // `storedStyles`, NOT `currentStyles`: which mode an axis is in is a question
  // about what is DECLARED. `currentStyles` folds computed values underneath,
  // and computed resolves every box to a concrete px — which would make every
  // element on the page read as "Fixed", auto-height ones included.
  const sizingRow = (axis: SizingAxis, ariaLabel: string) => (
    <SegmentedControl
      value={currentSizingMode(axis, storedStyles, parentLayout)}
      options={SIZING_OPTIONS}
      onChange={(mode) => applySizing(axis, mode)}
      aria-label={ariaLabel}
      fullWidth
    />
  )

  const cell = (
    property: keyof CSSPropertyBag,
    label: ReactNode,
    ariaLabel: string,
  ) => (
    <DimensionCell
      property={property}
      label={label}
      ariaLabel={ariaLabel}
      storedValue={storedStyles[property]}
      currentValue={currentStyles[property]}
      onChange={onChange}
      onClear={onClearProperty}
      onPreview={previewProperty}
      onClearPreview={onClearPreview}
    />
  )

  return (
    <>
      {/* Intent first, measurement second - the same reading order Figma
          uses, and the order the controls depend on each other in. */}
      <div className={styles.sizeGrid}>
        {sizingRow('width', 'Width sizing')}
        {sizingRow('height', 'Height sizing')}
      </div>
      <div className={styles.sizeGrid}>
        {cell('width', 'W', 'Width')}
        {cell('height', 'H', 'Height')}
        {cell('minWidth', <MinWidthIcon size={GLYPH_SIZE} aria-hidden="true" />, 'Minimum width')}
        {cell('minHeight', <MinHeightIcon size={GLYPH_SIZE} aria-hidden="true" />, 'Minimum height')}
        {cell('maxWidth', <MaxWidthIcon size={GLYPH_SIZE} aria-hidden="true" />, 'Maximum width')}
        {cell('maxHeight', <MaxHeightIcon size={GLYPH_SIZE} aria-hidden="true" />, 'Maximum height')}
      </div>
      {/* aspectRatio (free-form text, carries a frame glyph) and boxSizing
          (enum whose values name themselves) pair into one uncaptioned row —
          neither earns the full-width labelled row it used to own. */}
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
    </>
  )
}

// ---------------------------------------------------------------------------
// DimensionCell — in-field-marked numeric input for one size property
// ---------------------------------------------------------------------------

interface DimensionCellProps {
  property: keyof CSSPropertyBag
  /** In-field leading mark — a letterform (`W`, `H`) or a glyph. */
  label: ReactNode
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
