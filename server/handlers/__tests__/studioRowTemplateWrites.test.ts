/**
 * P3-C (OD-8) — a `.map` row's style and class edits land on the row TEMPLATE,
 * through the real load (parse → page) and the real save batch.
 *
 * Round-tripped end to end: the rows load with their literal inline styles
 * unlocked and a fingerprint that names the template; a write aimed at
 * `loopTemplateNodeId(row)` changes the one JSX site, byte for byte; and the
 * next load shows it on EVERY row — the promise the "Applied to all N rows"
 * notice makes. The P1-A guard applies to it like any other value write: a
 * template that no longer stands where the board read it is refused.
 *
 * The fixture is a restaurant menu and shares nothing with the eSIM corpus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loopTemplateNodeId, styleValueKey, type Page, type PageNode } from '@core/page-tree'
import { clearPageParseCache } from '../studio/pageParseCache'
import { clearStudioLoadMemo } from '../studio/studioLoadMemo'
import { clearWorkspaceProjects } from '../studio/workspaceProject'
import { loadStudioPages } from '../studioPageLoad'
import { applyStudioEditBatch } from '../studioWriteback'

let wsDir: string

const MENU = [
  "const DISHES = [{ id: 'r', name: 'Ramen' }, { id: 'p', name: 'Pho' }, { id: 'l', name: 'Laksa' }]",
  '',
  'export default function Menu() {',
  '  return (',
  '    <ul>',
  '      {DISHES.map((dish) => (',
  "        <li key={dish.id} className=\"dish\" style={{ padding: '4px' }}>",
  '          {dish.name}',
  '        </li>',
  '      ))}',
  '    </ul>',
  '  )',
  '}',
  '',
].join('\n')

function write(relPath: string, contents: string): void {
  const full = path.join(wsDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

function read(relPath: string): string {
  return fs.readFileSync(path.join(wsDir, ...relPath.split('/')), 'utf8')
}

async function menu(): Promise<Page> {
  clearStudioLoadMemo()
  clearPageParseCache()
  const page = (await loadStudioPages(wsDir)).pages.find((candidate) => candidate.title === 'Menu')
  if (!page) throw new Error('no Menu page')
  return page
}

function rows(page: Page): PageNode[] {
  return Object.values(page.nodes)
    .filter((node) => loopTemplateNodeId(node.id) !== null && node.inlineStyles?.padding !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id))
}

beforeEach(() => {
  clearPageParseCache()
  clearStudioLoadMemo()
  clearWorkspaceProjects()
  wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-row-template-'))
  write('pages/Menu.tsx', MENU)
})

afterEach(() => {
  clearPageParseCache()
  clearStudioLoadMemo()
  clearWorkspaceProjects()
  fs.rmSync(wsDir, { recursive: true, force: true })
})

describe('OD-8 — a .map row writes its template', () => {
  it('loads every row with an unlocked literal style and the template’s fingerprint', async () => {
    const dishes = rows(await menu())
    expect(dishes).toHaveLength(3)
    const template = loopTemplateNodeId(dishes[0]!.id)
    expect(template).toBe('pages/Menu.tsx:7:10')
    for (const dish of dishes) {
      expect(loopTemplateNodeId(dish.id)).toBe(template)
      expect(dish.codeProps ?? []).not.toContain(styleValueKey('padding'))
      expect(dish.sourceFingerprint).toBeDefined()
      expect(dish.sourceFingerprint).toBe(dishes[0]!.sourceFingerprint)
    }
  })

  it('a style and a class on one row land on the template, byte for byte, and every row shows them next load', async () => {
    const [first] = rows(await menu())
    const template = loopTemplateNodeId(first!.id)!

    const result = applyStudioEditBatch(
      wsDir,
      [
        { kind: 'style', nodeId: template, style: { color: 'tomato' } },
        { kind: 'class', nodeId: template, add: [{ kind: 'literal', token: 'featured' }], remove: [] },
      ],
      { [template]: first!.sourceFingerprint! },
    )

    expect(result.refusals).toEqual([])
    expect(result.written).toBe(2)
    expect(read('pages/Menu.tsx')).toBe(
      MENU.replace(
        "<li key={dish.id} className=\"dish\" style={{ padding: '4px' }}>",
        // WB-10 — the new value is written in the object's own quote.
        "<li key={dish.id} className=\"dish featured\" style={{ padding: '4px', color: 'tomato' }}>",
      ),
    )

    const after = rows(await menu())
    expect(after).toHaveLength(3)
    for (const dish of after) expect(dish.inlineStyles?.color).toBe('tomato')
  })

  it('refuses a template write whose element no longer stands where the board read it (P1-A)', async () => {
    const page = await menu()
    const [first] = rows(page)
    const template = loopTemplateNodeId(first!.id)!
    // The `<ul>`'s identity — what the guard sees if the template's line now held the list instead.
    const ul = page.nodes['pages/Menu.tsx:5:6']
    expect(ul?.sourceFingerprint).toBeDefined()

    const result = applyStudioEditBatch(
      wsDir,
      [{ kind: 'style', nodeId: template, style: { color: 'tomato' } }],
      { [template]: ul!.sourceFingerprint! },
    )

    expect(result.written).toBe(0)
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['element-moved'])
    expect(read('pages/Menu.tsx')).toBe(MENU)
  })
})
