/**
 * `W2-2` — the free canvas's lift and place, and an insert into a childless
 * parent, are each one ⌘Z that puts every file back byte for byte, even when
 * the write itself moved every id below it.
 *
 * Real end to end (`realSourceHarness.ts`): `/save` is the editor's own journaled
 * batch and `/load` the real parse of the same files. The undo these replaced
 * recorded a parent id at drag time (`canvas-layer-lift-back`); the lift prunes
 * the import only the lifted `<img>` used, so that id is a line off by ⌘Z and the
 * undo refused as stale.
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

const FORMAT = `export function formatPrice(n: number): string {
  return '$' + n
}
`

const HOME = `export default function Home() {
  return (
    <main className="home">
      <section className="hero" />
      <p>Hi</p>
    </main>
  )
}
`

const FRAME = `export function Frame() {
  return <div className="frame" />
}
`

const CHECKOUT = `import { Frame } from '../components/Frame'

export default function Checkout() {
  return (
    <main className="checkout">
      <Frame />
    </main>
  )
}
`

const BADGE = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>'

const store = () => useEditorStore.getState()
const pageNamed = (fragment: string) => store().site!.pages.find((p) => p.id.includes(fragment))!
const nodeAt = (page: { nodes: Record<string, { id: string }> }, line: number) =>
  Object.values(page.nodes).find((n) => n.id.includes(`:${line}:`))!

describe('W2-2 — the free canvas lift and place are byte-exact ⌘Z', () => {
  let project: RealSourceProject

  beforeEach(async () => {
    project = await openRealSourceProject({
      'pages/Product.tsx': PRODUCT,
      'pages/Cart.tsx': CART,
      'lib/format.ts': FORMAT,
      'assets/badge.svg': BADGE,
    })
  })
  afterEach(() => project.close())

  it('lifts an element onto the board, then one ⌘Z restores the page and removes the module', async () => {
    const product = pageNamed('roduct')
    const img = nodeAt(product, 8)
    store().liftNodeToCanvas(img.id, product.id, { x: 900, y: 40 }, false)
    await project.waitFor(() => project.saves.length === 1)
    await project.waitFor(() => store().canUndo)

    // The write really shifted ids: the import only the image used is gone.
    expect(project.read('pages/Product.tsx')).not.toContain('badge.svg')
    expect(Object.keys(store().canvasLayerPages)).toHaveLength(1)

    store().undo()
    await project.waitFor(() => project.saves.length === 2)
    await project.waitFor(() => !store().canUndo)

    expect(project.saves[1]!.edits[0]!.kind).toBe('restore')
    expect(project.read('pages/Product.tsx')).toBe(PRODUCT)
    expect(Object.keys(store().canvasLayerPages)).toHaveLength(0)
    expect(store().canRedo).toBe(true)

    // And the redo is undoable again.
    store().redo()
    await project.waitFor(() => project.saves.length === 3)
    await project.waitFor(() => store().canUndo)
    expect(project.read('pages/Product.tsx')).not.toContain('badge.svg')
    store().undo()
    await project.waitFor(() => project.saves.length === 4)
    await project.waitFor(() => !store().canUndo)
    expect(project.read('pages/Product.tsx')).toBe(PRODUCT)
  })

  it('drops the lifted layer into another frame, and each ⌘Z puts back the step before it byte for byte', async () => {
    const product = pageNamed('roduct')
    store().liftNodeToCanvas(nodeAt(product, 8).id, product.id, { x: 900, y: 40 }, false)
    await project.waitFor(() => project.saves.length === 1)
    await project.waitFor(() => store().canUndo && Object.keys(store().canvasLayerPages).length === 1)
    const lifted = project.read('pages/Product.tsx')
    const layerId = Object.keys(store().canvasLayerPages)[0]!.replace(/^canvas:/, '')

    const cart = pageNamed('art')
    const cartMain = nodeAt(cart, 4)
    store().placeCanvasLayer(layerId, { pageId: cart.id, parentId: cartMain.id, index: 1, copy: false })
    await project.waitFor(() => project.saves.length === 2)
    await project.waitFor(() => Object.keys(store().canvasLayerPages).length === 0)
    await project.waitFor(() => store().canUndo)
    expect(project.read('pages/Cart.tsx')).toContain('badge.svg')

    store().undo()
    await project.waitFor(() => project.saves.length === 3)
    await project.waitFor(() => Object.keys(store().canvasLayerPages).length === 1)
    expect(project.saves[2]!.edits[0]!.kind).toBe('restore')
    expect(project.read('pages/Cart.tsx')).toBe(CART)
    expect(project.read('pages/Product.tsx')).toBe(lifted)

    store().undo()
    await project.waitFor(() => project.saves.length === 4)
    await project.waitFor(() => !store().canUndo)
    expect(project.read('pages/Product.tsx')).toBe(PRODUCT)
    expect(project.read('pages/Cart.tsx')).toBe(CART)
    expect(Object.keys(store().canvasLayerPages)).toHaveLength(0)
  })
})

describe('W2-2 — a same-file move is undone byte for byte', () => {
  let project: RealSourceProject

  beforeEach(async () => {
    project = await openRealSourceProject({
      'pages/Product.tsx': PRODUCT,
      'pages/Cart.tsx': CART,
      'lib/format.ts': FORMAT,
      'assets/badge.svg': BADGE,
    })
  })
  afterEach(() => project.close())

  it('reorders a sibling, then ⌘Z restores the file with the journal and ⌘⇧Z moves it again', async () => {
    const product = pageNamed('roduct')
    store().setActivePage(product.id)
    const main = nodeAt(product, 7)
    store().moveNodes([nodeAt(product, 8).id], main.id, 4)
    await project.waitFor(() => project.saves.length === 1)
    await project.waitFor(() => store().canUndo)
    const moved = project.read('pages/Product.tsx')
    expect(moved).not.toBe(PRODUCT)

    store().undo()
    await project.waitFor(() => project.saves.length === 2)
    await project.waitFor(() => !store().canUndo)
    expect(project.saves[1]!.edits[0]!.kind).toBe('restore')
    expect(project.read('pages/Product.tsx')).toBe(PRODUCT)

    store().redo()
    await project.waitFor(() => project.saves.length === 3)
    await project.waitFor(() => store().canUndo)
    expect(project.read('pages/Product.tsx')).toBe(moved)
  })

  it('reparents into a sibling container, then ⌘Z restores the blank line and indentation', async () => {
    const cart = pageNamed('art')
    store().setActivePage(cart.id)
    const list = nodeAt(cart, 6)
    store().moveNodes([nodeAt(cart, 5).id], list.id, 1)
    await project.waitFor(() => project.saves.length === 1)
    await project.waitFor(() => store().canUndo)
    expect(project.read('pages/Cart.tsx')).not.toBe(CART)

    store().undo()
    await project.waitFor(() => project.saves.length === 2)
    await project.waitFor(() => !store().canUndo)
    expect(project.read('pages/Cart.tsx')).toBe(CART)
  })
})

describe('W2-2 — an insert into a self-closing element is undone byte for byte', () => {
  let project: RealSourceProject
  afterEach(() => project.close())

  it('inserts into `<section />`, then ⌘Z restores the self-closing form', async () => {
    project = await openRealSourceProject({ 'pages/Home.tsx': HOME })
    const home = pageNamed('ome')
    store().setActivePage(home.id)
    store().insertNode('base.container', {}, nodeAt(home, 4).id, 0)
    await project.waitFor(() => project.saves.length === 1)
    await project.waitFor(() => store().canUndo)
    expect(project.read('pages/Home.tsx')).not.toBe(HOME)

    store().undo()
    await project.waitFor(() => project.saves.length === 2)
    await project.waitFor(() => !store().canUndo)
    expect(project.saves[1]!.edits[0]!.kind).toBe('restore')
    expect(project.read('pages/Home.tsx')).toBe(HOME)
  })

  it('an insert into a populated parent still undoes as a plain delete', async () => {
    project = await openRealSourceProject({ 'pages/Home.tsx': HOME })
    const home = pageNamed('ome')
    store().setActivePage(home.id)
    store().insertNode('base.container', {}, nodeAt(home, 3).id, 2)
    await project.waitFor(() => project.saves.length === 1)
    await project.waitFor(() => store().canUndo)

    store().undo()
    await project.waitFor(() => project.saves.length === 2)
    expect(project.saves[1]!.edits[0]!.kind).toBe('delete')
  })

  it('an OD-7 insert into a shared component\'s self-closing root: one ⌘Z puts `<Frame />` back', async () => {
    project = await openRealSourceProject({ 'components/Frame.tsx': FRAME, 'pages/Checkout.tsx': CHECKOUT })
    const checkout = pageNamed('heckout')
    const inner = Object.values(checkout.nodes).find((n) => n.id.includes('~') && n.moduleId === 'base.container')!
    store().setActivePage(checkout.id)
    store().insertNode('base.container', {}, inner.id, 0)
    await project.waitFor(() => project.saves.length >= 2, 15000)
    await project.waitFor(() => store().canUndo)
    expect(project.read('pages/Checkout.tsx')).not.toContain('<Frame')

    store().undo()
    await project.waitFor(() => project.read('pages/Checkout.tsx') === CHECKOUT, 8000)
    expect(project.read('components/Frame.tsx')).toBe(FRAME)
  })
})
