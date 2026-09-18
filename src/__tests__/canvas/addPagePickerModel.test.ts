/**
 * addPagePickerModel — the merged "Add page" picker's pure half.
 *
 * Carries the intent of the two components it replaced: `NewPageButton`'s kind
 * menu (every `PAGE_KINDS` preset is offered) and `AddFramePicker`'s filter
 * (every page NOT framed on the active board, and only those), plus what the
 * merge itself added — one query across both sections, the owning-board label,
 * and the Enter pick.
 */
import { describe, expect, it } from 'bun:test'
import {
  buildAddPageOptions,
  filterAddPageOptions,
  firstAddPageChoice,
  pageRelPath,
} from '@site/canvas/BoardFramesLayer/addPagePickerModel'
import { PAGE_KINDS, type Board } from '@core/studio-board'
import type { Page } from '@core/page-tree'
import { makePage } from '../fixtures'

function studioPage(id: string, title: string, rel: string): Page {
  return makePage({ id, title, rootNodeId: `${rel}:1:1` })
}

function board(id: string, name: string, pageIds: string[]): Board {
  return {
    id,
    name,
    frames: pageIds.map((pageId, index) => ({
      id: `${id}-frame-${index}`,
      pageId,
      x: 0,
      y: 0,
    })),
    notes: [],
    docs: [],
  }
}

const home = studioPage('home', 'Home', 'pages/Home.tsx')
const checkout = studioPage('checkout', 'Checkout', 'pages/Checkout.tsx')
const receipt = studioPage('receipt', 'Receipt', 'pages/Receipt.tsx')

describe('buildAddPageOptions', () => {
  it('offers every page kind, in PAGE_KINDS order', () => {
    const options = buildAddPageOptions({ pages: [], boards: [], activeBoard: board('b1', 'Flow', []) })

    expect(options.newPages.map((option) => option.kind)).toEqual(
      PAGE_KINDS.map((preset) => preset.kind),
    )
    expect(options.newPages.map((option) => option.label)).toEqual(
      PAGE_KINDS.map((preset) => preset.label),
    )
  })

  it('offers only pages that are not already framed on the active board', () => {
    const active = board('b1', 'Flow', ['home'])

    const options = buildAddPageOptions({
      pages: [home, checkout, receipt],
      boards: [active],
      activeBoard: active,
    })

    expect(options.existingPages.map((option) => option.pageId)).toEqual(['checkout', 'receipt'])
  })

  it('names the other board a page already sits on', () => {
    const active = board('b1', 'Flow', [])
    const other = board('b2', 'Payments', ['checkout'])

    const options = buildAddPageOptions({
      pages: [checkout, receipt],
      boards: [active, other],
      activeBoard: active,
    })

    expect(options.existingPages).toEqual([
      {
        pageId: 'checkout',
        title: 'Checkout',
        relPath: 'pages/Checkout.tsx',
        otherBoardName: 'Payments',
      },
      {
        pageId: 'receipt',
        title: 'Receipt',
        relPath: 'pages/Receipt.tsx',
        otherBoardName: null,
      },
    ])
  })

  it('still offers the page kinds with no active board, and no files', () => {
    const options = buildAddPageOptions({ pages: [home], boards: [], activeBoard: null })

    expect(options.newPages).toHaveLength(PAGE_KINDS.length)
    expect(options.existingPages).toEqual([])
  })

  it('leaves the path empty for a page whose id is not source-derived', () => {
    const cmsShaped = makePage({ id: 'p1', title: 'Untitled', rootNodeId: 'root' })

    expect(pageRelPath(cmsShaped)).toBe('')
  })
})

describe('filterAddPageOptions', () => {
  const active = board('b1', 'Flow', [])
  const options = buildAddPageOptions({
    pages: [home, checkout, receipt],
    boards: [active],
    activeBoard: active,
  })

  it('returns everything for an empty query', () => {
    expect(filterAddPageOptions(options, '   ')).toEqual(options)
  })

  it('narrows the New page section by kind label', () => {
    const filtered = filterAddPageOptions(options, 'popup')

    expect(filtered.newPages.map((option) => option.kind)).toEqual(['popup'])
    expect(filtered.existingPages).toEqual([])
  })

  it('narrows the From files section by page title', () => {
    const filtered = filterAddPageOptions(options, 'check')

    expect(filtered.newPages).toEqual([])
    expect(filtered.existingPages.map((option) => option.pageId)).toEqual(['checkout'])
  })

  it('narrows the From files section by source path', () => {
    const filtered = filterAddPageOptions(options, 'pages/receipt')

    expect(filtered.existingPages.map((option) => option.pageId)).toEqual(['receipt'])
  })

  it('matches both sections with one query', () => {
    const filtered = filterAddPageOptions(options, 'e')

    expect(filtered.newPages.length).toBeGreaterThan(0)
    expect(filtered.existingPages.length).toBeGreaterThan(0)
  })
})

describe('firstAddPageChoice', () => {
  const active = board('b1', 'Flow', [])
  const options = buildAddPageOptions({
    pages: [checkout],
    boards: [active],
    activeBoard: active,
  })

  it('prefers the first New page row', () => {
    expect(firstAddPageChoice(options)).toEqual({ kind: 'new', pageKind: 'screen' })
  })

  it('falls through to the first file row when no kind matches', () => {
    expect(firstAddPageChoice(filterAddPageOptions(options, 'checkout'))).toEqual({
      kind: 'existing',
      pageId: 'checkout',
    })
  })

  it('is null when nothing matches', () => {
    expect(firstAddPageChoice(filterAddPageOptions(options, 'zzzz'))).toBeNull()
  })
})
