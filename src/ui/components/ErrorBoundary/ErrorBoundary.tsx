/**
 * ErrorBoundary — shared boundary primitive for the CMS admin tree.
 *
 * Why this exists
 * ───────────────
 * React's "Add an error boundary to your tree" suggestion is the only way to
 * keep a render-time crash from blanking the whole page. This primitive plugs
 * boundaries into the architectural seams of the CMS (admin shell, canvas,
 * plugin page renderer, per-node module renderer) and wires them into the
 * project's existing logging conventions:
 *
 *   1. `console.error('[error-boundary:<location>]', ...)` — matches the
 *      `[<module>]` prefix rule from CLAUDE.md
 *   2. Walks `error.cause` chains so typed domain errors render their full
 *      provenance (SiteValidationError, VisualComponentNameError, etc.)
 *   3. Renders its fallback **in place**, where the broken subtree was
 *      (see `silentToast` below)
 *   4. Resets state when `resetKeys` change (route, page id, module id) so
 *      navigation naturally clears stuck error states
 *   5. Dev fallback names the location and the error and keeps the cause
 *      chain / component stack one disclosure away. Prod fallback is one
 *      line. Both offer "Reload this panel", which resets the boundary.
 *
 * Why it does not toast
 * ─────────────────────
 * It used to, by default. A boundary is mounted per seam AND per canvas node,
 * so one bad module meant one identical red card per node — the single
 * loudest contributor to the "every error has a toast" problem Track Z fixes.
 * A crash already has somewhere honest to render: the hole it left. Only
 * `admin-shell` still toasts, because when the shell boundary catches there
 * is nothing else left on screen to read.
 *
 * Usage
 * ─────
 *   <ErrorBoundary location="canvas" resetKeys={[activePageId]}>
 *     <CanvasRoot />
 *   </ErrorBoundary>
 *
 * The `location` string ends up in:
 *   - the console prefix
 *   - the fallback's `data-error-location` attribute (and, in dev, its copy)
 *   - the architecture coverage gate (each seam asserts a unique location)
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@ui/components/Button'
import { ReloadIcon } from 'pixel-art-icons/icons/reload'
import { CircleAlertSolidIcon } from 'pixel-art-icons/icons/circle-alert-solid'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { pushToast } from '@ui/components/Toast'
import {
  flattenErrorChain,
  formatErrorReport,
  logErrorChain,
  type ErrorChainEntry,
} from './errorReporting'
import styles from './ErrorBoundary.module.css'

interface ErrorBoundaryFallbackInfo {
  location: string
  chain: ErrorChainEntry[]
  componentStack: string | null
  reset: () => void
}

interface ErrorBoundaryProps {
  /**
   * Architectural label for this boundary. Surfaced in console logs, toasts,
   * and the dev fallback. Must be unique across the boundary placements
   * enforced by `error-boundary-coverage.test.ts`.
   *
   * Examples: "admin-shell", "admin-route", "canvas", "plugin-page",
   * "node-renderer", "module-sandbox".
   */
  location: string
  /**
   * Bump any of these to clear the boundary's error state. Use a stable
   * identifier that meaningfully changes when the user navigates to a fresh
   * context (route pathname, active page id, plugin id).
   */
  resetKeys?: ReadonlyArray<unknown>
  /** Custom fallback. Receives the error context + a reset callback. */
  fallback?: (info: ErrorBoundaryFallbackInfo) => ReactNode
  /**
   * Suppress the toast push for this boundary. **Default `true`** — the
   * fallback renders where the broken subtree was, which is both quieter and
   * more informative than a card in the corner of the screen.
   *
   * Pass `false` only where the boundary's own fallback cannot be read: the
   * `admin-shell` boundary, whose catch means the entire app tree is gone.
   */
  silentToast?: boolean
  /**
   * ERR-13 — reset this many times on its own before the fallback is shown.
   * For a seam whose crash is most often a one-render race (a node id the
   * board just replaced, a resync landing mid-render): the retry renders
   * against the settled state and usually just works. The count starts over
   * whenever `resetKeys` change. Default 0 — most seams show their fallback at
   * once.
   */
  autoRetry?: number
  children: ReactNode
}

interface ErrorBoundaryState {
  chain: ErrorChainEntry[] | null
  componentStack: string | null
  /** Snapshot of `resetKeys` that was active when the boundary entered the
   *  errored state — compared in `getDerivedStateFromProps` to detect resets. */
  resetSnapshot: ReadonlyArray<unknown>
  /** Automatic resets spent since the last `resetKeys` change — see `autoRetry`. */
  autoRetries: number
}

function shallowEqualKeys(
  a: ReadonlyArray<unknown>,
  b: ReadonlyArray<unknown>,
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false
  }
  return true
}

const EMPTY_KEYS: ReadonlyArray<unknown> = []

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    chain: null,
    componentStack: null,
    resetSnapshot: this.props.resetKeys ?? EMPTY_KEYS,
    autoRetries: 0,
  }

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { chain: flattenErrorChain(error) }
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    const next = props.resetKeys ?? EMPTY_KEYS
    if (state.chain && !shallowEqualKeys(state.resetSnapshot, next)) {
      return { chain: null, componentStack: null, resetSnapshot: next, autoRetries: 0 }
    }
    if (!state.chain && state.resetSnapshot !== next) {
      return shallowEqualKeys(state.resetSnapshot, next)
        ? { resetSnapshot: next }
        : { resetSnapshot: next, autoRetries: 0 }
    }
    return null
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const chain = flattenErrorChain(error)
    const componentStack = info.componentStack ?? null
    const prefix = `error-boundary:${this.props.location}`

    logErrorChain(prefix, chain, componentStack)

    // ERR-13 — spend an automatic retry before the fallback is ever read.
    if (this.state.autoRetries < (this.props.autoRetry ?? 0)) {
      this.setState((state) => ({ chain: null, componentStack: null, autoRetries: state.autoRetries + 1 }))
      return
    }

    this.setState({ componentStack })

    // Default: silent. See this file's header — only `admin-shell` opts in,
    // because only its catch leaves nothing on screen to read.
    if (this.props.silentToast === false) {
      const head = chain[0]
      pushToast({
        kind: 'error',
        title: `Render failed in ${this.props.location}`,
        body: `${head.name}: ${head.message}`,
        location: prefix,
        action: {
          label: 'Copy details',
          onSelect: () => {
            const text = formatErrorReport(this.props.location, chain, componentStack)
            void copyToClipboard(text)
          },
        },
      })
    }
  }

  reset = (): void => {
    this.setState({ chain: null, componentStack: null })
  }

  render(): ReactNode {
    if (!this.state.chain) return this.props.children
    // An automatic retry is about to run (`componentDidCatch`): paint nothing
    // for that one frame rather than flash a fallback nobody needs to read.
    if (this.state.autoRetries < (this.props.autoRetry ?? 0)) return null

    const fallbackInfo: ErrorBoundaryFallbackInfo = {
      location: this.props.location,
      chain: this.state.chain,
      componentStack: this.state.componentStack,
      reset: this.reset,
    }

    if (this.props.fallback) return this.props.fallback(fallbackInfo)
    return <DefaultErrorFallback {...fallbackInfo} />
  }
}

// ─── Default fallback UI ─────────────────────────────────────────────────────

/**
 * The in-place fallback: a `--bg-surface-2` panel that occupies the hole the
 * crashed subtree left, one line of copy, and one action that resets the
 * boundary. Deliberately small — it may land inside a 240 px inspector
 * section as easily as a full route, so it cannot assume room for a stack
 * trace. In dev the cause chain and component stack stay one `<details>`
 * away, collapsed, so the panel is still one line tall at rest.
 */
function DefaultErrorFallback({
  location,
  chain,
  componentStack,
  reset,
}: ErrorBoundaryFallbackInfo) {
  const isDev = import.meta.env?.DEV ?? false
  const head = chain[0]
  const hasDetail = chain.length > 1 || componentStack !== null

  async function handleCopy() {
    await copyToClipboard(formatErrorReport(location, chain, componentStack))
  }

  return (
    <section
      role="alert"
      className={styles.fallback}
      data-error-location={location}
    >
      <span className={styles.icon} aria-hidden="true">
        <CircleAlertSolidIcon size={14} />
      </span>
      <div className={styles.content}>
        <p className={styles.message}>
          {isDev
            ? `${location} — ${head.name}: ${head.message}`
            : 'This panel stopped responding.'}
        </p>

        {isDev && hasDetail && (
          <details className={styles.details}>
            <summary>Details</summary>
            {chain.length > 1 && (
              <ol className={styles.causeChain}>
                {chain.slice(1).map((entry, i) => (
                  <li key={i}>
                    <code>{entry.name}</code>: {entry.message}
                  </li>
                ))}
              </ol>
            )}
            {componentStack && <pre className={styles.stack}>{componentStack.trim()}</pre>}
          </details>
        )}
      </div>

      <div className={styles.actions}>
        <Button variant="secondary" size="micro" onClick={reset}>
          <ReloadIcon size={12} aria-hidden="true" />
          <span>Reload this panel</span>
        </Button>
        {isDev && (
          <Button
            variant="ghost"
            size="micro"
            iconOnly
            aria-label="Copy error details"
            onClick={() => void handleCopy()}
          >
            <CopySolidIcon size={12} aria-hidden="true" />
          </Button>
        )}
      </div>
    </section>
  )
}

// ─── Clipboard helper ────────────────────────────────────────────────────────

async function copyToClipboard(text: string): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch (err) {
    console.error('[error-boundary] clipboard write failed:', err)
  }
}
