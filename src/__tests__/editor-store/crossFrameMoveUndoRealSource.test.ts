/**
 * `P0-3` — a cross-frame move that orphans an import in the file it leaves is
 * still ONE ⌘Z, and ⌘Z puts both files back byte for byte.
 *
 * Real end to end, on purpose: `/save` is `applyStudioEditBatch` against a temp
 * workspace and `/load` is `loadStudioPages` against the same files. The
 * hand-scripted network `structuralSourceUndo.test.ts` uses cannot catch this
 * defect, because it hands the store the ids the test author believed the write
 * would produce. Here the write produces them: the batch prunes the import the
 * moved `<img>` alone was using, every `line:col` below it in the origin file
 * moves up a line, and the undo's destination container — recorded at drag
 * time — has to be found at the line it moved to.
 *
 * The fixture shares nothing with the eSIM corpus: a storefront with a product
 * page and a cart page.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import '@modules/base'
import { useEditorStore } from '@site/store/store'
import { registerEditorSave } from '@site/hooks/editorSaveRef'
import { applySitePagesPatch } from '@site/hooks/siteReloadApply'
import { CMS_SITE_PAGES_PATCH_EVENT, type CmsSitePagesPatchDetail } from '@admin/state/adminEvents'
import { __resetToastBusForTests } from '@ui/components/Toast/toastBus'
import { resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { setStudioLoadedDir } from '@site/studio/studioWorkspaceDir'
import { makeSite } from '../fixtures'
import { applyStudioEditBatchLocked } from '../../../server/handlers/studioWriteback'
import { loadStudioPages } from '../../../server/handlers/studioPageLoad'
import { studioLoadStreamLines } from '../../../server/handlers/studio/studioLoadResponse'

const PRODUCT = `import badge from '../assets/badge.svg'
import { formatPrice } from '../lib/format'

export default function Product() {
  return (
    <main className="product">
      <h1>Kettle</h1>
      <img src={badge} alt="Best seller" />
      <p>{formatPrice(40)}</p>
      <button type="button">Add to cart</button>
    </main>
  )
}
`

const CART = `export default function Cart() {

  return (
    <main className="cart">
      <h1>Your cart</h1>
      <ul>
        <li>Kettle</li>
      </ul>
    </main>
  )
}
`

const SPARKLE = `export function Sparkle() {
  return <b>*</b>
}
`

const CHEVRON = `export function Chevron() {
  return <b>&gt;</b>
}
`

const BANNER = `import { Chevron } from './Chevron'
import { Sparkle } from './Sparkle'

export function Banner({ size = 'small', title, dismissible }: { size?: 'small' | 'large'; title: string; dismissible?: boolean }) {
  return (
    <section className="banner">
      {size === 'large' ? <Sparkle /> : <Chevron />}
      {dismissible && <button type="button">close</button>}
      <h2>{title}</h2>
    </section>
  )
}
`

const CHECKOUT = `import { Banner } from '../components/Banner'

export default function Checkout() {
  return (
    <main className="checkout">
      <Banner size="large" title="Almost there" />
    </main>
  )
}
`

const FORMAT = `export function formatPrice(n: number): string {
  return '$' + n
}
`

let dir: string
let originalFetch: typeof globalThis.fetch
let unregisterSave: (() => void) | null = null
let patchListener: ((evt: Event) => void) | null = null

const read = (rel: string) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8')
function write(rel: string, text: string): void {
  const full = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text, 'utf8')
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** `/save` is the real batch; `/load` is the real parse of the same files. */
function installRealServer(saves: { edits: { kind: string }[] }[]) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const route = url.split('?')[0]
    if (route === '/admin/api/studio/save') {
      const body = JSON.parse(String(init?.body)) as {
        edits: Parameters<typeof applyStudioEditBatchLocked>[1]
        expect?: Parameters<typeof applyStudioEditBatchLocked>[2]
      }
      // Exactly the route's own options: the editor's batches are journaled.
      const result = await applyStudioEditBatchLocked(dir, body.edits, body.expect ?? {}, {
        canvasLayers: 'allow',
        journal: true,
      })
      saves.push({ edits: [...body.edits] })
      return new Response(
        JSON.stringify({
          ok: true,
          ...result,
          touchedFiles: result.touchedFiles.map((file) => path.relative(dir, file).split(path.sep).join('/')),
        }),
        { status: 200 },
      )
    }
    if (route === '/admin/api/studio/reload-scope') {
      const pages = (await loadStudioPages(dir)).pages
      return new Response(JSON.stringify({ ok: true, narrow: true, pageIds: pages.map((p) => p.id) }), { status: 200 })
    }
    if (route === '/admin/api/studio/load') {
      const result = await loadStudioPages(dir)
      const lines: string[] = []
      for await (const line of studioLoadStreamLines({
        ...result,
        dir,
        projectName: 'shop',
        trust: 'static',
        projectKey: null,
        paletteHiddenModuleIds: [],
        missingPageIds: undefined,
      })) {
        lines.push(JSON.stringify(line))
      }
      return new Response(lines.join('\n') + '\n', { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  }) as typeof fetch
}

describe('P0-3 — a cross-frame move that orphans an import is one byte-exact ⌘Z', () => {
  let saves: Parameters<typeof installRealServer>[0]

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-xframe-undo-'))
    write('pages/Product.tsx', PRODUCT)
    write('pages/Cart.tsx', CART)
    write('lib/format.ts', FORMAT)
    write('components/Sparkle.tsx', SPARKLE)
    write('components/Chevron.tsx', CHEVRON)
    write('components/Banner.tsx', BANNER)
    write('pages/Checkout.tsx', CHECKOUT)
    write('assets/badge.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>')
    __resetToastBusForTests()
    resetStructuralCommitQueue()
    originalFetch = globalThis.fetch
    saves = []
    unregisterSave = registerEditorSave(async () => {})
    setStudioLoadedDir(dir)
    installRealServer(saves)

    patchListener = (evt: Event) => {
      applySitePagesPatch((evt as CustomEvent<CmsSitePagesPatchDetail>).detail)
    }
    window.addEventListener(CMS_SITE_PAGES_PATCH_EVENT, patchListener)

    const loaded = await loadStudioPages(dir)
    useEditorStore.getState().loadSite(makeSite({ pages: loaded.pages, styleRules: loaded.styleRules }))
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    unregisterSave?.()
    if (patchListener) window.removeEventListener(CMS_SITE_PAGES_PATCH_EVENT, patchListener)
    setStudioLoadedDir(null)
    resetStructuralCommitQueue()
    useEditorStore.getState().clearSite()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('moves the badge image to the cart page, then one ⌘Z restores BOTH files byte for byte', async () => {
    const site = useEditorStore.getState().site!
    const product = site.pages.find((p) => p.id.includes('roduct'))!
    const cart = site.pages.find((p) => p.id.endsWith('Cart') || p.id.includes('Cart') || p.id.includes('cart'))!
    const img = Object.values(product.nodes).find((n) => n.id.includes(':8:'))!
    const cartMain = Object.values(cart.nodes).find((n) => n.id.includes(':4:'))!

    useEditorStore.getState().transplantNodes([img.id], {
      originPageId: product.id,
      pageId: cart.id,
      parentId: cartMain.id,
      index: cartMain.children.length,
    })
    await waitFor(() => saves.length === 1)
    await waitFor(() => useEditorStore.getState().canUndo)

    // The write really happened: the import only the badge used is gone, and
    // the cart gained the element and the import.
    expect(read('pages/Product.tsx')).not.toContain('badge.svg')
    expect(read('pages/Cart.tsx')).toContain('badge.svg')

    useEditorStore.getState().undo()
    await waitFor(() => saves.length === 2)
    await waitFor(() => !useEditorStore.getState().canUndo)

    expect(saves[1]!.edits[0]!.kind).toBe('restore')
    expect(read('pages/Product.tsx')).toBe(PRODUCT)
    expect(read('pages/Cart.tsx')).toBe(CART)
    expect(useEditorStore.getState().canRedo).toBe(true)
  })

  it('redoes the move after the undo, and the redo is undoable again', async () => {
    const site = useEditorStore.getState().site!
    const product = site.pages.find((p) => p.id.includes('roduct'))!
    const cart = site.pages.find((p) => p.id.includes('art'))!
    const img = Object.values(product.nodes).find((n) => n.id.includes(':8:'))!
    const cartMain = Object.values(cart.nodes).find((n) => n.id.includes(':4:'))!
    useEditorStore.getState().transplantNodes([img.id], {
      originPageId: product.id,
      pageId: cart.id,
      parentId: cartMain.id,
      index: cartMain.children.length,
    })
    await waitFor(() => saves.length === 1)
    await waitFor(() => useEditorStore.getState().canUndo)
    const moved = [read('pages/Product.tsx'), read('pages/Cart.tsx')]

    useEditorStore.getState().undo()
    await waitFor(() => saves.length === 2)
    await waitFor(() => useEditorStore.getState().canRedo)

    useEditorStore.getState().redo()
    await waitFor(() => saves.length === 3)
    await waitFor(() => useEditorStore.getState().canUndo)
    expect([read('pages/Product.tsx'), read('pages/Cart.tsx')]).toEqual(moved)

    useEditorStore.getState().undo()
    await waitFor(() => saves.length === 4)
    await waitFor(() => !useEditorStore.getState().canUndo)
    expect(read('pages/Product.tsx')).toBe(PRODUCT)
    expect(read('pages/Cart.tsx')).toBe(CART)
  })

  it('P0-6 — an insert inside an instance detaches it, writes only the taken branches, and one ⌘Z puts it back', async () => {
    const site = useEditorStore.getState().site!
    const checkout = site.pages.find((p) => p.id.includes('heckout'))!
    // The `<section>` the instance renders: an inlined id, one call site deep.
    const inner = Object.values(checkout.nodes).find((n) => n.id.includes('~') && n.id.includes('Banner') && n.moduleId === 'base.container')!
    useEditorStore.getState().setActivePage(checkout.id)
    useEditorStore.getState().insertNode('base.container', {}, inner.id, 0)
    await waitFor(() => saves.length >= 2, 15000)
    await waitFor(() => useEditorStore.getState().canUndo)

    const after = read('pages/Checkout.tsx')
    expect(after).not.toContain('<Banner')
    expect(after).not.toContain('===')
    expect(after).not.toContain('undefined')
    expect(after).not.toContain('Chevron')
    expect(read('components/Banner.tsx')).toBe(BANNER)

    useEditorStore.getState().undo()
    await waitFor(() => read('pages/Checkout.tsx') === CHECKOUT, 8000)
  })
})
