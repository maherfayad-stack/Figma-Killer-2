/**
 * G-9 / OD-24 — "Unroll list", end to end through the real load and the real
 * save batch: the load stamps each row with its array and its template, an
 * `unroll-list` edit built from that stamp goes through the batch (path
 * guard, journal), the next load shows the rows as ordinary nodes with
 * writable ids, and the journal's `restore` puts the file back byte for byte.
 *
 * A reading-list fixture — nothing from the eSIM corpus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { hasWritableSourceLocation, listRowArrayOf, loopTemplateNodeId, type Page } from '@core/page-tree'
import { clearPageParseCache } from '../studio/pageParseCache'
import { clearStudioLoadMemo } from '../studio/studioLoadMemo'
import { clearWorkspaceProjects } from '../studio/workspaceProject'
import { loadStudioPages } from '../studioPageLoad'
import { applyStudioEditBatch } from '../studioWriteback'

let wsDir: string

const SHELF = [
  'const BOOKS = [',
  "  { isbn: '111', title: 'Dune', pages: 612 },",
  "  { isbn: '222', title: 'Solaris', pages: 204 },",
  "  { isbn: '333', title: 'Piranesi', pages: 272 },",
  ']',
  '',
  'export default function Shelf() {',
  '  return (',
  '    <ol>',
  '      {BOOKS.map((book, n) => (',
  '        <li key={book.isbn} title={book.title}>',
  '          <b>{book.title}</b>',
  '          <i>{book.pages} pages</i>',
  '        </li>',
  '      ))}',
  '    </ol>',
  '  )',
  '}',
  '',
].join('\n')

const EDITOR = { canvasLayers: 'allow', journal: true } as const

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

/** The row roots in board order, and the unroll edit the board would send for them. */
function unrollEdit(page: Page, overrides: { length?: number } = {}) {
  const rows = Object.values(page.nodes)
    .map((node) => ({ node, row: listRowArrayOf(node) }))
    .filter((entry): entry is { node: (typeof entry)['node']; row: NonNullable<(typeof entry)['row']> } => entry.row !== null)
    .sort((a, b) => a.row.index - b.row.index)
  const first = rows[0]!
  return {
    rows,
    edit: {
      kind: 'unroll-list' as const,
      nodeId: loopTemplateNodeId(first.node.id)!,
      array: first.row.array,
      length: overrides.length ?? first.row.length,
    },
  }
}

beforeEach(() => {
  clearPageParseCache()
  clearStudioLoadMemo()
  clearWorkspaceProjects()
  wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-unroll-list-'))
  write('pages/Shelf.tsx', SHELF)
})

afterEach(() => {
  clearPageParseCache()
  clearStudioLoadMemo()
  clearWorkspaceProjects()
  fs.rmSync(wsDir, { recursive: true, force: true })
})

describe('G-9 — unroll-list through the load and the save batch', () => {
  it('writes the rows out, reports each new element in order, and the next load shows ordinary writable nodes', async () => {
    const before = await shelf()
    const { rows, edit } = unrollEdit(before)
    expect(rows).toHaveLength(3)
    expect(rows.every((entry) => !hasWritableSourceLocation(entry.node.id))).toBe(true)

    const result = applyStudioEditBatch(wsDir, [edit], {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(result.written).toBe(1)
    expect(result.shifted).toBe(true)
    expect(read('pages/Shelf.tsx')).toBe(
      [
        'const BOOKS = [',
        "  { isbn: '111', title: 'Dune', pages: 612 },",
        "  { isbn: '222', title: 'Solaris', pages: 204 },",
        "  { isbn: '333', title: 'Piranesi', pages: 272 },",
        ']',
        '',
        'export default function Shelf() {',
        '  return (',
        '    <ol>',
        '      <li title="Dune">',
        '        <b>Dune</b>',
        '        <i>612 pages</i>',
        '      </li>',
        '      <li title="Solaris">',
        '        <b>Solaris</b>',
        '        <i>204 pages</i>',
        '      </li>',
        '      <li title="Piranesi">',
        '        <b>Piranesi</b>',
        '        <i>272 pages</i>',
        '      </li>',
        '    </ol>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    // The three created ids are the three <li>, in order, and they are what the next load calls its rows.
    expect(result.createdNodeIds).toHaveLength(3)
    const after = await shelf()
    expect(Object.values(after.nodes).some((node) => listRowArrayOf(node) !== null)).toBe(false)
    const lis = result.createdNodeIds.map((id) => after.nodes[id])
    expect(lis.every((node) => node !== undefined && hasWritableSourceLocation(node.id))).toBe(true)
    const titles = lis.map((li) => after.nodes[li!.children[0]!]?.props.text)
    expect(titles).toEqual(['Dune', 'Solaris', 'Piranesi'])
  })

  it('records a journal entry whose restore puts the file back byte for byte', async () => {
    const { edit } = unrollEdit(await shelf())
    const written = applyStudioEditBatch(wsDir, [edit], {}, EDITOR)
    expect(written.undoToken).toMatch(/^[0-9a-f]{32}$/)
    expect(read('pages/Shelf.tsx')).not.toBe(SHELF)

    const token = written.undoToken!
    const back = applyStudioEditBatch(wsDir, [{ kind: 'restore', nodeId: `undo-journal:${token}`, token }], {}, EDITOR)
    expect(back.refusals).toEqual([])
    expect(read('pages/Shelf.tsx')).toBe(SHELF)
    expect(unrollEdit(await shelf()).rows).toHaveLength(3)
  })

  it('refuses and writes nothing when the list changed since the board read it', async () => {
    const { edit } = unrollEdit(await shelf(), { length: 4 })
    const stale = applyStudioEditBatch(wsDir, [edit], {}, EDITOR)
    expect(stale.written).toBe(0)
    expect(stale.refusals.map((refusal) => refusal.reason)).toEqual(['list-changed'])
    expect(stale.undoToken).toBeUndefined()
    expect(read('pages/Shelf.tsx')).toBe(SHELF)
  })

  it('refuses when the array is in another file, whatever the id says', async () => {
    write('pages/data.ts', "export const OTHER = [{ title: 'x' }]\n")
    const { edit } = unrollEdit(await shelf())
    const foreign = applyStudioEditBatch(wsDir, [{ ...edit, array: 'pages/data.ts:1:23', length: 1 }], {}, EDITOR)
    expect(foreign.written).toBe(0)
    expect(foreign.refusals.map((refusal) => refusal.reason)).toEqual(['not-literal'])
    expect(read('pages/Shelf.tsx')).toBe(SHELF)
  })

  it('the path guard applies to both ends: nothing outside the workspace is read or written', async () => {
    const { edit } = unrollEdit(await shelf())
    const outside = path.join(path.dirname(wsDir), 'unroll-outside.tsx')
    fs.writeFileSync(outside, SHELF, 'utf8')
    try {
      const template = applyStudioEditBatch(wsDir, [{ ...edit, nodeId: '../unroll-outside.tsx:10:10' }], {}, EDITOR)
      expect(template.written).toBe(0)
      expect(template.refusals).toHaveLength(1)
      const array = applyStudioEditBatch(wsDir, [{ ...edit, array: '../unroll-outside.tsx:1:15' }], {}, EDITOR)
      expect(array.written).toBe(0)
      expect(array.refusals).toHaveLength(1)
      expect(fs.readFileSync(outside, 'utf8')).toBe(SHELF)
      expect(read('pages/Shelf.tsx')).toBe(SHELF)
    } finally {
      fs.rmSync(outside, { force: true })
    }
  })
})
