/**
 * DropdownSwitcher — shared segmented + dropdown control used by the Layout
 * and Position sections.
 *
 * ONE shape, always: `[ A | B | ▼ ]` (unset — no segment pressed), `[ A | B |
 * ▼ ]` with the matching segment pressed (primary value), or `[ A | B |
 * <value> | ▼ ]` with a synthetic trailing segment carrying the CURRENT value
 * when it's outside the two promoted primaries (e.g. `position: static`).
 * That third case used to swap the whole row for a full-width chip + a
 * separate close button — visually a different control, and on a narrow
 * panel it read as an oversized pill sitting where a compact row belongs.
 * Folding the out-of-band value into the SAME segmented track means the
 * shape never changes shell, only which segment (if any) is pressed — this
 * is what "same treatment" means when a sibling section reaches for this
 * shell for a property whose default value (like `display: block` or
 * `position: static`) never earns a promoted segment.
 *
 * Every segment — primary or synthetic — shares one interaction: hovering the
 * PRESSED segment reveals a close-icon overlay, and clicking it fires
 * `onClear()` (never a silent rewrite — the value stays exactly what it was
 * until the user explicitly clears it or picks a different one from the
 * dropdown). The synthetic segment never invents a label the control can't
 * honestly represent — it just echoes the raw CSS value string, so a value
 * this shell has no promoted button for is still shown verbatim rather than
 * coerced towards one of the primaries.
 *
 * The trailing chevron always opens a ContextMenu listing every value in
 * `allOptions` so power users can reach values not promoted to the primary
 * segments. Identification (test id, data attribute, aria labels) is driven
 * by `property`, so the same shell works for `display`, `position`, and any
 * future CSS property that fits this mold.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import styles from './LayoutSection.module.css'

interface PrimarySegment {
  value: string
  label?: ReactNode
  icon?: ReactNode
  ariaLabel?: string
  tooltip?: ReactNode
}

interface DropdownSwitcherProps {
  /** Lowercase CSS property name. Drives aria labels and the test id. */
  property: string
  /** Current CSS value (undefined renders the unset segmented control). */
  value: string | undefined
  /** Segments promoted to the primary segmented row. */
  primarySegments: ReadonlyArray<PrimarySegment>
  /** Full value list shown in the chevron dropdown. */
  allOptions: ReadonlyArray<string>
  onChange: (value: string) => void
  onClear: () => void
  /**
   * Optional hover-preview hooks. When provided (and the `hoverPreview`
   * editor preference is on), hovering a value in the dropdown transiently
   * applies it via `onPreview`; closing / leaving the menu fires
   * `onClearPreview`. Lets the Layout / Position switchers preview a display
   * or position value on the canvas before the user commits.
   */
  onPreview?: (value: string) => void
  onClearPreview?: () => void
}

export function DropdownSwitcher({
  property,
  value,
  primarySegments,
  allOptions,
  onChange,
  onClear,
  onPreview,
  onClearPreview,
}: DropdownSwitcherProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Hover previews are gated by the shared "Preview suggestions on hover"
  // preference; when off we don't fire preview callbacks at all.
  const hoverPreviewEnabled = useEditorPreference('hoverPreview')
  const previewActive = hoverPreviewEnabled && onPreview != null

  // Defensive: clear any live preview if the preference flips off mid-hover.
  useEffect(() => {
    if (!hoverPreviewEnabled) onClearPreview?.()
  }, [hoverPreviewEnabled, onClearPreview])

  const closeMenu = () => {
    onClearPreview?.()
    setMenuOpen(false)
  }

  const toggleMenu = () => {
    if (menuOpen) closeMenu()
    else setMenuOpen(true)
  }

  const capitalized = capitalize(property)
  const testId = `css-${property}-switcher`
  const dataValueAttr = `data-${property}-value`

  const isPrimary = value != null && primarySegments.some((seg) => seg.value === value)
  const isOtherValue = value != null && value !== '' && !isPrimary

  // The out-of-band value gets its own segment, appended after the
  // primaries, so it renders verbatim (never coerced towards a primary)
  // while keeping the exact same track shell. `ariaLabel` matches the old
  // chip's `"${Property}: ${value}"` accessible name — callers and tests
  // identify this state by that name, not by a class name or DOM shape.
  const segments: ReadonlyArray<PrimarySegment> = isOtherValue
    ? [...primarySegments, { value, label: value, ariaLabel: `${capitalized}: ${value}`, tooltip: `${property}: ${value}` }]
    : primarySegments

  const menu = menuOpen ? (
    <ContextMenu
      anchorRef={triggerRef}
      triggerRef={triggerRef}
      align="end"
      side="bottom"
      offset={6}
      ariaLabel={`${capitalized} values`}
      onClose={closeMenu}
      onMouseLeave={previewActive ? onClearPreview : undefined}
    >
      {allOptions.map((opt) => (
        <ContextMenuItem
          key={opt}
          role="menuitemradio"
          aria-checked={value === opt}
          active={value === opt}
          onMouseEnter={previewActive ? () => onPreview?.(opt) : undefined}
          onClick={() => {
            onChange(opt)
            closeMenu()
          }}
        >
          {opt}
        </ContextMenuItem>
      ))}
    </ContextMenu>
  ) : null

  return (
    <div
      className={styles.displayRow}
      data-testid={testId}
      {...{ [dataValueAttr]: value ?? '' }}
    >
      <SegmentedControl
        fullWidth
        aria-label={capitalized}
        value={isPrimary || isOtherValue ? value : undefined}
        onChange={onChange}
        onClear={onClear}
        options={segments.map((seg) => ({
          value: seg.value,
          label: seg.label,
          icon: seg.icon,
          ariaLabel: seg.ariaLabel,
          tooltip: seg.tooltip,
        }))}
        trailing={({ trailingClassName }) => (
          <Button
            ref={triggerRef}
            variant="secondary"
            size="sm"
            iconOnly
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`More ${property} values`}
            tooltip={`More ${property} values`}
            className={trailingClassName}
            onClick={toggleMenu}
          >
            <ChevronDownIcon size={14} color="currentColor" />
          </Button>
        )}
      />
      {menu}
    </div>
  )
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
