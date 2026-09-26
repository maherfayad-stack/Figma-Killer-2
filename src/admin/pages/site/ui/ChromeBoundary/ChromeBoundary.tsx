/**
 * ChromeBoundary — one piece of editor chrome (the toolbar, the rulers, a
 * context menu, a dialog, a sidebar rail) is its own failure domain, and a
 * crash in it is SILENT (ERR-13).
 *
 * ## The defect this closes
 *
 * Everything outside a narrower boundary fell back to one of two much wider
 * ones. Chrome inside the editor body fell to `LazyChunkBoundary
 * location="site-editor-body"`, which replaced the canvas AND every panel with
 * "Editor chunk failed to load" — a sentence that was not even true, since no
 * chunk had failed to load. Chrome outside it (the toolbar, `RefusalDialog`)
 * fell to `admin-route`, which took the whole editor down. One ruler throwing
 * during render cost the user the board they were working on.
 *
 * ## Why the fallback is nothing at all
 *
 * A panel's fallback has room for a title and a "Reload this panel" button
 * (`PanelBoundary`). A ruler, a toolbar, a context menu does not: a card in its
 * place would cover the canvas it sits over, and a user cannot act on "the
 * ruler crashed". So the chrome simply goes away, logged once
 * (`[error-boundary:chrome:<id>]` via `ErrorBoundary`'s own `logErrorChain`),
 * and comes back by itself on the next store change — the very next thing the
 * user does. That is the recovery a person would reach for anyway (click
 * something), made automatic.
 *
 * A chrome piece that crashes again on every change stops being retried after
 * {@link MAX_AUTOMATIC_RECOVERIES} attempts, so a deterministic render bug
 * logs a handful of times, not once per keystroke.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { ErrorBoundary } from '@ui/components/ErrorBoundary'
import { useEditorStore } from '@site/store/store'

/** How many times one mounted boundary brings its chrome back by itself. */
const MAX_AUTOMATIC_RECOVERIES = 3

interface ChromeBoundaryProps {
  /** Names the seam in the log line: `[error-boundary:chrome:<id>]`. Unique per mount site. */
  id: string
  children: ReactNode
}

export function ChromeBoundary({ id, children }: ChromeBoundaryProps) {
  const recoveries = useRef(0)
  return (
    <ErrorBoundary
      location={`chrome:${id}`}
      fallback={({ reset }) => (
        <RecoverOnNextStoreChange
          reset={() => {
            if (recoveries.current >= MAX_AUTOMATIC_RECOVERIES) return
            recoveries.current += 1
            reset()
          }}
        />
      )}
    >
      {children}
    </ErrorBoundary>
  )
}

/** Renders nothing; resets the boundary the first time the editor store changes. */
function RecoverOnNextStoreChange({ reset }: { reset: () => void }) {
  useEffect(() => useEditorStore.subscribe(() => reset()), [reset])
  return null
}
