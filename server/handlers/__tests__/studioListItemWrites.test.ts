/**
 * OD-8 — a `.map` row's structure is written to the ARRAY, end to end: the
 * real load stamps each row with its element, a `list-item` edit built from
 * that stamp goes through the real save batch (path guard, ordering, prune),
 * and the next load shows the rows in the new order. Plus the refusals the
 * batch must report rather than write.
 *
 * A reading-list fixture — nothing from the eSIM corpus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { listRowArrayOf, type Page } from '@core/page-tree'
import { clearPageParseCache } from '../studio/pageParseCache'
import { clearStudioLoadMemo } from '../studio/studioLoadMemo'
import { clearWorkspaceProjects } from '../studio/workspaceProject'
import { loadStudioPages } from '../studioPageLoad'
import { applyStudioEditBatch } from '../studioWriteback'

let wsDir: string

const SHELF = [
  "import { BookIcon } from './BookIcon'",
  '',
  'const BOOKS = [',
  "  { isbn: '111', title: 'Dune' },",
  "  // a re-read",
  "  { isbn: '222', title: 'Solaris', icon: BookIcon },",
  "  { isbn: '333', title: 'Piranesi' },",
  ']',
  '',
  'export default function Shelf() {',
  '  return (',
  '    <ol>',
  '      {BOOKS.map((book) => (',
  '        <li key={book.isbn}>{book.title}</li>',
  '      ))}',
  '    </ol>',
  '  )',
  '}',
  '',
].join('\n')

function write(relPath: string, contents: string): void {
  const full = path.join(wsDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

const read = (relPath: string) => fs.readFileSync(path.join(wsDir, ...relPath.split('/')), 'utf8')

async function shelf(): Promise<Page> {
  clearStudioLoadMemo()
  clearPageParseCache()
  const page = (await loadStudioPages(wsDir)).pages.find((candidate) => candidate.title === 'Shelf')
  if (!page) throw new Error('no Shelf page')
  return page
}

/** The row texts in board order, and the array stamp every row shares. */
function rowsOf(page: Page) {
  const rows = Object.values(page.nodes)
    .map((node) => ({ node, row: listRowArrayOf(node) }))
    .filter((entry) => entry.row !== null)
    .sort((a, b) => a.row!.index - b.row!.index)
  return { titles: rows.map((entry) => entry.node.props.text), stamp: rows[0]!.row! }
}

beforeEach(() => {
  clearPageParseCache()
  clearStudioLoadMemo()
  clearWorkspaceProjects()
  wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-list-items-'))
  write('pages/Shelf.tsx', SHELF)
  write('pages/BookIcon.tsx', 'export function BookIcon() {\n  return <svg />\n}\n')
})

afterEach(() => {
  clearPageParseCache()
  clearStudioLoadMemo()
  clearWorkspaceProjects()
  fs.rmSync(wsDir, { recursive: true, force: true })
})

describe('OD-8 — list-item edits through the load and the save batch', () => {
  it('a reorder rewrites the array and the next load shows the new order', async () => {
    const { titles, stamp } = rowsOf(await shelf())
    expect(titles).toEqual(['Dune', 'Solaris', 'Piranesi'])
    expect(stamp).toMatchObject({ array: 'pages/Shelf.tsx:3:15', length: 3, key: { kind: 'field', field: 'isbn' } })

    const result = applyStudioEditBatch(wsDir, [{ kind: 'list-item', nodeId: stamp.array, length: 3, op: { kind: 'reorder', order: [2, 0, 1] } }])
    expect(result.refusals).toEqual([])
    expect(result.written).toBe(1)
    expect(read('pages/Shelf.tsx')).toContain(
      "const BOOKS = [\n  { isbn: '333', title: 'Piranesi' },\n  { isbn: '111', title: 'Dune' },\n  // a re-read\n  { isbn: '222', title: 'Solaris', icon: BookIcon },\n]",
    )
    expect(rowsOf(await shelf()).titles).toEqual(['Piranesi', 'Dune', 'Solaris'])
  })

  it('a remove takes the import only it read, and its journal restore puts both back byte for byte (P3-F)', async () => {
    const { stamp } = rowsOf(await shelf())
    const EDITOR = { canvasLayers: 'allow', journal: true } as const
    const removed = applyStudioEditBatch(wsDir, [{ kind: 'list-item', nodeId: stamp.array, length: 3, op: { kind: 'remove', indices: [1] } }], {}, EDITOR)
    expect(removed.refusals).toEqual([])
    expect(read('pages/Shelf.tsx')).not.toContain('BookIcon')
    // The prune took the import line above the array, so the array moved up
    // one line — and the batch says where it is now, which the board re-reads.
    expect(removed.listArrays).toEqual([{ nodeId: stamp.array, to: 'pages/Shelf.tsx:2:15' }])
    expect(removed.undoToken).toMatch(/^[0-9a-f]{32}$/)

    const token = removed.undoToken!
    const back = applyStudioEditBatch(wsDir, [{ kind: 'restore', nodeId: `undo-journal:${token}`, token }], {}, EDITOR)
    expect(back.refusals).toEqual([])
    expect(read('pages/Shelf.tsx')).toBe(SHELF)
  })

  it('a reorder or copy records no journal entry — its inverse is an ordinary list-item edit', async () => {
    const { stamp } = rowsOf(await shelf())
    const result = applyStudioEditBatch(
      wsDir,
      [{ kind: 'list-item', nodeId: stamp.array, length: 3, op: { kind: 'reorder', order: [2, 0, 1] } }],
      {},
      { canvasLayers: 'allow', journal: true },
    )
    expect(result.written).toBe(1)
    expect(result.undoToken).toBeUndefined()
  })

  it('a copy gets a key of its own', async () => {
    const { stamp } = rowsOf(await shelf())
    applyStudioEditBatch(wsDir, [{ kind: 'list-item', nodeId: stamp.array, length: 3, op: { kind: 'copy', from: [0], at: 1, key: stamp.key } }])
    expect(read('pages/Shelf.tsx')).toContain("  { isbn: '111', title: 'Dune' },\n  { isbn: '111-copy', title: 'Dune' },\n")
    expect(rowsOf(await shelf()).titles).toEqual(['Dune', 'Dune', 'Solaris', 'Piranesi'])
  })

  it('refuses, and writes nothing, when the array changed since the board read it or the id is not an array', async () => {
    const { stamp } = rowsOf(await shelf())
    const stale = applyStudioEditBatch(wsDir, [{ kind: 'list-item', nodeId: stamp.array, length: 4, op: { kind: 'remove', indices: [0] } }])
    expect(stale.refusals.map((refusal) => refusal.reason)).toEqual(['list-changed'])
    const notArray = applyStudioEditBatch(wsDir, [{ kind: 'list-item', nodeId: 'pages/Shelf.tsx:14:9', length: 3, op: { kind: 'remove', indices: [0] } }])
    expect(notArray.refusals.map((refusal) => refusal.reason)).toEqual(['not-found'])
    expect(read('pages/Shelf.tsx')).toBe(SHELF)
  })

  it('the path guard applies: an array id outside the workspace is never written', async () => {
    const escaped = applyStudioEditBatch(wsDir, [{ kind: 'list-item', nodeId: '../outside.tsx:1:1', length: 1, op: { kind: 'remove', indices: [0] } }])
    expect(escaped.written).toBe(0)
    expect(escaped.refusals).toHaveLength(1)
  })
})
