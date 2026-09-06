import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  EDITOR_PREFS_KEY,
  applyEditorAppearancePreferencesToDocument,
  readEditorSelectPreference,
  resolveEditorTheme,
  setEditorSelectPreference,
} from '@site/preferences/editorPreferences'
import { PREFERENCE_CATALOG } from '@site/preferences/catalog'

function resetAppearanceState() {
  localStorage.clear()
  document.documentElement.removeAttribute('data-editor-density')
  document.documentElement.removeAttribute('data-editor-theme')
  document.documentElement.removeAttribute('data-editor-text-scale')
}

beforeEach(resetAppearanceState)
afterEach(resetAppearanceState)

describe('editor appearance preferences', () => {
  it('defaults to dark theme and default text size without changing density', () => {
    expect(readEditorSelectPreference('theme')).toBe('dark')
    expect(readEditorSelectPreference('textScale')).toBe('default')
    expect(readEditorSelectPreference('density')).toBe('compact')
  })

  it('persists theme and text size with the rest of the editor prefs', () => {
    setEditorSelectPreference('theme', 'light')
    setEditorSelectPreference('textScale', 'large')

    const stored = JSON.parse(localStorage.getItem(EDITOR_PREFS_KEY) ?? '{}')
    expect(stored.theme).toBe('light')
    expect(stored.textScale).toBe('large')
  })

  it('applies appearance preferences to the document root for global token scopes', () => {
    applyEditorAppearancePreferencesToDocument(document, {
      density: 'comfortable',
      theme: 'light',
      textScale: 'extra-large',
    })

    expect(document.documentElement.getAttribute('data-editor-density')).toBe('comfortable')
    expect(document.documentElement.getAttribute('data-editor-theme')).toBe('light')
    expect(document.documentElement.getAttribute('data-editor-text-scale')).toBe('extra-large')
  })
})

describe('theme is a three-state preference stamped as two', () => {
  it('offers dark, light and system in the catalog', () => {
    const theme = PREFERENCE_CATALOG.find((def) => def.id === 'theme')
    expect(theme?.type).toBe('select')
    const values = theme?.type === 'select' ? theme.options.map((o) => o.value) : []
    expect(values).toEqual(['dark', 'light', 'system'])
  })

  it("resolves 'system' against prefers-color-scheme in both directions", () => {
    expect(resolveEditorTheme('system', true)).toBe('light')
    expect(resolveEditorTheme('system', false)).toBe('dark')
  })

  it('leaves an explicit choice alone regardless of the OS setting', () => {
    expect(resolveEditorTheme('light', false)).toBe('light')
    expect(resolveEditorTheme('dark', true)).toBe('dark')
  })

  it('resolves an unrecognised stored value to dark, the catalog default', () => {
    // A newer build could write a theme this one has never heard of; the
    // stylesheet only gates on 'light', so anything else must fall to dark
    // rather than stamping an attribute value that matches no token block.
    expect(resolveEditorTheme('midnight-neon', true)).toBe('dark')
  })

  it('persists the raw preference, not the resolved one', () => {
    setEditorSelectPreference('theme', 'system')

    const stored = JSON.parse(localStorage.getItem(EDITOR_PREFS_KEY) ?? '{}')
    expect(stored.theme).toBe('system')
    expect(readEditorSelectPreference('theme')).toBe('system')
  })
})
