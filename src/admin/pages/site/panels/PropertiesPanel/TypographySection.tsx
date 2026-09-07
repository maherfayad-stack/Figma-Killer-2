/**
 * TypographySection — Figma-style compact editor for the `typography`
 * section (docs/features/inspector-disclosure.md G9 / F23).
 *
 * Target shape (F23's four rows):
 *
 *   [ Inter                        ▾ ]
 *   [ Regular ▾ ]         [ 12 ▾ ]
 *   [ ⇕ Auto ]            [ ⟺ 0% ]
 *   [ ≡ ≡ ≡ ]  [ ⊤ ⊹ ⊥ ]         [⚙]
 *
 * Rows 1–3 (family; weight+size; line-height+letter-spacing) are unchanged
 * from before this pass and still rendered by `StackedPropertyGrid`, so the
 * dispatch / token / preview / font-weight logic for those three is
 * unchanged and shared with every other curated section.
 *
 * Row 4 is bespoke: `textAlign` and vertical-align are two icon-toggle
 * GROUPS sharing one row plus a ⚙ trigger, a shape `StackedPropertyGrid`'s
 * single/full-width-or-paired layout can't express — so this file builds it
 * directly with `SegmentedControl` (the same dispatch `ClassPropertyRow`
 * itself uses for an icon-enum property, just laid out by hand) rather than
 * routing it through `ClassPropertyRow`'s row wrapper, which is sized to be
 * a full-width row on its own.
 *
 * VERTICAL ALIGN HAS NO CSS EQUIVALENT — it isn't a `CSSPropertyBag`
 * property at all. The nearest honest mapping is `alignItems` on the text
 * node's OWN box (`verticalAlignWrite.ts`), which only means something once
 * that box is itself a flex container. When it can't be written honestly for
 * the current selection, the group renders DISABLED with the reason as its
 * tooltip rather than disappearing — docs/features/inspector-disclosure.md §7 /
 * §8.4: the asymmetry with Figma is real, and hiding it would be the lie
 * this repo's second invariant forbids. It reads/writes the exact same
 * `alignItems` property `LayoutSection`'s own alignment control does — see
 * `verticalAlignWrite.ts`'s doc for why that's fine, not a conflict.
 *
 * SEARCH REACHABILITY: `fontStyle` / `textDecoration` / `textTransform` /
 * `whiteSpace` moved off their old resident rows (4/5/7) into the settings
 * popover's Basics tab (F25), but `cssControlTypes.ts`'s curated property
 * list for this section — frozen for this pass, see the work order — still
 * claims them, so a style search can narrow `visibleProperties` down to just
 * one of them. Row 4 — the only way to reach the popover — stays reachable
 * whenever ANY of those, or `textAlign`, survives the filter, not only
 * `textAlign`. `SETTINGS_ONLY_PROPERTIES` is that list; `showSettingsTrigger`
 * below is the gate.
 *
 * `color` and `textShadow` are NOT here. They moved to Fill and Effects
 * respectively (G9's target shape, finished in W8-1) once those two sections
 * existed to receive them — a text node's colour is its fill, and a text
 * shadow is a shadow. `classStyleSections.ts` is where that ownership is
 * declared, and a property may be claimed by exactly one section. This
 * section is now literally F23's four rows.
 */

import { useRef, useState } from 'react'
import type { IconComponent } from 'pixel-art-icons/types'
import type { CSSPropertyBag } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { isMixed, MIXED } from '@ui/components/MixedValue'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { AlignStartVerticalSolidIcon } from 'pixel-art-icons/icons/align-start-vertical-solid'
import { AlignCenterVerticalSolidIcon } from 'pixel-art-icons/icons/align-center-vertical-solid'
import { AlignEndVerticalSolidIcon } from 'pixel-art-icons/icons/align-end-vertical-solid'
import { StackedPropertyGrid, type StackedGridEntry } from './StackedPropertyGrid'
import { getIconEnumOptions } from './cssPropertyIcons'
import { TypographySettings } from './TypographySettings'
import { useFontVariationAxes } from './useFontVariationAxes'
import {
  resolveVerticalAlignAvailability,
  verticalAlignEdgeValue,
  verticalAlignFromAlignItems,
  type VerticalAlign,
} from './verticalAlignWrite'
import type { PropertyProvenance } from './stylePropertyProvenance'
import styles from './TypographySection.module.css'

const TOP_SPEC: ReadonlyArray<StackedGridEntry> = [
  'fontFamily',
  // Weight before size: Figma's order, and the one that reads correctly —
  // the family and its weight are one choice, the size is a separate one.
  ['fontWeight', 'fontSize'],
  ['lineHeight', 'letterSpacing'],
]

/** See this file's "SEARCH REACHABILITY" doc. */
const SETTINGS_ONLY_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = [
  'fontStyle',
  'textDecoration',
  'textTransform',
  'whiteSpace',
]

const VERTICAL_ALIGN_EDGES: ReadonlyArray<{ edge: VerticalAlign; icon: IconComponent; label: string }> = [
  { edge: 'top', icon: AlignStartVerticalSolidIcon, label: 'Align top' },
  { edge: 'middle', icon: AlignCenterVerticalSolidIcon, label: 'Align middle' },
  { edge: 'bottom', icon: AlignEndVerticalSolidIcon, label: 'Align bottom' },
]

interface TypographySectionProps {
  currentStyles: Record<string, unknown>
  storedStyles: Record<string, unknown>
  /** Properties that survived the active style search. */
  visibleProperties: ReadonlyArray<keyof CSSPropertyBag>
  /** Active breakpoint tab id. */
  activeTab: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
  /** Track F1 — see `StackedPropertyGrid`'s doc. */
  provenanceByProperty?: ReadonlyMap<string, PropertyProvenance>
}

export function TypographySection({
  currentStyles,
  storedStyles,
  visibleProperties,
  activeTab,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
  provenanceByProperty,
}: TypographySectionProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsTriggerRef = useRef<HTMLButtonElement>(null)

  const fonts = useEditorStore((state) => state.site?.settings.fonts ?? null)
  const variationAxes = useFontVariationAxes(currentStyles.fontFamily, fonts)

  const visible = new Set(visibleProperties)
  const showTextAlignGroup = visible.has('textAlign')
  const showSettingsTrigger =
    showTextAlignGroup || SETTINGS_ONLY_PROPERTIES.some((prop) => visible.has(prop))

  const textAlignOptions = getIconEnumOptions('textAlign') ?? []
  const storedTextAlign = storedStyles.textAlign
  const verticalAvailability = resolveVerticalAlignAvailability(currentStyles)
  // W8-3 — both alignment groups are driven by a raw cell that can be the
  // multi-selection MIXED sentinel; `SegmentedControl` takes it directly and
  // renders indeterminate rather than pressing one member's value.
  const textAlignMixed = isMixed(storedTextAlign)
  const verticalAlignMixed = isMixed(storedStyles.alignItems)
  const currentVerticalEdge = verticalAlignMixed
    ? undefined
    : verticalAlignFromAlignItems(storedStyles.alignItems)

  const gridProps = {
    currentStyles,
    storedStyles,
    activeTab,
    onChange,
    onRemove,
    onPreview,
    onClearPreview,
    provenanceByProperty,
  }

  return (
    <div className={styles.section}>
      <StackedPropertyGrid spec={TOP_SPEC} visibleProperties={visibleProperties} {...gridProps} />

      {(showTextAlignGroup || showSettingsTrigger) && (
        <div className={styles.alignRow}>
          {showTextAlignGroup && (
            <div className={styles.alignGroups}>
              <SegmentedControl
                aria-label="Text align"
                data-testid="typography-text-align"
                value={
                  textAlignMixed
                    ? MIXED
                    : typeof storedTextAlign === 'string' && storedTextAlign !== ''
                      ? storedTextAlign
                      : undefined
                }
                options={textAlignOptions.map((option) => ({
                  value: option.value,
                  icon: option.icon ? <option.icon size={14} aria-hidden="true" /> : undefined,
                  ariaLabel: `Text align: ${option.tooltip}`,
                  tooltip: option.tooltip,
                }))}
                onChange={(next) => onChange('textAlign', next)}
                onClear={() => onRemove('textAlign')}
              />
              <SegmentedControl
                aria-label="Vertical align"
                data-testid="typography-vertical-align"
                disabled={!verticalAvailability.available}
                value={verticalAlignMixed ? MIXED : currentVerticalEdge}
                options={VERTICAL_ALIGN_EDGES.map(({ edge, icon: EdgeIcon, label }) => ({
                  value: edge,
                  icon: <EdgeIcon size={14} aria-hidden="true" />,
                  ariaLabel: label,
                  tooltip: verticalAvailability.available ? label : verticalAvailability.reason,
                }))}
                onChange={(edge) => onChange('alignItems', verticalAlignEdgeValue(edge))}
                onClear={() => onRemove('alignItems')}
              />
            </div>
          )}
          {showSettingsTrigger && (
            <Button
              ref={settingsTriggerRef}
              variant="ghost"
              size="xs"
              iconOnly
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              aria-label="Typography settings"
              tooltip="Typography settings"
              data-testid="typography-settings-trigger"
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <SlidersHorizontalIcon size={14} aria-hidden="true" />
            </Button>
          )}
        </div>
      )}

      {settingsOpen && (
        <TypographySettings
          id="typography-settings"
          anchorRef={settingsTriggerRef}
          onClose={() => setSettingsOpen(false)}
          storedStyles={storedStyles}
          onChange={onChange}
          onRemove={onRemove}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
          variationAxes={variationAxes}
        />
      )}
    </div>
  )
}
