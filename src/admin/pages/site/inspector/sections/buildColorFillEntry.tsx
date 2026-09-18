/**
 * buildColorFillEntry — the Text/Solid-fill `PropertyList` row shape, factored
 * out of `FillSection.tsx` (which was pushed to the 700-line
 * `module-size-budgets.test.ts` ceiling by panel-33) into its own plain
 * function. Kept in a file with NO component export — mixing a component
 * export with a plain-function export in one module trips
 * `react-refresh/only-export-components` (`FillSectionActions.tsx`'s own doc
 * comment names the same constraint for `writeBackgroundModel.ts`).
 *
 * `refused` decides the row's own shape: the section's row-activation
 * popover (`ColorWriteRefusalBody`, still owned by `FillSection.tsx`) when
 * `writeTarget.kind === 'none'`, or the row's own inline `ColorFieldRow`
 * otherwise — see `FillSection.tsx`'s "ONE CLICK TO THE REAL PICKER" doc for
 * why. Generic over `TData` rather than importing `FillSection.tsx`'s own
 * private `FillEntryData` type, so this stays a leaf the section owns the
 * shape of, not the other way around.
 */
import type { CSSPropertyBag } from '@core/page-tree'
import type { PropertyListEntry } from '@ui/components/PropertyList'
import { ColorFieldRow, ColorSwatch } from './FillColorField'
import { ColorOpacityField } from './FillSectionParts'
import { SourceConstraintNotice } from '../../panels/PropertiesPanel/SourceConstraintNotice'

export function buildColorFillEntry<TData>(opts: {
  id: string
  label: string
  property: 'color' | 'backgroundColor'
  ariaLabel: string
  swatchLabel: string
  opacityAriaLabel: string
  displayValue: string
  /** The frame's real computed value for `property` — see `ColorValueInput`'s own doc. */
  resolvedColor: string | undefined
  /** `writeTarget.kind === 'none'` — no honest place for a new declaration to land. */
  refused: boolean
  /**
   * The selected layers disagree on this colour (`docs/features/inspector.md`
   * §9.3). The row STAYS — it used to vanish, because `readString` collapses
   * the `MIXED` Symbol to `undefined` — and reads "Mixed". Its `%` opacity
   * cell is dropped: there is no single alpha channel to show, and
   * `ColorOpacityField` has no mixed state of its own.
   */
  mixed: boolean
  stored: boolean
  /** Only meaningful when `!stored` — committing this exact value again writes nothing. */
  mutedValue: string | undefined
  /** panel-32's informational "declared elsewhere" note, pre-rendered as text by the caller. */
  note: string | undefined
  data: TData
  onCommit: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onPreview: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview: () => void
}): PropertyListEntry<TData> {
  const {
    id,
    label,
    property,
    ariaLabel,
    swatchLabel,
    opacityAriaLabel,
    displayValue,
    resolvedColor,
    refused,
    mixed,
    stored,
    mutedValue,
    note,
    data,
    onCommit,
    onPreview,
    onClearPreview,
  } = opts

  return {
    id,
    label,
    leading: refused ? <ColorSwatch color={displayValue} resolvedColor={resolvedColor} /> : undefined,
    summary: refused ? (
      displayValue
    ) : (
      <ColorFieldRow
        property={property}
        ariaLabel={ariaLabel}
        swatchLabel={swatchLabel}
        value={mixed ? '' : displayValue}
        mixed={mixed}
        resolvedValue={mixed ? undefined : resolvedColor}
        skipIfEquals={stored ? undefined : mutedValue}
        notice={note ? <SourceConstraintNotice hasWritableLocation writeTargetNote={note} /> : undefined}
        onCommit={onCommit}
        onPreview={onPreview}
        onClearPreview={onClearPreview}
      />
    ),
    value: mixed ? undefined : (
      <ColorOpacityField value={displayValue} ariaLabel={opacityAriaLabel} onChange={(next) => onCommit(property, next)} />
    ),
    data,
    muted: !stored,
    removable: stored,
  }
}
