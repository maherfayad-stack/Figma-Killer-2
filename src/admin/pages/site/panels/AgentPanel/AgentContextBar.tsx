/**
 * AgentContextBar — the selection chip above the composer (AI-28).
 *
 * Every message already carries the canvas selection to the agent, which the
 * server turns into `file:line`, an excerpt and a box (P4-D). This makes that
 * visible — "Button · Checkout.tsx:42 +2" — and removable: the × keeps THIS
 * selection out of the next message (`dismissAgentSelection`), and selecting
 * anything else brings the chip back.
 */
import { agentSelectionKey } from '@site/agent'
import { useAgentStore } from '@admin/ai/useAgentStore'
import { Button } from '@ui/components/Button'
import { Tooltip } from '@ui/components/Tooltip'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { selectionChip, type AgentLiveContext } from './agentContext'
import styles from './AgentPanel.module.css'

export function AgentContextBar({ context }: { context: AgentLiveContext }) {
  const dismissed = useAgentStore((s) => s.agentSelectionDismissed)
  const dismiss = useAgentStore((s) => s.dismissAgentSelection)
  const chip = selectionChip(context)
  const key = agentSelectionKey(context.selectedNodeIds)
  if (!chip || dismissed === key) return null

  return (
    <div className={styles.contextBar} data-testid="agent-context-bar">
      <Tooltip content={`The assistant will look at: ${chip.title}`}>
        <span className={styles.selectionChip}>
          <span className={styles.selectionChipLabel}>{chip.label}</span>
          {chip.more && <span className={styles.selectionChipMore}>{chip.more}</span>}
          <Button
            variant="ghost"
            size="micro"
            iconOnly
            aria-label="Leave the selection out of the next message"
            onClick={() => dismiss(key)}
          >
            <CloseIcon size={10} />
          </Button>
        </span>
      </Tooltip>
    </div>
  )
}
