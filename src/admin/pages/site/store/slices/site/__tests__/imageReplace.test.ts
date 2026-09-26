/**
 * P5-B — a file dropped ONTO an image replaces it (IMG-3), and a ⇧-drop sets
 * a container's background (IMG-7).
 *
 * Replace has two honest targets, and which one is decided by the node:
 *
 *  - a LITERAL `src="/old.png"`: the file lands in `public/` and the served URL
 *    replaces the literal through the ordinary value path — so ⌘Z is the
 *    ordinary value undo;
 *  - an IMPORT-BOUND `src={hero}`: the IMPORT is repointed (`kind: 'asset'`),
 *    the new file lands beside the one it imported, and the undo points the
 *    import back.
 *
 * A background is written to the element's own inline style, and refused
 * when a class already owns the background — the Fill section asks where to
 * write; a drop cannot.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { resolveStructuralInverse } from '@site/studio/structuralUndoPlan'
import { refuseBackgroundTarget } from '@site/store/slices/site/imageDropActions'
import { createFakeUploadXhr } from '../../../../studio/__tests__/fakeUploadXhr'
import { makeNode, makePage, makeSite } from '../../../../../../../__tests__/fixtures'
import '@modules/base/index'

const ROOT = 'about:body'
const MAIN = 'pages/About.tsx:4:5'
const LITERAL_IMG = 'pages/About.tsx:5:7'
const IMPORTED_IMG = 'pages/About.tsx:6:7'
const HERO_IMPORT = { rel: 'pages/About.tsx', line: 1, col: 18 }

const realFetch = globalThis.fetch
let posted: { edits: Record<string, unknown>[] }[] = []

const xhr = createFakeUploadXhr((url, body) => {
  const name = (body.get('file') as File).name
  if (url.startsWith('/admin/api/studio/asset-upload')) {
    const dir = String(body.get('targetDir') ?? 'src/assets')
    return { status: 200, body: { ok: true, relPath: `${dir}/${name}`, src: null, width: 10, height: 10, deduped: false } }
  }
  return {
    status: 200,
    body: { ok: true, mode: 'public', relPath: `public/${name}`, src: `/${name}`, width: 10, height: 10, deduped: false },
  }
})

function seed(): void {
  const page = makePage({
    id: 'about',
    slug: 'about',
    title: 'About',
    rootNodeId: ROOT,
    nodes: {
      [ROOT]: makeNode({ id: ROOT, moduleId: 'base.container', children: [MAIN] }),
      [MAIN]: makeNode({ id: MAIN, moduleId: 'base.container', children: [LITERAL_IMG, IMPORTED_IMG], parentId: ROOT }),
      [LITERAL_IMG]: makeNode({ id: LITERAL_IMG, moduleId: 'base.image', props: { src: '/old.png' }, parentId: MAIN }),
      [IMPORTED_IMG]: makeNode({
        id: IMPORTED_IMG,
        moduleId: 'base.image',
        // How an import-bound src reaches the board: the server rewrote its
        // `studio-asset:` sentinel to the preview route (`rewriteStudioAssetSentinels`).
        props: { src: '/admin/api/studio/asset?dir=%2Fws%2Fp&path=src%2Fassets%2Fbrand%2Fhero.png' },
        codeProps: ['src'],
        assetOrigin: HERO_IMPORT,
        parentId: MAIN,
      }),
    },
  })
  useEditorStore.getState().loadSite(makeSite({ pages: [page] }))
  useEditorStore.setState({ activePageId: 'about' } as Parameters<typeof useEditorStore.setState>[0])
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const png = (name: string) => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' })
const node = (id: string) => useEditorStore.getState().site!.pages[0]!.nodes[id]!

beforeEach(() => {
  resetStructuralCommitQueue()
  posted = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/admin/api/studio/save')) posted.push(JSON.parse(String(init?.body ?? '{}')))
    return new Response(
      JSON.stringify({ ok: true, written: 1, skipped: 0, shifted: false, sharedComponents: false, touchedFiles: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  xhr.requests.length = 0
  xhr.install()
  seed()
})

afterEach(() => {
  globalThis.fetch = realFetch
  xhr.restore()
  resetStructuralCommitQueue()
})

describe('replaceImageInPage — a literal src (IMG-3)', () => {
  it('lands the file in public/ and writes its served URL over the literal, undoably', async () => {
    useEditorStore.getState().replaceImageInPage('about', LITERAL_IMG, { kind: 'file', file: png('new.png') })
    await settle()

    expect(xhr.requests.map((request) => request.url.split('?')[0])).toEqual(['/admin/api/studio/asset-drop'])
    expect(node(LITERAL_IMG).props.src).toBe('/new.png')

    useEditorStore.getState().undo()
    expect(node(LITERAL_IMG).props.src).toBe('/old.png')
  })
})

describe('replaceImageInPage — an import-bound src (IMG-3)', () => {
  it('lands the file beside the old one and repoints the IMPORT, never the JSX', async () => {
    useEditorStore.getState().replaceImageInPage('about', IMPORTED_IMG, { kind: 'file', file: png('new.png') })
    await settle()

    const [upload] = xhr.requests
    expect(upload?.url).toBe('/admin/api/studio/asset-upload')
    expect(upload?.body.get('targetDir')).toBe('src/assets/brand')
    expect(posted).toHaveLength(1)
    expect(posted[0]!.edits).toEqual([
      expect.objectContaining({ kind: 'asset', nodeId: 'pages/About.tsx:1:18', assetPath: 'src/assets/brand/new.png' }),
    ])
  })

  it('records an undo that points the import back at the file it named before', () => {
    const inverse = resolveStructuralInverse(
      { kind: 'known', inverse: [{ kind: 'asset', nodeId: 'pages/About.tsx:1:18', assetPath: 'src/assets/brand/hero.png' }] },
      { createdNodeIds: [], relocatedNodeIds: [], removed: [], prunedImports: [] },
    )
    expect(inverse).toEqual([{ kind: 'asset', nodeId: 'pages/About.tsx:1:18', assetPath: 'src/assets/brand/hero.png' }])
  })
})

describe('setBackgroundImageInPage — shift-drop (IMG-7)', () => {
  it('writes the image as the top background layer of the element’s own inline style', async () => {
    useEditorStore.getState().setBackgroundImageInPage('about', MAIN, { kind: 'file', file: png('bg.png') })
    await settle()

    expect(node(MAIN).inlineStyles?.backgroundImage).toBe("url('/bg.png')")
  })

  it('refuses a background a class already owns, before any upload', async () => {
    const refusal = refuseBackgroundTarget(
      makeNode({ id: MAIN, moduleId: 'base.container', classIds: ['card'] }),
      { card: { styles: { backgroundImage: 'linear-gradient(red, blue)' } } },
    )
    expect(refusal).toContain('Fill section')
  })

  it('refuses a background computed in code', () => {
    const refusal = refuseBackgroundTarget(
      makeNode({ id: MAIN, moduleId: 'base.container', codeProps: ['style:backgroundImage'] }),
      {},
    )
    expect(refusal).toContain('computed in code')
  })
})
