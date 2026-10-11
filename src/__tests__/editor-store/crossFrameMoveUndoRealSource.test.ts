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
import { useEditorStore } from '@site/store/store'
import { openRealSourceProject, type RealSourceProject } from './realSourceHarness'

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

describe('P0-3 — a cross-frame move that orphans an import is one byte-exact ⌘Z', () => {
  let project: RealSourceProject
  const read = (rel: string) => project.read(rel)
  const waitFor = (predicate: () => boolean, timeoutMs?: number) => project.waitFor(predicate, timeoutMs)

  beforeEach(async () => {
    project = await openRealSourceProject({
      'pages/Product.tsx': PRODUCT,
      'pages/Cart.tsx': CART,
      'lib/format.ts': FORMAT,
      'components/Sparkle.tsx': SPARKLE,
      'components/Chevron.tsx': CHEVRON,
      'components/Banner.tsx': BANNER,
      'pages/Checkout.tsx': CHECKOUT,
      'assets/badge.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>',
    })
  })

  afterEach(() => project.close())

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
    await waitFor(() => project.saves.length === 1)
    await waitFor(() => useEditorStore.getState().canUndo)

    // The write really happened: the import only the badge used is gone, and
    // the cart gained the element and the import.
    expect(read('pages/Product.tsx')).not.toContain('badge.svg')
    expect(read('pages/Cart.tsx')).toContain('badge.svg')

    useEditorStore.getState().undo()
    await waitFor(() => project.saves.length === 2)
    await waitFor(() => !useEditorStore.getState().canUndo)

    expect(project.saves[1]!.edits[0]!.kind).toBe('restore')
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
    await waitFor(() => project.saves.length === 1)
    await waitFor(() => useEditorStore.getState().canUndo)
    const moved = [read('pages/Product.tsx'), read('pages/Cart.tsx')]

    useEditorStore.getState().undo()
    await waitFor(() => project.saves.length === 2)
    await waitFor(() => useEditorStore.getState().canRedo)

    useEditorStore.getState().redo()
    await waitFor(() => project.saves.length === 3)
    await waitFor(() => useEditorStore.getState().canUndo)
    expect([read('pages/Product.tsx'), read('pages/Cart.tsx')]).toEqual(moved)

    useEditorStore.getState().undo()
    await waitFor(() => project.saves.length === 4)
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
    await waitFor(() => project.saves.length >= 2, 15000)
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
