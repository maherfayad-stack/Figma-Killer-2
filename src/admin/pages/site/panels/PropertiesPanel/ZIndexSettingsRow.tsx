/**
 * ZIndexSettingsRow — z-index moved off the resident rows (Law 2) behind a
 * small sliders-icon trigger. `ContextMenu` stands in for the popover; once
 * `InspectorPopover` (built elsewhere this wave) exists, this trigger should
 * open that instead — same content, real focus trap + Esc/outside dismiss.
 *
 * Extracted out of `PositionSection.tsx` to keep that file under the repo's
 * module-size ceiling (`module-size-budgets.test.ts`) — same ownership,
 * just its own file.
 */
import { useRef, useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { ContextMenu } from '@ui/components/ContextMenu'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { ClassPropertyRow } from './ClassPropertyRow'
import { getCSSPropertyDefaultValue } from './cssControlTypes'
import { hasStyleValue } from './styleValueUtils'
import posStyles from './PositionSection.module.css'

interface ZIndexSettingsRowProps {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
}

export function ZIndexSettingsRow({
  storedStyles,
  currentStyles,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
}: ZIndexSettingsRowProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const zIndexStored = storedStyles.zIndex
  const zIndexIsSet = hasStyleValue(zIndexStored)
  const zIndexCurrent = currentStyles.zIndex
  const zIndexFallback = hasStyleValue(zIndexCurrent) ? zIndexCurrent : getCSSPropertyDefaultValue('zIndex')

  return (
    <div className={posStyles.settingsRow}>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="xs"
        iconOnly
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Position settings"
        tooltip="Z-index"
        data-testid="position-settings-trigger"
        onClick={() => setOpen((o) => !o)}
      >
        <SlidersHorizontalIcon size={14} aria-hidden="true" />
      </Button>
      {zIndexIsSet && (
        <span className={posStyles.settingsBadge}>z {String(zIndexStored)}</span>
      )}
      {open && (
        <ContextMenu
          ariaLabel="Position settings"
          anchorRef={triggerRef}
          triggerRef={triggerRef}
          align="end"
          side="bottom"
          offset={6}
          width={220}
          onClose={() => setOpen(false)}
        >
          <div className={posStyles.settingsMenuTitle}>Z-index</div>
          <ClassPropertyRow
            property="zIndex"
            value={zIndexIsSet ? (zIndexStored as string | number) : undefined}
            placeholder={!zIndexIsSet ? zIndexFallback : undefined}
            isSet={zIndexIsSet}
            onChange={onChange}
            onRemove={onRemove}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        </ContextMenu>
      )}
    </div>
  )
}
