/**
 * D2 G15 / P5-B — `dropImagesIntoPage`, the commit behind image files dropped
 * onto a board frame.
 *
 * The properties, each of which a simpler implementation breaks silently:
 *
 *  1. **It writes into the page it was NAMED** — and activates it — not the
 *     page that happened to be active. A file dropped from the desktop lands
 *     wherever the pointer was.
 *  2. **N files are ONE insert edit** (IMG-2): the first image is the edit's
 *     own element and the rest ride `siblings`, so the save route writes them
 *     in one splice, reports every created id, and `delete-created` takes
 *     them all back in one undo step. Before P5-B, three files were refused.
 *  3. **Each image carries its intrinsic size, clamped to the container**
 *     (IMG-9), and a non-empty `alt`.
 *  4. **A ghost shows at once** (IMG-8): one optimistic `<img>` per file from
 *     its object URL, marked uploading, BEFORE any byte has landed — and it is
 *     rolled back, with every object URL revoked, when nothing lands.
 *
 * The upload goes through the one XHR upload client (`fakeUploadXhr`); the
 * save route through a stub `fetch`. Both restorable (`standing-01`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { resetOptimisticPreviewTracking } from '@site/store/slices/site/structuralOptimism'
import { UPLOADING_ATTRIBUTE } from '@site/store/slices/site/imageDropActions'
import { createFakeUploadXhr, type FakeUploadAnswer } from '../../../../studio/__tests__/fakeUploadXhr'
import { makeNode, makePage, makeSite } from '../../../../../../../__tests__/fixtures'
import '@modules/base/index'

const HOME_ROOT = 'home:body'
const HOME_MAIN = 'pages/Home.tsx:4:5'
const ABOUT_ROOT = 'about:body'
const ABOUT_MAIN = 'pages/About.tsx:4:5'
const ABOUT_H1 = 'pages/About.tsx:5:7'
const ABOUT_ROW = 'pages/About.tsx:9:7#2'

const realFetch = globalThis.fetch
const realCreateObjectURL = URL.createObjectURL
const realRevokeObjectURL = URL.revokeObjectURL
let posted: { edits: Record<string, unknown>[] }[] = []
let revoked: string[] = []

/** What `asset-drop` answers for each file, by name. Default: lands in public/ at its intrinsic size. */
let landing: (name: string) => FakeUploadAnswer = (name) => ({
  status: 200,
  body: { ok: true, mode: 'public', relPath: `public/${name}`, src: `/${name}`, width: 1600, height: 900, deduped: false },
})
const xhr = createFakeUploadXhr((_url, body) => landing((body.get('file') as File).name))

function stubSaveRoute(): void {
  posted = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/admin/api/studio/save')) {
      posted.push(JSON.parse(String(init?.body ?? '{}')))
      return new Response(
        JSON.stringify({ ok: true, written: 1, skipped: 0, shifted: true, sharedComponents: false, touchedFiles: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

function seedSite(): void {
  const site = makeSite({
    pages: [
      makePage({
        id: 'home',
        slug: 'index',
        title: 'Home',
        rootNodeId: HOME_ROOT,
        nodes: {
          [HOME_ROOT]: makeNode({ id: HOME_ROOT, moduleId: 'base.container', children: [HOME_MAIN] }),
          [HOME_MAIN]: makeNode({ id: HOME_MAIN, moduleId: 'base.container', parentId: HOME_ROOT }),
        },
      }),
      makePage({
        id: 'about',
        slug: 'about',
        title: 'About',
        rootNodeId: ABOUT_ROOT,
        nodes: {
          [ABOUT_ROOT]: makeNode({ id: ABOUT_ROOT, moduleId: 'base.container', children: [ABOUT_MAIN] }),
          [ABOUT_MAIN]: makeNode({
            id: ABOUT_MAIN,
            moduleId: 'base.container',
            children: [ABOUT_H1, ABOUT_ROW],
            parentId: ABOUT_ROOT,
          }),
          [ABOUT_H1]: makeNode({ id: ABOUT_H1, moduleId: 'base.text', parentId: ABOUT_MAIN }),
          [ABOUT_ROW]: makeNode({ id: ABOUT_ROW, moduleId: 'base.container', parentId: ABOUT_MAIN }),
        },
      }),
    ],
  })
  useEditorStore.getState().loadSite(site)
  // The ACTIVE page is deliberately the one the drop did NOT land on.
  useEditorStore.setState({
    activePageId: 'home',
    structuralRefusalDialog: null,
  } as Parameters<typeof useEditorStore.setState>[0])
}

const png = (name: string) => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' })

function drop(files: File[], overrides: Partial<Parameters<ReturnType<typeof useEditorStore.getState>['dropImagesIntoPage']>[0]> = {}) {
  useEditorStore.getState().dropImagesIntoPage({
    pageId: 'about',
    parentId: ABOUT_MAIN,
    index: 0,
    files,
    maxWidth: null,
    absolute: null,
    ...overrides,
  })
}

/** Everything the drop does is behind uploads and a flushed save; a few macrotask turns settle it in these stubs. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  resetStructuralCommitQueue()
  resetOptimisticPreviewTracking()
  landing = (name) => ({
    status: 200,
    body: { ok: true, mode: 'public', relPath: `public/${name}`, src: `/${name}`, width: 1600, height: 900, deduped: false },
  })
  revoked = []
  let minted = 0
  URL.createObjectURL = () => `blob:preview-${(minted += 1)}`
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url)
  }
  xhr.requests.length = 0
  xhr.install()
  stubSaveRoute()
  seedSite()
})

afterEach(() => {
  globalThis.fetch = realFetch
  URL.createObjectURL = realCreateObjectURL
  URL.revokeObjectURL = realRevokeObjectURL
  xhr.restore()
  resetStructuralCommitQueue()
  resetOptimisticPreviewTracking()
})

describe('dropImagesIntoPage — one write', () => {
  it('writes ONE insert into the page it was named, and activates that page', async () => {
    drop([png('photo.png')])
    expect(useEditorStore.getState().activePageId).toBe('about')
    await settle()

    expect(posted).toHaveLength(1)
    expect(posted[0]!.edits).toHaveLength(1)
    const edit = posted[0]!.edits[0]!
    expect(edit.kind).toBe('insert')
    expect(edit.nodeId).toBe(ABOUT_MAIN)
    expect(edit.name).toBe('img')
    expect(edit.props).toEqual({ src: '/photo.png', alt: 'photo', width: 1600, height: 900 })
    // The drop landed at index 0, so it is written BEFORE the existing child.
    expect(edit.anchorNodeId).toBe(ABOUT_H1)
    expect(edit.position).toBe('before')
  })

  it('IMG-2 — three files are ONE insert of three siblings, in drop order', async () => {
    drop([png('a.png'), png('b.png'), png('c.png')])
    await settle()

    expect(xhr.requests).toHaveLength(3)
    expect(posted).toHaveLength(1)
    expect(posted[0]!.edits).toHaveLength(1)
    const edit = posted[0]!.edits[0]!
    expect((edit.props as { src: string }).src).toBe('/a.png')
    expect((edit.siblings as { name: string; props: { src: string } }[]).map((node) => [node.name, node.props.src])).toEqual([
      ['img', '/b.png'],
      ['img', '/c.png'],
    ])
  })

  it('IMG-9 — clamps the intrinsic size to the container, keeping the aspect', async () => {
    drop([png('wide.png')], { maxWidth: 390 })
    await settle()

    expect(posted[0]!.edits[0]!.props).toEqual({ src: '/wide.png', alt: 'wide', width: 390, height: 219 })
  })

  it('writes no size at all when the file does not say one', async () => {
    landing = (name) => ({
      status: 200,
      body: { ok: true, mode: 'public', relPath: `public/${name}`, src: `/${name}`, width: null, height: null, deduped: false },
    })
    drop([png('mystery.png')], { maxWidth: 390 })
    await settle()

    expect(posted[0]!.edits[0]!.props).toEqual({ src: '/mystery.png', alt: 'mystery' })
  })

  it('IMG-9 — a cmd-drop writes K6 absolute placement, cascading each further image', async () => {
    drop([png('a.png'), png('b.png')], { absolute: { property: 'left', inline: 40, top: 12 } })
    await settle()

    const edit = posted[0]!.edits[0]!
    expect((edit.props as { style: unknown }).style).toEqual({ position: 'absolute', left: '40px', top: '12px' })
    expect((edit.siblings as { props: { style: unknown } }[])[0]!.props.style).toEqual({
      position: 'absolute',
      left: '64px',
      top: '36px',
    })
  })

  it('writes the images that landed and names the one the server refused', async () => {
    landing = (name) =>
      name === 'bad.png'
        ? { status: 400, body: { error: 'That file is not an image Studio can read.' } }
        : { status: 200, body: { ok: true, mode: 'public', relPath: `public/${name}`, src: `/${name}`, width: 10, height: 10, deduped: false } }
    drop([png('a.png'), png('bad.png'), png('c.png')])
    await settle()

    expect(posted).toHaveLength(1)
    const edit = posted[0]!.edits[0]!
    expect((edit.props as { src: string }).src).toBe('/a.png')
    expect((edit.siblings as { props: { src: string } }[]).map((node) => node.props.src)).toEqual(['/c.png'])
  })
})

describe('dropImagesIntoPage — the ghost (IMG-8)', () => {
  it('paints one uploading <img> per file BEFORE any byte has landed', async () => {
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const base = landing
    landing = (name) => ({ ...base(name), gate })
    drop([png('a.png'), png('b.png')])

    const about = useEditorStore.getState().site!.pages.find((page) => page.id === 'about')!
    const ghosts = about.nodes[ABOUT_MAIN]!.children.slice(0, 2).map((id) => about.nodes[id]!)
    expect(ghosts.map((node) => node.moduleId)).toEqual(['base.image', 'base.image'])
    expect(ghosts.map((node) => node.props.src)).toEqual(['blob:preview-1', 'blob:preview-2'])
    expect(ghosts.every((node) => (node.props.htmlAttributes as Record<string, string>)[UPLOADING_ATTRIBUTE] === '')).toBe(true)
    expect(posted).toHaveLength(0)

    open()
    await settle()
    expect(posted).toHaveLength(1)
    expect(revoked.sort()).toEqual(['blob:preview-1', 'blob:preview-2'])
  })

  it('rolls the ghost back and revokes every object URL when nothing lands', async () => {
    landing = () => ({ status: 409, body: { error: 'This project has no public/ folder.' } })
    drop([png('a.png'), png('b.png')])
    await settle()

    expect(posted).toHaveLength(0)
    const about = useEditorStore.getState().site!.pages.find((page) => page.id === 'about')!
    expect(about.nodes[ABOUT_MAIN]!.children).toEqual([ABOUT_H1, ABOUT_ROW])
    expect(revoked.sort()).toEqual(['blob:preview-1', 'blob:preview-2'])
  })
})

describe('dropImagesIntoPage — refusals write nothing', () => {
  it('refuses a `.map` row container out loud, before any upload', async () => {
    drop([png('photo.png')], { parentId: ABOUT_ROW })
    await settle()

    expect(xhr.requests).toHaveLength(0)
    expect(posted).toHaveLength(0)
    const dialog = useEditorStore.getState().structuralRefusalDialog
    expect(dialog).not.toBeNull()
    expect(dialog!.constraint.reason).toBe('list-row')
  })

  it('does nothing at all for a page that is no longer on the site', async () => {
    drop([png('photo.png')], { pageId: 'gone' })
    await settle()

    expect(xhr.requests).toHaveLength(0)
    expect(posted).toHaveLength(0)
    expect(useEditorStore.getState().structuralRefusalDialog).toBeNull()
  })
})
