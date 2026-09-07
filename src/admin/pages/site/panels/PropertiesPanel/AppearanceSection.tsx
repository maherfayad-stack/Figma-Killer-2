/**
 * AppearanceSection — the section that didn't exist yet
 * (docs/features/inspector-disclosure.md §4 G5, F10-F12).
 *
 * Figma's Appearance block is one row at rest — opacity beside corner
 * radius, an expand icon for the four corners — plus two icons in its own
 * header: an eye that hides the element without deleting it, and a droplet
 * that opens the blend-mode menu. Before this section existed, `opacity` was
 * one of eight fields in Effects' always-on grid and corner radius lived
 * inside `BorderControl`'s corner-picker diagram; `mixBlendMode` had no
 * curated control at all and fell through to the generic Custom properties
 * editor.
 *
 * Two components are exported:
 *   - `AppearanceSectionActions` — the header's eye + droplet buttons.
 *     `StyleSectionsEditor` renders this in `Section`'s `actions` slot,
 *     alongside (before) the section's `SectionStylesMenu` button.
 *   - `AppearanceSection` — the body: opacity + the radius
 *     `ExpandableFieldCluster`.
 *
 * Both read/write the SAME `storedStyles`/`onChange` the rest of the panel
 * uses — this is not a special editing surface, just a curated arrangement
 * of ordinary CSSPropertyBag properties.
 *
 * Two things this section deliberately does NOT do (plan §7):
 *   - No corner-smoothing (⚙) control. Figma's F11 shows one; it is a vector
 *     feature with no CSS equivalent, and inventing a control to fill the
 *     icon's place would violate the "one honest target" rule. The icon is
 *     just absent.
 *   - The eye writes `visibility: hidden`, which keeps the element's box in
 *     flow (space reserved, contents invisible) — a DIFFERENT thing from the
 *     layer tree's `toggleNodeHidden`, which removes the node from the page
 *     entirely. Both exist; their tooltips say which is which so the two
 *     "hides" are never confused for one feature.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { ScrubInput } from '@ui/components/ScrubInput'
import { ExpandableFieldCluster } from '@ui/components/ExpandableFieldCluster'
import { CornerRadiusIcon } from '@ui/components/InspectorIcons'
import { EyeSolidIcon } from 'pixel-art-icons/icons/eye-solid'
import { EyeOffSolidIcon } from 'pixel-art-icons/icons/eye-off-solid'
import { ColorsSwatchSolidIcon } from 'pixel-art-icons/icons/colors-swatch-solid'
import { useRef, useState } from 'react'
import { ClassPropertyRow } from './ClassPropertyRow'
import { parseNudgeableValue } from '@site/property-controls/numericNudge'
import { resolveStylePlaceholder } from './stylePlaceholder'
import { resolveStyleFieldDisplay } from './styleFieldDisplay'
import { hasStyleValue, pickMixedString, plainString, readString } from './styleValueUtils'
import { isMixed, MIXED, type Mixed } from '@ui/components/MixedValue'
import type { PropertyProvenance } from './stylePropertyProvenance'
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
// mix-blend-mode — F12's grouped droplet menu
// ---------------------------------------------------------------------------

/** Grouped exactly as Figma's F12 blend-mode menu groups them. */
const BLEND_MODE_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ['normal'],
  ['darken', 'multiply', 'color-burn'],
  ['lighten', 'screen', 'color-dodge'],
  ['overlay', 'soft-light', 'hard-light'],
  ['difference', 'exclusion'],
  ['hue', 'saturation', 'color', 'luminosity'],
]

function blendModeLabel(value: string): string {
  return value
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

// ---------------------------------------------------------------------------
// AppearanceSectionActions — the header's eye + droplet
// ---------------------------------------------------------------------------

interface AppearanceSectionActionsProps {
  storedStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
}

export function AppearanceSectionActions({ storedStyles, onChange }: AppearanceSectionActionsProps) {
  const isHidden = readString(storedStyles, 'visibility') === 'hidden'
  const blendValue = readString(storedStyles, 'mixBlendMode')
  const blendActive = blendValue != null && blendValue !== 'normal'

  const [blendMenuOpen, setBlendMenuOpen] = useState(false)
  const blendTriggerRef = useRef<HTMLButtonElement>(null)

  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        iconOnly
        pressed={isHidden}
        aria-label={isHidden ? 'Show element' : 'Hide element (keeps its space)'}
        tooltip={isHidden ? 'Show element' : 'Hide element (keeps its space)'}
        data-testid="appearance-visibility-toggle"
        onClick={() => onChange('visibility', isHidden ? undefined : 'hidden')}
      >
        {isHidden ? (
          <EyeOffSolidIcon size={14} aria-hidden="true" />
        ) : (
          <EyeSolidIcon size={14} aria-hidden="true" />
        )}
      </Button>
      <Button
        ref={blendTriggerRef}
        variant="ghost"
        size="xs"
        iconOnly
        active={blendActive}
        aria-haspopup="menu"
        aria-expanded={blendMenuOpen}
        aria-label={blendValue ? `Blend mode: ${blendModeLabel(blendValue)}` : 'Blend mode'}
        tooltip={blendValue ? `Blend mode: ${blendModeLabel(blendValue)}` : 'Blend mode'}
        data-testid="appearance-blend-mode-trigger"
        onClick={() => setBlendMenuOpen((v) => !v)}
      >
        <ColorsSwatchSolidIcon size={14} aria-hidden="true" />
      </Button>
      {blendMenuOpen && (
        <ContextMenu
          anchorRef={blendTriggerRef}
          triggerRef={blendTriggerRef}
          align="end"
          side="bottom"
          offset={6}
          ariaLabel="Blend mode"
          onClose={() => setBlendMenuOpen(false)}
        >
          {BLEND_MODE_GROUPS.flatMap((group, groupIndex) => [
            groupIndex > 0 && <ContextMenuSeparator key={`sep-${group[0]}`} />,
            ...group.map((mode) => (
              <ContextMenuItem
                key={mode}
                selected={(blendValue ?? 'normal') === mode}
                onClick={() => {
                  onChange('mixBlendMode', mode === 'normal' ? undefined : mode)
                  setBlendMenuOpen(false)
                }}
              >
                {blendModeLabel(mode)}
              </ContextMenuItem>
            )),
          ])}
        </ContextMenu>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// AppearanceSection — the body: opacity + radius
// ---------------------------------------------------------------------------

interface AppearanceSectionProps {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  activeTab: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
  provenanceByProperty?: ReadonlyMap<string, PropertyProvenance>
}

export function AppearanceSection({
  storedStyles,
  currentStyles,
  activeTab,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
  provenanceByProperty,
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

  const opacityMixed = isMixed(storedStyles.opacity)
  const opacityIsSet = !opacityMixed && hasStyleValue(storedStyles.opacity)

  return (
    <div className={styles.row}>
      <div className={styles.opacityCell}>
        <ClassPropertyRow
          key={`${activeTab}-opacity`}
          property="opacity"
          value={
            opacityMixed ? MIXED : opacityIsSet ? (storedStyles.opacity as string | number) : undefined
          }
          placeholder={
            opacityIsSet
              ? undefined
              : resolveStylePlaceholder({
                  property: 'opacity',
                  provenance: provenanceByProperty?.get('opacity'),
                  currentValue: currentStyles.opacity,
                })
          }
          isSet={opacityIsSet}
          layout="stacked"
          onChange={onChange}
          onRemove={onRemove}
          onPreview={previewProperty}
          onClearPreview={onClearPreview}
          provenance={provenanceByProperty?.get('opacity')}
        />
      </div>
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
