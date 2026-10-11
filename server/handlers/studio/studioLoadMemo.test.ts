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
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadStudioPages, loadStudioPagesShared } from '../studioPageLoad'
import { clearLoadedProjects } from './loadedProjects'
import { fileStamp } from './loadDigest'
import { clearStudioLoadMemo, memoizedStudioLoad, workspaceLoadFingerprint, type StudioLoadComputation } from './studioLoadMemo'
import type { StudioLoadResult } from './studioLoadContract'

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
    clearLoadedProjects()
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

  it('a rewritten `lastOpenedAt` does NOT invalidate — the memo is not busted by its own reader', async () => {
    // The regression this pins. `GET /admin/api/studio/load` stamps
    // `lastOpenedAt` through `recordProjectOpened` on its way in, and the board
    // calls that same route to re-sync after every structural edit. While the
    // fingerprint stamped `.studio/meta.json` by mtime, that guaranteed a fresh
    // fingerprint on every load, the memo never hit once, and each duplicate or
    // insert paid a full cold `computeStudioPages` — measured at ~600 ms on a
    // two-page project, against ~15 ms once the memo works.
    //
    // Asserted against the FINGERPRINT and the memo's identity, not through a
    // load's content: a hit and a miss return the same bytes when nothing but
    // the timestamp moved, so content cannot tell them apart and a timing
    // assertion would be a flake. A memo hit hands the route the SAME shared
    // object; a recompute builds a new one.
    mkdirSync(join(dir, '.studio'), { recursive: true })
    const meta = join(dir, '.studio', 'meta.json')
    writeFileSync(meta, JSON.stringify({ displayName: 'Fixture', lastOpenedAt: 1 }))
    const first = await loadStudioPagesShared(dir)
    const before = workspaceLoadFingerprint(dir)

    // Exactly what `recordProjectOpened` does, and nothing else.
    writeFileSync(meta, JSON.stringify({ displayName: 'Fixture', lastOpenedAt: 2 }))
    expect(workspaceLoadFingerprint(dir), 'a new `lastOpenedAt` changed the fingerprint').toBe(before)
    expect(await loadStudioPagesShared(dir), 'a new `lastOpenedAt` busted the memo').toBe(first)

    // The exclusion must not have widened: a field that DOES decide a parse
    // still invalidates, from the same file.
    writeFileSync(meta, JSON.stringify({ displayName: 'Fixture', lastOpenedAt: 2, pagesDir: 'src/screens' }))
    expect(workspaceLoadFingerprint(dir), 'a changed `pagesDir` was ignored').not.toBe(before)
    expect(await loadStudioPagesShared(dir)).not.toBe(first)
  })

  it('PERF-8 — the fingerprint is collision-safe: `Aa.tsx` and `BB.tsx` with identical stamps differ', () => {
    // The 32-bit `hash * 31 + charCode` it replaced is Java's
    // `String.hashCode`, under which "Aa" and "BB" collide — so a page renamed
    // between those names, keeping its size and mtime, fingerprinted the SAME
    // and the memo served the old page list.
    const other = mkdtempSync(join(tmpdir(), 'studio-load-memo-collide-'))
    try {
      rmSync(join(dir, 'pages', 'Home.tsx'))
      mkdirSync(join(other, 'pages'), { recursive: true })
      const when = new Date('2026-01-01T00:00:00Z')
      writeFileSync(join(dir, 'pages', 'Aa.tsx'), page('Same'))
      writeFileSync(join(other, 'pages', 'BB.tsx'), page('Same'))
      writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { react: '^18.0.0' } }))
      for (const file of [join(dir, 'pages', 'Aa.tsx'), join(other, 'pages', 'BB.tsx'), join(dir, 'package.json'), join(other, 'package.json')]) {
        utimesSync(file, when, when)
      }
      expect(workspaceLoadFingerprint(dir)).not.toBe(workspaceLoadFingerprint(other))
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })


  it('a key REORDER in `.studio/meta.json` is not mistaken for a change', async () => {
    mkdirSync(join(dir, '.studio'), { recursive: true })
    const meta = join(dir, '.studio', 'meta.json')
    writeFileSync(meta, JSON.stringify({ displayName: 'Fixture', lastOpenedAt: 1 }))
    expect(headingOf((await loadStudioPages(dir)).pages, 'home')).toBe('Before')

    writeFileSync(meta, JSON.stringify({ lastOpenedAt: 1, displayName: 'Fixture' }))
    expect(headingOf((await loadStudioPages(dir)).pages, 'home')).toBe('Before')
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

describe('memoizedStudioLoad — one compute per project at a time', () => {
  let dir: string

  beforeEach(() => {
    clearStudioLoadMemo()
    dir = mkdtempSync(join(tmpdir(), 'studio-load-inflight-'))
    mkdirSync(join(dir, 'pages'), { recursive: true })
    writeFileSync(join(dir, 'pages', 'Home.tsx'), page('One'))
  })

  afterEach(() => {
    clearLoadedProjects()
    rmSync(dir, { recursive: true, force: true })
  })

  /** A computation whose compute runs only when the test says so, stamped on `pages/Home.tsx` as read at compute START. */
  function gatedComputation() {
    const releases: Array<() => void> = []
    let computes = 0
    const homeFile = join(dir, 'pages', 'Home.tsx')
    const computation: StudioLoadComputation = {
      routeListing: () => 'pages/Home.tsx',
      compute: async () => {
        computes += 1
        const label = `compute-${computes}`
        const stamp = fileStamp(homeFile)
        await new Promise<void>((resolve) => releases.push(resolve))
        return { result: { label } as unknown as StudioLoadResult, dependencies: new Map([[homeFile, stamp]]) }
      },
    }
    const releaseNext = async () => {
      while (releases.length === 0) await new Promise((resolve) => setTimeout(resolve, 1))
      releases.shift()!()
    }
    /** Lets every compute started so far run — on the old code, the duplicate one too. */
    const releaseAll = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      for (const release of releases.splice(0)) release()
    }
    return { computation, releaseNext, releaseAll, computes: () => computes, homeFile }
  }

  const labelOf = (result: StudioLoadResult) => (result as unknown as { label: string }).label

  it('two loads at once share ONE compute and get the same result', async () => {
    const gated = gatedComputation()
    const first = memoizedStudioLoad(dir, gated.computation)
    const second = memoizedStudioLoad(dir, gated.computation)
    await gated.releaseAll()
    await gated.releaseAll()
    const [a, b] = await Promise.all([first, second])
    expect(gated.computes()).toBe(1)
    expect(b).toBe(a)
  })

  it('a load that joined a compute whose input changed meanwhile computes again — never the stale result', async () => {
    const gated = gatedComputation()
    const first = memoizedStudioLoad(dir, gated.computation)
    const second = memoizedStudioLoad(dir, gated.computation)
    await new Promise((resolve) => setTimeout(resolve, 5))
    writeFileSync(gated.homeFile, page('Two, and longer'))
    await gated.releaseNext()
    expect(labelOf(await first)).toBe('compute-1')
    await gated.releaseNext()
    expect(labelOf(await second)).toBe('compute-2')
    expect(gated.computes()).toBe(2)
  })
})
