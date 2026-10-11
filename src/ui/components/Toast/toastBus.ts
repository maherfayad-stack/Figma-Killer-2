/**
 * Toast bus — singleton event source decoupled from React.
 *
 * Producers (error boundaries, async handlers, plugin runtime) call
 * `pushToast({ kind, title, body })`. The single mounted `<ToastProvider />`
 * subscribes via `subscribeToasts` and renders the resulting list.
 *
 * Why a module-level bus rather than React context:
 *   - Error boundaries must be able to push from `componentDidCatch`, which
 *     runs outside the normal render flow and can't safely call `useContext`.
 *   - Plugin runtime / non-React code (server callbacks, store middleware)
 *     can publish notifications without taking a React dependency.
 *
 * Constraints:
 *   - Pure module — no JSX here.
 *   - Each toast has a stable id; producers receive it back so they can
 *     dismiss imperatively (e.g. when the boundary resets).
 *   - The provider is the single source of truth for visibility and timing —
 *     this module only stores the canonical list.
 *   - **Collapsing is the default, not an opt-in.** Two pushes that would
 *     render the same card (same `kind` + `title` + `body`) are the same
 *     event as far as the reader is concerned, so the second one bumps a
 *     `×N` counter on the card already on screen instead of stacking a
 *     duplicate. One root cause can no longer mean N identical red boxes —
 *     the "noisy errors" failure this bus used to produce with 139 call
 *     sites and three of them passing a `dedupeKey`.
 *     A caller with genuinely distinct events that happen to share copy
 *     (two uploads of different files, say) passes `dedupeKey: false`.
 */

export type ToastKind = 'info' | 'success' | 'warning' | 'error'

export interface ToastInput {
  /** Visual + a11y kind. Errors and warnings render with role="alert". */
  kind: ToastKind
  /** Short headline (one line). */
  title: string
  /** Optional detail body — wraps to ~3 lines before truncation. */
  body?: string
  /**
   * Free-form location tag (e.g. "error-boundary:canvas") — carried on the
   * toast element as `data-toast-location` and in copy-to-clipboard payloads so
   * a bug report says where the failure came from. It is never drawn: a mono
   * "site-editor" under every message told the person nothing.
   */
  location?: string
  /**
   * Auto-dismiss after this many ms. Errors default to 8000, others to 4000.
   * Pass `null` to keep the toast until the user closes it.
   */
  durationMs?: number | null
  /**
   * Optional secondary action (e.g. "Copy stack"). Rendered as a Button next
   * to the close affordance.
   */
  action?: ToastAction
  /**
   * Collapse key. A push whose resolved key matches a toast already on the
   * bus REPLACES that toast in place — same id, same stack position,
   * refreshed content, `repeatCount` incremented — instead of stacking a
   * second copy.
   *
   * Three values:
   *   - **omitted (the default)** — the key is derived from
   *     `kind + title + body`. Two pushes that read identically to the user
   *     ARE the same notification, so the second bumps `×2` on the first.
   *   - **a string** — an explicit identity, for repeats whose copy varies
   *     but whose cause does not (`structural-refusal:<reason>`), or to
   *     deliberately collapse a family of related messages onto one card.
   *   - **`false`** — opt out. For genuinely distinct events that share
   *     copy, e.g. "Upload failed" for two different files, where counting
   *     them as one would hide the second file's failure.
   */
  dedupeKey?: string | false
}

interface ToastAction {
  label: string
  /**
   * Called when the action is clicked. If it returns a promise, the toast
   * stays mounted until the promise resolves.
   */
  onSelect: () => void | Promise<void>
}

export interface Toast extends ToastInput {
  /** Stable identifier; producers can dismiss with this. */
  id: string
  /** ms-since-epoch the toast was published — used for stable ordering. */
  createdAt: number
  /**
   * How many times this toast has been pushed, counting the first. Above 1
   * whenever a repeat collapsed onto this card; the provider renders it as
   * `×N` so a repeated refusal still reads as new feedback.
   */
  repeatCount: number
  /**
   * The RESOLVED collapse key — the caller's `dedupeKey` string, the derived
   * `kind + title + body` key, or `null` when the caller opted out with
   * `dedupeKey: false`. Stored separately from the input field so the lookup
   * never has to re-derive it, and so `null` (opted out) can never
   * accidentally match another opted-out toast.
   */
  collapseKey: string | null
}

type Listener = (toasts: ReadonlyArray<Toast>) => void

let counter = 0
const toasts: Toast[] = []
const listeners = new Set<Listener>()

function nextId(): string {
  counter += 1
  return `toast-${counter}-${Date.now().toString(36)}`
}

function notify(): void {
  const snapshot = toasts.slice()
  for (const listener of listeners) listener(snapshot)
}

/**
 * The collapse identity of a push.
 *
 * `\u0000` joins the parts because it cannot appear in UI copy, so a title
 * ending in the separator can never be confused with a body starting with it.
 * `location` and `action` are deliberately NOT part of the key: the user
 * reads the card, and two cards that read the same are one event to them.
 */
function resolveCollapseKey(input: ToastInput): string | null {
  if (input.dedupeKey === false) return null
  if (input.dedupeKey !== undefined) return input.dedupeKey
  return `auto\u0000${input.kind}\u0000${input.title}\u0000${input.body ?? ''}`
}

/**
 * Push a new toast onto the queue. Returns the assigned id so the caller can
 * dismiss it imperatively if needed — for a push that collapsed onto an
 * existing toast, that is the EXISTING id.
 */
export function pushToast(input: ToastInput): string {
  const collapseKey = resolveCollapseKey(input)
  const existing = collapseKey === null
    ? -1
    : toasts.findIndex((t) => t.collapseKey === collapseKey)
  if (existing !== -1) {
    const previous = toasts[existing]!
    toasts[existing] = {
      ...input,
      id: previous.id,
      createdAt: Date.now(),
      repeatCount: previous.repeatCount + 1,
      collapseKey,
    }
    notify()
    return previous.id
  }
  const id = nextId()
  toasts.push({ ...input, id, createdAt: Date.now(), repeatCount: 1, collapseKey })
  notify()
  return id
}

/** Remove a toast by id. No-op if the id is not present. */
export function dismissToast(id: string): void {
  const idx = toasts.findIndex((t) => t.id === id)
  if (idx === -1) return
  toasts.splice(idx, 1)
  notify()
}

/**
 * Subscribe to bus updates. The listener is invoked synchronously with the
 * current snapshot on each push/dismiss. Returns an unsubscribe fn.
 */
export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener)
  listener(toasts.slice())
  return () => {
    listeners.delete(listener)
  }
}

export function __resetToastBusForTests(): void {
  counter = 0
  toasts.splice(0)
  listeners.clear()
}
