/**
 * AlignBar — Figma's align/distribute action row.
 *
 * Purely presentational + callback-driven: it doesn't know whether "align"
 * means board frames, a multi-node selection, or anything else — the
 * caller supplies the geometry logic and this renders the 6 align + 2
 * distribute (+ optional tidy) icon buttons with the right disabled states
 * for the current selection count.
 *
 * `FrameBulkInspector` (WS-7.2, `board-01`) hand-rolled an equivalent icon
 * row for its own frame-align actions before this primitive existed; this
 * component is the shared, reusable version — see `AlignBar.test.tsx` and
 * `FrameBulkInspector`'s usage for the real integration.
 */
import { Button } from '@ui/components/Button'
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
  /** Omit to hide the distribute row entirely (e.g. a single-node inspector with no distribute concept). */
  onDistribute?: (axis: DistributeAxis) => void
  /** Omit to hide the tidy button. */
  onTidy?: () => void
  /** Minimum selection size to enable align actions. Default 2. */
  minAlign?: number
  /** Minimum selection size to enable distribute actions. Default 3. */
  minDistribute?: number
  disabled?: boolean
  className?: string
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
}: AlignBarProps) {
  const alignDisabled = disabled || count < minAlign
  const distributeDisabled = disabled || count < minDistribute

  return (
    <div className={className}>
      <div className={styles.row} role="group" aria-label="Align selection">
        {ALIGN_BUTTONS.map(({ edge, label, icon: EdgeIcon }) => (
          <Button
            key={edge}
            variant="ghost"
            size="sm"
            iconOnly
            disabled={alignDisabled}
            onClick={() => onAlign(edge)}
            aria-label={label}
            tooltip={label}
            data-testid={`align-bar-${edge}`}
          >
            <EdgeIcon size={14} aria-hidden="true" />
          </Button>
        ))}
      </div>
      {(onDistribute || onTidy) && (
        <div className={styles.row} role="group" aria-label="Distribute selection">
          {onDistribute && (
            <>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                disabled={distributeDisabled}
                onClick={() => onDistribute('horizontal')}
                aria-label="Distribute horizontally"
                tooltip="Distribute horizontally"
                data-testid="align-bar-distribute-horizontal"
              >
                <AlignHorizontalSpaceBetweenSolidIcon size={14} aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                disabled={distributeDisabled}
                onClick={() => onDistribute('vertical')}
                aria-label="Distribute vertically"
                tooltip="Distribute vertically"
                data-testid="align-bar-distribute-vertical"
              >
                <AlignVerticalSpaceBetweenSolidIcon size={14} aria-hidden="true" />
              </Button>
            </>
          )}
          {onTidy && (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              disabled={disabled}
              onClick={onTidy}
              aria-label="Tidy into a grid"
              tooltip="Tidy into a grid"
              data-testid="align-bar-tidy"
            >
              <Grid2x22SolidIcon size={14} aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
