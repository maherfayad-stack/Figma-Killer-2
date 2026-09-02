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
import { addImportedColorTokens, overwriteImportedColorTokens } from './importedColorTokens'

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

  it('leaves `origin` unset — undefined re-emits, same as `studio-authored` (STUDIO-FIGMA-PARITY-PLAN.md T4)', () => {
    const site = emptySite()
    const next = create(site, (draft) => {
      addImportedColorTokens(draft, [{ slug: 'brand', value: '#fff' }])
    })
    expect(next.settings.framework!.colors!.tokens[0]!.origin).toBeUndefined()
  })
})

describe('overwriteImportedColorTokens', () => {
  it('clears a stale extracted `origin` on overwrite — the new value no longer matches the project\'s own CSS', () => {
    // Simulates a slug collision between a `tokenExtractBuild.ts`-extracted
    // token and a value imported from a DIFFERENT site: the extracted token
    // is being overwritten with a value that has nothing to do with the
    // currently open project's own stylesheet, so it must start re-emitting
    // (`origin: undefined`) or the canvas would silently keep showing the
    // OLD, still-accurate-to-disk value instead of this overwrite.
    const site: SiteDocument = {
      settings: {
        framework: {
          colors: {
            tokens: [
              {
                id: 'extracted-token',
                category: '',
                slug: 'aqua',
                lightValue: '#0c9ab0',
                darkValue: '',
                darkModeEnabled: false,
                generateUtilities: { text: true, background: true, border: true, fill: false },
                generateTransparent: false,
                generateShades: { enabled: false, count: 0 },
                generateTints: { enabled: false, count: 0 },
                order: 0,
                createdAt: 0,
                updatedAt: 0,
                origin: 'project-css',
              },
            ],
          },
        },
      },
    } as unknown as SiteDocument

    const next = create(site, (draft) => {
      overwriteImportedColorTokens(draft, [{ existingTokenId: 'extracted-token', value: '#ff00aa' }])
    })
    const token = next.settings.framework!.colors!.tokens[0]!
    expect(token.lightValue).toBe('#ff00aa')
    expect(token.origin).toBeUndefined()
  })
})
