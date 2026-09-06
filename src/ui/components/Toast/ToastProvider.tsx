/**
 * ToastProvider — mounts once at the admin shell and renders bus-published
 * toasts in a fixed-position stack at the bottom-right of the viewport.
 *
 * Render path:
 *   1. Subscribes to `subscribeToasts`; React state mirrors the bus snapshot.
 *   2. Each toast renders with role="alert" (errors / warnings) or "status"
 *      (info / success).
 *   3. Toasts auto-dismiss based on their `durationMs` (8s for errors, 4s for
 *      others, or `null` to keep until manually closed).
 *
 * Pause-on-hover: the auto-dismiss timer pauses while the user hovers the
 * stack, so multi-toast bursts stay readable. Resumes on mouseleave.
 *
 * Constraints:
 *   - CSS Modules only, achromatic + semantic state tokens
 *   - No Tailwind, no inline styles except dynamic CSS custom properties
 *   - role="alert" / role="status" per toast kind
 *   - Close affordance + optional action use the Button primitive
 *   - Pixel-art icons only (close, circle-alert, warning-diamond)
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@ui/components/Button'
import { cn } from '@ui/cn'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { CircleAlertSolidIcon } from 'pixel-art-icons/icons/circle-alert-solid'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import {
  dismissToast,
  subscribeToasts,
  type Toast,
  type ToastKind,
} from './toastBus'
import styles from './Toast.module.css'

const DEFAULT_DURATION_MS: Record<ToastKind, number> = {
  error: 8000,
  warning: 6000,
  success: 4000,
  info: 4000,
}

const TOAST_ROOT_ID = 'toast-root'

function getToastRoot(): HTMLElement {
  let root = document.getElementById(TOAST_ROOT_ID)
  if (!root) {
    root = document.createElement('div')
    root.id = TOAST_ROOT_ID
    document.body.appendChild(root)
  }
  return root
}

/**
 * Resolve the role attribute from the kind. Errors / warnings interrupt
 * assistive tech; info / success are non-blocking status announcements.
 */
function ariaRoleForKind(kind: ToastKind): 'alert' | 'status' {
  return kind === 'error' || kind === 'warning' ? 'alert' : 'status'
}

/**
 * Countdown identity: the toast, at this generation. A `dedupeKey` collapse
 * keeps the id and refreshes `createdAt`, which is exactly the moment the
 * countdown should start over.
 */
function timerKey(toast: Toast): string {
  return `${toast.id}:${toast.createdAt}`
}

function ToastIcon({ kind }: { kind: ToastKind }) {
  if (kind === 'error') return <CircleAlertSolidIcon size={14} aria-hidden="true" />
  if (kind === 'warning') return <WarningDiamondSolidIcon size={14} aria-hidden="true" />
  // success / info share the circle-alert glyph at lower visual weight
  return <CircleAlertSolidIcon size={14} aria-hidden="true" />
}

export function ToastProvider() {
  const [items, setItems] = useState<ReadonlyArray<Toast>>([])
  const [paused, setPaused] = useState(false)
  const portalRoot = typeof document !== 'undefined' ? getToastRoot() : null
  // Per-toast time left, in ms — the state the timer effect cannot keep in a
  // `setTimeout` alone. See the effect below for why it has to exist.
  const remainingRef = useRef(new Map<string, number>())

  useEffect(() => {
    return subscribeToasts((next) => setItems(next))
  }, [])

  // Single timer-lifecycle effect: arm a setTimeout per visible toast (unless
  // paused or opted-out), and clean them up on re-render / unmount.
  //
  // The effect re-runs whenever `items` or `paused` changes, and its cleanup
  // clears every timer it armed — so the countdown is REBUILT on each run. It
  // is rebuilt from `remainingRef`, not from the toast's full duration: this
  // effect runs again every time ANY toast is pushed or dismissed, and
  // restarting every visible toast's full countdown on each of those meant a
  // burst of toasts kept each other alive indefinitely (and, with
  // pause-on-hover, that a mouse crossing the stack reset the lot). Each entry
  // is decremented by the time the previous arming actually ran for, so the
  // total time a toast is visible is its own duration — plus however long the
  // pointer rested on the stack, which is what pause-on-hover promises.
  useEffect(() => {
    const remaining = remainingRef.current
    const armedAt = Date.now()
    // Drop countdowns for toasts no longer on the bus, and for the previous
    // GENERATION of a `dedupeKey`ed toast that was just re-pushed — the key
    // carries `createdAt`, which a repeat refreshes, so a collapsed repeat
    // starts its countdown over rather than inheriting the original's.
    const live = new Set(items.map(timerKey))
    for (const key of remaining.keys()) {
      if (!live.has(key)) remaining.delete(key)
    }
    if (paused) return

    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    for (const toast of items) {
      if (toast.durationMs === null) continue
      const key = timerKey(toast)
      const duration = remaining.get(key) ?? toast.durationMs ?? DEFAULT_DURATION_MS[toast.kind]
      remaining.set(key, duration)
      const timer = setTimeout(() => {
        timers.delete(key)
        dismissToast(toast.id)
      }, duration)
      timers.set(key, timer)
    }
    return () => {
      const elapsed = Date.now() - armedAt
      for (const [key, timer] of timers) {
        clearTimeout(timer)
        remaining.set(key, Math.max(0, (remaining.get(key) ?? 0) - elapsed))
      }
      timers.clear()
    }
  }, [items, paused])

  if (!portalRoot || items.length === 0) return null

  return createPortal(
    <div
      className={styles.stack}
      data-testid="toast-stack"
      aria-label="Notifications"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {items.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>,
    portalRoot,
  )
}

async function runToastAction(
  action: NonNullable<Toast['action']>,
  setActionPending: (v: boolean) => void,
): Promise<void> {
  setActionPending(true)
  try {
    await Promise.resolve(action.onSelect())
  } catch (err) {
    console.error(`[toast] action "${action.label}" failed:`, err)
  } finally {
    setActionPending(false)
  }
}

function ToastItem({ toast }: { toast: Toast }) {
  const [actionPending, setActionPending] = useState(false)

  async function handleAction() {
    if (!toast.action) return
    await runToastAction(toast.action, setActionPending)
  }

  return (
    <div
      role={ariaRoleForKind(toast.kind)}
      aria-live={toast.kind === 'error' || toast.kind === 'warning' ? 'assertive' : 'polite'}
      className={cn(styles.toast, styles[`kind-${toast.kind}`])}
      data-toast-kind={toast.kind}
      data-toast-location={toast.location}
    >
      <span className={styles.icon} aria-hidden="true">
        <ToastIcon kind={toast.kind} />
      </span>
      <div className={styles.content}>
        <p className={styles.title}>
          {toast.title}
          {/* A collapsed repeat is otherwise invisible: the card is already
              on screen saying the same thing, so without a count the user's
              second attempt looks like it did nothing at all. */}
          {toast.repeatCount > 1 && (
            <span className={styles.repeat} data-toast-repeat={toast.repeatCount}>
              ×{toast.repeatCount}
            </span>
          )}
        </p>
        {toast.body && <p className={styles.body}>{toast.body}</p>}
        {toast.location && (
          <p className={styles.location}>{toast.location}</p>
        )}
      </div>
      <div className={styles.actions}>
        {toast.action && (
          <Button
            variant="secondary"
            size="micro"
            onClick={() => void handleAction()}
            disabled={actionPending}
          >
            <span>{toast.action.label}</span>
          </Button>
        )}
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          aria-label="Dismiss notification"
          onClick={() => dismissToast(toast.id)}
        >
          <CloseIcon size={12} aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}
