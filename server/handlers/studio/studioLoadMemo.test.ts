/**
 * W9-5 lever 1 — the `loadStudioPages` memo's INVALIDATION contract.
 *
 * The perf half (26 ms → 2.7 ms on a 36-page project) is a benchmark number,
 * not a test: a timing assertion in a shared CI runner is a flake generator.
 * What is tested here is the only thing that can actually break — that a memo
 * hit never serves a result a fresh load would not have produced. Every case
 * below is a way the workspace can change that the fingerprint must catch, plus
 * the aliasing guarantee that lets two tools hold the result at once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadStudioPages } from '../studioPageLoad'
import { clearStudioLoadMemo } from './studioLoadMemo'

function page(heading: string): string {
  return `export default function Page() {\n  return <div><h1>${heading}</h1></div>\n}\n`
}

function headingOf(pages: Array<{ id: string; nodes: Record<string, { props: Record<string, unknown> }> }>, pageId: string): string {
  const found = pages.find((p) => p.id === pageId)
  if (!found) throw new Error(`page "${pageId}" not in result`)
  const texts = Object.values(found.nodes)
    .map((node) => node.props.text)
    .filter((text): text is string => typeof text === 'string')
  return texts.join('|')
}

describe('loadStudioPages memo — invalidation', () => {
  let dir: string

  beforeEach(() => {
    clearStudioLoadMemo()
    dir = mkdtempSync(join(tmpdir(), 'studio-load-memo-'))
    mkdirSync(join(dir, 'pages'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { react: '^18.0.0' } }))
    writeFileSync(join(dir, 'pages', 'Home.tsx'), page('Before'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('serves the same content on a repeat load with nothing changed', async () => {
    const first = await loadStudioPages(dir)
    const second = await loadStudioPages(dir)
    expect(second.pages.map((p) => p.id)).toEqual(first.pages.map((p) => p.id))
    expect(headingOf(second.pages, 'home')).toBe('Before')
  })

  it('an EDITED page file invalidates — the memo never serves the old text', async () => {
    expect(headingOf((await loadStudioPages(dir)).pages, 'home')).toBe('Before')
    // `mtimeMs` has sub-millisecond resolution on the platforms this runs on,
    // but the fingerprint also covers size, and "After" differs in length —
    // belt and braces against a same-millisecond rewrite.
    writeFileSync(join(dir, 'pages', 'Home.tsx'), page('After!!'))
    expect(headingOf((await loadStudioPages(dir)).pages, 'home')).toBe('After!!')
  })

  it('an ADDED page file invalidates — the new page appears without a restart', async () => {
    expect((await loadStudioPages(dir)).pages.map((p) => p.id)).toEqual(['home'])
    writeFileSync(join(dir, 'pages', 'About.tsx'), page('About'))
    expect((await loadStudioPages(dir)).pages.map((p) => p.id).sort()).toEqual(['about', 'home'])
  })

  it('a DELETED page file invalidates — the removed page does not linger', async () => {
    writeFileSync(join(dir, 'pages', 'About.tsx'), page('About'))
    expect((await loadStudioPages(dir)).pages.map((p) => p.id).sort()).toEqual(['about', 'home'])
    unlinkSync(join(dir, 'pages', 'About.tsx'))
    expect((await loadStudioPages(dir)).pages.map((p) => p.id)).toEqual(['home'])
  })

  it('an edited LOCAL COMPONENT invalidates the page that inlines it — `pageParseCache`\'s one-level limit is not inherited', async () => {
    mkdirSync(join(dir, 'components'), { recursive: true })
    writeFileSync(join(dir, 'components', 'Hero.tsx'), 'export function Hero() {\n  return <h1>HeroBefore</h1>\n}\n')
    writeFileSync(
      join(dir, 'pages', 'Home.tsx'),
      "import { Hero } from '../components/Hero'\n\nexport default function Page() {\n  return <div><Hero /></div>\n}\n",
    )
    expect(headingOf((await loadStudioPages(dir)).pages, 'home')).toContain('HeroBefore')

    writeFileSync(join(dir, 'components', 'Hero.tsx'), 'export function Hero() {\n  return <h1>HeroAfterEdit</h1>\n}\n')
    expect(headingOf((await loadStudioPages(dir)).pages, 'home')).toContain('HeroAfterEdit')
  })

  it('`.studio/meta.json` invalidates — a changed `pagesDir` is not served from the old directory', async () => {
    expect((await loadStudioPages(dir)).pages.map((p) => p.id)).toEqual(['home'])

    mkdirSync(join(dir, '.studio'), { recursive: true })
    mkdirSync(join(dir, 'src', 'screens'), { recursive: true })
    writeFileSync(join(dir, 'src', 'screens', 'Dash.tsx'), page('Dash'))
    writeFileSync(join(dir, '.studio', 'meta.json'), JSON.stringify({ pagesDir: 'src/screens' }))

    expect((await loadStudioPages(dir)).pages.map((p) => p.id)).toEqual(['dash'])
  })

  it('mutating a returned page does not leak into the next caller', async () => {
    const first = await loadStudioPages(dir)
    const firstPage = first.pages[0]!
    firstPage.title = 'MUTATED BY CALLER ONE'

    const second = await loadStudioPages(dir)
    expect(second.pages[0]!.title).not.toBe('MUTATED BY CALLER ONE')
  })

  it('a narrowed load is served from the memo but never poisons it', async () => {
    writeFileSync(join(dir, 'pages', 'About.tsx'), page('About'))
    expect((await loadStudioPages(dir)).pages).toHaveLength(2)

    const narrowed = await loadStudioPages(dir, { pageIds: ['home'] })
    expect(narrowed.pages.map((p) => p.id)).toEqual(['home'])

    // The next FULL load must still see both pages — a narrowed result must
    // never have been stored as if it were the project-wide truth.
    expect((await loadStudioPages(dir)).pages.map((p) => p.id).sort()).toEqual(['about', 'home'])
  })

  it('a narrowed load computed COLD is not stored — the following full load is complete', async () => {
    writeFileSync(join(dir, 'pages', 'About.tsx'), page('About'))
    clearStudioLoadMemo()

    const narrowed = await loadStudioPages(dir, { pageIds: ['about'] })
    expect(narrowed.pages.map((p) => p.id)).toEqual(['about'])
    expect((await loadStudioPages(dir)).pages.map((p) => p.id).sort()).toEqual(['about', 'home'])
  })
})
