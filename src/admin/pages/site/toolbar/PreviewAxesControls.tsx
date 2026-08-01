/**
 * PreviewAxesControls — WS-10's board-global direction (RTL), dark-mode, and
 * (§4.2, Phase 3) locale controls.
 *
 * Direction and dark-mode are RENDER-TIME (see `previewAxes.ts`'s module
 * doc) — toggling either is free: no re-parse, no frame remount (the canvas
 * applies them via an attribute effect, `IframeFrameSurface.tsx`).
 *
 * Locale is the ONE axis that is different in kind: `preferredKey` selects a
 * DICTIONARY BRANCH during evaluation (`staticEvalCore.ts`'s
 * `evaluateElementAccess`), which is parse-time. Switching it costs a real
 * project re-parse — `configHash` (`studioPageLoad.ts`) already includes
 * `preferredKey`, so the cache correctly busts and switching BACK to a
 * previously-parsed locale is free; the client side of that cost is: persist
 * the new locale, then `requestCmsSiteReload()`, which re-fetches the whole
 * site document. The `Select` disables itself for the duration
 * (`isReparsing`) so a second click can't queue a second reload mid-flight.
 *
 * Both the dark-mode button and the locale `Select` can be genuinely
 * inapplicable — a project with no detectable mechanism/dictionary renders
 * DISABLED WITH THE REASON in its tooltip/label (WS-10 §7.4 "probe
 * honesty"), never a silent no-op. Direction has no such gate: `dir` always
 * applies (whether the result looks CORRECT for a project written with
 * physical CSS properties is a separate, honest finding —
 * `RTL_PHYSICAL_PROPERTY` — not a reason to disable the toggle itself).
 *
 * Same shape as `ZoomControls.tsx`: a `role="group"` of controls, disabled +
 * reason for the inapplicable case, never an absent control.
 */
import { useState, useSyncExternalStore, type ChangeEvent } from 'react'
import { useAdminUi } from '@admin/state/adminUi'
import { useEditorStore } from '@site/store/store'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { Button } from '@ui/components/Button'
import { Select } from '@ui/components/Select'
import {
  getColorSchemeCapability,
  getLocalesCapability,
  savePreviewAxes,
  subscribeColorSchemeCapability,
  subscribeLocalesCapability,
} from '@site/studio/previewAxesCapability'
import styles from './PreviewAxesControls.module.css'

const NO_DARK_MODE_REASON = 'No dark-mode stylesheet was detected in this project (no `.dark`/`[data-theme]` selector and no `@media (prefers-color-scheme: dark)` rule).'
const NO_LOCALE_REASON = 'No locale dictionary was detected in this project (no `translations[lang]`-style index, i18next/react-intl `resources` map, or `locales/*.json` directory).'

export function PreviewAxesControls() {
  const dir = useAdminUi((s) => s.studioProject?.dir ?? null)
  const previewAxes = useEditorStore((s) => s.previewAxes)
  const setPreviewAxes = useEditorStore((s) => s.setPreviewAxes)
  const colorScheme = useSyncExternalStore(subscribeColorSchemeCapability, getColorSchemeCapability, getColorSchemeCapability)
  const locales = useSyncExternalStore(subscribeLocalesCapability, getLocalesCapability, getLocalesCapability)
  const [isReparsing, setIsReparsing] = useState(false)

  const isRtl = previewAxes.direction === 'rtl'
  const isDark = previewAxes.colorScheme === 'dark'
  const schemeApplies = colorScheme !== null && colorScheme.mechanism !== 'none'
  const localeApplies = locales !== null

  const toggleDirection = () => {
    const direction = isRtl ? 'ltr' : 'rtl'
    setPreviewAxes({ direction })
    if (dir) void savePreviewAxes(dir, { direction })
  }

  const toggleScheme = () => {
    const colorSchemeValue = isDark ? 'light' : 'dark'
    setPreviewAxes({ colorScheme: colorSchemeValue })
    if (dir) void savePreviewAxes(dir, { colorScheme: colorSchemeValue })
  }

  const currentLocale = previewAxes.locale ?? locales?.defaultKey ?? locales?.keys[0] ?? ''

  const handleLocaleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const locale = event.target.value
    if (!locale || locale === currentLocale || isReparsing) return
    setPreviewAxes({ locale })
    setIsReparsing(true)
    void (async () => {
      try {
        if (dir) await savePreviewAxes(dir, { locale })
      } finally {
        // Re-parse machinery already exists (`configHash` includes
        // `preferredKey`) — this reload is what actually asks for it.
        requestCmsSiteReload()
        setIsReparsing(false)
      }
    })()
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
      <span title={localeApplies ? undefined : NO_LOCALE_REASON}>
        <Select
          fieldSize="sm"
          aria-label={
            localeApplies
              ? `Preview locale: ${currentLocale}.${isReparsing ? ' Re-parsing…' : ' Click to switch (re-parses the project).'}`
              : NO_LOCALE_REASON
          }
          data-testid="toolbar-preview-locale"
          disabled={!localeApplies || isReparsing}
          value={localeApplies ? currentLocale : ''}
          onChange={handleLocaleChange}
          options={(locales?.keys ?? []).map((key) => ({ value: key, label: key.toUpperCase() }))}
          placeholder={localeApplies ? undefined : '—'}
          className={styles.localeSelect}
        />
      </span>
    </div>
  )
}
