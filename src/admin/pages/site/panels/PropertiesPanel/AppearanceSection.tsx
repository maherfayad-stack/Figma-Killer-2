/**
 * AppearanceSection — the corner-radius remainder
 * (docs/features/inspector-disclosure.md §4 G5, F10-F12).
 *
 * Figma's Appearance block used to be one row at rest — opacity beside
 * corner radius, an expand icon for the four corners — plus two icons in
 * its own header: an eye that hides the element without deleting it, and a
 * droplet that opens the blend-mode menu.
 *
 * `STATE.md` `panel-25` (P3 item 1, Layer) moved opacity, `mixBlendMode`,
 * and the CSS `visibility` toggle out to the new `LayerSection` — Penpot's
 * own measured Y-origins (`02-measurements.md`) put radius in the SAME
 * section as W/H/X/Y/rotation (Measures, P3 item 3), NOT bundled with
 * opacity/blend the way this file used to group them. This file is the
 * DELIBERATE, temporary remainder: only the radius `ExpandableFieldCluster`
 * survives here until Measures' own PR claims it and deletes this file
 * outright (Layer's own "Deletes" note — sequence Layer and Measures
 * back-to-back, never leave two components racing to write the same
 * property in between).
 *
 * `AppearanceSectionActions` (the header's eye + droplet) is gone — both
 * moved to `LayerSection` verbatim.
 *
 * This section deliberately does NOT do corner-smoothing (⚙). Figma's F11
 * shows one; it is a vector feature with no CSS equivalent, and inventing a
 * control to fill the icon's place would violate the "one honest target"
 * rule. The icon is just absent.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import { ExpandableFieldCluster } from '@ui/components/ExpandableFieldCluster'
import { CornerRadiusIcon } from '@ui/components/InspectorIcons'
import { parseNudgeableValue } from '@site/property-controls/numericNudge'
import { resolveStyleFieldDisplay } from './styleFieldDisplay'
import { isMixed, MIXED, type Mixed } from '@ui/components/MixedValue'
import { pickMixedString, plainString } from './styleValueUtils'
import { ScrubInput } from '@ui/components/ScrubInput'
import styles from './AppearanceSection.module.css'

// ---------------------------------------------------------------------------
// Corner radius — shared key + read helpers
// ---------------------------------------------------------------------------

const CORNERS = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'] as const
type Corner = (typeof CORNERS)[number]

function radiusKey(corner: Corner): keyof CSSPropertyBag {
  return `border${corner}Radius` as keyof CSSPropertyBag
}

function readCorners(bag: Record<string, unknown>): {
  perCorner: Record<Corner, string | Mixed>
  uniform: boolean
  anySet: boolean
} {
  // `pickMixedString` keeps the W8-3 MIXED sentinel intact — a corner the
  // selection disagrees on is SET (it counts for `anySet`) and equal to its
  // fellow mixed corners (so a uniformly-mixed radius stays linked).
  const perCorner = {} as Record<Corner, string | Mixed>
  for (const corner of CORNERS) perCorner[corner] = pickMixedString(bag[radiusKey(corner)])
  const values = CORNERS.map((c) => perCorner[c])
  const anySet = values.some((v) => v !== '')
  const uniform = anySet && values.every((v) => v === values[0])
  return { perCorner, uniform, anySet }
}

function cornerLabel(corner: Corner): string {
  return corner.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
}

// ---------------------------------------------------------------------------
// AppearanceSection — the body: the radius cluster
// ---------------------------------------------------------------------------

interface AppearanceSectionProps {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

export function AppearanceSection({
  storedStyles,
  currentStyles,
  onChange,
  onPreview,
  onClearPreview,
}: AppearanceSectionProps) {
  const radiusState = readCorners(storedStyles)
  const radiusFallback = readCorners(currentStyles)
  // Law 4: linked purely from the data — every corner equal (or nothing set,
  // which is trivially uniform). The cluster itself keeps no copy of this.
  const radiusLinked = radiusState.uniform || !radiusState.anySet

  const writeAllCorners = (value: string | number | undefined) => {
    for (const corner of CORNERS) onChange(radiusKey(corner), value)
  }

  const previewProperty = onPreview
    ? (property: keyof CSSPropertyBag, value: string | number | undefined) =>
        onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)
    : undefined

  /** The linked field previews all four corners in ONE patch, not four. */
  const writeAllCornerPreviews = (value: string) => {
    if (!onPreview) return
    const patch: Record<string, string | null> = {}
    for (const corner of CORNERS) patch[String(radiusKey(corner))] = value || null
    onPreview(patch as Partial<CSSPropertyBag>)
  }

  // A corner shows its own stored value (MIXED included); when nothing is
  // stored it falls back to the effective one, and a MIXED fallback becomes
  // the field's own mixed state rather than a Symbol in the placeholder.
  const cornerValue = (corner: Corner): string | Mixed => {
    const stored = radiusState.perCorner[corner]
    if (stored !== '') return stored
    return isMixed(radiusFallback.perCorner[corner]) ? MIXED : ''
  }
  const cornerPlaceholder = (corner: Corner): string =>
    plainString(radiusFallback.perCorner[corner]) || '0px'

  const collapsedValue = cornerValue('TopLeft')
  const collapsedPlaceholder = cornerPlaceholder('TopLeft')
  const collapsedDisplay = radiusDisplay(collapsedValue, collapsedPlaceholder)

  /*
   * All five radius fields are `ScrubInput`s: the corner glyph they already
   * carried is now the drag handle, and commit runs through
   * `resolveCommitValue`, so a typed `12` becomes `12px` instead of the
   * invalid declaration `border-radius: 12`. They used to be bare `Input`s
   * with an arrow-key nudge bolted on and a commit on every keystroke —
   * the only fields in the panel with a mark you could not drag.
   *
   * `min: 0` because a negative corner radius is not a CSS value; the drag
   * stops at zero rather than emitting one. The unit comes from the computed
   * placeholder when it carries one, so a `rem`-based stylesheet keeps
   * scrubbing in `rem`.
   */
  const collapsedField = (
    <ScrubInput
      key="radius-all"
      fieldSize="sm"
      label={<CornerRadiusIcon size={13} aria-hidden="true" />}
      value={collapsedDisplay.value}
      placeholder={collapsedDisplay.placeholder}
      inherited={collapsedDisplay.inherited}
      unit={parseNudgeableValue(collapsedPlaceholder)?.unit ?? 'px'}
      min={0}
      aria-label="Corner radius, all corners"
      data-testid="appearance-radius-all"
      onChange={(next) => writeAllCorners(next || undefined)}
      onPreview={previewProperty ? (next) => writeAllCornerPreviews(next) : undefined}
      onClearPreview={onClearPreview}
    />
  )

  const expandedFields = CORNERS.map((corner) => {
    const placeholder = cornerPlaceholder(corner)
    const display = radiusDisplay(cornerValue(corner), placeholder)
    return (
      <ScrubInput
        key={corner}
        fieldSize="sm"
        label={<CornerRadiusIcon size={13} aria-hidden="true" />}
        value={display.value}
        placeholder={display.placeholder}
        inherited={display.inherited}
        unit={parseNudgeableValue(placeholder)?.unit ?? 'px'}
        min={0}
        aria-label={`Border radius, ${cornerLabel(corner)}`}
        data-testid={`appearance-radius-${corner}`}
        onChange={(next) => onChange(radiusKey(corner), next || undefined)}
        onPreview={
          previewProperty ? (next) => previewProperty(radiusKey(corner), next || undefined) : undefined
        }
        onClearPreview={onClearPreview}
      />
    )
  })

  return (
    <div className={styles.row}>
      <div className={styles.radiusCell}>
        <ExpandableFieldCluster
          id="radius"
          collapsed={[collapsedField]}
          expanded={expandedFields}
          linked={radiusLinked}
          expandLabel="Expand to individual corners"
          collapseLabel="Collapse to a single corner radius"
        />
      </div>
    </div>
  )
}

/**
 * The `value` / `placeholder` / `inherited` trio for one corner-radius field,
 * from the one display rule (`styleFieldDisplay.ts`): the declared radius,
 * else the radius the element actually renders (muted), else nothing.
 */
function radiusDisplay(stored: string | Mixed, current: string): { value: string | Mixed | undefined; placeholder: string | undefined; inherited: boolean } {
  const display = resolveStyleFieldDisplay({
    storedValue: isMixed(stored) ? undefined : stored,
    currentValue: current,
  })
  return {
    value: isMixed(stored) ? stored : display.value,
    placeholder: display.placeholder,
    inherited: !isMixed(stored) && display.inherited,
  }
}
