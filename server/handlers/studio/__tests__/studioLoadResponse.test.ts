/**
 * studioLoadResponse — unit tests for the pure `pageIds` query-param parser
 * and the pure missing-id reporter. End-to-end coverage of the actual
 * `GET /admin/api/studio/load?pageIds=` route lives in
 * `server/handlers/__tests__/studio.test.ts`.
 */
import { describe, expect, it } from 'bun:test'
import type { Page } from '@core/page-tree'
import { missingStudioLoadPageIds, parseStudioLoadPageIdsParam } from '../studioLoadResponse'

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

describe('missingStudioLoadPageIds', () => {
  // `pages` is what a NARROWED `loadStudioPages(dir, { pageIds })` already
  // returned — this reports on that set, it never filters a second time.
  it('undefined pageIds (no filter) reports undefined, which keeps an unfiltered response byte-identical', () => {
    expect(missingStudioLoadPageIds([stubPage('home'), stubPage('about')], undefined)).toBeUndefined()
  })

  it('every requested id present reports an empty array', () => {
    expect(missingStudioLoadPageIds([stubPage('about')], ['about'])).toEqual([])
  })

  it('reports a requested id the narrowed load produced no page for, without failing', () => {
    expect(missingStudioLoadPageIds([stubPage('home')], ['home', 'ghost-page'])).toEqual(['ghost-page'])
  })

  it('every requested id missing still reports, rather than erroring', () => {
    expect(missingStudioLoadPageIds([], ['ghost-1', 'ghost-2'])).toEqual(['ghost-1', 'ghost-2'])
  })

  it('a brand-new page id (never seen by the client) needs no special case — it is present, so it is not missing', () => {
    // studio_create_page: `loadStudioPages` re-walks the pages directory on
    // every call, so a page the client has never loaded is converted and
    // returned like any other as soon as the caller names its id.
    expect(missingStudioLoadPageIds([stubPage('contact')], ['contact'])).toEqual([])
  })
})
