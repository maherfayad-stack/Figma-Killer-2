/**
 * The Allow / Deny card for a tool call the agent needs approval for.
 *
 * The `claude` CLI runs headless here, so it has no terminal to prompt in. It
 * asks Studio instead (`server/ai/mcp/permissionGate.ts`), and the question
 * lands in the chat as this card. The CLI is genuinely blocked while it shows —
 * nothing else in the turn proceeds until one of these buttons is clicked, or
 * the turn is stopped, which counts as a denial.
 */
import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import { Button } from '@ui/components/Button'
import type { AgentPermissionRequest } from '@site/agent/permissionPrompt'
import styles from './AgentPermissionCard.module.css'

interface AgentPermissionCardProps {
  request: AgentPermissionRequest
  onDecide: (id: string, behavior: 'allow' | 'deny') => void
}

export function AgentPermissionCard({ request, onDecide }: AgentPermissionCardProps) {
  return (
    // `alertdialog`: it interrupts the turn and needs an answer, which is
    // exactly what the role means — and unlike `alert` it tells a screen reader
    // that the controls inside are the response.
    <div className={styles.card} role="alertdialog" aria-labelledby={`perm-title-${request.id}`}>
      <div className={styles.header}>
        <LockSolidIcon className={styles.icon} aria-hidden="true" />
        <span className={styles.title} id={`perm-title-${request.id}`}>
          {request.title}
        </span>
      </div>
      {request.detail && <pre className={styles.detail}>{request.detail}</pre>}
      <div className={styles.actions}>
        <Button
          variant="primary"
          size="sm"
          onClick={() => onDecide(request.id, 'allow')}
          autoFocus
        >
          Allow
        </Button>
        <Button variant="secondary" size="sm" onClick={() => onDecide(request.id, 'deny')}>
          Deny
        </Button>
      </div>
    </div>
  )
}
