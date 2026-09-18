/**
 * PanelBoundary — one editor panel (or one inspector section) is one
 * independent failure domain.
 *
 * ## The defect this closes
 *
 * `verify-3` case 5 measured it: the nearest boundary above the inspector was
 * `AdminCanvasLayout`'s `LazyChunkBoundary location="site-editor-body"`, which
 * wraps the canvas AND every panel together. A single section throwing during
 * render therefore replaced the whole editor body with "Editor chunk failed to
 * load" — not the panel's own fallback, and not a true statement either: no
 * chunk failed to load, one component threw.
 *
 * Track Z's `Z2` (`store-12`) had already made `ErrorBoundary` render in place
 * and stop toasting. What was missing was a boundary AT the panel seam, so
 * "in place" meant "in the panel" rather than "instead of the editor".
 *
 * ## The two frames
 *
 * A fallback has to occupy the geometry of the thing it replaced, or the
 * surrounding layout jumps and the user cannot tell what broke:
 *
 *   - `frame="panel"` — a whole panel or inspector tab. Its own title row
 *     (the panel's name), then one line and the reset action.
 *   - `frame="section"` — one `INSPECTOR_SECTIONS` entry inside the Design
 *     tab's continuous scroll. Reuses the `Section` primitive so the header
 *     row is byte-identical to the one the working section draws, and only
 *     the body is replaced.
 *
 * ## Logging: exactly one line, and it names the seam
 *
 * `ErrorBoundary` already logs once per catch through `logErrorChain`, tagged
 * `[error-boundary:<location>]`. This component's `location` is
 * `inspector:<id>` / `panel:<id>`, so that single line reads
 * `[error-boundary:inspector:fill]` and names both the mechanism and the
 * section. A second `console.error` here would be a second log for one error —
 * exactly the noise Track Z exists to remove — and it would also break
 * `studio-feel-phase0.e2e.ts` case 7, whose allowlist is pinned to the
 * boundary's own prefix.
 *
 * No toast: `ErrorBoundary` is silent by default and `admin-shell` is the one
 * seam that opts back in (`error-boundary-coverage.test.ts`).
 *
 * ## The dev-only way to exercise it
 *
 * Every boundary mounts a `PanelCrashProbe` keyed by its own id, so a browser
 * test can make exactly one panel or one section throw
 * (`window.dispatchEvent(new CustomEvent('studio:panel-crash-probe', { detail:
 * 'inspector:fill' }))`). The probe is erased from a production build at its
 * mount site — see its own header for both gates.
 */
import type { ReactNode } from 'react'
import { ErrorBoundary } from '@ui/components/ErrorBoundary'
import { Button } from '@ui/components/Button'
import { Section } from '@ui/components/Section'
import { ReloadIcon } from 'pixel-art-icons/icons/reload'
import { CircleAlertSolidIcon } from 'pixel-art-icons/icons/circle-alert-solid'
import { PanelCrashProbe } from '../../inspector/PanelCrashProbe'
import styles from './PanelBoundary.module.css'

export type PanelBoundaryFrame = 'panel' | 'section'

interface PanelBoundaryProps {
  /**
   * The seam's id — `fill`, `design`, `explorer`. Combined with `frame` into
   * the boundary `location` (`inspector:fill`, `panel:explorer`), which is
   * what the console line and `data-error-location` carry.
   */
  id: string
  /** Human-readable name of the panel/section, shown in the fallback's title row. */
  label: string
  frame: PanelBoundaryFrame
  /**
   * Bump to clear a stuck fallback. Selecting a different node is the natural
   * one for an inspector section: the crash was about the node it was
   * rendering.
   */
  resetKeys?: ReadonlyArray<unknown>
  children: ReactNode
}

/** `panel:` / `inspector:` — the prefix a frame contributes to `location`. */
const LOCATION_PREFIX: Record<PanelBoundaryFrame, string> = {
  panel: 'panel',
  section: 'inspector',
}

export function PanelBoundary({ id, label, frame, resetKeys, children }: PanelBoundaryProps) {
  const location = `${LOCATION_PREFIX[frame]}:${id}`

  return (
    <ErrorBoundary
      location={location}
      resetKeys={resetKeys}
      fallback={({ chain, reset }) => (
        <PanelBoundaryFallback
          location={location}
          label={label}
          frame={frame}
          message={chain[0]?.message ?? null}
          onReset={reset}
        />
      )}
    >
      {/* Dev-only, build-time-erased. `import.meta.env.DEV` is replaced with
          the literal `false` in a production build, which drops both the
          element and the import. */}
      {import.meta.env.DEV && <PanelCrashProbe panel={location} />}
      {children}
    </ErrorBoundary>
  )
}

function PanelBoundaryFallback({
  location,
  label,
  frame,
  message,
  onReset,
}: {
  location: string
  label: string
  frame: PanelBoundaryFrame
  message: string | null
  onReset: () => void
}) {
  const body = (
    <div className={styles.body} role="alert" data-error-location={location}>
      <p className={styles.message}>
        <span className={styles.icon} aria-hidden="true">
          <CircleAlertSolidIcon size={12} />
        </span>
        <span>
          {`${label} stopped responding.`}
          {/* The cause is dev-only for the same reason the shared fallback's
              is: a production user cannot act on a stack, and the one action
              that helps is right beside it. */}
          {import.meta.env.DEV && message ? <span className={styles.cause}> {message}</span> : null}
        </span>
      </p>
      <Button variant="secondary" size="micro" onClick={onReset}>
        <ReloadIcon size={12} aria-hidden="true" />
        <span>Reload this panel</span>
      </Button>
    </div>
  )

  if (frame === 'section') {
    // `forceOpen` — a fallback behind a chevron is a panel that looks empty.
    // `flush` matches every other section in the Design tab's scroll.
    return (
      <Section title={label} forceOpen flush>
        {body}
      </Section>
    )
  }

  return (
    <div className={styles.panelFrame}>
      <div className={styles.panelTitle}>{label}</div>
      {body}
    </div>
  )
}
