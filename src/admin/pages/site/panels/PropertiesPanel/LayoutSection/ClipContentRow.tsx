/**
 * ClipContentRow — `overflow` promoted to a checkbox (F3/F4/F6/F7: "Clip
 * content" is present in every single layout state, flex/grid or not).
 *
 * Renders unconditionally regardless of `display` — Figma shows this row
 * even with no auto-layout, and so must we, since `overflow` (unlike
 * padding's Figma-only Auto-Layout coupling) is meaningful on every CSS box.
 *
 * The checkbox itself is a UI rename only: checking it writes
 * `overflow: hidden`, unchecking clears the property — the CSS property
 * written is still `overflow`. Any OTHER stored value (`scroll`, `auto`, …)
 * reads as unchecked (it isn't `hidden`) but is never silently discarded:
 * its tooltip states the real value, and it round-trips through the
 * asymmetric `overflowX`/`overflowY` popover below (or a future raw editor)
 * rather than this binary control clobbering it on an unrelated click.
 *
 * `overflowX` / `overflowY` — the asymmetric case — sit behind their own
 * small ⚙, deliberately separate from `LayoutSettingsButton`.
 *
 * `extraTrigger` is how `LayoutSection.tsx` mounts the (also resident)
 * `LayoutSettingsButton` on this same row instead of giving it a second row
 * of its own — this is the one row on a plain, non-flex/grid element that is
 * guaranteed to render, so it's where every "must always be reachable"
 * layout control lives.
 */
import { useRef, useState, type ReactNode } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { StackedPropertyGrid } from '../StackedPropertyGrid'
import { hasStyleValue, readString } from '../styleValueUtils'
import styles from '../LayoutSection.module.css'

const OVERFLOW_AXES_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = ['overflowX', 'overflowY']

interface ClipContentRowProps {
  activeTab: string
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
  /** Extra resident trigger(s) rendered on this same row, before the overflow ⚙ — see the file doc. */
  extraTrigger?: ReactNode
}

export function ClipContentRow({
  activeTab,
  storedStyles,
  currentStyles,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
  extraTrigger,
}: ClipContentRowProps) {
  const [axesOpen, setAxesOpen] = useState(false)
  const axesTriggerRef = useRef<HTMLButtonElement>(null)

  const storedOverflow = readString(storedStyles, 'overflow')
  const checked = storedOverflow === 'hidden'
  const isCustomValue = hasStyleValue(storedOverflow) && !checked
  const tooltip = isCustomValue ? `overflow: ${storedOverflow} — click to clip, or clear via the ⚙` : undefined

  const axesSet = OVERFLOW_AXES_PROPERTIES.some((prop) => hasStyleValue(storedStyles[prop]))

  return (
    <div className={styles.clipContentRow}>
      <label className={styles.clipContentLabel}>
        <Checkbox
          checked={checked}
          onCheckedChange={(next) => (next ? onChange('overflow', 'hidden') : onRemove('overflow'))}
          data-testid="css-clip-content-checkbox"
        />
        <span title={tooltip}>Clip content</span>
      </label>
      {extraTrigger}
      <Button
        ref={axesTriggerRef}
        variant="ghost"
        size="xs"
        iconOnly
        pressed={axesSet}
        aria-haspopup="dialog"
        aria-expanded={axesOpen}
        aria-label="Overflow settings"
        tooltip="Overflow X / Y"
        data-testid="css-overflow-axes-trigger"
        onClick={() => setAxesOpen((open) => !open)}
      >
        <SlidersHorizontalIcon size={14} aria-hidden="true" />
      </Button>
      {axesOpen && (
        <InspectorPopover
          id="layout-overflow-axes"
          anchorRef={axesTriggerRef}
          onClose={() => setAxesOpen(false)}
          title="Overflow"
          width={220}
        >
          <StackedPropertyGrid
            spec={[['overflowX', 'overflowY']]}
            visibleProperties={OVERFLOW_AXES_PROPERTIES}
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
    </div>
  )
}
