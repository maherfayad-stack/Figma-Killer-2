/**
 * G-7 - the single-file structure gestures that used to answer with a warning
 * write now, and each one is a single byte-exact ⌘Z.
 *
 * Real end to end (`realSourceHarness.ts`): `/save` is the editor's own journaled
 * batch and `/load` the real parse of the same files, so the ids the store acts
 * on are the ids the parser minted and the undo is the journal's `restore`.
 *
 * The fixture shares nothing with the eSIM corpus: a bakery's order page.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { openRealSourceProject, type RealSourceProject } from './realSourceHarness'

const ORDER = `export default function Order() {
  return (
    <main className="order">
      <h1>Order</h1>
      <p>Pick a loaf</p>
      <h2>Sides</h2>
      <p>And a spread</p>
    </main>
  )
}
`

const TILES = `export default function Tiles({ save }: { save: () => void }) {
  return (
    <main className="tiles">
      <div className="tile" onClick={save}>
        <h2>Rye</h2>
        <p>Dark</p>
      </div>
    </main>
  )
}
`

const SPLASH = 'export default function Splash() {\n  return <section className="splash">Hello</section>\n}\n'

const store = () => useEditorStore.getState()
const pageNamed = (fragment: string) => store().site!.pages.find((p) => p.id.includes(fragment))!
const nodeAt = (page: { nodes: Record<string, { id: string }> }, line: number) =>
  Object.values(page.nodes).find((n) => n.id.includes(`:${line}:`))!

describe('G-7 - structure gestures that resolve instead of warn', () => {
  let project: RealSourceProject

  beforeEach(async () => {
    project = await openRealSourceProject({
      'pages/Order.tsx': ORDER,
      'pages/Tiles.tsx': TILES,
      'pages/Splash.tsx': SPLASH,
    })
  })
  afterEach(() => project.close())

  it('groups two elements that are not next to each other - the one between stays - and ⌘Z restores every byte', async () => {
    const order = pageNamed('rder')
    const [first, third] = [nodeAt(order, 5), nodeAt(order, 7)]
    store().selectMany([first.id, third.id])
    store().groupNodes([first.id, third.id], 'base.container', { tag: 'div' })
    await project.waitFor(() => project.saves.length === 1)
    await project.waitFor(() => store().canUndo)

    expect(project.saves[0]!.edits[0]!.kind).toBe('group')
    expect(project.read('pages/Order.tsx')).toBe(`export default function Order() {
  return (
    <main className="order">
      <h1>Order</h1>
      <div>
        <p>Pick a loaf</p>
        <p>And a spread</p>
      </div>
      <h2>Sides</h2>
    </main>
  )
}
`)

    store().undo()
    await project.waitFor(() => project.saves.length === 2)
    await project.waitFor(() => !store().canUndo)
    expect(project.saves[1]!.edits[0]!.kind).toBe('restore')
    expect(project.read('pages/Order.tsx')).toBe(ORDER)
  }, 30_000)

  it('ungroups a wrapper that carries a handler: the children come out, the wrapper stays with its handler, and ⌘Z restores every byte', async () => {
    const tiles = pageNamed('iles')
    const tile = nodeAt(tiles, 4)
    store().setActivePage(tiles.id)
    store().ungroupNode(tile.id)
    await project.waitFor(() => project.saves.length === 1)
    await project.waitFor(() => store().canUndo)

    expect(project.saves[0]!.edits[0]!.kind).toBe('ungroup')
    expect(project.read('pages/Tiles.tsx')).toBe(`export default function Tiles({ save }: { save: () => void }) {
  return (
    <main className="tiles">
      <div className="tile" onClick={save} />
      <h2>Rye</h2>
      <p>Dark</p>
    </main>
  )
}
`)

    store().undo()
    await project.waitFor(() => project.saves.length === 2)
    await project.waitFor(() => !store().canUndo)
    expect(project.read('pages/Tiles.tsx')).toBe(TILES)
  }, 30_000)

  it('deletes the element a component returns - it renders nothing now - and ⌘Z brings it back byte for byte', async () => {
    const splash = pageNamed('plash')
    const section = nodeAt(splash, 2)
    // Selecting an element on a frame is what makes its page the active one.
    store().setActivePage(splash.id)
    store().selectNode(section.id)
    store().deleteNodes([section.id])
    await project.waitFor(() => project.saves.length === 1)
    await project.waitFor(() => store().canUndo)

    expect(project.read('pages/Splash.tsx')).toBe('export default function Splash() {\n  return null\n}\n')

    // A delete's entry exists before its write has answered; its inverse (the journal token) is what ⌘Z needs.
    await project.waitFor(() => {
      const past = store()._historyPast
      const entry = past[past.length - 1]
      return entry?.structural?.gesture === 'source' && entry.structural.source.inverse !== null
    })
    store().undo()
    await project.waitFor(() => project.saves.length === 2)
    await project.waitFor(() => !store().canUndo)
    expect(project.saves[1]!.edits[0]!.kind).toBe('restore')
    expect(project.read('pages/Splash.tsx')).toBe(SPLASH)
  }, 30_000)
})
