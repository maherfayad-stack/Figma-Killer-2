/**
 * RadiusCluster — the corner-radius row of Penpot's Measures section
 * (`STATE.md` `panel-25`, P3 item 3 — `02-measurements.md`'s own Y-origins:
 * `rotation/radius row y=252 (Δ4)`, the SAME tight group as W/H and X/Y, not
 * bundled with opacity/blend the way the old `AppearanceSection.tsx` grouped
 * them). Docs/features/inspector.md §4 G5, F10-F12.
 *
 * ## The link toggle writes the shorthand (P9)
 *
 * Figma's radius control is one field with a link that splits it into four.
 * So is this one — but the link now decides WHICH DECLARATION is written, not
 * only how many fields are drawn:
 *
 *   - **linked** → `border-radius: 12px`, the four longhands cleared;
 *   - **unlinked** → the four `border-*-radius` longhands, the shorthand
 *     cleared.
 *
 * Never both: a shorthand and a longhand in the same rule resolve by source
 * order, which a property bag does not model, so emitting the pair would make
 * the panel's own read-back a coin flip. Before P9 the linked field wrote
 * four longhands regardless, which turned every hand-written
 * `border-radius: 12px` into four lines the first time anything touched it.
 *
 * Unlinking is a real conversion, and it is done from the parsed shorthand
 * (`borderRadiusShorthand.ts`) rather than from a measurement — CSS's own
 * 1/2/3/4-component expansion is deterministic, so no live frame is needed
 * and no corner is invented. A shorthand that module REFUSES to split (an
 * elliptical `/` form, or one containing a function call) keeps its text in
 * the collapsed field and disables the four corner fields with the reason,
 * rather than offering an edit that would rewrite what the parse did not
 * understand.
 *
 * This section deliberately does NOT do corner-smoothing (⚙). Figma's F11
 * shows one; it is a vector feature with no CSS equivalent, and inventing a
 * control to fill the icon's place would violate the "one honest target"
 * rule. The icon is just absent.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import { ExpandableFieldCluster } from '@ui/components/ExpandableFieldCluster'
import { CornerRadiusIcon } from '@ui/components/InspectorIcons'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { Grid2x22SolidIcon } from 'pixel-art-icons/icons/grid-2x2-2-solid'
import { parseNudgeableValue } from '@site/property-controls/numericNudge'
import { resolveStyleFieldDisplay } from '../../panels/PropertiesPanel/styleFieldDisplay'
import { isMixed, MIXED, type Mixed } from '@ui/components/MixedValue'
import { pickMixedString, plainString, readString } from '../../panels/PropertiesPanel/styleValueUtils'
import { ScrubInput } from '@ui/components/ScrubInput'
import {
  RADIUS_CORNERS,
  parseRadiusShorthand,
  radiusLonghand,
  type RadiusCorner,
  type RadiusCornerValues,
} from './borderRadiusShorthand'
import styles from './RadiusCluster.module.css'

// ---------------------------------------------------------------------------
// Corner radius — shared read helpers
// ---------------------------------------------------------------------------

/**
 * What each corner is DECLARED as in this bag: its own longhand when there is
 * one, else the component the `border-radius` shorthand gives it. A refused
 * shorthand contributes nothing — the corners then read as unset, which is
 * exactly what the disabled per-corner fields say.
 */
function readCorners(
  bag: Record<string, unknown>,
  shorthandCorners: RadiusCornerValues | null,
): {
  perCorner: Record<RadiusCorner, string | Mixed>
  uniform: boolean
  anySet: boolean
} {
  // `pickMixedString` keeps the W8-3 MIXED sentinel intact — a corner the
  // selection disagrees on is SET (it counts for `anySet`) and equal to its
  // fellow mixed corners (so a uniformly-mixed radius stays linked).
  const perCorner = {} as Record<RadiusCorner, string | Mixed>
  for (const corner of RADIUS_CORNERS) {
    const longhand = pickMixedString(bag[radiusLonghand(corner)])
    perCorner[corner] = longhand !== '' ? longhand : (shorthandCorners?.[corner] ?? '')
  }
  const values = RADIUS_CORNERS.map((c) => perCorner[c])
  const anySet = values.some((v) => v !== '')
  const uniform = anySet && values.every((v) => v === values[0])
  return { perCorner, uniform, anySet }
}

function cornerLabel(corner: RadiusCorner): string {
  return corner.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
}

// ---------------------------------------------------------------------------
// RadiusCluster
// ---------------------------------------------------------------------------

interface RadiusClusterProps {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  /** Patch-shaped commit — linking and unlinking each move the radius between declarations in ONE history entry. */
  onChangeMany: (patch: Record<string, string | number | null>) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

export function RadiusCluster({
  storedStyles,
  currentStyles,
  onChange,
  onChangeMany,
  onPreview,
  onClearPreview,
}: RadiusClusterProps) {
  const storedShorthand = readString(storedStyles, 'borderRadius')
  const shorthand = storedShorthand ? parseRadiusShorthand(storedShorthand) : null
  const shorthandRefusal = shorthand && !shorthand.ok ? shorthand.reason : undefined
  const shorthandCorners = shorthand?.ok ? shorthand.corners : null

  const radiusState = readCorners(storedStyles, shorthandCorners)
  const radiusFallback = readCorners(currentStyles, parseCurrentShorthand(currentStyles))
  // Law 4: linked purely from the data — every corner equal (or nothing set,
  // which is trivially uniform). The cluster itself keeps no copy of this.
  const radiusLinked = radiusState.uniform || !radiusState.anySet

  /** Linked: ONE `border-radius`, and the longhands it replaces cleared. */
  const writeLinked = (value: string | undefined) => {
    const patch: Record<string, string | null> = { borderRadius: value || null }
    for (const corner of RADIUS_CORNERS) patch[String(radiusLonghand(corner))] = null
    onChangeMany(patch)
  }

  /**
   * Unlinked: this corner's longhand. When a shorthand is what currently
   * declares the radius, the same patch materialises the other three corners
   * from it and drops the shorthand — otherwise the shorthand would keep
   * painting them and the panel would show four fields editing one value.
   */
  const writeCorner = (corner: RadiusCorner, value: string | undefined) => {
    if (!shorthandCorners) {
      onChange(radiusLonghand(corner), value || undefined)
      return
    }
    const patch: Record<string, string | null> = { borderRadius: null }
    for (const each of RADIUS_CORNERS) {
      const next = each === corner ? value || '' : (plainString(radiusState.perCorner[each]) ?? '')
      patch[String(radiusLonghand(each))] = next || null
    }
    onChangeMany(patch)
  }

  const previewProperty = onPreview
    ? (property: keyof CSSPropertyBag, value: string | number | undefined) =>
        onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)
    : undefined

  /** The linked field previews the ONE shorthand it is about to commit. */
  const previewLinked = (value: string) => {
    if (!onPreview) return
    onPreview({ borderRadius: value || null } as Partial<CSSPropertyBag>)
  }

  // A corner shows its own declared value (MIXED included); when nothing is
  // declared it falls back to the effective one, and a MIXED fallback becomes
  // the field's own mixed state rather than a Symbol in the placeholder.
  const cornerValue = (corner: RadiusCorner): string | Mixed => {
    const stored = radiusState.perCorner[corner]
    if (stored !== '') return stored
    return isMixed(radiusFallback.perCorner[corner]) ? MIXED : ''
  }
  const cornerPlaceholder = (corner: RadiusCorner): string => plainString(radiusFallback.perCorner[corner]) || '0px'

  // The collapsed field edits ONE declaration, so it shows one: the stored
  // shorthand verbatim when there is one (including a refused one — its text
  // is still the honest value), else the uniform corner.
  const collapsedStored: string | Mixed = storedShorthand ?? cornerValue('TopLeft')
  const collapsedPlaceholder = cornerPlaceholder('TopLeft')
  const collapsedDisplay = radiusDisplay(collapsedStored, collapsedPlaceholder)

  /*
   * All five radius fields are `ScrubInput`s: the corner glyph they already
   * carried is now the drag handle, and commit runs through
   * `resolveCommitValue`, so a typed `12` becomes `12px` instead of the
   * invalid declaration `border-radius: 12`.
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
      data-testid="measures-radius-all"
      onChange={(next) => writeLinked(next || undefined)}
      onPreview={previewProperty ? (next) => previewLinked(next) : undefined}
      onClearPreview={onClearPreview}
    />
  )

  const expandedFields = RADIUS_CORNERS.map((corner) => {
    const placeholder = cornerPlaceholder(corner)
    const display = radiusDisplay(cornerValue(corner), placeholder)
    const field = (
      <ScrubInput
        fieldSize="sm"
        label={<CornerRadiusIcon size={13} aria-hidden="true" />}
        value={display.value}
        placeholder={display.placeholder}
        inherited={display.inherited}
        unit={parseNudgeableValue(placeholder)?.unit ?? 'px'}
        min={0}
        disabled={shorthandRefusal != null}
        aria-label={`Border radius, ${cornerLabel(corner)}`}
        data-testid={`measures-radius-${corner}`}
        onChange={(next) => writeCorner(corner, next || undefined)}
        onPreview={previewProperty ? (next) => previewProperty(radiusLonghand(corner), next || undefined) : undefined}
        onClearPreview={onClearPreview}
      />
    )
    // A disabled field must still say why — the same `title`-wrapper
    // `GapRow` uses for its own inert axis.
    return (
      <div key={corner} className={styles.cornerField} title={shorthandRefusal}>
        {field}
      </div>
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
          collapsedIcon={<LinkIcon size={14} aria-hidden="true" />}
          expandedIcon={<Grid2x22SolidIcon size={14} aria-hidden="true" />}
          expandLabel="Unlink the corners — edit each one"
          collapseLabel="Link the corners — one radius for all four"
        />
      </div>
    </div>
  )
}

/** The effective (rendered) shorthand, used only for placeholders. */
function parseCurrentShorthand(currentStyles: Record<string, unknown>): RadiusCornerValues | null {
  const value = readString(currentStyles, 'borderRadius')
  if (!value) return null
  const parsed = parseRadiusShorthand(value)
  return parsed.ok ? parsed.corners : null
}

/**
 * The `value` / `placeholder` / `inherited` trio for one corner-radius field,
 * from the one display rule (`styleFieldDisplay.ts`): the declared radius,
 * else the radius the element actually renders (muted), else nothing.
 */
function radiusDisplay(
  stored: string | Mixed,
  current: string,
): { value: string | Mixed | undefined; placeholder: string | undefined; inherited: boolean } {
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
