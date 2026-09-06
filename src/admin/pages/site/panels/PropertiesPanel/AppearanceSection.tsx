/**
 * AppearanceSection — the section that didn't exist yet
 * (STUDIO-INSPECTOR-DISCLOSURE-PLAN §4 G5, F10-F12).
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
import { Input } from '@ui/components/Input'
import { ExpandableFieldCluster } from '@ui/components/ExpandableFieldCluster'
import { CornerRadiusIcon } from '@ui/components/InspectorIcons'
import { EyeSolidIcon } from 'pixel-art-icons/icons/eye-solid'
import { EyeOffSolidIcon } from 'pixel-art-icons/icons/eye-off-solid'
import { ColorsSwatchSolidIcon } from 'pixel-art-icons/icons/colors-swatch-solid'
import { useRef, useState } from 'react'
import { ClassPropertyRow } from './ClassPropertyRow'
import { handleNudgeKeydown, parseNudgeableValue } from '@site/property-controls/numericNudge'
import { resolveStylePlaceholder } from './stylePlaceholder'
import { hasStyleValue, readString } from './styleValueUtils'
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

function pickString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return `${value}px`
  return ''
}

function readCorners(bag: Record<string, unknown>): {
  perCorner: Record<Corner, string>
  uniform: boolean
  anySet: boolean
} {
  const perCorner = {} as Record<Corner, string>
  for (const corner of CORNERS) perCorner[corner] = pickString(bag[radiusKey(corner)])
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

  const collapsedValue = radiusState.perCorner.TopLeft
  const collapsedPlaceholder = radiusFallback.perCorner.TopLeft || '0px'

  const collapsedField = (
    <Input
      key="radius-all"
      fieldSize="sm"
      prefix={<CornerRadiusIcon size={13} aria-hidden="true" />}
      value={collapsedValue}
      placeholder={collapsedPlaceholder}
      aria-label="Corner radius, all corners"
      data-testid="appearance-radius-all"
      onChange={(e) => writeAllCorners(e.target.value || undefined)}
      onKeyDown={(e) =>
        handleNudgeKeydown(e, collapsedValue, (next) => writeAllCorners(next), {
          emptyUnit: parseNudgeableValue(collapsedPlaceholder ?? '')?.unit ?? 'px',
        })
      }
    />
  )

  const expandedFields = CORNERS.map((corner) => {
    const value = radiusState.perCorner[corner]
    const placeholder = radiusFallback.perCorner[corner] || '0px'
    return (
      <Input
        key={corner}
        fieldSize="sm"
        prefix={<CornerRadiusIcon size={13} aria-hidden="true" />}
        value={value}
        placeholder={placeholder}
        aria-label={`Border radius, ${cornerLabel(corner)}`}
        data-testid={`appearance-radius-${corner}`}
        onChange={(e) => onChange(radiusKey(corner), e.target.value || undefined)}
        onKeyDown={(e) =>
          handleNudgeKeydown(e, value, (next) => onChange(radiusKey(corner), next), {
            emptyUnit: parseNudgeableValue(placeholder ?? '')?.unit ?? 'px',
          })
        }
      />
    )
  })

  const opacityIsSet = hasStyleValue(storedStyles.opacity)

  return (
    <div className={styles.row}>
      <div className={styles.opacityCell}>
        <ClassPropertyRow
          key={`${activeTab}-opacity`}
          property="opacity"
          value={opacityIsSet ? (storedStyles.opacity as string | number) : undefined}
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
