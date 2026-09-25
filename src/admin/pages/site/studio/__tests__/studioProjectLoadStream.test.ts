/**
 * `loadStudioProject` with `progress` (P6-B) — the document reaches the board
 * while its pages are still on the wire.
 *
 * The `/load` body here is a real `ReadableStream` the test releases in two
 * chunks, so "before the stream ended" is an observable moment rather than an
 * assumption:
 *
 *   - `open` fires after the FIRST chunk, before the second is released, with
 *     the pages that arrived (in page order) and the rest named as pending;
 *   - the first delivery waits for the page the editor opens on (the home
 *     page) even when another page's line came first;
 *   - later pages arrive through `pages`, with the framework class-id rewrite
 *     the open document got from `loadSite` applied to them too;
 *   - the promise resolves with the whole document, in page order;
 *   - the sidecar read is issued with the load and supplies the open
 *     document's framework; the token extraction is only issued after the
 *     last page (it used to hold the load's first byte back).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { FrameworkSettings } from '@core/framework-schema'
import type { Page, SiteDocument, StyleRule } from '@core/page-tree'
import type { PendingPage } from '@core/persistence/types'
import { loadStudioProject } from '../studioProjectLoad'
import { makeNode, makePage } from '../../../../../__tests__/fixtures'

const USER_CLASS_ID = 'css:text-primary'

/** A user class whose NAME collides with a framework utility: `loadSite` re-points every node that uses it at the framework class. */
const USER_CLASS: StyleRule = {
  id: USER_CLASS_ID,
  name: 'text-primary',
  kind: 'class',
  selector: '.text-primary',
  order: 0,
  styles: { color: 'red' },
  contextStyles: {},
  createdAt: 1,
  updatedAt: 1,
}

const FRAMEWORK: FrameworkSettings = {
  colors: {
    tokens: [
      {
        id: 'primary-token',
        category: 'Brand',
        slug: 'primary',
        lightValue: 'hsla(238, 100%, 62%, 1)',
        darkValue: 'hsla(238, 100%, 42%, 1)',
        darkModeEnabled: false,
        generateUtilities: { text: true, background: false, border: false, fill: false },
        generateTransparent: false,
        generateShades: { enabled: false, count: 0 },
        generateTints: { enabled: false, count: 0 },
        order: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  },
}

function page(id: string, slug: string): Page {
  const root = `${id}-root`
  const text = `${id}-text`
  return makePage({
    id,
    slug,
    title: id.toUpperCase(),
    rootNodeId: root,
    nodes: {
      [root]: makeNode({ id: root, moduleId: 'base.body', children: [text] }),
      [text]: makeNode({ id: text, moduleId: 'base.text', props: { text: id }, parentId: root, classIds: [USER_CLASS_ID] }),
    },
  })
}

/** Page order a, b, c, d — `a` is home. */
const PAGES = [page('a', 'index'), page('b', 'b'), page('c', 'c'), page('d', 'd')]

function metaLine(): string {
  return JSON.stringify({
    kind: 'meta',
    dir: '/tmp/stream-test',
    projectName: 'stream-test',
    componentSources: {},
    styleRules: { [USER_CLASS_ID]: USER_CLASS },
    styleRuleSources: {},
    styledStyleRuleSources: {},
    conditions: [],
    vendorCss: '',
    authoredCss: '',
    trust: 'static',
    paletteHiddenModuleIds: [],
    pageList: PAGES.map(({ id, slug, title }) => ({ id, slug, title })),
  })
}

function pageLine(index: number): string {
  return JSON.stringify({ kind: 'page', page: PAGES[index], index })
}

interface StreamControl {
  /** Releases the second chunk and ends the stream. */
  release(): void
  /** Every request path, in the order it was issued. */
  requests: string[]
}

/** Serves `/load` as two chunks: `first` now, `second` on `release()`. */
function stubStreamedFetch(first: string[], second: string[]): StreamControl {
  const encoder = new TextEncoder()
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  const requests: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    const path = url.split('?')[0]!
    requests.push(path)
    if (path === '/admin/api/studio/load') {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(first.map((line) => `${line}\n`).join('')))
          await released
          controller.enqueue(encoder.encode(second.map((line) => `${line}\n`).join('')))
          controller.close()
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
    }
    if (path === '/admin/api/studio/framework') return Response.json({ framework: FRAMEWORK, fonts: null })
    if (path === '/admin/api/studio/tokens') {
      return Response.json({ ok: true, framework: FRAMEWORK, source: 'project-css', counts: { colors: 1, spacing: 0, typography: 0 }, warnings: [] })
    }
    return Response.json({})
  }) as typeof fetch
  return { release, requests }
}

interface Recorded {
  opened: { pages: string[]; pending: string[] } | null
  batches: string[][]
  openSite: SiteDocument | null
  later: Page[]
}

function recordProgress(): { recorded: Recorded; progress: { open(site: SiteDocument, pending: readonly PendingPage[]): void; pages(pages: readonly Page[]): void } } {
  const recorded: Recorded = { opened: null, batches: [], openSite: null, later: [] }
  return {
    recorded,
    progress: {
      open(site, pending) {
        recorded.openSite = site
        recorded.opened = { pages: site.pages.map((p) => p.id), pending: pending.map((p) => p.id) }
      },
      pages(pages) {
        recorded.batches.push(pages.map((p) => p.id))
        recorded.later.push(...pages)
      },
    },
  }
}

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the streamed load')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('loadStudioProject — streamed (P6-B)', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('opens the document after the first chunk, before the stream ends, and delivers the rest as it arrives', async () => {
    // Viewport order: c, then a (home), then b and d.
    const control = stubStreamedFetch([metaLine(), pageLine(2), pageLine(0)], [pageLine(1), pageLine(3)])
    const { recorded, progress } = recordProgress()
    const done = loadStudioProject({ progress })

    await until(() => recorded.opened !== null)
    // Open came while the second chunk is still held back.
    expect(recorded.opened).toEqual({ pages: ['a', 'c'], pending: ['b', 'd'] })
    expect(recorded.batches).toEqual([])
    // The sidecar read went out with the load, and its framework is the open
    // document's; the token extraction waits for the load to finish.
    expect(control.requests).toContain('/admin/api/studio/framework')
    expect(control.requests).not.toContain('/admin/api/studio/tokens')
    expect(recorded.openSite!.settings.framework).toEqual(FRAMEWORK)

    control.release()
    const site = await done
    expect(recorded.batches).toEqual([['b', 'd']])
    expect(site.pages.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd'])
    // After the last page, never before it.
    expect(control.requests).toContain('/admin/api/studio/tokens')
  })

  it('waits for the page the editor opens on before the first delivery', async () => {
    const control = stubStreamedFetch([metaLine(), pageLine(2)], [pageLine(0), pageLine(1), pageLine(3)])
    const { recorded, progress } = recordProgress()
    const done = loadStudioProject({ progress })
    // Give the first chunk every chance to be delivered.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(recorded.opened).toBeNull()

    control.release()
    await done
    expect(recorded.opened!.pages).toEqual(['a', 'b', 'c', 'd'])
    expect(recorded.opened!.pending).toEqual([])
  })

  it('rewrites a later page\'s framework-colliding class ids exactly as `loadSite` rewrites the open document\'s', async () => {
    const control = stubStreamedFetch([metaLine(), pageLine(0)], [pageLine(1), pageLine(2), pageLine(3)])
    const { recorded, progress } = recordProgress()
    const done = loadStudioProject({ progress })
    await until(() => recorded.opened !== null)
    control.release()
    await done

    const later = recorded.later.map((p) => p.nodes[`${p.id}-text`]!.classIds)
    expect(later.length).toBe(3)
    for (const classIds of later) {
      expect(classIds).not.toContain(USER_CLASS_ID)
      expect(classIds.length).toBe(1)
      expect(classIds[0]!.startsWith('framework:')).toBe(true)
    }
  })

  it('without progress, resolves once with the whole document in page order', async () => {
    const control = stubStreamedFetch([metaLine(), pageLine(3), pageLine(1)], [pageLine(0), pageLine(2)])
    const done = loadStudioProject()
    control.release()
    const site = await done
    expect(site.pages.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})
