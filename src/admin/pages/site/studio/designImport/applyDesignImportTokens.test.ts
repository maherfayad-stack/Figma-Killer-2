/**
 * applyDesignImportTokens — dark-mode passthrough coverage. Guards the fix
 * for the root cause described in `parseCssTokens.ts`: before it, every
 * candidate landed with `darkValue: ''` / `darkModeEnabled: false`
 * regardless of what the source declared, because the dark half was
 * discarded before it ever reached this module. These tests exercise the
 * OTHER end of that fix — that a `ColorCandidate.dark` value, once it
 * survives the HTTP boundary, is actually passed through to
 * `createFrameworkColorToken`/`updateFrameworkColorToken` as `darkValue` +
 * `darkModeEnabled: true`, and that a candidate with no dark value never
 * fabricates one.
 */
import { describe, expect, it } from 'bun:test'
import type { FrameworkColorToken } from '@core/framework-schema'
import { applyDesignImportTokens } from './applyDesignImportTokens'
import type { ColorCandidate } from './designImportApi'

type ApplyStore = Parameters<typeof applyDesignImportTokens>[0]

function makeCandidate(overrides: Partial<ColorCandidate> = {}): ColorCandidate {
  return { id: 'c1', name: 'brand', value: '#fff', file: 'a.css', ...overrides }
}

function stubColorToken(overrides: Partial<FrameworkColorToken> = {}): FrameworkColorToken {
  const now = Date.now()
  return {
    id: 'tok-1',
    category: '',
    slug: 'brand',
    lightValue: '#fff',
    darkValue: '',
    darkModeEnabled: false,
    generateUtilities: { text: true, background: true, border: true, fill: false },
    generateTransparent: true,
    generateShades: { enabled: true, count: 4 },
    generateTints: { enabled: true, count: 4 },
    order: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function neverCalled(label: string) {
  return () => {
    throw new Error(`${label} should not be called in this test`)
  }
}

describe('applyDesignImportTokens — color dark-mode passthrough', () => {
  it('sets darkValue + darkModeEnabled: true only for a candidate carrying a real dark value (create path)', () => {
    const createCalls: unknown[] = []
    const store = {
      site: { settings: { framework: { colors: { tokens: [] } } } },
      createFrameworkColorToken: (input: unknown) => {
        createCalls.push(input)
        return stubColorToken()
      },
      updateFrameworkColorToken: neverCalled('updateFrameworkColorToken'),
      createFrameworkTypographyGroup: neverCalled('createFrameworkTypographyGroup'),
      updateFrameworkTypographyGroup: neverCalled('updateFrameworkTypographyGroup'),
      createFrameworkSpacingGroup: neverCalled('createFrameworkSpacingGroup'),
      updateFrameworkSpacingGroup: neverCalled('updateFrameworkSpacingGroup'),
    } as unknown as ApplyStore

    const result = applyDesignImportTokens(store, 'acme/tokens', {
      colors: [
        makeCandidate({ id: 'c1', name: 'brand', value: '#fff', dark: '#111' }),
        makeCandidate({ id: 'c2', name: 'muted', value: '#eee' }), // no dark value at all
      ],
      typography: [],
      spacing: [],
    })

    expect(result.colorsApplied).toBe(2)
    expect(createCalls[0]).toMatchObject({
      slug: 'brand',
      lightValue: '#fff',
      darkValue: '#111',
      darkModeEnabled: true,
    })
    // No dark value on the candidate -> no dark fields at all in the create
    // input, never a fabricated `darkModeEnabled: false`/`darkValue: ''`.
    expect(createCalls[1]).toMatchObject({ slug: 'muted', lightValue: '#eee' })
    expect(createCalls[1]).not.toHaveProperty('darkModeEnabled')
    expect(createCalls[1]).not.toHaveProperty('darkValue')
  })

  it('patches darkValue + darkModeEnabled: true only for a candidate carrying a real dark value (update path, existing slug match)', () => {
    const updateCalls: Array<{ id: string; patch: unknown }> = []
    const existingToken = stubColorToken({ id: 'tok-existing', slug: 'brand', lightValue: '#000' })
    const store = {
      site: { settings: { framework: { colors: { tokens: [existingToken] } } } },
      createFrameworkColorToken: neverCalled('createFrameworkColorToken'),
      updateFrameworkColorToken: (id: string, patch: unknown) => {
        updateCalls.push({ id, patch })
        return stubColorToken()
      },
      createFrameworkTypographyGroup: neverCalled('createFrameworkTypographyGroup'),
      updateFrameworkTypographyGroup: neverCalled('updateFrameworkTypographyGroup'),
      createFrameworkSpacingGroup: neverCalled('createFrameworkSpacingGroup'),
      updateFrameworkSpacingGroup: neverCalled('updateFrameworkSpacingGroup'),
    } as unknown as ApplyStore

    applyDesignImportTokens(store, 'acme/tokens', {
      colors: [makeCandidate({ id: 'c1', name: 'brand', value: '#fff', dark: '#222' })],
      typography: [],
      spacing: [],
    })

    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0]!.id).toBe('tok-existing')
    expect(updateCalls[0]!.patch).toMatchObject({ lightValue: '#fff', darkValue: '#222', darkModeEnabled: true })
  })

  it('leaves an existing token dark settings untouched on re-import when the candidate has no dark value', () => {
    const updateCalls: Array<{ id: string; patch: unknown }> = []
    const existingToken = stubColorToken({
      id: 'tok-existing',
      slug: 'brand',
      lightValue: '#000',
      darkValue: '#custom',
      darkModeEnabled: true,
    })
    const store = {
      site: { settings: { framework: { colors: { tokens: [existingToken] } } } },
      createFrameworkColorToken: neverCalled('createFrameworkColorToken'),
      updateFrameworkColorToken: (id: string, patch: unknown) => {
        updateCalls.push({ id, patch })
        return stubColorToken()
      },
      createFrameworkTypographyGroup: neverCalled('createFrameworkTypographyGroup'),
      updateFrameworkTypographyGroup: neverCalled('updateFrameworkTypographyGroup'),
      createFrameworkSpacingGroup: neverCalled('createFrameworkSpacingGroup'),
      updateFrameworkSpacingGroup: neverCalled('updateFrameworkSpacingGroup'),
    } as unknown as ApplyStore

    applyDesignImportTokens(store, 'acme/tokens', {
      colors: [makeCandidate({ id: 'c1', name: 'brand', value: '#fff' })],
      typography: [],
      spacing: [],
    })

    expect(updateCalls[0]!.patch).toMatchObject({ lightValue: '#fff' })
    expect(updateCalls[0]!.patch).not.toHaveProperty('darkValue')
    expect(updateCalls[0]!.patch).not.toHaveProperty('darkModeEnabled')
  })
})
