/**
 * LayoutSettingsButton — the layout ⚙ (STUDIO-INSPECTOR-DISCLOSURE-PLAN.md
 * §4 G3, F5/F8's "Layout settings" popover).
 *
 * RESIDENT, regardless of `display` — mounted once by `LayoutSection.tsx`
 * inside the always-present `ClipContentRow` row, never inside the flex/grid
 * block. This is the corrected shape after a review caught the first version
 * anchoring this trigger next to the gap field, which only exists inside the
 * flex/grid block: that made `alignSelf` / `justifySelf` / `flex` /
 * `gridColumn` / `gridRow` unreachable on the single most common node in any
 * real project — a plain `<div>` whose PARENT is a flex/grid container, but
 * whose OWN `display` is not. Those five are item-level properties governed
 * by the PARENT's display, which a class-style editor cannot observe, so the
 * pre-existing fallback grid rendered them unconditionally for exactly that
 * reason (see `LayoutSection.tsx`'s git history / `FALLBACK_PROPS`) — this
 * component restores that guarantee while keeping the popover disclosure.
 *
 * Property buckets:
 *   - ALWAYS shown, any `display`: `alignSelf`, `justifySelf`, `flex`,
 *     `gridColumn`, `gridRow` — item-level, the parent decides whether they
 *     do anything.
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
 * already have working `ClassPropertyRow` treatments (enum dropdowns for the
 * `select`-type ones, token-aware text for the rest); a settings popover
 * doesn't need a second implementation of them, only a new place to live.
 */
import { useRef, useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { StackedPropertyGrid, type StackedGridEntry } from '../StackedPropertyGrid'
import { hasStyleValue } from '../styleValueUtils'

/** Item-level — depend on the PARENT's display, always reachable regardless of this element's own `display`. */
const ALWAYS_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = [
  'alignSelf',
  'justifySelf',
  'flex',
  'gridColumn',
  'gridRow',
]

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

  const spec: StackedGridEntry[] = [
    ['alignSelf', 'justifySelf'],
    'flex',
    ['gridColumn', 'gridRow'],
  ]
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
