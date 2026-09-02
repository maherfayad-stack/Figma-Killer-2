/**
 * ReasoningRow — extended-thinking content (WS-12 §5.4), in the same visual
 * family as `ToolCallRow`'s compact row.
 *
 * Open by default. It shipped collapsed, on the reasoning that thinking traces
 * run long and are secondary to the actual reply — but during a long
 * tool-using turn the reply is the one thing that hasn't arrived yet, so a
 * collapsed row made a working agent look like a hung one. Watching it think
 * IS the content until the answer exists. It stays a `<details>` so anyone
 * re-reading a finished conversation can fold the traces away.
 *
 * Only the `claudeCli` driver populates this, from the CLI's
 * `thinking_delta` stream events — confirmed against a real v2.1.114 turn.
 * A conversation that never receives a `reasoning` event never renders this
 * component at all.
 */
import { SparklesSolidIcon } from 'pixel-art-icons/icons/sparkles-solid'
import styles from './AgentPanel.module.css'

export function ReasoningRow({ text }: { text: string }) {
  if (!text.trim()) return null
  return (
    <details className={styles.reasoningRow} open>
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
