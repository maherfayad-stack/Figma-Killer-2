/**
 * AlignBar — Figma's align/distribute action row.
 *
 * Purely presentational + callback-driven: it doesn't know whether "align"
 * means board frames, a multi-node selection, or a single node against its
 * flex/grid parent — the caller supplies the geometry logic and this renders
 * the 6 align buttons plus a 7th trailing button that opens the rare
 * distribute/tidy actions in an overflow menu (F2 — "Tidy up", "Distribute
 * vertical spacing", "Distribute horizontal spacing" with their shortcuts).
 *
 * `FrameBulkInspector` (WS-7.2, `board-01`) hand-rolled an equivalent icon
 * row for its own frame-align actions before this primitive existed; this
 * component is the shared, reusable version — see `AlignBar.test.tsx` and
 * `FrameBulkInspector`'s usage for the real integration. `PositionSection`
 * (G10) is the single-node consumer — it also supplies `alignDisabledReasons`
 * so each align button can be disabled independently with an honest reason
 * when no single CSS write exists for that edge, instead of the coarse
 * count-based `disabled`/`minAlign` gate multi-selection callers use.
 */
import { useRef, useState } from 'react'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { ShortcutKeys } from '@ui/components/Kbd'
import { AlignStartHorizontalSolidIcon } from 'pixel-art-icons/icons/align-start-horizontal-solid'
import { AlignCenterHorizontalSolidIcon } from 'pixel-art-icons/icons/align-center-horizontal-solid'
import { AlignEndHorizontalSolidIcon } from 'pixel-art-icons/icons/align-end-horizontal-solid'
import { AlignStartVerticalSolidIcon } from 'pixel-art-icons/icons/align-start-vertical-solid'
import { AlignCenterVerticalSolidIcon } from 'pixel-art-icons/icons/align-center-vertical-solid'
import { AlignEndVerticalSolidIcon } from 'pixel-art-icons/icons/align-end-vertical-solid'
import { AlignHorizontalSpaceBetweenSolidIcon } from 'pixel-art-icons/icons/align-horizontal-space-between-solid'
import { AlignVerticalSpaceBetweenSolidIcon } from 'pixel-art-icons/icons/align-vertical-space-between-solid'
import { Grid2x22SolidIcon } from 'pixel-art-icons/icons/grid-2x2-2-solid'
import styles from './AlignBar.module.css'

export type AlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'
export type DistributeAxis = 'horizontal' | 'vertical'

export interface AlignBarProps {
  /** Number of items in the current selection — drives disabled states. */
  count: number
  onAlign: (edge: AlignEdge) => void
  /** Omit to hide the distribute menu items (e.g. a single-node inspector with no distribute concept). */
  onDistribute?: (axis: DistributeAxis) => void
  /** Omit to hide the tidy menu item. */
  onTidy?: () => void
  /** Minimum selection size to enable align actions. Default 2. */
  minAlign?: number
  /** Minimum selection size to enable distribute actions. Default 3. */
  minDistribute?: number
  disabled?: boolean
  className?: string
  /**
   * Per-edge disabled reason, keyed by `AlignEdge`. When an edge has an
   * entry here it overrides the `count`/`minAlign` gate for THAT button
   * only — disabled, with the reason as its tooltip. Use this for a
   * single-node caller where each edge's CSS write is independently honest
   * or not (see `PositionSection`'s `resolveAlignWrite`); omit entirely to
   * keep the plain count-based gate every multi-selection caller uses.
   */
  alignDisabledReasons?: Partial<Record<AlignEdge, string>>
}

// `icon`, lowercase — a locally-destructured `Icon` (PascalCase, required for
// React to treat it as a component reference) collides with the
// `direct-icon-imports` architecture gate's `<Icon\b` regex, which exists to
// ban the *lazy* `pixel-art-icons/Icon` wrapper. Assigned to a PascalCase
// local right before use instead (same pattern `StyleCategoryRail.tsx`'s
// `ModuleRailButton` already uses for the identical reason).
const ALIGN_BUTTONS: ReadonlyArray<{ edge: AlignEdge; label: string; icon: typeof AlignStartHorizontalSolidIcon }> = [
  { edge: 'left', label: 'Align left', icon: AlignStartHorizontalSolidIcon },
  { edge: 'center', label: 'Align center', icon: AlignCenterHorizontalSolidIcon },
  { edge: 'right', label: 'Align right', icon: AlignEndHorizontalSolidIcon },
  { edge: 'top', label: 'Align top', icon: AlignStartVerticalSolidIcon },
  { edge: 'middle', label: 'Align middle', icon: AlignCenterVerticalSolidIcon },
  { edge: 'bottom', label: 'Align bottom', icon: AlignEndVerticalSolidIcon },
]

export function AlignBar({
  count,
  onAlign,
  onDistribute,
  onTidy,
  minAlign = 2,
  minDistribute = 3,
  disabled = false,
  className,
  alignDisabledReasons,
}: AlignBarProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const moreTriggerRef = useRef<HTMLButtonElement>(null)

  const countBelowMin = disabled || count < minAlign
  const distributeDisabled = disabled || count < minDistribute
  const hasOverflowItems = Boolean(onDistribute || onTidy)

  return (
    <div className={className}>
      <div className={styles.row} role="group" aria-label="Align selection">
        {ALIGN_BUTTONS.map(({ edge, label, icon: EdgeIcon }) => {
          const reason = alignDisabledReasons?.[edge]
          const isDisabled = reason !== undefined ? true : countBelowMin
          return (
            <Button
              key={edge}
              variant="ghost"
              size="sm"
              iconOnly
              disabled={isDisabled}
              onClick={() => onAlign(edge)}
              aria-label={label}
              tooltip={reason ?? label}
              data-testid={`align-bar-${edge}`}
            >
              <EdgeIcon size={14} aria-hidden="true" />
            </Button>
          )
        })}
        {hasOverflowItems && (
          <Button
            ref={moreTriggerRef}
            variant="ghost"
            size="sm"
            iconOnly
            disabled={disabled}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="More alignment actions"
            tooltip="Tidy & distribute"
            data-testid="align-bar-more"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Grid2x22SolidIcon size={14} aria-hidden="true" />
          </Button>
        )}
      </div>
      {menuOpen && hasOverflowItems && (
        <ContextMenu
          ariaLabel="Tidy and distribute"
          anchorRef={moreTriggerRef}
          triggerRef={moreTriggerRef}
          align="end"
          side="bottom"
          offset={6}
          onClose={() => setMenuOpen(false)}
        >
          {onTidy && (
            <ContextMenuItem
              disabled={disabled}
              onClick={() => {
                setMenuOpen(false)
                onTidy()
              }}
              data-testid="align-bar-tidy"
            >
              <span aria-hidden="true"><Grid2x22SolidIcon size={13} /></span>
              <span className={styles.itemLabel}>Tidy up</span>
              <ShortcutKeys label="⇧⌥T" className={styles.itemShortcut} />
            </ContextMenuItem>
          )}
          {onDistribute && (
            <>
              <ContextMenuItem
                disabled={distributeDisabled}
                onClick={() => {
                  setMenuOpen(false)
                  onDistribute('vertical')
                }}
                data-testid="align-bar-distribute-vertical"
              >
                <span aria-hidden="true"><AlignVerticalSpaceBetweenSolidIcon size={13} /></span>
                <span className={styles.itemLabel}>Distribute vertical spacing</span>
                <ShortcutKeys label="⌥⌘V" className={styles.itemShortcut} />
              </ContextMenuItem>
              <ContextMenuItem
                disabled={distributeDisabled}
                onClick={() => {
                  setMenuOpen(false)
                  onDistribute('horizontal')
                }}
                data-testid="align-bar-distribute-horizontal"
              >
                <span aria-hidden="true"><AlignHorizontalSpaceBetweenSolidIcon size={13} /></span>
                <span className={styles.itemLabel}>Distribute horizontal spacing</span>
                <ShortcutKeys label="⌥⌘H" className={styles.itemShortcut} />
              </ContextMenuItem>
            </>
          )}
        </ContextMenu>
      )}
    </div>
  )
}
