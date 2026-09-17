/**
 * PlayCrashCard — P8: the Play/Live surface's answer to a screen that did not
 * render.
 *
 * ## The failure it removes
 *
 * A component that throws paints a white rectangle. In the design board that is
 * survivable — there are fourteen other frames and a badge on this one. On the
 * Live/Play surface there is exactly ONE screen filling the viewport, so a
 * crash is indistinguishable from "this screen is blank", from "the prototype
 * link went somewhere empty", and from "the preview is broken". That ambiguity
 * is the whole of the "no errors in the preview" complaint: the preview was not
 * producing errors, it was producing SILENCE about them.
 *
 * ## Both tiers, one source
 *
 * Reads `canvasDiagnosticsBuffer.ts` by scope key, so it does not know or care
 * which runtime rendered the screen — a Tier-0/1 portal frame fills that buffer
 * through `CanvasDiagnosticsInjector`, a Tier-2 live frame through Z5's wire
 * `error` message and `useBridgeFrameDiagnostics`. Same card, same words.
 *
 * ## Only a CRASH, never a complaint
 *
 * Gated on `isCrashDiagnostic` — an uncaught exception, an unhandled rejection,
 * or a module that did not resolve. A `console.error` or a 404 from a backend
 * that is not running does NOT put a card over a screen that rendered
 * perfectly well; that is what the frame badge is for. A card that cried wolf
 * would be dismissed by the second time it appeared.
 *
 * ## It covers, it does not replace
 *
 * Rendered as a sibling overlay in the PARENT document, over the frame — never
 * inside the canvas DOM (see `IframeFrameSurface`'s docblock: no wrapper
 * elements, ever). Whatever the screen did manage to paint stays underneath,
 * dimmed, because a partially-rendered screen is evidence.
 */
import { useState, useSyncExternalStore } from 'react'
import { Button } from '@ui/components/Button'
import { CircleAlertSolidIcon } from 'pixel-art-icons/icons/circle-alert-solid'
import {
  getScopeDiagnostics,
  isCrashDiagnostic,
  subscribeScopeDiagnostics,
} from './canvasDiagnosticsBuffer'
import styles from './PlayCrashCard.module.css'

/** How many findings "open diagnostics" reveals. The buffer publishes newest-first. */
const DETAIL_LIMIT = 5

/** First lines only — a full React stack is 40 frames of framework internals nobody reads in a card. */
const STACK_LINES = 4

interface PlayCrashCardProps {
  /** The diagnostics scope key of the screen currently on the surface — see `CanvasDiagnosticsScopeContext`. */
  scopeKey: string
}

export function PlayCrashCard({ scopeKey }: PlayCrashCardProps) {
  const [open, setOpen] = useState(false)
  const entries = useSyncExternalStore(
    (listener) => subscribeScopeDiagnostics(scopeKey, listener),
    () => getScopeDiagnostics(scopeKey),
    () => getScopeDiagnostics(scopeKey),
  )

  const crashes = entries.filter(isCrashDiagnostic)
  if (crashes.length === 0) return null

  const shown = crashes.slice(0, DETAIL_LIMIT)

  return (
    <div className={styles.cover} data-testid="play-crash-card">
      <section className={styles.card} role="alert" aria-label="This screen crashed">
        <CircleAlertSolidIcon size={16} className={styles.icon} aria-hidden="true" />
        <p className={styles.title}>This screen crashed — open diagnostics</p>
        <p className={styles.lead}>{shown[0]!.message}</p>
        {open && (
          <ul className={styles.list}>
            {shown.map((entry) => (
              <li key={`${entry.code}|${entry.message}|${entry.url ?? ''}`} className={styles.entry}>
                <span className={styles.entryCode}>
                  {entry.code}
                  {entry.count > 1 && <span className={styles.entryCount}> ×{entry.count}</span>}
                </span>
                <span className={styles.entryMessage}>{entry.message}</span>
                {entry.url && <span className={styles.entryUrl}>{entry.url}</span>}
                {entry.stack && <pre className={styles.entryStack}>{firstStackLines(entry.stack)}</pre>}
              </li>
            ))}
          </ul>
        )}
        <Button
          variant="secondary"
          size="xs"
          onClick={() => setOpen(!open)}
          data-testid="play-crash-card-toggle"
        >
          {open ? 'Hide diagnostics' : 'Open diagnostics'}
        </Button>
      </section>
    </div>
  )
}

function firstStackLines(stack: string): string {
  return stack.split('\n').slice(0, STACK_LINES).join('\n')
}
