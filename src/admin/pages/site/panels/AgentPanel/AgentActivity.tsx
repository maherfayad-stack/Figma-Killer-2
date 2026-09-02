/**
 * AgentActivity — the live "here is what I am doing" strip, shown under the
 * in-flight assistant turn for as long as it is streaming.
 *
 * Replaces a header badge that said "Working…" and nothing more. Two levels,
 * because the two questions are different: the always-visible summary answers
 * "is this alive, and on what?", and expanding answers "what has it actually
 * done so far?". Collapsed by default — the headline is the reassurance, and
 * the step list is for when that is not enough.
 *
 * It renders inside the message thread rather than in the panel chrome, so it
 * sits where the answer will appear and the eye is already pointed.
 *
 * A native details/summary disclosure, like `ReasoningRow` beside it: the
 * expand semantics, keyboard handling, and focus behaviour come for free, and
 * it needs no §8 exception to the Button-primitive gate.
 */
import { useEffect, useState } from 'react'
import type { AgentMessage } from '@site/agent'
import { LoaderIcon } from 'pixel-art-icons/icons/loader'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { CircleAlertSolidIcon } from 'pixel-art-icons/icons/circle-alert-solid'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { cn } from '@ui/cn'
import { summarizeAgentActivity } from './activitySummary'
import styles from './AgentPanel.module.css'

export function AgentActivity({ message }: { message: AgentMessage | null }) {
  const elapsed = useElapsedSeconds(message?.timestamp)
  const { headline, steps, completedCount } = summarizeAgentActivity(message)

  const progress = steps.length > 0
    ? `${completedCount} of ${steps.length} step${steps.length === 1 ? '' : 's'} done`
    : null

  return (
    // `aria-live` on the wrapper, not the summary: the headline rewrites
    // itself every few seconds, and a live region is the one place that is
    // announced without stealing focus or renaming a control mid-interaction.
    <div role="status" aria-live="polite" aria-label={`Working. ${headline}.`}>
      <details className={styles.activity}>
        <summary className={styles.activitySummary}>
          <span className={styles.activitySpinner} aria-hidden="true">
            <LoaderIcon size={12} />
          </span>
          <span className={styles.activityCopy}>
            <span className={styles.activityHeadline}>{headline}</span>
            <span className={styles.activityMeta}>
              {elapsed}
              {progress ? ` · ${progress}` : ''}
            </span>
          </span>
          <span className={styles.activityChevron} aria-hidden="true">
            <ChevronRightIcon size={12} />
          </span>
        </summary>

        {steps.length === 0 ? (
          <p className={styles.activityEmpty}>No tools run yet — it&rsquo;s still thinking.</p>
        ) : (
          <ol className={styles.activitySteps}>
            {steps.map((step) => (
              <li key={step.key} className={styles.activityStep}>
                <span
                  className={cn(
                    styles.activityStepIcon,
                    step.status === 'pending' && styles.activityStepIconPending,
                    step.status === 'error' && styles.activityStepIconError,
                  )}
                  aria-hidden="true"
                >
                  {step.status === 'pending' ? (
                    <LoaderIcon size={10} />
                  ) : step.status === 'error' ? (
                    <CircleAlertSolidIcon size={10} />
                  ) : (
                    <CheckIcon size={10} />
                  )}
                </span>
                <span className={styles.activityStepCopy}>
                  <span className={styles.activityStepTitle}>{step.title}</span>
                  {step.detail && <span className={styles.activityStepDetail}>{step.detail}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </details>
    </div>
  )
}

/**
 * Elapsed time since the turn started, ticking once a second. Its real job is
 * to prove liveness: a number that moves is the difference between "slow" and
 * "frozen", which is the actual anxiety during a long delegated task.
 */
function useElapsedSeconds(startedAt: number | undefined): string {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  if (!startedAt) return '0s'
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}
