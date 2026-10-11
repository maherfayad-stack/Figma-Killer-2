/**
 * `G-3` / OD-22 - a gesture that crosses a component instance's edge never
 * ends in a refusal: it detaches that one instance (the OD-7 recipe), replays
 * the gesture on the markup that replaced it, says so in one line, and one
 * Cmd+Z puts every byte back.
 *
 *   - dragging an element OUT of an instance into the page around it;
 *   - dropping an element from the page INTO an instance's own markup;
 *   - dropping into a layout component's `children` slot, which needs no detach
 *     at all - the element is written between the `<Layout>` tags, where the
 *     component renders it;
 *   - the same drop into a component that renders no children, which does
 *     detach, with the notice.
 *
 * Real end to end (`realSourceHarness.ts`): `/save` is the editor's own
 * journaled batch and `/load` the real parse of the same files, so the ids the
 * replay addresses are the ones the first write really produced - including
 * the ones that shifted because the detach added or removed a line above them.
 * The fixtures are a kiosk and a recipe app: nothing in them is the eSIM corpus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { openRealSourceProject, type RealSourceProject } from './realSourceHarness'

const store = () => useEditorStore.getState()

function toasts(): Toast[] {
  let snapshot: Toast[] = []
  subscribeToasts((current) => {
    snapshot = current
  })()
  return snapshot
}

const TICKET_HEADER = `export function TicketHeader({ title }: { title: string }) {
  return (
    <header className="ticket-header">
      <h2>{title}</h2>
      <button type="button" className="close">Close</button>
    </header>
  )
}
`

const KIOSK = `import { TicketHeader } from '../components/TicketHeader'

export default function Kiosk() {
  return (
    <main className="kiosk">
      <TicketHeader title="Pick a seat" />
      <p className="note">Prices include tax</p>
    </main>
  )
}
`

/** Finds the node whose id ends at `file:line:col`, composite or not. */
function nodeEndingAt(page: { nodes: Record<string, { id: string }> }, tail: string): { id: string; children: string[] } {
  const found = Object.values(page.nodes).find((node) => node.id === tail || node.id.endsWith(`~${tail}`))
  if (!found) throw new Error(`no node at ${tail}: ${Object.keys(page.nodes).join(', ')}`)
  return found as { id: string; children: string[] }
}

describe('G-3 - dragging out of, and dropping into, a component instance', () => {
  let project: RealSourceProject
  beforeEach(async () => {
    project = await openRealSourceProject({
      'pages/Kiosk.tsx': KIOSK,
      'components/TicketHeader.tsx': TICKET_HEADER,
    })
    store().setActivePage(store().site!.pages[0]!.id)
  })
  afterEach(() => project.close())

  it('drag OUT: the close button leaves the instance for the page - the instance is detached, the button moved, one Cmd+Z restores both files', async () => {
    const page = store().site!.pages[0]!
    const close = nodeEndingAt(page, 'components/TicketHeader.tsx:5:8')
    const main = nodeEndingAt(page, 'pages/Kiosk.tsx:5:6')

    store().moveNodes([close.id], main.id, main.children.length)
    await project.waitFor(() => project.saves.length >= 2, 15000)
    await project.waitFor(() => store().canUndo)

    const after = project.read('pages/Kiosk.tsx')
    expect(after).not.toContain('<TicketHeader')
    expect(after).toContain('<h2>Pick a seat</h2>')
    // The button is now the page's own, after the note.
    expect(after.indexOf('className="close"')).toBeGreaterThan(after.indexOf('className="note"'))
    expect(project.read('components/TicketHeader.tsx')).toBe(TICKET_HEADER)
    expect(toasts().some((toast) => toast.kind === 'error')).toBe(false)
    expect(toasts().some((toast) => toast.title === 'Detached TicketHeader to place this. Undo restores it.')).toBe(true)

    store().undo()
    await project.waitFor(() => project.read('pages/Kiosk.tsx') === KIOSK, 15000)
    expect(project.read('components/TicketHeader.tsx')).toBe(TICKET_HEADER)
  })

  it('drop IN: the note moves from the page into the instance\'s header - detached, moved, one Cmd+Z', async () => {
    const page = store().site!.pages[0]!
    const note = nodeEndingAt(page, 'pages/Kiosk.tsx:7:8')
    const header = nodeEndingAt(page, 'components/TicketHeader.tsx:3:6')

    store().moveNodes([note.id], header.id, header.children.length)
    await project.waitFor(() => project.saves.length >= 2, 15000)
    await project.waitFor(() => store().canUndo)

    const after = project.read('pages/Kiosk.tsx')
    expect(after).not.toContain('<TicketHeader')
    // Inside the detached <header>, after the close button.
    const header2 = after.slice(after.indexOf('<header'), after.indexOf('</header>'))
    expect(header2).toContain('className="note"')
    expect(project.read('components/TicketHeader.tsx')).toBe(TICKET_HEADER)

    store().undo()
    await project.waitFor(() => project.read('pages/Kiosk.tsx') === KIOSK, 15000)
  })
})

const SHELL = `export function Shell({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <section className="shell">
      <h1>{title}</h1>
      <div className="shell-body">{children}</div>
      <footer className="shell-foot">fin</footer>
    </section>
  )
}
`

const RECIPES = `import { Shell } from '../components/Shell'

export default function Recipes() {
  return (
    <main className="recipes">
      <Shell title="Soups">
        <p className="first">Leek</p>
      </Shell>
      <aside className="tip">Salt early</aside>
    </main>
  )
}
`

describe("OD-22 - a drop into a layout component's children slot is written at the call site, no detach", () => {
  let project: RealSourceProject
  beforeEach(async () => {
    project = await openRealSourceProject({
      'pages/Recipes.tsx': RECIPES,
      'components/Shell.tsx': SHELL,
    })
    store().setActivePage(store().site!.pages[0]!.id)
  })
  afterEach(() => project.close())

  it('the parser names the slot: the instance carries the id of the element that renders {children}', () => {
    const page = store().site!.pages[0]!
    const instance = Object.values(page.nodes).find((node) => node.moduleId === 'studio.instance')!
    expect((instance.props as { childrenHost?: string }).childrenHost).toBe(`${instance.id}~components/Shell.tsx:5:8`)
  })

  it('moves the tip INTO the slot: it is written between the <Shell> tags, Shell is not detached, one Cmd+Z restores the page', async () => {
    const page = store().site!.pages[0]!
    const tip = nodeEndingAt(page, 'pages/Recipes.tsx:9:8')
    const host = nodeEndingAt(page, 'components/Shell.tsx:5:8')

    store().moveNodes([tip.id], host.id, host.children.length)
    await project.waitFor(() => project.saves.length >= 1, 15000)
    await project.waitFor(() => store().canUndo)

    const after = project.read('pages/Recipes.tsx')
    expect(after).toContain('<Shell title="Soups">')
    expect(after.indexOf('className="tip"')).toBeGreaterThan(after.indexOf('className="first"'))
    expect(after.indexOf('className="tip"')).toBeLessThan(after.indexOf('</Shell>'))
    expect(project.saves).toHaveLength(1)
    expect(project.read('components/Shell.tsx')).toBe(SHELL)
    expect(toasts().length).toBe(0)

    store().undo()
    await project.waitFor(() => project.read('pages/Recipes.tsx') === RECIPES, 15000)
    expect(store().canUndo).toBe(false)
  })

  it("inserts a new element into the slot at the dropped position: before the call site's first child", async () => {
    const page = store().site!.pages[0]!
    const host = nodeEndingAt(page, 'components/Shell.tsx:5:8')

    store().insertNode('base.container', {}, host.id, 0)
    await project.waitFor(() => project.saves.length >= 1, 15000)
    await project.waitFor(() => store().canUndo)

    const after = project.read('pages/Recipes.tsx')
    expect(after).not.toContain('<Shell title="Soups"/>')
    const inside = after.slice(after.indexOf('<Shell'), after.indexOf('</Shell>'))
    expect(inside.indexOf('<div')).toBeGreaterThan(-1)
    expect(inside.indexOf('<div')).toBeLessThan(inside.indexOf('className="first"'))
    expect(project.read('components/Shell.tsx')).toBe(SHELL)
    expect(project.saves).toHaveLength(1)
    expect(toasts().length).toBe(0)

    store().undo()
    await project.waitFor(() => project.read('pages/Recipes.tsx') === RECIPES, 15000)
  })

  it('a drop onto the instance itself appends to its children', async () => {
    const page = store().site!.pages[0]!
    const tip = nodeEndingAt(page, 'pages/Recipes.tsx:9:8')
    const instance = Object.values(page.nodes).find((node) => node.moduleId === 'studio.instance')!

    store().moveNodes([tip.id], instance.id, 0)
    await project.waitFor(() => project.saves.length >= 1, 15000)
    await project.waitFor(() => store().canUndo)
    const after = project.read('pages/Recipes.tsx')
    expect(after.indexOf('className="tip"')).toBeGreaterThan(after.indexOf('className="first"'))
    expect(after.indexOf('className="tip"')).toBeLessThan(after.indexOf('</Shell>'))
    expect(project.read('components/Shell.tsx')).toBe(SHELL)
  })
})

const BADGE_COMPONENT = `export function Plate({ label }: { label: string }) {
  return (
    <div className="plate">
      <span>{label}</span>
    </div>
  )
}
`

const MENU = `import { Plate } from '../components/Plate'

export default function Menu() {
  return (
    <main className="menu">
      <Plate label="Soup" />
      <aside className="tip">Salt early</aside>
    </main>
  )
}
`

describe('OD-22 - a drop into a component that renders no children detaches it, with the notice', () => {
  let project: RealSourceProject
  beforeEach(async () => {
    project = await openRealSourceProject({
      'pages/Menu.tsx': MENU,
      'components/Plate.tsx': BADGE_COMPONENT,
    })
    store().setActivePage(store().site!.pages[0]!.id)
  })
  afterEach(() => project.close())

  it('the instance has no children slot, so there is nothing to write at the call site', () => {
    const page = store().site!.pages[0]!
    const instance = Object.values(page.nodes).find((node) => node.moduleId === 'studio.instance')!
    expect((instance.props as { childrenHost?: string }).childrenHost).toBeUndefined()
  })

  it('dropping on the instance detaches Plate, writes the tip inside its root, and says so', async () => {
    const page = store().site!.pages[0]!
    const tip = nodeEndingAt(page, 'pages/Menu.tsx:7:8')
    const instance = Object.values(page.nodes).find((node) => node.moduleId === 'studio.instance')!

    store().moveNodes([tip.id], instance.id, 0)
    await project.waitFor(() => project.saves.length >= 2, 15000)
    await project.waitFor(() => store().canUndo)

    const after = project.read('pages/Menu.tsx')
    expect(after).not.toContain('<Plate')
    const plate = after.slice(after.indexOf('<div className="plate"'), after.indexOf('</div>'))
    expect(plate).toContain('className="tip"')
    expect(project.read('components/Plate.tsx')).toBe(BADGE_COMPONENT)
    expect(toasts().some((toast) => toast.title === 'Detached Plate to place this. Undo restores it.')).toBe(true)

    store().undo()
    await project.waitFor(() => project.read('pages/Menu.tsx') === MENU, 15000)
  })
})
