/**
 * Auto-save cadence precedence — `resolveAutoSaveDelayMs` (usePersistence.ts).
 *
 * Phase 5B: Studio source writeback should feel snappy without inheriting the
 * CMS's slower, user-configurable idle-commit delay (default 30s). Rather
 * than forking usePersistence for Studio, the Site editor shell passes an
 * explicit `autoSaveDelayMs` override (`STUDIO_AUTOSAVE_DELAY_MS`, 2s) that
 * wins over the preference. This pins the precedence rule as a pure,
 * timer-free unit test — no React mount, no waiting on real timeouts.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { resolveAutoSaveDelayMs } from '@site/hooks/usePersistence'
import { STUDIO_AUTOSAVE_DELAY_MS } from '@site/studio/fsCodemodAdapter'
import { EDITOR_PREFS_KEY, setEditorSelectPreference } from '@site/preferences/editorPreferences'

afterEach(() => {
  globalThis.localStorage?.removeItem(EDITOR_PREFS_KEY)
})

describe('resolveAutoSaveDelayMs', () => {
  it('falls back to the CMS preference (default 30s) with no override', () => {
    expect(resolveAutoSaveDelayMs(undefined)).toBe(30_000)
  })

  it('still honors a user-changed CMS preference with no override', () => {
    setEditorSelectPreference('autoSaveDelay', '5')
    expect(resolveAutoSaveDelayMs(undefined)).toBe(5_000)
  })

  it("Studio's fixed override wins over the CMS preference, whatever it is set to", () => {
    setEditorSelectPreference('autoSaveDelay', '300')
    expect(resolveAutoSaveDelayMs(STUDIO_AUTOSAVE_DELAY_MS)).toBe(STUDIO_AUTOSAVE_DELAY_MS)
  })

  it('the Studio cadence sits inside the ~1.5-3s "snappy" target band, below the CMS default', () => {
    expect(STUDIO_AUTOSAVE_DELAY_MS).toBeGreaterThanOrEqual(1_500)
    expect(STUDIO_AUTOSAVE_DELAY_MS).toBeLessThanOrEqual(3_000)
    expect(STUDIO_AUTOSAVE_DELAY_MS).toBeLessThan(30_000)
  })
})
