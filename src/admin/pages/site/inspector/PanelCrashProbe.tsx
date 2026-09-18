/**
 * PanelCrashProbe — the one way a browser test can make an editor panel throw
 * on purpose.
 *
 * Why it exists
 * ─────────────
 * Track Z's `Z2` contract is "a panel that throws renders its own in-place
 * fallback — not a blank inspector, not a toast" (`store-12`). Nothing else in
 * the tree can produce that render-time failure on demand: every panel is
 * defensive, and faking it by breaking a shared browser API would break ten
 * other things at the same time and prove nothing about the boundary.
 *
 * So the seam is explicit, named, and one line long.
 *
 * Why it cannot reach production
 * ──────────────────────────────
 * Two independent gates, both resolved at BUILD time by Vite:
 *
 *   1. Its only mount site is written `{import.meta.env.DEV && <PanelCrashProbe …/>}`.
 *      `import.meta.env.DEV` is replaced with the literal `false` in a
 *      production build, so the element is dropped and this module's import
 *      becomes unused — it is not in the production bundle at all.
 *   2. The listener that can arm it is itself behind `import.meta.env.DEV`, so
 *      even if a future caller mounted it unguarded, the event could never
 *      arm it outside a dev build.
 *
 * There is no runtime flag, no env var, and no query parameter: a dev session
 * that never dispatches the event never changes behaviour by a single render.
 *
 * Usage from a spec
 * ─────────────────
 *   await page.evaluate(() =>
 *     window.dispatchEvent(new CustomEvent('studio:panel-crash-probe', { detail: 'inspector' })),
 *   )
 */
import { useEffect, useState } from 'react'

/** The event a test dispatches; `detail` names the panel that should throw. */
export const PANEL_CRASH_PROBE_EVENT = 'studio:panel-crash-probe'

interface PanelCrashProbeProps {
  /** Which panel this probe stands in — matched against the event's `detail`. */
  panel: string
}

export function PanelCrashProbe({ panel }: PanelCrashProbeProps) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const arm = (event: Event) => {
      if ((event as CustomEvent<unknown>).detail === panel) setArmed(true)
    }
    window.addEventListener(PANEL_CRASH_PROBE_EVENT, arm)
    return () => window.removeEventListener(PANEL_CRASH_PROBE_EVENT, arm)
  }, [panel])

  if (armed) {
    throw new Error(
      `PanelCrashProbe: the "${panel}" panel was asked to throw by a test (${PANEL_CRASH_PROBE_EVENT}).`,
    )
  }
  return null
}
