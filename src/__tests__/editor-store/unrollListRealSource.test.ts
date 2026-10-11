/**
 * `G-9` / OD-24 — "Unroll list", end to end on a real temp project.
 *
 * `/save` is the editor's own journaled batch and `/load` the real parse of the
 * same files (`realSourceHarness.ts`), so the ids the replayed gesture is aimed
 * at are the ones the write really produced. What this pins:
 *
 *  - the menu action writes the rows out and ⌘Z puts the file back byte for byte;
 *  - a gesture the array cannot express (here: deleting an element INSIDE a row)
 *    is refused with "Unroll list" as a remedy, and taking it writes the rows
 *    out AND runs the gesture on the row the user pointed at — one ⌘Z undoes
 *    both, byte for byte;
 *  - a list that is not an array literal in this file is never offered it.
 *
 * A noodle-bar menu — nothing from the eSIM corpus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { listRowArrayOf, type Page } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { openRealSourceProject, type RealSourceProject } from './realSourceHarness'

const MENU = `const DISHES = [
  { id: 'a', name: 'Dumplings', price: 8 },
  { id: 'b', name: 'Noodles', price: 11 },
  { id: 'c', name: 'Congee', price: 7 },
]

export default function Menu() {
  return (
    <main className="menu">
      <h1>Tonight</h1>
      <ul>
        {DISHES.map((dish) => (
          <li key={dish.id}>
            <b>{dish.name}</b>
            <span>{dish.price}</span>
          </li>
        ))}
      </ul>
      <p>Open until late</p>
    </main>
  )
}
`

const UNROLLED = `const DISHES = [
  { id: 'a', name: 'Dumplings', price: 8 },
  { id: 'b', name: 'Noodles', price: 11 },
  { id: 'c', name: 'Congee', price: 7 },
]

export default function Menu() {
  return (
    <main className="menu">
      <h1>Tonight</h1>
      <ul>
        <li>
          <b>Dumplings</b>
          <span>8</span>
        </li>
        <li>
          <b>Noodles</b>
          <span>11</span>
        </li>
        <li>
          <b>Congee</b>
          <span>7</span>
        </li>
      </ul>
      <p>Open until late</p>
    </main>
  )
}
`

/** The same page after "delete the <b> of the SECOND row" ran on the unrolled list. */
const UNROLLED_THEN_DELETED = UNROLLED.replace('          <b>Noodles</b>\n', '')

const IMPORTED = `import { DISHES } from './dishes'

export default function Menu() {
  return (
    <ul>
      {DISHES.map((dish) => (
        <li key={dish.id}>
          <b>{dish.name}</b>
        </li>
      ))}
    </ul>
  )
}
`

function currentToasts(): Toast[] {
  let snapshot: Toast[] = []
  subscribeToasts((toasts) => {
    snapshot = toasts
  })()
  return snapshot
}

const store = () => useEditorStore.getState()
const page = (): Page => store().site!.pages.find((candidate) => candidate.title === 'Menu')!

/** The row roots of the list in array order. */
function rowRoots(): string[] {
  return Object.values(page().nodes)
    .map((node) => ({ id: node.id, row: listRowArrayOf(node) }))
    .filter((entry) => entry.row !== null)
    .sort((a, b) => a.row!.index - b.row!.index)
    .map((entry) => entry.id)
}

describe('G-9 — "Unroll list" on a real project', () => {
  let project: RealSourceProject

  beforeEach(async () => {
    project = await openRealSourceProject({ 'pages/Menu.tsx': MENU })
  })
  afterEach(() => project.close())

  it('the menu action writes the rows out, names the consequence, and ⌘Z / ⌘⇧Z are byte-exact', async () => {
    const rows = rowRoots()
    expect(rows).toHaveLength(3)

    await expect(store().unrollList(rows[1]!)).resolves.toBe('unrolled')
    await project.waitFor(() => store().canUndo)
    expect(project.read('pages/Menu.tsx')).toBe(UNROLLED)
    // The board re-read it: three ordinary, writable elements and no list.
    expect(rowRoots()).toHaveLength(0)
    const notice = currentToasts().find((toast) => toast.title === 'List unrolled')
    expect(notice?.kind).toBe('info')
    expect(notice?.body).toContain('DISHES is now 3 separate elements')

    store().undo()
    await project.waitFor(() => project.saves.length === 2)
    await project.waitFor(() => !store().canUndo)
    expect(project.saves[1]!.edits[0]!.kind).toBe('restore')
    expect(project.read('pages/Menu.tsx')).toBe(MENU)
    await project.waitFor(() => rowRoots().length === 3)

    store().redo()
    await project.waitFor(() => project.saves.length === 3)
    await project.waitFor(() => store().canUndo)
    expect(project.read('pages/Menu.tsx')).toBe(UNROLLED)
  })

  it('a node inside a row is not offered the array path; taking "Unroll list" runs the refused delete on that row, and one ⌘Z undoes both', async () => {
    const rows = rowRoots()
    const secondRow = page().nodes[rows[1]!]!
    const bold = secondRow.children[0]!

    store().deleteNodes([bold])
    // Refused: nothing was written, and the dialog offers the remedy.
    expect(project.saves).toHaveLength(0)
    const dialog = store().structuralRefusalDialog
    expect(dialog?.constraint.reason).toBe('list-row')
    expect(dialog?.constraint.actions.map((action) => action.kind)).toContain('unroll-list')
    expect(dialog?.replayRemedies?.unrollList).toBeTypeOf('function')

    dialog!.replayRemedies!.unrollList!()
    await project.waitFor(() => project.saves.length === 2)
    await project.waitFor(() => store().canUndo)
    expect(project.saves.map((save) => save.edits[0]!.kind)).toEqual(['unroll-list', 'delete'])
    expect(project.read('pages/Menu.tsx')).toBe(UNROLLED_THEN_DELETED)

    // One ⌘Z: the delete AND the unroll, byte for byte.
    store().undo()
    await project.waitFor(() => project.saves.length === 4)
    await project.waitFor(() => !store().canUndo)
    expect(project.saves.slice(2).map((save) => save.edits[0]!.kind)).toEqual(['restore', 'restore'])
    expect(project.read('pages/Menu.tsx')).toBe(MENU)
  })

  it('a gesture the array CAN express (deleting a whole row) still edits the array, never the unroll', async () => {
    store().deleteNodes([rowRoots()[2]!])
    await project.waitFor(() => project.saves.length === 1)
    expect(project.saves[0]!.edits[0]!.kind).toBe('list-item')
    expect(store().structuralRefusalDialog).toBeNull()
    expect(project.read('pages/Menu.tsx')).toContain('.map((dish)')
  })

  it('the Layers menu / palette action does nothing on a node that is not in a list', async () => {
    const heading = Object.values(page().nodes).find((node) => node.props.text === 'Tonight')!
    await expect(store().unrollList(heading.id)).resolves.toBe('nothing')
    expect(project.saves).toHaveLength(0)
  })
})

describe('G-9 — a list whose array is not written in this file is not offered "Unroll list"', () => {
  let project: RealSourceProject

  beforeEach(async () => {
    project = await openRealSourceProject({
      'pages/Menu.tsx': IMPORTED,
      'pages/dishes.ts': "export const DISHES = [{ id: 'a', name: 'Dumplings' }, { id: 'b', name: 'Noodles' }]\n",
    })
  })
  afterEach(() => project.close())

  it('refuses the wrap with its own sentence and no unroll remedy; nothing is written', async () => {
    const row = Object.values(page().nodes).find((node) => node.listRow?.kind === 'refused')!
    expect(row.listRow).toMatchObject({ kind: 'refused', reason: 'imported' })

    await expect(store().unrollList(row.id)).resolves.toBe('nothing')
    store().deleteNodes([row.children[0]!])
    const dialog = store().structuralRefusalDialog
    expect(dialog?.constraint.reason).toBe('list-row')
    expect(dialog?.constraint.actions.map((action) => action.kind)).not.toContain('unroll-list')
    expect(dialog?.replayRemedies?.unrollList).toBeUndefined()
    expect(project.saves).toHaveLength(0)
  })
})
