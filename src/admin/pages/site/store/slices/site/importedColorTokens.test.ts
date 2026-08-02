/**
 * addImportedColorTokens — dark-value passthrough coverage. Before this fix,
 * every imported color token hardcoded `darkValue: ''` / `darkModeEnabled:
 * false` regardless of what the caller supplied (see `ImportColorToken.dark`'s
 * doc) — this is the "Super Import" site-import path's half of the same
 * class of bug the GitHub/npm design-import wizard had.
 */
import { describe, expect, it } from 'bun:test'
import { create } from 'mutative'
import type { SiteDocument } from '@core/page-tree'
import { addImportedColorTokens } from './importedColorTokens'

function emptySite(): SiteDocument {
  return {
    settings: { framework: { colors: { tokens: [] } } },
  } as unknown as SiteDocument
}

describe('addImportedColorTokens', () => {
  it('sets darkValue + darkModeEnabled: true when the token carries a dark value that differs from light', () => {
    const site = emptySite()
    const next = create(site, (draft) => {
      addImportedColorTokens(draft, [{ slug: 'brand', value: '#fff', dark: '#111' }])
    })
    const token = next.settings.framework!.colors!.tokens[0]!
    expect(token.lightValue).toBe('#fff')
    expect(token.darkValue).toBe('#111')
    expect(token.darkModeEnabled).toBe(true)
  })

  it('does not enable dark mode when no dark value is supplied', () => {
    const site = emptySite()
    const next = create(site, (draft) => {
      addImportedColorTokens(draft, [{ slug: 'brand', value: '#fff' }])
    })
    const token = next.settings.framework!.colors!.tokens[0]!
    expect(token.darkValue).toBe('')
    expect(token.darkModeEnabled).toBe(false)
  })

  it('does not enable dark mode when the supplied dark value equals the light value', () => {
    const site = emptySite()
    const next = create(site, (draft) => {
      addImportedColorTokens(draft, [{ slug: 'brand', value: '#fff', dark: '#fff' }])
    })
    const token = next.settings.framework!.colors!.tokens[0]!
    expect(token.darkValue).toBe('')
    expect(token.darkModeEnabled).toBe(false)
  })
})
