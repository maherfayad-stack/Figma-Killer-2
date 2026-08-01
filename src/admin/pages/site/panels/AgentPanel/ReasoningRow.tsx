/**
 * ReasoningRow — a collapsed disclosure for extended-thinking content
 * (WS-12 §5.4). Same visual family as `ToolCallRow`'s compact row, but the
 * body is hidden behind a native `<details>` toggle rather than always
 * rendered inline — thinking traces run long and are secondary to the
 * assistant's actual reply.
 *
 * Currently only ever populated by the `claudeCli` driver, and only if the
 * CLI's stream actually carries the documented Anthropic `thinking_delta`
 * shape this driver watches for (unverified — see
 * `server/ai/drivers/claudeCliEvents.ts`). A conversation that never
 * receives a `reasoning` event never renders this component at all.
 */
import { SparklesSolidIcon } from 'pixel-art-icons/icons/sparkles-solid'
import styles from './AgentPanel.module.css'

export function ReasoningRow({ text }: { text: string }) {
  if (!text.trim()) return null
  return (
    <details className={styles.reasoningRow}>
      <summary className={styles.reasoningSummary}>
        <span className={styles.toolCallIcon} aria-hidden="true">
          <SparklesSolidIcon size={15} />
        </span>
        <span className={styles.toolCallTitle}>Reasoning</span>
      </summary>
      <p className={styles.reasoningText}>{text}</p>
    </details>
  )
}
