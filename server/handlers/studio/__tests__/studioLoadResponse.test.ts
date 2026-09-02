/**
 * studioLoadResponse — unit tests for the pure `pageIds` query-param parser
 * and the pure page-subset selector. End-to-end coverage of the actual
 * `GET /admin/api/studio/load?pageIds=` route lives in
 * `server/handlers/__tests__/studio.test.ts`.
 */
import { describe, expect, it } from 'bun:test'
import type { Page } from '@core/page-tree'
import { filterStudioLoadPages, parseStudioLoadPageIdsParam } from '../studioLoadResponse'

function stubPage(id: string): Page {
  return {
    nodes: {},
    rootNodeId: 'root',
    id,
    slug: id,
    title: id,
  } as Page
}

describe('parseStudioLoadPageIdsParam', () => {
  it('returns undefined for a missing param — "no filter", the existing unfiltered contract', () => {
    expect(parseStudioLoadPageIdsParam(null)).toBeUndefined()
  })

  it('parses a comma-separated list, trimming whitespace', () => {
    expect(parseStudioLoadPageIdsParam('home, about ,contact')).toEqual(['home', 'about', 'contact'])
  })

  it('deduplicates repeated ids while preserving first-seen order', () => {
    expect(parseStudioLoadPageIdsParam('home,about,home')).toEqual(['home', 'about'])
  })

  it('a single id (no comma) parses to a one-element array', () => {
    expect(parseStudioLoadPageIdsParam('home')).toEqual(['home'])
  })

  it('returns null (caller error, not "no filter") for an empty string', () => {
    expect(parseStudioLoadPageIdsParam('')).toBeNull()
  })

  it('returns null for a whitespace/empty-segment-only param', () => {
    expect(parseStudioLoadPageIdsParam(' , , ')).toBeNull()
  })
})

describe('filterStudioLoadPages', () => {
  const pages = [stubPage('home'), stubPage('about'), stubPage('contact')]

  it('undefined pageIds (no filter) returns every page unchanged and missingPageIds undefined', () => {
    const result = filterStudioLoadPages(pages, undefined)
    expect(result.pages.map((p) => p.id)).toEqual(['home', 'about', 'contact'])
    expect(result.missingPageIds).toBeUndefined()
  })

  it('selects only the requested subset', () => {
    const result = filterStudioLoadPages(pages, ['about'])
    expect(result.pages.map((p) => p.id)).toEqual(['about'])
    expect(result.missingPageIds).toEqual([])
  })

  it('reports a requested id matching no page as missingPageIds, without failing', () => {
    const result = filterStudioLoadPages(pages, ['home', 'ghost-page'])
    expect(result.pages.map((p) => p.id)).toEqual(['home'])
    expect(result.missingPageIds).toEqual(['ghost-page'])
  })

  it('every requested id missing still returns ok with an empty pages array', () => {
    const result = filterStudioLoadPages(pages, ['ghost-1', 'ghost-2'])
    expect(result.pages).toEqual([])
    expect(result.missingPageIds).toEqual(['ghost-1', 'ghost-2'])
  })

  it('a brand-new page id (not previously seen by the client) is returned like any other match — no special case needed', () => {
    // Simulates studio_create_page: the caller asks for an id it has never
    // loaded before. filterStudioLoadPages has no notion of "seen before" —
    // it only checks whether the id is present in the freshly-computed
    // `pages` array, which is exactly what makes a new page reachable.
    const result = filterStudioLoadPages(pages, ['contact'])
    expect(result.pages.map((p) => p.id)).toEqual(['contact'])
    expect(result.missingPageIds).toEqual([])
  })
})
