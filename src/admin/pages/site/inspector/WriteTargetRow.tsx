/**
 * WriteTargetRow — the chip row `STUDIO-LIVE-CANVAS-PLAN.md` §P1 asks for:
 * "One row under the layer name shows the element's selectors as chips
 * (`.card` `.primary` `style=`)."
 *
 * This is deliberately INFORMATIONAL, not a mode switch — the old
 * `StyleTargetChip` toggle this replaces (for the single-node surface only;
 * it is still used by the multi-selection composer) picked which of two
 * independent blocks rendered. There is only one block now
 * (`StyleSectionsEditor`, called once — see `StyleSurface.tsx`), and
 * `resolveWriteTarget.ts` decides where each individual commit lands. This
 * row just shows the user what the element carries, and which chip is
 * today's *default* — the one `resolveWriteTarget` reaches for a brand-new
 * property with no existing declaration anywhere.
 *
 * A locked chip (a compiled/unmapped class, or a structurally-locked
 * element) is shown struck-through with its reason as a tooltip rather than
 * omitted — the same "say so, don't hide it" posture as the rest of the
 * panel.
 */
import { Tooltip } from '@ui/components/Tooltip'
import { cn } from '@ui/cn'
import styles from './WriteTargetRow.module.css'

export interface WriteTargetChipInfo {
  key: string
  label: string
  /** `null` when this chip is writable; a reason string when it is locked. */
  lockReason: string | null
}

interface WriteTargetRowProps {
  classChips: ReadonlyArray<WriteTargetChipInfo>
  /** Whether `style=""` is a reachable target at all for this node. */
  inlineReachable: boolean
  inlineLockReason: string | null
  /** The chip `resolveWriteTarget` would reach for on a brand-new property — `null`/`'inline'`. */
  defaultTargetKey: string | null
}

export function WriteTargetRow({
  classChips,
  inlineReachable,
  inlineLockReason,
  defaultTargetKey,
}: WriteTargetRowProps) {
  if (!inlineReachable && classChips.length === 0) return null

  return (
    <div className={styles.row} data-testid="write-target-row">
      <span className={styles.label}>Writes to</span>
      <div className={styles.chips} role="group" aria-label="Style sources on this element">
        {classChips.map((chip) => (
          <Tooltip
            key={chip.key}
            content={chip.lockReason ?? `Declarations already here, or new ones by default, save to ${chip.label}.`}
          >
            <span
              className={cn(
                styles.chip,
                chip.lockReason != null && styles.chipLocked,
                defaultTargetKey === chip.key && styles.chipDefault,
              )}
              data-testid={`write-target-chip-${chip.key}`}
              data-locked={chip.lockReason != null ? 'true' : 'false'}
              data-default={defaultTargetKey === chip.key ? 'true' : 'false'}
            >
              {chip.label}
            </span>
          </Tooltip>
        ))}
        {inlineReachable && (
          <Tooltip
            content={
              inlineLockReason ?? 'A property with no writable class saves here, on this one element.'
            }
          >
            <span
              className={cn(
                styles.chip,
                styles.chipInline,
                inlineLockReason != null && styles.chipLocked,
                defaultTargetKey === 'inline' && styles.chipDefault,
              )}
              data-testid="write-target-chip-inline"
              data-locked={inlineLockReason != null ? 'true' : 'false'}
              data-default={defaultTargetKey === 'inline' ? 'true' : 'false'}
            >
              style=
            </span>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
