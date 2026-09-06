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
import {
  AUTOSAVE_MAX_DEFERRAL_MULTIPLE,
  nextAutoSaveDelayMs,
  resolveAutoSaveDelayMs,
} from '@site/hooks/usePersistence'
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

/**
 * The trailing debounce's starvation cap.
 *
 * The scheduler re-arms on every edit, which is what makes a typing burst
 * collapse into ONE save at the end of the burst instead of firing 2 s after
 * its first keystroke. Left uncapped that is also a way for a long burst to
 * keep the `.tsx` on disk permanently behind the canvas, so a burst gets a
 * budget: `AUTOSAVE_MAX_DEFERRAL_MULTIPLE` × the idle delay, after which the
 * next tick fires immediately.
 */
describe('nextAutoSaveDelayMs', () => {
  it('uses the full idle delay at the start of a burst', () => {
    expect(nextAutoSaveDelayMs(2_000, 0)).toBe(2_000)
  })

  it('still uses the full idle delay while the burst is inside its budget', () => {
    expect(nextAutoSaveDelayMs(2_000, 1_000)).toBe(2_000)
    expect(nextAutoSaveDelayMs(2_000, 5_000)).toBe(2_000)
  })

  it('trims the last tick so the burst never exceeds its total budget', () => {
    const budget = 2_000 * AUTOSAVE_MAX_DEFERRAL_MULTIPLE
    expect(nextAutoSaveDelayMs(2_000, budget - 500)).toBe(500)
  })

  it('fires on the next tick once the budget is spent, and never asks for a negative delay', () => {
    const budget = 2_000 * AUTOSAVE_MAX_DEFERRAL_MULTIPLE
    expect(nextAutoSaveDelayMs(2_000, budget)).toBe(0)
    expect(nextAutoSaveDelayMs(2_000, budget + 60_000)).toBe(0)
  })

  it('caps Studio at a bounded worst case, not an unbounded one', () => {
    const worstCaseMs = STUDIO_AUTOSAVE_DELAY_MS * AUTOSAVE_MAX_DEFERRAL_MULTIPLE
    expect(worstCaseMs).toBeGreaterThan(STUDIO_AUTOSAVE_DELAY_MS)
    expect(worstCaseMs).toBeLessThanOrEqual(15_000)
  })
})
