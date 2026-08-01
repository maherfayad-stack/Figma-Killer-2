/**
 * PreviewAxesControls — WS-10 Phase 1 §5.1: the board-global direction (RTL)
 * and dark-mode toggle. Both axes are render-time (see `previewAxes.ts`'s
 * module doc) — toggling either is free: no re-parse, no frame remount (the
 * canvas applies them via an attribute effect, `IframeFrameSurface.tsx`).
 *
 * The dark-mode button is the one that can be genuinely inapplicable — a
 * project with no detectable dark-mode mechanism renders it DISABLED WITH
 * THE REASON in its tooltip (WS-10 §7.4 "probe honesty"), never a silent
 * no-op toggle. Direction has no such gate: `dir` always applies (whether the
 * result looks CORRECT for a project written with physical CSS properties is
 * a separate, honest finding — `RTL_PHYSICAL_PROPERTY` — not a reason to
 * disable the toggle itself).
 *
 * Same shape as `ZoomControls.tsx`: a `role="group"` of `Button`s, disabled +
 * tooltip for the inapplicable case, never an absent control.
 */
import { useAdminUi } from '@admin/state/adminUi'
import { useEditorStore } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { useSyncExternalStore } from 'react'
import { getColorSchemeCapability, savePreviewAxes, subscribeColorSchemeCapability } from '@site/studio/previewAxesCapability'
import styles from './PreviewAxesControls.module.css'

const NO_DARK_MODE_REASON = 'No dark-mode stylesheet was detected in this project (no `.dark`/`[data-theme]` selector and no `@media (prefers-color-scheme: dark)` rule).'

export function PreviewAxesControls() {
  const dir = useAdminUi((s) => s.studioProject?.dir ?? null)
  const previewAxes = useEditorStore((s) => s.previewAxes)
  const setPreviewAxes = useEditorStore((s) => s.setPreviewAxes)
  const capability = useSyncExternalStore(subscribeColorSchemeCapability, getColorSchemeCapability, getColorSchemeCapability)

  const isRtl = previewAxes.direction === 'rtl'
  const isDark = previewAxes.colorScheme === 'dark'
  const schemeApplies = capability !== null && capability.mechanism !== 'none'

  const toggleDirection = () => {
    const direction = isRtl ? 'ltr' : 'rtl'
    setPreviewAxes({ direction })
    if (dir) void savePreviewAxes(dir, { direction })
  }

  const toggleScheme = () => {
    const colorScheme = isDark ? 'light' : 'dark'
    setPreviewAxes({ colorScheme })
    if (dir) void savePreviewAxes(dir, { colorScheme })
  }

  return (
    <div role="group" aria-label="Preview axes" data-testid="toolbar-preview-axes" className={styles.axesGroup}>
      <Button
        variant="ghost"
        size="sm"
        pressed={isRtl}
        aria-label={`Preview direction: ${isRtl ? 'right-to-left' : 'left-to-right'}. Click to switch.`}
        tooltip={isRtl ? 'Previewing right-to-left — click for left-to-right' : 'Previewing left-to-right — click for right-to-left'}
        onClick={toggleDirection}
        className={styles.axisButton}
      >
        {isRtl ? 'RTL' : 'LTR'}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        pressed={isDark}
        aria-label={`Preview color scheme: ${isDark ? 'dark' : 'light'}. ${schemeApplies ? 'Click to switch.' : NO_DARK_MODE_REASON}`}
        tooltip={schemeApplies ? (isDark ? 'Previewing dark — click for light' : 'Previewing light — click for dark') : NO_DARK_MODE_REASON}
        disabled={!schemeApplies}
        onClick={toggleScheme}
        className={styles.axisButton}
      >
        {isDark ? 'Dark' : 'Light'}
      </Button>
    </div>
  )
}
