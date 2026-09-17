/**
 * rankAssets — the Assets panel's search.
 *
 * The queries in `PURPOSE_QUERIES` are the ones DS-6 exists for: a designer
 * types what a component is FOR ("header", "pill", "row"), not what the
 * library decided to call it.
 *
 * They are asserted TWICE, on purpose:
 *
 *   - against the synthetic `CATALOG` below, so a ranking regression is
 *     diagnosable without the registry in the frame; and
 *   - against the REAL merged registry (the last `describe`), because the
 *     ranking and the keyword data are two halves of one promise and each can
 *     be right while the pair is wrong — a component whose keywords are fine
 *     still loses if a sibling outranks it on a substring nobody thought
 *     about. `src/__tests__/architecture/assets-search-coverage.test.ts`
 *     holds the same table with its own crude scorer; keep the three lists
 *     identical.
 */
import { describe, expect, it } from 'bun:test'
import { queryTokens, rankAssets, type RankableAsset } from '@site/panels/AssetsPanel/rankAssets'
import { registry } from '@core/module-engine'
import {
  buildAssetItems,
  type ModuleInsertionContext,
} from '@site/panels/AssetsPanel/assetsModel'
import { buildColorAssetItems } from '@site/panels/AssetsPanel/colorTokens'
// Side-effect registration, exactly as `canvasModuleSet.ts` does it — the real
// registry is the point of the last `describe` in this file.
import '@modules/base'
import '@modules/alm/register'

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

/** query → the name that must come back first. The shared coverage table. */
const PURPOSE_QUERIES: [string, string][] = [
  ['header', 'Navbar'],
  ['pill', 'Chip'],
  ['row', 'Cell'],
  ['toast', 'Snackbar'],
  ['switch', 'Toggle'],
  ['divider', 'Separator'],
  ['wrapper', 'Container'],
]

/**
 * The same seven rows keyed by MODULE ID — byte-for-byte
 * `assets-search-coverage.test.ts`'s `EXPECTED_FIRST_HIT`.
 */
const PURPOSE_QUERIES_BY_MODULE_ID: [string, string][] = [
  ['header', 'alm.Navbar'],
  ['pill', 'alm.Chip'],
  ['row', 'alm.Cell'],
  ['toast', 'alm.Snackbar'],
  ['switch', 'alm.Toggle'],
  ['divider', 'alm.Separator'],
  ['wrapper', 'base.container'],
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

/**
 * The same table, run through the SAME `rankAssets` the panel calls, over the
 * REAL registry.
 *
 * Two populations, because they answer two different questions:
 *
 *   - **Every registered module** — the data question, and the same
 *     population `assets-search-coverage.test.ts` scores. `toast` must resolve
 *     to `alm.Snackbar` even though the panel never shows a Snackbar card:
 *     Snackbar is one of the five palette-hidden overlays, and its keywords
 *     still have to be right, because the DOM panel's right-click picker and
 *     every future surface read the same model.
 *   - **What the panel actually offers** — the product question. Six of the
 *     seven rows are insertable and must come first there too.
 */
describe('rankAssets over the real registry', () => {
  const PAGE_CONTEXT: ModuleInsertionContext = {
    isVCMode: false,
    activeVcId: null,
    isTemplate: false,
    hasOutlet: false,
  }

  /** Every REGISTERED module as a rankable item — visible or not. */
  const allModuleAssets = registry.list().map((mod) => ({
    id: mod.id,
    name: mod.name,
    description: mod.description ?? '',
    keywords: mod.keywords ?? [],
  }))

  const { moduleItems } = buildAssetItems({
    modules: registry.list(),
    context: PAGE_CONTEXT,
    savedLayouts: [],
    visualComponents: [],
  })

  it('offers the design system and the base elements at all', () => {
    expect(moduleItems.some((item) => item.id.startsWith('alm.'))).toBe(true)
    expect(moduleItems.some((item) => item.id === 'base.container')).toBe(true)
  })

  for (const [query, expectedId] of PURPOSE_QUERIES_BY_MODULE_ID) {
    it(`puts ${expectedId} first for "${query}"`, () => {
      const ranked = rankAssets(query, allModuleAssets)

      expect(ranked.length).toBeGreaterThan(0)
      expect(ranked[0]?.item.id).toBe(expectedId)
      // Unambiguous, not merely first: a tie would make the order depend on
      // registration order, which is not a promise this data can keep.
      if (ranked.length > 1) expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score)
    })
  }

  for (const [query, expectedId] of PURPOSE_QUERIES_BY_MODULE_ID) {
    // Snackbar is palette-hidden (an overlay you place in source, not from a
    // card), so the panel is EXPECTED to find nothing for "toast" — asserted
    // below rather than skipped, so unhiding it is a visible change here.
    if (expectedId === 'alm.Snackbar') continue
    it(`offers ${expectedId} first in the panel for "${query}"`, () => {
      const ranked = rankAssets(query, moduleItems)

      expect(ranked[0]?.item.id).toBe(expectedId)
    })
  }

  it('finds no CARD for "toast" — the Snackbar is a hidden overlay, by design', () => {
    expect(rankAssets('toast', moduleItems)).toEqual([])
    expect(rankAssets('toast', allModuleAssets)[0]?.item.id).toBe('alm.Snackbar')
  })
})

/**
 * DS-7 — the design system's colour tokens ride the SAME ranker. They are not
 * `AssetItem`s (nothing inserts a colour), they are `RankableAsset`s, which is
 * the whole contract this file tests: a section supplies name, description and
 * keywords, and gets a ranked list back.
 *
 * The keywords a colour carries are its family, its own name (whole and split
 * on `-`), and both hex values — so the three ways a designer asks for a
 * colour all land.
 */
describe('rankAssets over the colour palette', () => {
  const colorItems = buildColorAssetItems()

  it('ranks a whole palette without any module in the frame', () => {
    expect(colorItems.length).toBeGreaterThan(100)
    expect(rankAssets('', colorItems).map((r) => r.item.name)).toEqual(
      colorItems.map((item) => item.name),
    )
  })

  it('reports the family as the matched keyword so the hit is explainable', () => {
    const [top] = rankAssets('coral', colorItems)

    expect(top?.item.name).toBe('--color-coral-10')
    expect(top?.matchedKeyword).toBe('Coral')
  })

  it('finds a token by the hex a designer pasted in', () => {
    expect(rankAssets('#E9666F', colorItems)[0]?.item.name).toBe('--color-coral-100')
  })

  it('narrows a family with a second token, same AND rule as components', () => {
    expect(rankAssets('coral 100', colorItems).map((r) => r.item.name)).toEqual([
      '--color-coral-100',
    ])
  })

  it('drops the palette entirely for a component query', () => {
    expect(rankAssets('navbar', colorItems)).toEqual([])
  })
})
