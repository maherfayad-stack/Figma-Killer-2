/**
 * P1-D — WB-1's re-locate half: an edit whose file changed on disk after the
 * board read it lands on the element it was aimed at, wherever that element
 * now is — or refuses, when there is not exactly one place it can be.
 *
 * WB-1's probe, one step further than P1-A's guard test
 * (`studioElementIdentity.test.ts`): the board LOADS the project through the
 * real load path (which is what records the text it read), an outside writer
 * inserts a line above the list, and the board's stale ids are posted with
 * the identities it read. P1-A made that a refusal; now the element is
 * re-found through a line diff, re-verified by its fingerprint, and written
 * where it actually is.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@core/page-tree'
import { clearPageParseCache } from '../studio/pageParseCache'
import { clearSourceTextHistory } from '../studio/sourceTextHistory'
import { projectsRootDir } from '../studioProjects'
import { loadStudioPages } from '../studioPageLoad'
import { applyStudioEditBatch, type StudioEdit } from '../studioWriteback'

let wsDir: string

const write = (rel: string, contents: string) => {
  const full = path.join(wsDir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}
const read = (rel: string) => fs.readFileSync(path.join(wsDir, ...rel.split('/')), 'utf8')

beforeEach(() => {
  clearPageParseCache()
  clearSourceTextHistory()
  const root = projectsRootDir()
  fs.mkdirSync(root, { recursive: true })
  wsDir = fs.mkdtempSync(path.join(root, '__relocate_test_'))
})

afterEach(() => {
  fs.rmSync(wsDir, { recursive: true, force: true })
  clearPageParseCache()
  clearSourceTextHistory()
})

const LIST = [
  'export default function Home() {',
  '  return (',
  '    <ul>',
  '      <li title="a">One</li>',
  '      <li title="b">Two</li>',
  '      <li title="c">Three</li>',
  '    </ul>',
  '  )',
  '}',
  '',
].join('\n')

/** `rel:line:col` of the `<tag` on 1-based `line` of `source` — the id the parser mints (col just after `<`). */
function idAt(source: string, line: number, tag: string): string {
  const text = source.split('\n')[line - 1]!
  return `pages/Home.tsx:${line}:${text.indexOf(`<${tag}`) + 2}`
}

/** What the board holds after a real load: every node's identity, by id. */
async function loadBoard(): Promise<Page> {
  const { pages } = await loadStudioPages(wsDir)
  return pages.find((page) => page.id === 'home')!
}

/** The identity the board read for `id` — the `expect` a save sends. */
function expectFor(page: Page, ...ids: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const id of ids) {
    const fingerprint = page.nodes[id]?.sourceFingerprint
    if (!fingerprint) throw new Error(`the board has no identity for ${id}`)
    out[id] = fingerprint
  }
  return out
}

describe('P1-D — an edit whose file changed under the board is re-found, not refused', () => {
  it('writes a prop and a text edit aimed at "Two" to "Two" after a line was inserted above it', async () => {
    write('pages/Home.tsx', LIST)
    const board = await loadBoard()
    const two = idAt(LIST, 5, 'li')
    write('pages/Home.tsx', LIST.replace('    <ul>\n', '    <ul>\n      <li>Zero</li>\n'))

    const edits: StudioEdit[] = [
      { kind: 'prop', nodeId: two, prop: 'title', value: 'EDITED-b' },
      { kind: 'text', nodeId: two, text: 'Two (edited)' },
    ]
    const result = applyStudioEditBatch(wsDir, edits, expectFor(board, two))

    expect(result.refusals).toEqual([])
    expect(result.written).toBe(2)
    const after = read('pages/Home.tsx')
    expect(after).toContain('<li title="a">One</li>')
    expect(after).toContain('<li>Zero</li>')
    expect(after).toMatch(/<li title="EDITED-b">\{?"?Two \(edited\)"?\}?<\/li>/)
    // Reported against the id the board sent, plus where it really was.
    expect(result.retargeted).toEqual([{ nodeId: two, to: 'pages/Home.tsx:6:8' }])
    expect(result.shifted).toBe(true)
    expect(result.fingerprints.map((entry) => entry.nodeId)).toEqual([two, two])
  })

  it('deletes "One" — not "Zero" — after a line was inserted above it', async () => {
    write('pages/Home.tsx', LIST)
    const board = await loadBoard()
    const one = idAt(LIST, 4, 'li')
    write('pages/Home.tsx', LIST.replace('    <ul>\n', '    <ul>\n      <li>Zero</li>\n'))

    const result = applyStudioEditBatch(wsDir, [{ kind: 'delete', nodeId: one }], expectFor(board, one))

    expect(result.refusals).toEqual([])
    expect(result.written).toBe(1)
    expect(read('pages/Home.tsx')).toContain('<li>Zero</li>')
    expect(read('pages/Home.tsx')).not.toContain('One')
  })

  it('follows an element whose block was re-indented by an outside wrap', async () => {
    write('pages/Home.tsx', LIST)
    const board = await loadBoard()
    const three = idAt(LIST, 6, 'li')
    const wrapped = LIST.replace('    <ul>\n', '    <section>\n    <ul>\n')
      .replace('      <li title="c">Three</li>\n', '          <li title="c">Three</li>\n')
      .replace('    </ul>\n', '    </ul>\n    </section>\n')
    write('pages/Home.tsx', wrapped)

    const result = applyStudioEditBatch(wsDir, [{ kind: 'prop', nodeId: three, prop: 'title', value: 'moved' }], expectFor(board, three))

    expect(result.refusals).toEqual([])
    expect(read('pages/Home.tsx')).toContain('          <li title="moved">Three</li>')
    expect(result.retargeted).toEqual([{ nodeId: three, to: 'pages/Home.tsx:7:12' }])
  })

  it('also re-finds an element moved by an edit Studio itself wrote earlier', async () => {
    write('pages/Home.tsx', LIST)
    const board = await loadBoard()
    const one = idAt(LIST, 4, 'li')
    const three = idAt(LIST, 6, 'li')
    // Studio's own value write: the board keeps its ids and learns One's new identity.
    const own = applyStudioEditBatch(wsDir, [{ kind: 'prop', nodeId: one, prop: 'title', value: 'own' }], expectFor(board, one))
    expect(own.written).toBe(1)
    write('pages/Home.tsx', read('pages/Home.tsx').replace('    <ul>\n', '    <ul>\n      <li>Zero</li>\n'))

    const result = applyStudioEditBatch(
      wsDir,
      [{ kind: 'prop', nodeId: one, prop: 'title', value: 'again' }, { kind: 'prop', nodeId: three, prop: 'title', value: 'x' }],
      { [one]: own.fingerprints[0]!.fingerprint, ...expectFor(board, three) },
    )

    expect(result.refusals).toEqual([])
    expect(read('pages/Home.tsx')).toContain('<li title="again">One</li>')
    expect(read('pages/Home.tsx')).toContain('<li title="x">Three</li>')
  })
})

describe('P1-D — refuses when there is not exactly one honest answer', () => {
  it('refuses when one of two identical siblings was deleted — the diff cannot say which', async () => {
    const twins = LIST.replace('      <li title="b">Two</li>\n', '      <li title="b">Two</li>\n      <li title="b">Two</li>\n')
    write('pages/Home.tsx', twins)
    const board = await loadBoard()
    const second = idAt(twins, 6, 'li')
    const oneDeleted = twins.replace('      <li title="b">Two</li>\n', '').replace('    <ul>\n', '    <ul>\n      <li>Zero</li>\n      <li>Zero2</li>\n')
    write('pages/Home.tsx', oneDeleted)

    const result = applyStudioEditBatch(wsDir, [{ kind: 'prop', nodeId: second, prop: 'title', value: 'EDITED' }], expectFor(board, second))

    expect(result.written).toBe(0)
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['element-moved'])
    expect(read('pages/Home.tsx')).toBe(oneDeleted)
  })

  it('refuses when the element itself was rewritten outside Studio', async () => {
    write('pages/Home.tsx', LIST)
    const board = await loadBoard()
    const two = idAt(LIST, 5, 'li')
    const rewritten = LIST.replace('    <ul>\n', '    <ul>\n      <li>Zero</li>\n').replace('>Two<', '>Deux<')
    write('pages/Home.tsx', rewritten)

    const result = applyStudioEditBatch(wsDir, [{ kind: 'text', nodeId: two, text: 'x' }], expectFor(board, two))

    expect(result.written).toBe(0)
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['element-moved'])
    expect(read('pages/Home.tsx')).toBe(rewritten)
  })

  it('refuses when the server never saw the text the board read (a restart)', async () => {
    write('pages/Home.tsx', LIST)
    const board = await loadBoard()
    const two = idAt(LIST, 5, 'li')
    clearSourceTextHistory()
    const shifted = LIST.replace('    <ul>\n', '    <ul>\n      <li>Zero</li>\n')
    write('pages/Home.tsx', shifted)

    const result = applyStudioEditBatch(wsDir, [{ kind: 'prop', nodeId: two, prop: 'title', value: 'x' }], expectFor(board, two))

    expect(result.written).toBe(0)
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['element-moved'])
    expect(read('pages/Home.tsx')).toBe(shifted)
  })

  it('refuses the whole edit when one of the ids it names cannot be re-found', async () => {
    write('pages/Home.tsx', LIST)
    const board = await loadBoard()
    const one = idAt(LIST, 4, 'li')
    const three = idAt(LIST, 6, 'li')
    const changed = LIST.replace('    <ul>\n', '    <ul>\n      <li>Zero</li>\n').replace('>Three<', '>Drei<')
    write('pages/Home.tsx', changed)

    const result = applyStudioEditBatch(
      wsDir,
      [{ kind: 'move', nodeId: one, anchorNodeId: three, position: 'after' }],
      expectFor(board, one, three),
    )

    expect(result.written).toBe(0)
    expect(result.refusals.map((refusal) => [refusal.kind, refusal.reason])).toEqual([['move', 'element-moved']])
    expect(read('pages/Home.tsx')).toBe(changed)
  })
})
