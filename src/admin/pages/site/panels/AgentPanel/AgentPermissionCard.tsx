/**
 * The Allow / Deny card for a tool call the agent needs approval for.
 *
 * The `claude` CLI runs headless here, so it has no terminal to prompt in. It
 * asks Studio instead (`server/ai/mcp/permissionGate.ts`), and the question
 * lands in the chat as this card. The CLI is genuinely blocked while it shows —
 * nothing else in the turn proceeds until one of these buttons is clicked, or
 * the turn is stopped, which counts as a denial.
 *
 * A PLAN (AI-22) — the CLI's `ExitPlanMode` in plan mode, or the HTTP agent's
 * `studio_propose_plan` — renders as an approvable checklist instead: every
 * step ticked means "Approve plan"; unticking steps turns the answer into
 * "Revise without N steps", which sends the agent back to planning with the
 * steps the user removed named.
 */
import { useState } from 'react'
import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import type { AgentPermissionRequest } from '@site/agent/permissionPrompt'
import styles from './AgentPermissionCard.module.css'

interface AgentPermissionCardProps {
  request: AgentPermissionRequest
  onDecide: (id: string, behavior: 'allow' | 'deny', message?: string) => void
}

export function AgentPermissionCard({ request, onDecide }: AgentPermissionCardProps) {
  if (request.plan) return <PlanCard request={request} steps={request.plan} onDecide={onDecide} />
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

function PlanCard({
  request,
  steps,
  onDecide,
}: {
  request: AgentPermissionRequest
  steps: readonly string[]
  onDecide: AgentPermissionCardProps['onDecide']
}) {
  const [kept, setKept] = useState<readonly boolean[]>(() => steps.map(() => true))
  const removed = steps.filter((_, index) => !kept[index])

  function approve(): void {
    if (removed.length === 0) {
      onDecide(request.id, 'allow')
      return
    }
    onDecide(
      request.id,
      'deny',
      `Revise the plan: the user removed ${removed.length === 1 ? 'this step' : 'these steps'} — ${removed.map((step) => `"${step}"`).join('; ')}. Present the revised plan for approval again, without ${removed.length === 1 ? 'it' : 'them'}.`,
    )
  }

  return (
    <div className={styles.card} role="alertdialog" aria-labelledby={`perm-title-${request.id}`} data-testid="agent-plan-card">
      <div className={styles.header}>
        <span className={styles.title} id={`perm-title-${request.id}`}>
          Plan · {steps.length} step{steps.length === 1 ? '' : 's'}
        </span>
      </div>
      {steps.length === 0 ? (
        <p className={styles.planEmpty}>The plan came without steps — ask for them, or approve to let it proceed.</p>
      ) : (
        <ol className={styles.planSteps}>
          {steps.map((step, index) => (
            <li key={index} className={styles.planStep}>
              <Checkbox
                checked={kept[index] ?? true}
                onCheckedChange={(checked) => setKept((current) => current.map((value, i) => (i === index ? checked : value)))}
                aria-label={`Keep step ${index + 1}`}
              />
              <span className={kept[index] ? styles.planStepText : styles.planStepRemoved}>{step}</span>
            </li>
          ))}
        </ol>
      )}
      <div className={styles.actions}>
        <Button variant="primary" size="sm" onClick={approve} autoFocus>
          {removed.length === 0 ? 'Approve plan' : `Revise without ${removed.length}`}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onDecide(request.id, 'deny', 'The user wants to keep planning. Ask what to change, then present the plan again.')}
        >
          Keep planning
        </Button>
      </div>
    </div>
  )
}
