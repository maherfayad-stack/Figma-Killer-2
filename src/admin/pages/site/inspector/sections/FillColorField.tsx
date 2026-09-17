/**
 * FillColorField — the Text / Solid-fill rows' OWN colour chrome (`STATE.md`
 * panel-33: "why here I need 2 clicks to change a colors"). Split out of
 * `FillSectionParts.tsx` into its own file purely for
 * `module-size-budgets.test.ts` — both `FillSection.tsx` and
 * `FillSectionParts.tsx` were pushed to the 700-line ceiling by this ticket's
 * own growth, and this is a genuinely separate responsibility from either:
 * not "which rows exist" (`FillSection.tsx`) and not "the background-layer /
 * gradient / content-fit popover bodies" (`FillSectionParts.tsx`), but "how a
 * single flat colour value renders and edits, in or out of the row." The
 * pure "what does the note say" string builder lives in its OWN sibling file,
 * `colorWriteTargetNote.ts` — `react-refresh/only-export-components` forbids
 * mixing a plain function export with components in one file, the same
 * reason `writeBackgroundModel.ts` is split from `FillSectionActions.tsx`.
 *
 * Two components, two write-target shapes:
 *
 * - `ColorFieldRow` — `stored`, or muted with a real `writeTarget`: the
 *   row's OWN `ColorValueInput`, guarded with `stopPropagation` so it never
 *   also fires `PropertyList`'s row `onActivate`. Its swatch button opens
 *   `ColorPickerPopover` on the FIRST click — there is no more intermediate
 *   "Text colour"/"Solid fill" hop that existed only to reveal a second
 *   swatch to click.
 * - `ColorWriteRefusalBody` — `writeTarget.kind === 'none'`: no honest place
 *   for a new declaration to land. A disabled swatch cannot open its own
 *   picker to explain why it's disabled, so this ONE case still renders
 *   inside `FillSection.tsx`'s own row-activation `InspectorPopover` — that
 *   path was already a single click before this ticket, never the reported
 *   defect.
 *
 * `ColorSwatch` — the plain, non-interactive swatch glyph `ColorWriteRefusalBody`'s
 * caller uses as the refused row's `leading` (a disabled field has no swatch
 * button of its own to serve that role).
 */
import { type CSSProperties, type ReactNode } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { ColorValueInput } from '@site/property-controls/ColorValueInput'
import { resolveSwatchColor } from '@ui/components/ColorPickerPopover'
import { SourceConstraintNotice } from '../../panels/PropertiesPanel/SourceConstraintNotice'
import styles from './FillSection.module.css'

// ---------------------------------------------------------------------------
// ColorSwatch — the refused row's leading glyph. Paints the RESOLVED colour
// (`resolveSwatchColor`, `STATE.md` panel-33) whenever the authored `color`
// itself doesn't already parse — a `var(--token)` reference has no meaning
// inside the admin's own document, a different DOM tree from the canvas
// iframe the token is actually declared in.
// ---------------------------------------------------------------------------

export function ColorSwatch({ color, resolvedColor }: { color: string; resolvedColor?: string }) {
  return (
    <span
      className={styles.swatch}
      style={{ '--fill-swatch-color': resolveSwatchColor(color, resolvedColor) } as CSSProperties}
      aria-hidden="true"
    />
  )
}

// ---------------------------------------------------------------------------
// ColorFieldRow — see file doc. The prefilled-but-unstored commit guard
// (`prefilledFieldCommitGuard.test.tsx`'s own precedent) lives here now:
// committing the SAME value a muted row was already showing writes nothing.
// `notice` (panel-32's informational "declared elsewhere" fact) is an opaque
// `ReactNode` threaded through `ColorValueInput` into the picker's own
// `notice` slot, so it stays visible once the popover the swatch opens IS
// the real picker, not a stop on the way to it.
// ---------------------------------------------------------------------------

export function ColorFieldRow({
  property,
  ariaLabel,
  swatchLabel,
  value,
  resolvedValue,
  skipIfEquals,
  notice,
  onCommit,
  onPreview,
  onClearPreview,
}: {
  property: 'color' | 'backgroundColor'
  ariaLabel: string
  swatchLabel: string
  /** The value to show and edit — `storedDisplayValue` when stored, `mutedDisplayValue` otherwise. */
  value: string
  /** The frame's real computed value for `property` — see `ColorValueInput`'s own doc for why the swatch needs this. */
  resolvedValue: string | undefined
  /** `mutedDisplayValue`, passed only when `!stored` — committing this exact value again writes nothing. */
  skipIfEquals: string | undefined
  notice?: ReactNode
  onCommit: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onPreview: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview: () => void
}) {
  return (
    <span
      className={styles.colorFieldGuard}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <ColorValueInput
        value={value}
        ariaLabel={ariaLabel}
        swatchLabel={swatchLabel}
        resolvedValue={resolvedValue}
        notice={notice}
        onChange={(next) => {
          if (skipIfEquals !== undefined && next === skipIfEquals) return
          onCommit(property, next || undefined)
        }}
        onPreview={(next) => onPreview(property, next)}
        onClearPreview={onClearPreview}
      />
    </span>
  )
}

// ---------------------------------------------------------------------------
// ColorWriteRefusalBody — see file doc.
// ---------------------------------------------------------------------------

export function ColorWriteRefusalBody({
  ariaLabel,
  swatchLabel,
  value,
  reason,
}: {
  ariaLabel: string
  swatchLabel: string
  value: string | undefined
  reason: string
}) {
  return (
    <div className={styles.popoverBody}>
      <SourceConstraintNotice hasWritableLocation writeTargetReason={reason} />
      <ColorValueInput
        value={value ?? ''}
        ariaLabel={ariaLabel}
        swatchLabel={swatchLabel}
        disabled
        onChange={() => {}}
      />
    </div>
  )
}
