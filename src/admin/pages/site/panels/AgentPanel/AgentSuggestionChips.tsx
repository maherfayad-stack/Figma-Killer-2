/**
 * AgentSuggestionChips — the empty conversation's starting points (AI-28),
 * built from what is on screen (`suggestionChips`): the selection, the page,
 * the open review comments. A chip sends its prompt as the first message.
 */
import { useAgentStore } from '@admin/ai/useAgentStore'
import { Button } from '@ui/components/Button'
import { suggestionChips, type AgentLiveContext } from './agentContext'
import styles from './AgentPanel.module.css'

export function AgentSuggestionChips({ context, disabled }: { context: AgentLiveContext; disabled: boolean }) {
  const sendAgentMessage = useAgentStore((s) => s.sendAgentMessage)
  const chips = suggestionChips(context)

  return (
    <div className={styles.suggestions} role="group" aria-label="Suggestions" data-testid="agent-suggestions">
      <p className={styles.suggestionsTitle}>Describe what you want, or start from one of these:</p>
      {chips.map((chip) => (
        <Button
          key={chip.id}
          variant="secondary"
          size="sm"
          className={styles.suggestionChip}
          disabled={disabled}
          tooltip={chip.prompt}
          onClick={() => void sendAgentMessage([{ kind: 'text', text: chip.prompt }])}
        >
          {chip.label}
        </Button>
      ))}
    </div>
  )
}
