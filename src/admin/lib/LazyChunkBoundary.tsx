import {
  Fragment,
  Suspense,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { ErrorBoundary, type ErrorChainEntry } from '@ui/components/ErrorBoundary'
import { Button } from '@ui/components/Button'
import { ReloadIcon } from 'pixel-art-icons/icons/reload'
import styles from './LazyChunkBoundary.module.css'

const DEFAULT_TIMEOUT_MS = 8000
const EMPTY_RESET_KEYS: ReadonlyArray<unknown> = []

/**
 * The messages browsers and bundlers use for a lazy chunk that could not be
 * fetched or evaluated: Vite/Chromium ("Failed to fetch dynamically imported
 * module"), Safari ("Importing a module script failed"), Firefox ("error
 * loading dynamically imported module"), Vite's CSS preload, and webpack's
 * `ChunkLoadError`.
 */
const CHUNK_LOAD_MESSAGE =
  /failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module|unable to preload css|loading (css )?chunk [\w-]+ failed/i

/**
 * ERR-13 — whether a caught error is really a chunk that failed to load. Only
 * then is "Editor chunk failed to load" true; an ordinary render error that
 * reaches this boundary is something else, and says so.
 */
export function isChunkLoadError(chain: readonly ErrorChainEntry[]): boolean {
  return chain.some((entry) => entry.name === 'ChunkLoadError' || CHUNK_LOAD_MESSAGE.test(entry.message))
}

interface LazyChunkBoundaryProps {
  location: string
  fallback: ReactNode
  resetKeys?: ReadonlyArray<unknown>
  timeoutMs?: number
  onReset?: () => void
  children: ReactNode
}

export function LazyChunkBoundary({
  location,
  fallback,
  resetKeys = EMPTY_RESET_KEYS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onReset,
  children,
}: LazyChunkBoundaryProps) {
  const [attempt, setAttempt] = useState(0)
  const boundaryResetKeys = [...resetKeys, attempt]

  function retry(resetErrorBoundary?: () => void) {
    onReset?.()
    setAttempt((current) => current + 1)
    resetErrorBoundary?.()
  }

  return (
    <ErrorBoundary
      location={location}
      resetKeys={boundaryResetKeys}
      fallback={({ chain, reset }) =>
        isChunkLoadError(chain) ? (
          <LazyChunkFailure
            titleId={`lazy-chunk-boundary-${location}-title`}
            title="Editor chunk failed to load"
            message={chain[0]?.message ?? 'The editor chunk could not be loaded.'}
            onRetry={() => retry(reset)}
          />
        ) : (
          // ERR-13 — not a chunk: a render error nothing narrower caught. Every
          // editor panel, section and chrome seam has its own boundary now, so
          // reaching here is rare; the copy says what happened, and the raw
          // message stays in the console (`[error-boundary:<location>]`).
          <LazyChunkFailure
            titleId={`lazy-chunk-boundary-${location}-title`}
            title="The editor stopped responding"
            message="Something in the editor failed while drawing. Your files are unchanged."
            onRetry={() => retry(reset)}
          />
        )
      }
    >
      <Suspense
        fallback={(
          <LazyChunkPendingFallback
            key={`${attempt}:${timeoutMs}`}
            fallback={fallback}
            timeoutMs={timeoutMs}
            onRetry={() => retry()}
          />
        )}
      >
        <LazyChunkAttempt key={attempt}>{children}</LazyChunkAttempt>
      </Suspense>
    </ErrorBoundary>
  )
}

function LazyChunkAttempt({ children }: { children: ReactNode }) {
  return <Fragment>{children}</Fragment>
}

function LazyChunkPendingFallback({
  fallback,
  timeoutMs,
  onRetry,
}: {
  fallback: ReactNode
  timeoutMs: number
  onRetry: () => void
}) {
  const [timedOut, setTimedOut] = useState(timeoutMs <= 0)

  useEffect(() => {
    if (timeoutMs <= 0) return
    const timeoutId = window.setTimeout(() => setTimedOut(true), timeoutMs)
    return () => window.clearTimeout(timeoutId)
  }, [timeoutMs])

  if (!timedOut) return <Fragment>{fallback}</Fragment>

  return (
    <LazyChunkFailure
      titleId="lazy-chunk-boundary-pending-title"
      title="Editor is still loading"
      message="The dev server has not delivered the editor chunk yet. Retry the import instead of waiting on the loading view."
      onRetry={onRetry}
    />
  )
}

function LazyChunkFailure({
  titleId,
  title,
  message,
  onRetry,
}: {
  titleId: string
  title: string
  message: string
  onRetry: () => void
}) {
  return (
    <section
      className={styles.chunkFailure}
      role="alert"
      aria-labelledby={titleId}
    >
      <div className={styles.panel}>
        <h2 id={titleId} className={styles.title}>{title}</h2>
        <p className={styles.message}>{message}</p>
        <div className={styles.actions}>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            <ReloadIcon size={13} aria-hidden="true" />
            <span>Retry</span>
          </Button>
        </div>
      </div>
    </section>
  )
}
