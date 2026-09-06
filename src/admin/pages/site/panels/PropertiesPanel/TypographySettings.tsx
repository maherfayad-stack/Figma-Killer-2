/**
 * TypographySettings — the Typography section's ⚙ popover
 * (docs/features/inspector-disclosure.md G9, F25–F27).
 *
 * A tabbed `InspectorPopover` that absorbs every typography control used in
 * under ~10% of edits (Law 2), so the resident section stays F23's four
 * rows:
 *
 *   - **Basics** (F25) — `fontStyle`, `textDecoration`, `textTransform`,
 *     `whiteSpace`, plus `textOverflow` / `textIndent` / `marginBlock`
 *     (paragraph spacing), none of which had a curated control before this
 *     tab existed. `fontStyle`/`textDecoration`/`textTransform`/`whiteSpace`
 *     moved off the section's old resident rows 4/5/7 — see
 *     `TypographySection`'s own doc for how a style search still reaches
 *     them here.
 *   - **Details** (F26) — `fontVariantNumeric`, `fontFeatureSettings`,
 *     `hangingPunctuation`, `fontKerning`. Not curated anywhere today (they
 *     fall into `CustomPropertiesSection`'s generic key/value editor) —
 *     curating them here is a net-new capability, not a relocation.
 *   - **Variable** (F27) — one row per axis the resolved font's `fvar` table
 *     actually declares (`useFontVariationAxes`), writing the
 *     `font-variation-settings` shorthand. Omitted by the caller entirely
 *     when the font exposes none — see `TypographySection`.
 *
 * `textOverflow` / `textIndent` / `marginBlock` / `fontVariantNumeric` /
 * `fontFeatureSettings` / `hangingPunctuation` / `fontKerning` /
 * `fontVariationSettings` are declared members of `CSSPropertyBag` and are
 * listed in the typography section's `properties`. They are NOT threaded
 * through a `keyof` cast: `keyof CSSPropertyBag` is how the entire style
 * pipeline is typed, so a property that only reaches disk by defeating that
 * type is also invisible to the section's search and its "N set" count. If a
 * future control needs a property this bag does not model, add it to the bag.
 */
import type { RefObject } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import type { FontVariationAxis } from '@core/fonts'
import { InspectorPopover, type InspectorPopoverTab } from '@ui/components/InspectorPopover'
import { ControlRow } from '@ui/components/ControlRow'
import { Input } from '@ui/components/Input'
import { ClassPropertyRow } from './ClassPropertyRow'
import { parseFontVariationSettingsValue, serializeFontVariationSettingsValue } from '@core/fonts'
import { hasStyleValue } from './styleValueUtils'
import styles from './TypographySettings.module.css'

const BASICS_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = [
  'fontStyle',
  'textDecoration',
  'textTransform',
  'whiteSpace',
  'textOverflow',
  'textIndent',
  'marginBlock',
]

const DETAILS_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = [
  'fontVariantNumeric',
  'fontFeatureSettings',
  'hangingPunctuation',
  'fontKerning',
]

interface TypographySettingsProps {
  id: string
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  storedStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
  /** Empty ⇒ the caller omits the "Variable" tab entirely (F27's rule). */
  variationAxes: ReadonlyArray<FontVariationAxis>
}

export function TypographySettings({
  id,
  anchorRef,
  onClose,
  storedStyles,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
  variationAxes,
}: TypographySettingsProps) {
  const previewProperty = onPreview
    ? (property: keyof CSSPropertyBag, value: string | number | undefined) =>
        onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)
    : undefined

  const tabs: InspectorPopoverTab[] = [
    {
      value: 'basics',
      label: 'Basics',
      content: (
        <GenericPropertyList
          properties={BASICS_PROPERTIES}
          storedStyles={storedStyles}
          onChange={onChange}
          onRemove={onRemove}
          onPreview={previewProperty}
          onClearPreview={onClearPreview}
        />
      ),
    },
    {
      value: 'details',
      label: 'Details',
      content: (
        <GenericPropertyList
          properties={DETAILS_PROPERTIES}
          storedStyles={storedStyles}
          onChange={onChange}
          onRemove={onRemove}
          onPreview={previewProperty}
          onClearPreview={onClearPreview}
        />
      ),
    },
  ]

  if (variationAxes.length > 0) {
    tabs.push({
      value: 'variable',
      label: 'Variable',
      content: (
        <VariableAxesTab
          axes={variationAxes}
          storedValue={storedStyles.fontVariationSettings}
          onChange={onChange}
        />
      ),
    })
  }

  return (
    <InspectorPopover
      id={id}
      anchorRef={anchorRef}
      onClose={onClose}
      title="Typography settings"
      tabs={tabs}
      defaultTab="basics"
    />
  )
}

// ---------------------------------------------------------------------------
// GenericPropertyList — Basics / Details tab bodies. Every row goes through
// `ClassPropertyRow` in `inline` layout (label left, control right) — the
// popover is a settings LIST (F25/F26), not the compact captionless grid the
// resident section uses.
// ---------------------------------------------------------------------------

interface GenericPropertyListProps {
  properties: ReadonlyArray<keyof CSSPropertyBag>
  storedStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
}

function GenericPropertyList({
  properties,
  storedStyles,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
}: GenericPropertyListProps) {
  return (
    <div className={styles.tabBody}>
      {properties.map((property) => {
        const storedValue = storedStyles[property]
        const isSet = hasStyleValue(storedValue)
        return (
          <ClassPropertyRow
            key={String(property)}
            property={property}
            value={isSet ? (storedValue as string | number) : undefined}
            isSet={isSet}
            layout="inline"
            onChange={onChange}
            onRemove={onRemove}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// VariableAxesTab — F27: one bounded numeric field per axis the font's own
// `fvar` table declares, writing the `font-variation-settings` shorthand.
// A dedicated slider primitive doesn't exist in `src/ui/components/` and
// this pass doesn't add one — a `min`/`max`-bounded numeric `Input` is the
// same honest, bounded edit without inventing a new shared primitive.
// ---------------------------------------------------------------------------

interface VariableAxesTabProps {
  axes: ReadonlyArray<FontVariationAxis>
  storedValue: unknown
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
}

function VariableAxesTab({ axes, storedValue, onChange }: VariableAxesTabProps) {
  const currentValues = parseFontVariationSettingsValue(storedValue)

  function handleAxisChange(tag: string, next: number) {
    const merged = { ...currentValues, [tag]: next }
    const serialized = serializeFontVariationSettingsValue(merged, axes)
    onChange('fontVariationSettings', serialized)
  }

  return (
    <div className={styles.tabBody}>
      {axes.map((axis) => {
        const value = currentValues[axis.tag] ?? axis.default
        return (
          <ControlRow key={axis.tag} propKey={`axis-${axis.tag}`} label={axis.name} layout="inline">
            <Input
              type="number"
              fieldSize="sm"
              min={axis.min}
              max={axis.max}
              step={1}
              value={value}
              aria-label={`${axis.name} (${axis.tag})`}
              onChange={(event) => {
                const parsed = Number(event.target.value)
                if (Number.isFinite(parsed)) handleAxisChange(axis.tag, parsed)
              }}
            />
          </ControlRow>
        )
      })}
    </div>
  )
}
