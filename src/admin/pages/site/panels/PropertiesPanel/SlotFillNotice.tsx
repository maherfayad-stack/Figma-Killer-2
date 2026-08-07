/**
 * SlotFillNotice — states that the SELECTED node is itself the content
 * filling another component's slot (`header={<Icon/>}`'s `<Icon/>`, or a
 * child inside an E2.3 fragment slot), with a one-click way back to the
 * component instance that owns it.
 *
 * A slot fill is an ordinary, individually-editable node once selected (its
 * own Properties-panel view renders exactly like any other node of its
 * `moduleId`) — nothing about ITS controls is different. What is invisible
 * without this notice is WHERE it sits: nothing on the canvas marks "this is
 * the `header` slot of that Card below" the way `SharedComponentNotice`
 * already marks "this came from a shared component file". Uses `slotOwners`'
 * reverse index (`lookupSlotOwner`) — an O(1) lookup after the first ask per
 * site version, not a fresh scan per selection.
 */
import { useEditorStore } from '@site/store/store'
import { lookupSlotOwner } from './slotOwners'
import { Button } from '@ui/components/Button'
import { BoxStackSolidIcon } from 'pixel-art-icons/icons/box-stack-solid'
import styles from './SlotFillNotice.module.css'

interface SlotFillNoticeProps {
  nodeId: string
}

export function SlotFillNotice({ nodeId }: SlotFillNoticeProps) {
  const owner = useEditorStore((s) => lookupSlotOwner(s.site, nodeId))
  const selectNode = useEditorStore((s) => s.selectNode)

  if (!owner) return null

  return (
    <div className={styles.notice} role="note" data-testid="slot-fill-notice">
      <BoxStackSolidIcon size={13} className={styles.icon} aria-hidden="true" />
      <p className={styles.text}>
        Fills the <strong>{owner.propKey}</strong> slot of{' '}
        <Button
          variant="ghost"
          size="xs"
          className={styles.jumpButton}
          onClick={() => selectNode(owner.ownerNodeId)}
        >
          the component below
        </Button>
        .
      </p>
    </div>
  )
}
