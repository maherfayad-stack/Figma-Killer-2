/**
 * SlotControl — the WS-6.5 affordance for a `node`-kind prop (WS-3.4's
 * captured slot children, e.g. `<Cell icon={<Icon/>}/>`).
 *
 * A `node`-kind prop's value on the wire is a `studio-slot:<nodeId>`
 * sentinel (`studioSlotNodeId`, `@core/utils/studioSlotSentinel`) — it names
 * a REAL node materialized elsewhere in the flat page tree (see that
 * module's doc), not a scalar this control could ever show or edit
 * directly. Before this control existed, `controlForKind` returned
 * `undefined` for `node` kind and the prop got no row at all — a real user
 * couldn't tell the component even HAD an icon/header slot, let alone reach
 * it. This renders "Edit contents" instead: clicking it selects the slot's
 * own node, which is an ordinary, editable node in the tree the moment
 * you're on it (own `data-node-id`, own Properties panel surface) — same
 * "materialized but not tree-visible" shape `base.slot-instance` content
 * already has (see `pkg-02`'s STATE.md entry, honest gap #3).
 */
import type { ControlProps } from './shared'
import { studioSlotNodeId } from '@core/utils/studioSlotSentinel'
import { useEditorStore } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { ControlRow } from '@ui/components/ControlRow'
import { CursorClickSolidIcon } from 'pixel-art-icons/icons/cursor-click-solid'
import styles from './controls.module.css'

export function SlotControl({ propKey, value, label, isOverride, layout, disabled }: ControlProps<unknown>) {
  const slotNodeId = studioSlotNodeId(value)

  return (
    <ControlRow propKey={propKey} label={label} layout={layout} isOverride={isOverride} disabled={disabled}>
      {slotNodeId ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => useEditorStore.getState().selectNode(slotNodeId)}
          data-testid={`slot-control-${propKey}`}
        >
          <CursorClickSolidIcon size={12} aria-hidden="true" />
          Edit contents
        </Button>
      ) : (
        <span className={styles.codeValue} data-testid={`slot-control-${propKey}-empty`}>
          — <span className={styles.codeValueHint}>no content in this slot</span>
        </span>
      )}
    </ControlRow>
  )
}
