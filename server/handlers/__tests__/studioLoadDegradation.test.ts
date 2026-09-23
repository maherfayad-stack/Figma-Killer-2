/**
 * A load never fails because the repository is mid-edit (WB-23, WB-24).
 *
 * - **WB-23** — a `tsconfig.json` with a missing brace made ts-morph throw
 *   `'}' expected.` out of `createWorkspaceProject`, so `loadStudioPages`
 *   threw and `/load` answered 500 with the raw message: the board did not
 *   open. Now the project is built without the tsconfig — path aliases stop
 *   resolving, nothing else changes — and the load reports
 *   `tsconfig-unreadable`. Fixing the file brings the aliases back without a
 *   restart.
 * - **WB-24** — a page whose file does not parse was parsed by TypeScript's
 *   error recovery and stayed fully editable, so a codemod could splice bytes
 *   into a tree the file does not actually spell. Now the load flags the page
 *   `syntax-error` with the line, and every write to that file is refused,
 *   naming the line, while writes to other files in the same batch land.
 *
 * The fixture is a small bookshelf app — nothing from the eSIM corpus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@core/page-tree'
import { clearPageParseCache } from '../studio/pageParseCache'
import { clearStudioLoadMemo } from '../studio/studioLoadMemo'
import { clearWorkspaceProjects } from '../studio/workspaceProject'
import { loadStudioPages } from '../studioPageLoad'
import { applyStudioEditBatch } from '../studioWriteback'
import { locateTag } from '../../../src/core/ast-codemods/__tests__/fixtureLocation'

let dir: string

function write(relPath: string, contents: string): void {
  const full = path.join(dir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

function bump(relPath: string): void {
  const abs = path.join(dir, ...relPath.split('/'))
  const later = new Date(fs.statSync(abs).mtime.getTime() + 5000)
  fs.utimesSync(abs, later, later)
}

const read = (relPath: string): string => fs.readFileSync(path.join(dir, ...relPath.split('/')), 'utf8')

const pageTitled = (pages: readonly Page[], title: string): Page | undefined => pages.find((page) => page.title === title)

beforeEach(() => {
  clearPageParseCache()
  clearStudioLoadMemo()
  clearWorkspaceProjects()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-load-degradation-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  clearPageParseCache()
  clearStudioLoadMemo()
  clearWorkspaceProjects()
})

describe('WB-23 — a tsconfig.json that does not parse', () => {
  const VALID_TSCONFIG = '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }\n'
  const BROKEN_TSCONFIG = '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } }\n'

  beforeEach(() => {
    write('src/components/Badge.tsx', 'export default function Badge() {\n  return <span>Badge text</span>\n}\n')
    write('pages/Shelf.tsx', [
      "import Badge from '@/components/Badge'",
      'export default function Shelf() {',
      '  return <main><h1>Bookshelf</h1><Badge /></main>',
      '}',
      '',
    ].join('\n'))
  })

  it('opens the board anyway: the page loads, the aliases do not, and the load says so', async () => {
    write('tsconfig.json', BROKEN_TSCONFIG)

    const result = await loadStudioPages(dir)
    const shelf = JSON.stringify(pageTitled(result.pages, 'Shelf'))
    expect(shelf).toContain('Bookshelf')
    // The alias is the one thing lost: `@/components/Badge` no longer resolves
    // to a local file, so the component is not inlined.
    expect(shelf).not.toContain('Badge text')
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'tsconfig-unreadable', file: 'tsconfig.json' }),
    ])
  })

  it('brings the aliases back — and drops the warning — once the file is fixed, without a restart', async () => {
    write('tsconfig.json', BROKEN_TSCONFIG)
    await loadStudioPages(dir)

    write('tsconfig.json', VALID_TSCONFIG)
    bump('tsconfig.json')
    const fixed = await loadStudioPages(dir)
    expect(fixed.warnings).toEqual([])
    expect(JSON.stringify(pageTitled(fixed.pages, 'Shelf'))).toContain('Badge text')
  })

  it('a healthy tsconfig loads with no warning and resolves its aliases', async () => {
    write('tsconfig.json', VALID_TSCONFIG)
    const result = await loadStudioPages(dir)
    expect(result.warnings).toEqual([])
    expect(JSON.stringify(pageTitled(result.pages, 'Shelf'))).toContain('Badge text')
  })
})

describe('WB-24 — a page whose file does not parse', () => {
  const BROKEN = [
    'export default function Broken() {',
    '  return (',
    '    <main title="shelf">',
    '      <p>unclosed',
    '      <span>ok</span>',
    '    </main>',
    '  )',
    '}',
    '',
  ].join('\n')
  const FINE = [
    'export default function Fine() {',
    '  return <main title="shelf"><p>All good</p></main>',
    '}',
    '',
  ].join('\n')

  beforeEach(() => {
    write('pages/Broken.tsx', BROKEN)
    write('pages/Fine.tsx', FINE)
  })

  it('still loads, and flags the page with the line of the first parse error', async () => {
    const result = await loadStudioPages(dir)
    const broken = pageTitled(result.pages, 'Broken')
    expect(broken).toBeDefined()
    expect(pageTitled(result.pages, 'Fine')).toBeDefined()
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'syntax-error', pageId: broken!.id, file: 'pages/Broken.tsx', line: 4 }),
    ])
  })

  it('refuses every write into the broken file by name and line, and still writes the clean one in the same batch', () => {
    const brokenMain = locateTag(BROKEN, 'main')
    const fineMain = locateTag(FINE, 'main')
    const result = applyStudioEditBatch(dir, [
      { kind: 'prop', nodeId: `pages/Broken.tsx:${brokenMain.line}:${brokenMain.col}`, prop: 'title', value: 'shelves' },
      { kind: 'prop', nodeId: `pages/Fine.tsx:${fineMain.line}:${fineMain.col}`, prop: 'title', value: 'shelves' },
    ])

    expect(read('pages/Broken.tsx')).toBe(BROKEN)
    expect(read('pages/Fine.tsx')).toContain('title="shelves"')
    expect(result.written).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.refusals).toEqual([
      expect.objectContaining({ kind: 'prop', reason: 'syntax-error', nodeId: `pages/Broken.tsx:${brokenMain.line}:${brokenMain.col}` }),
    ])
    expect(result.refusals[0]!.message).toContain('pages/Broken.tsx')
    expect(result.refusals[0]!.message).toContain('line 4')
  })
})
