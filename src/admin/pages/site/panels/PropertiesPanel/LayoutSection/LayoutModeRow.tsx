/**
 * LayoutModeRow — the four Figma-style layout mode buttons.
 *
 * Fixes the "block chip" defect: `DropdownSwitcher` (still used by
 * `PositionSection`) is a 3-state control — segmented row for its two
 * primary values, full-width CHIP for "any other value". Wired to `display`
 * directly, that meant the single most common element in any project (a
 * plain block) rendered as a grey "Display: block" chip that says nothing
 * about layout, while F3/F4/F6/F7 in Figma show the SAME four mode buttons
 * for every element, always, with only the highlight changing.
 *
 * The root cause: `display` is a CSS *mechanism* (a ten-value keyword) where
 * Figma exposes layout *intent* (four modes). A layout mode is a
 * `(display, flex-direction)` PAIR, not a raw `display` value — exactly the
 * same fix `SizeSection` already made for width/height (Fixed / Hug / Fill
 * instead of raw `fit-content` / `100%`). `resolveLayoutMode` below is that
 * pair → mode classifier; `layoutModePatch` is the mode → CSS writer.
 *
 * `display` values none of the four buttons can represent (`inline-block`,
 * `inline`, `none`, `contents`, `table`, …) are real, load-bearing values —
 * losing one because our UI only has four buttons would be data loss. They
 * render with all four buttons UNSELECTED (never a guess) and stay reachable
 * through the trailing ▾ menu, whose trigger honestly names the current
 * value in its tooltip/aria-label instead of a full-width chip that eats a
 * row. Nothing is ever rewritten automatically on render — a mode only
 * changes display on an explicit click, whether that's a mode button or a
 * menu item.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import { Grid2x22SolidIcon } from 'pixel-art-icons/icons/grid-2x2-2-solid'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { FlowRowIcon, FlowColumnIcon } from '@ui/components/InspectorIcons'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { isMixed, type Mixed } from '@ui/components/MixedValue'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import { getEnumOptions } from '../cssControlTypes'
import type { LayoutMode } from './layoutMode'
import styles from './LayoutModeRow.module.css'

// Pure mode-derivation logic (`resolveLayoutMode`, `layoutModePatch`,
// `isLayoutModeRepresentable`, `DISPLAY_DEPENDENT_PROPS`) lives in
// `./layoutMode`, not here — react-refresh/only-export-components forbids a
// component file from also exporting plain functions/constants (even as a
// re-export). Import from `./layoutMode` directly.

// ---------------------------------------------------------------------------
// The four buttons
// ---------------------------------------------------------------------------

const MODE_OPTIONS: ReadonlyArray<{
  value: LayoutMode
  icon: ReactNode
  ariaLabel: string
  tooltip: string
}> = [
  { value: 'none', icon: <LayoutSolidIcon size={14} />, ariaLabel: 'No auto layout', tooltip: 'No auto layout' },
  {
    value: 'vertical',
    icon: <FlowColumnIcon size={14} />,
    ariaLabel: 'Vertical stack',
    tooltip: 'display: flex · flex-direction: column',
  },
  {
    value: 'horizontal',
    icon: <FlowRowIcon size={14} />,
    ariaLabel: 'Horizontal stack',
    tooltip: 'display: flex · flex-direction: row',
  },
  { value: 'grid', icon: <Grid2x22SolidIcon size={14} />, ariaLabel: 'Grid', tooltip: 'display: grid' },
]

const DISPLAY_OPTIONS = getEnumOptions('display') ?? ['block']

interface LayoutModeRowProps {
  /**
   * Currently highlighted mode, or `undefined` when the current `display`
   * isn't one of the four button-representable values (see
   * `isLayoutModeRepresentable` — the caller applies that gate before
   * passing a mode here, so this component never has to guess).
   */
  mode: LayoutMode | Mixed | undefined
  /** Raw `display` value — used only to name it honestly in the ▾ menu. */
  display: string | undefined
  onSelectMode: (mode: LayoutMode) => void
  /** Fired when the already-active mode segment is clicked again. */
  onClearMode: () => void
  /** Explicit pick of a raw `display` value from the ▾ menu. */
  onSelectDisplayValue: (value: string) => void
  onPreviewDisplayValue?: (value: string) => void
  onClearPreview?: () => void
}

export function LayoutModeRow({
  mode,
  display,
  onSelectMode,
  onClearMode,
  onSelectDisplayValue,
  onPreviewDisplayValue,
  onClearPreview,
}: LayoutModeRowProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const hoverPreviewEnabled = useEditorPreference('hoverPreview')
  const previewActive = hoverPreviewEnabled && onPreviewDisplayValue != null

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

  // The one honest surface for an unrepresentable value: the trigger that
  // reaches every `display` keyword names the actual value instead of the
  // generic "more values" label, so it's discoverable without a resident row.
  const chevronLabel = mode == null && display ? `Display: ${display}` : 'More display values'
  // W8-3 — `data-mode` names the highlighted mode for tests and CSS; a
  // disagreeing selection is neither a mode nor "unset".
  const modeAttr = isMixed(mode) ? 'mixed' : (mode ?? 'unset')

  return (
    <div className={styles.modeRow} data-testid="css-layout-mode-row" data-mode={modeAttr}>
      <SegmentedControl
        fullWidth
        aria-label="Layout mode"
        value={mode}
        onChange={onSelectMode}
        onClear={onClearMode}
        options={MODE_OPTIONS}
        trailing={({ trailingClassName }) => (
          <Button
            ref={triggerRef}
            variant="secondary"
            size="sm"
            iconOnly
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={chevronLabel}
            tooltip={chevronLabel}
            className={trailingClassName}
            onClick={toggleMenu}
          >
            <ChevronDownIcon size={14} color="currentColor" />
          </Button>
        )}
      />
      {menuOpen && (
        <ContextMenu
          anchorRef={triggerRef}
          triggerRef={triggerRef}
          align="end"
          side="bottom"
          offset={6}
          ariaLabel="Display values"
          onClose={closeMenu}
          onMouseLeave={previewActive ? onClearPreview : undefined}
        >
          {DISPLAY_OPTIONS.map((opt) => (
            <ContextMenuItem
              key={opt}
              role="menuitemradio"
              aria-checked={display === opt}
              active={display === opt}
              onMouseEnter={previewActive ? () => onPreviewDisplayValue?.(opt) : undefined}
              onClick={() => {
                onSelectDisplayValue(opt)
                closeMenu()
              }}
            >
              {opt}
            </ContextMenuItem>
          ))}
        </ContextMenu>
      )}
    </div>
  )
}
