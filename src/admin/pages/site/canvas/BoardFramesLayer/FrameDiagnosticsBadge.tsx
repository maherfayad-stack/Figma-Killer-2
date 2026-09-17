/**
 * FrameDiagnosticsBadge — Z5's "a live frame that crashes says so, QUIETLY".
 *
 * A single `--warning` dot on the board frame's own header, present only when
 * that frame's runtime actually reported something, with the last five findings
 * (and their stacks) in a hover/focus popover.
 *
 * ## Why a dot and not a toast
 *
 * A React render loop emits the identical error hundreds of times a second. The
 * toast bus would stack that into a wall of red boxes over the board — the
 * exact "noisy errors" experience Track Z exists to remove — and it would do it
 * for a frame the author may not even be looking at. A dot on the frame that
 * produced it is addressed to the right frame, costs nothing when there is
 * nothing to say, and never interrupts. `canvasDiagnosticsBuffer.ts` has always
 * aggregated by identity, so "×412" is one line here, not 412 lines anywhere.
 *
 * ## Both tiers, one subscription
 *
 * The badge does not know or care whether this frame is a Tier-0 portal or a
 * Tier-2 cross-origin bridge. Both publish under the same scope key (the board
 * frame's id) — the portal frame via `CanvasDiagnosticsInjector` reaching into
 * its own document, the bridge frame via `useBridgeFrameDiagnostics` recording
 * what `runtime.ts` posted over the wire.
 *
 * Renders NOTHING into the canvas DOM: this is parent-document frame chrome,
 * beside the title, in the same header that already carries the axes badge.
 */
import { useSyncExternalStore } from 'react'
import { Tooltip } from '@ui/components/Tooltip'
import {
  getScopeDiagnostics,
  isCrashDiagnostic,
  type CanvasDiagnosticEntry,
} from '../canvasDiagnosticsBuffer'
import { subscribeScopeDiagnostics } from '../canvasDiagnosticsBuffer'
import styles from './FrameDiagnosticsBadge.module.css'

/** How many findings the popover lists. The buffer publishes newest-first, so these are the five most recent DISTINCT problems. */
const POPOVER_ENTRY_LIMIT = 5

/** First lines only — a full React stack is 40 frames of framework internals nobody reads in a popover. */
const STACK_LINES = 3

interface FrameDiagnosticsBadgeProps {
  /** This frame's diagnostics scope key — the board frame id. See `CanvasDiagnosticsScopeContext`. */
  scopeKey: string
}

export function FrameDiagnosticsBadge({ scopeKey }: FrameDiagnosticsBadgeProps) {
  // `getScopeDiagnostics` returns a cached, stable array that only changes
  // identity when a finding actually lands — which is what makes this a legal
  // `useSyncExternalStore` snapshot rather than an infinite render loop.
  const entries = useSyncExternalStore(
    (listener) => subscribeScopeDiagnostics(scopeKey, listener),
    () => getScopeDiagnostics(scopeKey),
    () => getScopeDiagnostics(scopeKey),
  )

  if (entries.length === 0) return null

  const crashed = entries.some(isCrashDiagnostic)
  const total = entries.reduce((sum, entry) => sum + entry.count, 0)
  const shown = entries.slice(0, POPOVER_ENTRY_LIMIT)

  return (
    <Tooltip
      size="wide"
      openOnFocus
      content={
        <div className={styles.popover}>
          <p className={styles.popoverTitle}>
            {crashed
              ? 'This screen’s code threw while rendering.'
              : 'This screen’s runtime reported a problem.'}
          </p>
          <ul className={styles.list}>
            {shown.map((entry) => (
              <li key={`${entry.code}|${entry.message}|${entry.url ?? ''}`} className={styles.entry}>
                <span className={styles.entryHead}>
                  <span className={styles.entryCode}>{entry.code}</span>
                  {entry.count > 1 && <span className={styles.entryCount}>×{entry.count}</span>}
                </span>
                <span className={styles.entryMessage}>{entry.message}</span>
                {entry.url && <span className={styles.entryUrl}>{entry.url}</span>}
                {entry.stack && <pre className={styles.entryStack}>{firstStackLines(entry.stack)}</pre>}
              </li>
            ))}
          </ul>
          {entries.length > shown.length && (
            <p className={styles.more}>+{entries.length - shown.length} more distinct problems.</p>
          )}
        </div>
      }
    >
      {/*
        A status, not a control — same shape as the axes badge beside it. There
        is no action to take here: the popover IS the whole affordance, and the
        agent reads the same findings through `studio_page_diagnostics`.
        `tabIndex` + `openOnFocus` is what makes the detail reachable without a
        pointer.
      */}
      <span
        className={styles.badge}
        data-crashed={crashed ? 'true' : undefined}
        data-testid="frame-diagnostics-badge"
        role="status"
        tabIndex={0}
        aria-label={`${total} runtime ${total === 1 ? 'problem' : 'problems'} reported by this screen`}
      >
        <span className={styles.dot} aria-hidden="true" />
      </span>
    </Tooltip>
  )
}

function firstStackLines(stack: CanvasDiagnosticEntry['stack']): string {
  return (stack ?? '').split('\n').slice(0, STACK_LINES).join('\n')
}
