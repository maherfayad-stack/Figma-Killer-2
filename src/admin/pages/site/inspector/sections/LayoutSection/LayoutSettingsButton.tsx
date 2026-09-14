/**
 * LayoutSettingsButton — the layout ⚙ (docs/features/inspector-disclosure.md
 * §4 G3, F5/F8's "Layout settings" popover).
 *
 * RESIDENT, regardless of `display` — mounted once by the new Penpot Layout
 * section (`inspector/sections/LayoutSection.tsx`, `STATE.md` `panel-25`,
 * P3 item 4) inside its always-present `ClipContentRow` row, never inside
 * the flex/grid block. `flex` / `gridColumn` / `gridRow` are item-level
 * properties governed by the PARENT's display, which a class-style editor
 * cannot observe, so they must stay reachable regardless of THIS element's
 * own `display` — the same reasoning that originally motivated this
 * component's resident placement.
 *
 * `alignSelf` / `justifySelf` used to live here too, but P3's Align section
 * (`inspector/sections/AlignSection.tsx`, item 2) now owns them exclusively
 * as a dedicated align/distribute row with its own code-lock handling —
 * keeping a second live control for the same two properties here would be
 * exactly the "two components racing to write the same property" hazard
 * `LayerSection.tsx`'s own doc warns about, so they were dropped from this
 * popover in that migration, not merely duplicated.
 *
 * Property buckets:
 *   - ALWAYS shown, any `display`: `flex`, `gridColumn`, `gridRow` —
 *     item-level, the parent decides whether they do anything.
 *   - Shown only when THIS element is a flex container (`display: flex`):
 *     `flexWrap` — reachable nowhere else once `WrapToggleButton` collapses
 *     the resident control to a plain on/off toggle; this is the only way
 *     back to `wrap-reverse`.
 *   - Shown only when THIS element is a flex OR grid container: `rowGap` /
 *     `columnGap` — container-only, matching the CSS reality that gap only
 *     applies to flex/grid containers (same `isContainer` test the removed
 *     `CONTAINER_ONLY_PROPS` set used).
 *
 * Built on `StackedPropertyGrid` (the same Figma-paired-cells renderer the
 * OLD fallback grid used) rather than bespoke controls — these properties
 * already have working `ClassPropertyRow` treatments (an icon toggle group
 * for `flexWrap` — `cssPropertyIcons.ts`'s `ICON_ENUM_OPTIONS`, panel-22 Rule
 * 4 — plain dropdowns for the other `select`-type ones, token-aware text for
 * the rest); a settings popover doesn't need a second implementation of
 * them, only a new place to live.
 */
import { useRef, useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { StackedPropertyGrid, type StackedGridEntry } from '../../../panels/PropertiesPanel/StackedPropertyGrid'
import { hasStyleValue } from '../../../panels/PropertiesPanel/styleValueUtils'

/** Item-level — depend on the PARENT's display, always reachable regardless of this element's own `display`. */
const ALWAYS_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = ['flex', 'gridColumn', 'gridRow']

interface LayoutSettingsButtonProps {
  /** This element's own `display` — used only to decide which CONTAINER-level rows to add; the item-level rows above are unconditional. */
  display: string | undefined
  activeTab: string
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

export function LayoutSettingsButton({
  display,
  activeTab,
  storedStyles,
  currentStyles,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
}: LayoutSettingsButtonProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const isFlexContainer = display === 'flex'
  const isGridContainer = display === 'grid'
  const isContainer = isFlexContainer || isGridContainer

  const properties: Array<keyof CSSPropertyBag> = [...ALWAYS_PROPERTIES]
  if (isContainer) properties.push('rowGap', 'columnGap')
  if (isFlexContainer) properties.push('flexWrap')

  const spec: StackedGridEntry[] = ['flex', ['gridColumn', 'gridRow']]
  if (isContainer) spec.push(['rowGap', 'columnGap'])
  if (isFlexContainer) spec.push('flexWrap')

  const anySet = properties.some((prop) => hasStyleValue(storedStyles[prop]))

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="xs"
        iconOnly
        pressed={anySet}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Layout settings"
        tooltip="Layout settings"
        data-testid="layout-settings-trigger"
        onClick={() => setOpen((o) => !o)}
      >
        <SlidersHorizontalIcon size={14} aria-hidden="true" />
      </Button>
      {open && (
        <InspectorPopover
          id="layout-settings"
          anchorRef={triggerRef}
          onClose={() => setOpen(false)}
          title="Layout settings"
          width={248}
        >
          <StackedPropertyGrid
            spec={spec}
            visibleProperties={properties}
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            activeTab={activeTab}
            onChange={onChange}
            onRemove={onRemove}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        </InspectorPopover>
      )}
    </>
  )
}
