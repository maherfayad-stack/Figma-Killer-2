/**
 * D2 G15's commit — `insertImageIntoPage`.
 *
 * Two properties, both of which a "just use the active tree" implementation
 * would break silently:
 *
 *  1. **It writes into the page it was NAMED**, not the active one. A file
 *     dropped from the desktop lands wherever the pointer was, and the frame
 *     under a drop has never been activated by a pointerdown because there was
 *     no pointerdown. Asserted by leaving the active page as a DIFFERENT page
 *     and checking the write targets the dropped-on one.
 *  2. **One structural commit**, `kind: 'insert'`, an intrinsic `img` with a
 *     literal `src` and a non-empty `alt`. An `<img>` with no `alt` is a real
 *     accessibility defect written into someone's repository; an empty one
 *     asserts the image is decorative, which Studio cannot know.
 *
 * The network is stubbed at `globalThis.fetch` — restorable, unlike
 * `mock.module`, which is process-global and permanent (`standing-01`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../../../../../../../__tests__/fixtures'
import '@modules/base/index'

const HOME_ROOT = 'home:body'
const HOME_MAIN = 'pages/Home.tsx:4:5'
const ABOUT_ROOT = 'about:body'
const ABOUT_MAIN = 'pages/About.tsx:4:5'
const ABOUT_H1 = 'pages/About.tsx:5:7'
const ABOUT_ROW = 'pages/About.tsx:9:7#2'

const realFetch = globalThis.fetch
let posted: { edits: Record<string, unknown>[] }[] = []

function stubSaveRoute(): void {
  posted = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/admin/api/studio/save')) {
      posted.push(JSON.parse(String(init?.body ?? '{}')))
      return new Response(
        JSON.stringify({
          ok: true,
          written: 1,
          skipped: 0,
          shifted: true,
          sharedComponents: false,
          touchedFiles: [],
        }),
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

beforeEach(() => {
  stubSaveRoute()
  seedSite()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('insertImageIntoPage', () => {
  it('writes ONE insert into the page it was named, while a different page is active', async () => {
    useEditorStore.getState().insertImageIntoPage('about', ABOUT_MAIN, 0, {
      src: '/photo.png',
      alt: 'photo',
    })
    // The commit flushes a save first, then posts; one turn of the microtask
    // queue is enough for both in this stub.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(posted).toHaveLength(1)
    expect(posted[0]!.edits).toHaveLength(1)
    const edit = posted[0]!.edits[0]!
    expect(edit.kind).toBe('insert')
    expect(edit.nodeId).toBe(ABOUT_MAIN)
    expect(edit.name).toBe('img')
    expect(edit.props).toEqual({ src: '/photo.png', alt: 'photo' })
    // The drop landed at index 0, so it is written BEFORE the existing child.
    expect(edit.anchorNodeId).toBe(ABOUT_H1)
    expect(edit.position).toBe('before')
  })

  it('appends when the drop landed past the container last child', async () => {
    useEditorStore.getState().insertImageIntoPage('about', ABOUT_MAIN, 9, {
      src: '/photo.png',
      alt: 'photo',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const edit = posted[0]!.edits[0]!
    expect(edit.anchorNodeId).toBeUndefined()
  })

  it('refuses a `.map` row container out loud and writes nothing', async () => {
    useEditorStore.getState().insertImageIntoPage('about', ABOUT_ROW, 0, {
      src: '/photo.png',
      alt: 'photo',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(posted).toHaveLength(0)
    const dialog = useEditorStore.getState().structuralRefusalDialog
    expect(dialog).not.toBeNull()
    expect(dialog!.constraint.reason).toBe('list-row')
  })

  it('does nothing at all for a page that is no longer on the site', async () => {
    useEditorStore.getState().insertImageIntoPage('gone', ABOUT_MAIN, 0, {
      src: '/photo.png',
      alt: 'photo',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(posted).toHaveLength(0)
    expect(useEditorStore.getState().structuralRefusalDialog).toBeNull()
  })
})
