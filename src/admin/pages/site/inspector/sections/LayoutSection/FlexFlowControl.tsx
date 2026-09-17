/**
 * FlexFlowControl — the two flow facts Figma's auto-layout header carries
 * beside the direction: **reverse** and **wrap**.
 *
 * ## Why this replaced the 4-segment direction picker (P9)
 *
 * `FlexDirectionControl` offered `row | column | row-reverse |
 * column-reverse`. Its first two segments were a second, competing picker for
 * a choice `LayoutModeRow` above it already makes — "Horizontal stack" writes
 * `flex-direction: row`, "Vertical stack" writes `column` — so the same fact
 * had two controls, drawn with different glyphs, on adjacent rows. Figma has
 * exactly one direction control, and so does this section now: the mode row.
 *
 * What was genuinely only reachable from the old picker is the REVERSE half,
 * and that is what survives here: one toggle that flips the CURRENT axis into
 * (or out of) its reverse. Its glyph follows the axis — reversing a row and
 * reversing a column are different pictures — so the button never shows a
 * horizontal mark for a vertical stack. `WrapToggleButton` folds in beside it
 * as the second toggle of the same cluster, now marked with the layout set's
 * own `WrapIcon` rather than the text-wrapping glyph it borrowed.
 *
 * Nothing became unreachable: `row`/`column` are the mode row and
 * `wrap-reverse` is still the Layout settings ⚙ (`LayoutSettingsButton`).
 *
 * The wrap toggle CLEARS `flex-wrap` when switched off — `nowrap` is the
 * initial value, so clearing and setting it explicitly are the same layout
 * and clearing leaves less in the user's file. The reverse toggle does NOT:
 * clearing `flex-direction: column-reverse` would fall back to `row` and
 * silently turn a column into a row, so switching reverse off writes the
 * plain axis (`column`) instead.
 */
import { Button } from '@ui/components/Button'
import { isMixed, type Mixed } from '@ui/components/MixedValue'
import { FlowRowReverseIcon, FlowColumnReverseIcon, WrapIcon } from '@ui/components/InspectorIcons'
import styles from '../LayoutSection.module.css'

interface FlexFlowControlProps {
  /** `MIXED` when the selection's members disagree — the reverse toggle then has no single axis to flip. */
  flexDirection: string | Mixed | undefined
  flexWrap: string | undefined
  onChangeDirection: (value: string) => void
  onChangeWrap: (value: string) => void
  onClearWrap: () => void
}

export function FlexFlowControl({
  flexDirection,
  flexWrap,
  onChangeDirection,
  onChangeWrap,
  onClearWrap,
}: FlexFlowControlProps) {
  const directionMixed = isMixed(flexDirection)
  const direction = directionMixed ? undefined : (flexDirection ?? 'row')
  const isColumn = direction === 'column' || direction === 'column-reverse'
  const isReversed = direction === 'row-reverse' || direction === 'column-reverse'
  const axisName = isColumn ? 'column' : 'row'

  const isWrapping = flexWrap === 'wrap' || flexWrap === 'wrap-reverse'
  const wrapTooltip =
    flexWrap === 'wrap-reverse'
      ? 'flex-wrap: wrap-reverse — click to clear'
      : isWrapping
        ? 'flex-wrap: wrap — click to clear'
        : 'Wrap'

  return (
    <div className={styles.flowCluster}>
      <Button
        variant="ghost"
        size="xs"
        iconOnly
        pressed={isReversed}
        disabled={directionMixed}
        aria-label="Reverse direction"
        tooltip={
          directionMixed
            ? 'The selection uses more than one flex-direction, so there is no single axis to reverse.'
            : isReversed
              ? `flex-direction: ${axisName}-reverse — click for ${axisName}`
              : `Reverse — flex-direction: ${axisName}-reverse`
        }
        data-testid="css-layout-reverse-toggle"
        onClick={() => onChangeDirection(isReversed ? axisName : `${axisName}-reverse`)}
      >
        {isColumn ? (
          <FlowColumnReverseIcon size={14} aria-hidden="true" />
        ) : (
          <FlowRowReverseIcon size={14} aria-hidden="true" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="xs"
        iconOnly
        pressed={isWrapping}
        aria-label="Flex wrap"
        tooltip={wrapTooltip}
        data-testid="css-layout-wrap-toggle"
        onClick={() => (isWrapping ? onClearWrap() : onChangeWrap('wrap'))}
      >
        <WrapIcon size={14} aria-hidden="true" />
      </Button>
    </div>
  )
}
