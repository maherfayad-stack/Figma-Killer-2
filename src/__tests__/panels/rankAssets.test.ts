/**
 * rankAssets — the Assets panel's search.
 *
 * The queries in `PURPOSE_QUERIES` are the ones DS-6 exists for: a designer
 * types what a component is FOR ("header", "pill", "row"), not what the
 * library decided to call it. They are the same pairs DS-9's
 * `assets-search-coverage.test.ts` will assert against the REAL registry once
 * DS-1 has filled every module's keywords; here they run against synthetic
 * items so the ranking itself is under test, not the registry's data.
 */
import { describe, expect, it } from 'bun:test'
import { queryTokens, rankAssets, type RankableAsset } from '@site/panels/AssetsPanel/rankAssets'

function asset(name: string, keywords: string[] = [], description = ''): RankableAsset {
  return { name, keywords, description }
}

const NAVBAR = asset('Navbar', ['header', 'app bar', 'top bar', 'title'], 'The bar at the top of a screen.')
const CHIP = asset('Chip', ['pill', 'filter', 'tag'], 'A compact, selectable token.')
const CELL = asset('Cell', ['row', 'list row', 'setting'], 'One row of a list.')
const SNACKBAR = asset('Snackbar', ['toast', 'notification'], 'A brief message at the bottom of the screen.')
const TOGGLE = asset('Toggle', ['switch', 'on off'], 'A binary control.')
const SEPARATOR = asset('Separator', ['divider', 'rule', 'hairline'], 'A thin dividing line.')
const CONTAINER = asset('Container', ['box', 'div', 'wrapper', 'section', 'stack'], 'A generic grouping element.')
const BUTTON = asset('Button', ['action', 'cta', 'primary', 'destructive'], 'Buttons trigger actions.')
const BUTTON_GROUP = asset('ButtonGroup', ['segmented', 'actions'], 'Several buttons side by side.')

const CATALOG = [NAVBAR, CHIP, CELL, SNACKBAR, TOGGLE, SEPARATOR, CONTAINER, BUTTON, BUTTON_GROUP]

/** query → the name that must come back first. The DS-9 coverage table. */
const PURPOSE_QUERIES: [string, string][] = [
  ['header', 'Navbar'],
  ['pill', 'Chip'],
  ['row', 'Cell'],
  ['toast', 'Snackbar'],
  ['switch', 'Toggle'],
  ['divider', 'Separator'],
  ['wrapper', 'Container'],
]

describe('rankAssets', () => {
  it('returns everything, in source order, for an empty query', () => {
    const ranked = rankAssets('   ', CATALOG)

    expect(ranked.map((r) => r.item.name)).toEqual(CATALOG.map((item) => item.name))
    expect(ranked.every((r) => r.matchedKeyword === null)).toBe(true)
  })

  for (const [query, expected] of PURPOSE_QUERIES) {
    it(`finds ${expected} from the purpose "${query}"`, () => {
      const ranked = rankAssets(query, CATALOG)

      expect(ranked[0]?.item.name).toBe(expected)
    })
  }

  it('puts an exact name prefix above a component that merely mentions the word', () => {
    const ranked = rankAssets('button', CATALOG)

    expect(ranked[0]?.item.name).toBe('Button')
    expect(ranked.map((r) => r.item.name)).toContain('ButtonGroup')
  })

  it('reports the keyword that earned the hit so the card can show it', () => {
    const [top] = rankAssets('pill', CATALOG)

    expect(top?.item.name).toBe('Chip')
    expect(top?.matchedKeyword).toBe('pill')
  })

  it('reports no keyword when the NAME is what matched — the chip would be noise', () => {
    const [top] = rankAssets('chip', CATALOG)

    expect(top?.item.name).toBe('Chip')
    expect(top?.matchedKeyword).toBeNull()
  })

  it('matches an enum value carried as a keyword', () => {
    const [top] = rankAssets('destructive', CATALOG)

    expect(top?.item.name).toBe('Button')
    expect(top?.matchedKeyword).toBe('destructive')
  })

  it('falls back to the description when nothing else matches', () => {
    const ranked = rankAssets('dividing', CATALOG)

    expect(ranked.map((r) => r.item.name)).toEqual(['Separator'])
  })

  it('requires every token of a multi-word query to hit', () => {
    expect(rankAssets('app bar', CATALOG).map((r) => r.item.name)).toEqual(['Navbar'])
    // "bar" alone hits Navbar and Snackbar; adding a token that only Navbar
    // carries must narrow it, not widen it.
    expect(rankAssets('bar top', CATALOG).map((r) => r.item.name)).toEqual(['Navbar'])
    expect(rankAssets('pill navbar', CATALOG)).toEqual([])
  })

  it('keeps source order when two cards score the same', () => {
    // Both match "bar" the same way (name substring), so the section's own
    // order decides — a search must not shuffle equals between renders.
    const ranked = rankAssets('bar', CATALOG)

    expect(ranked.map((r) => r.item.name)).toEqual(['Navbar', 'Snackbar'])
  })

  it('drops everything when nothing matches', () => {
    expect(rankAssets('zzzznothing', CATALOG)).toEqual([])
  })
})

describe('queryTokens', () => {
  it('lowercases, splits on whitespace and drops empties', () => {
    expect(queryTokens('  Bottom   SHEET ')).toEqual(['bottom', 'sheet'])
    expect(queryTokens('   ')).toEqual([])
  })
})
