/**
 * P1-A — every node the parser reads carries a fingerprint of WHO sits at its
 * `line:col`, and the writeback guard's reading of the same position agrees
 * with it byte for byte.
 *
 * The fixture follows `genericRepoShapes.test.ts`'s discipline: a small
 * recipe-box app that shares nothing with the eSIM corpus — `.tsx`, an arrow
 * component on a `const`, a NAMED export, a local component reached through a
 * barrel, a typed dictionary module, and a `.map` over a local array.
 *
 * What is pinned:
 *   - siblings with IDENTICAL opening tags (`<li>Flour</li>` / `<li>Sugar</li>`)
 *     get different fingerprints — the neighbour that slides into a shifted
 *     line is usually exactly such a sibling (WB-1);
 *   - a `.map` row has none (its id has no writable location to guard);
 *   - an inlined component's nodes carry the fingerprint of the COMPONENT file's
 *     element — the tail their writes land on;
 *   - a resolved text's origin carries its literal's fingerprint;
 *   - CRLF and re-indentation do not change a fingerprint;
 *   - `readSourceFingerprintAt` (the guard) reads the same value at every
 *     node's own position (the one contract the whole guard rests on).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createPageEvalBudget,
  createWorkspaceProject,
  inlineLocalComponents,
  parsePageFile,
  resolveComponentSources,
  type ParsedNode,
} from '@core/page-parser'
import { createProject, loadSourceFile, readSourceFingerprintAt } from '@core/ast-codemods'
import { decodeSourceNodeId, hasWritableSourceLocation, loopTemplateNodeId } from '@core/page-tree'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-fingerprint-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

function load(pageRel: string): ParsedNode[] {
  const file = path.join(tmpDir, ...pageRel.split('/'))
  const project = createWorkspaceProject(tmpDir)
  const opts = { pageBudget: createPageEvalBudget(), workspaceRoot: tmpDir }
  const parsed = parsePageFile(file, tmpDir, project, opts)
  const sources = resolveComponentSources(project, file, tmpDir, parsed)
  return Object.values(inlineLocalComponents(parsed, sources, project, tmpDir, { evalOptions: opts }).nodes)
}

function writeRecipeBox(eol = '\n'): void {
  write('src/copy/labels.ts', ["export const labels = {", "  heading: 'Pantry',", '}', ''].join(eol))
  write(
    'src/widgets/Badge.tsx',
    ["export const Badge = ({ tone }: { tone: string }) => <span className={tone}>new</span>", ''].join(eol),
  )
  write('src/widgets/index.ts', ["export { Badge } from './Badge'", ''].join(eol))
  write(
    'src/views/Pantry.tsx',
    [
      "import { labels } from '../copy/labels'",
      "import { Badge } from '../widgets'",
      '',
      "const tins = ['Beans', 'Soup']",
      '',
      'export const Pantry = () => (',
      '  <section className="pantry">',
      '    <h1>{labels.heading}</h1>',
      '    <ul>',
      '      <li>Flour</li>',
      '      <li>Sugar</li>',
      '    </ul>',
      '    <ol>',
      '      {tins.map((tin) => (',
      '        <li key={tin}>{tin}</li>',
      '      ))}',
      '    </ol>',
      '    <Badge tone="warm" />',
      '  </section>',
      ')',
      '',
    ].join(eol),
  )
}

describe('every parsed node records who sits at its position', () => {
  it('tells identical-tag siblings apart by their own text', () => {
    writeRecipeBox()
    const nodes = load('src/views/Pantry.tsx')
    const items = nodes.filter((node) => node.name === 'li' && hasWritableSourceLocation(node.id))
    expect(items.map((node) => node.text)).toEqual(['Flour', 'Sugar'])
    expect(items[0]!.fingerprint).toMatch(/^li#[0-9a-f]{8}$/)
    expect(items[1]!.fingerprint).toMatch(/^li#[0-9a-f]{8}$/)
    expect(items[0]!.fingerprint).not.toBe(items[1]!.fingerprint)
  })

  it('P3-C (OD-8) — stamps every .map row with its TEMPLATE element, where its style and class edits land', () => {
    writeRecipeBox()
    const rows = load('src/views/Pantry.tsx').filter((node) => node.id.includes('#'))
    expect(rows.length).toBeGreaterThan(0)
    const project = createProject()
    for (const row of rows) {
      const template = decodeSourceNodeId(loopTemplateNodeId(row.id)!)!
      const sourceFile = loadSourceFile(project, path.join(tmpDir, ...template.rel.split('/')))
      expect(row.fingerprint).toBe(readSourceFingerprintAt(sourceFile, template.line, template.col))
    }
  })

  it('stamps an inlined node with the COMPONENT file element its writes land on', () => {
    writeRecipeBox()
    const inlined = load('src/views/Pantry.tsx').find((node) => node.name === 'span')
    expect(inlined?.id).toContain('~src/widgets/Badge.tsx:')
    expect(inlined?.fingerprint).toMatch(/^span#[0-9a-f]{8}$/)
  })

  it("records a resolved text's literal origin with the literal's own fingerprint", () => {
    writeRecipeBox()
    const heading = load('src/views/Pantry.tsx').find((node) => node.name === 'h1')
    expect(heading?.textOrigin?.rel).toBe('src/copy/labels.ts')
    expect(heading?.textOrigin?.fingerprint).toMatch(/^literal#[0-9a-f]{8}$/)
  })

  it('is unchanged by a CRLF checkout and by re-indentation', () => {
    writeRecipeBox('\n')
    const lf = load('src/views/Pantry.tsx')
    writeRecipeBox('\r\n')
    const crlf = load('src/views/Pantry.tsx')
    expect(crlf.map((node) => node.fingerprint)).toEqual(lf.map((node) => node.fingerprint))

    const reindented = fs
      .readFileSync(path.join(tmpDir, 'src/views/Pantry.tsx'), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace('<section className="pantry">', '<section\n    className="pantry"\n  >')
    write('src/views/Pantry.tsx', reindented)
    const after = load('src/views/Pantry.tsx')
    const section = (list: ParsedNode[]) => list.find((node) => node.name === 'section')?.fingerprint
    expect(section(after)).toBe(section(lf))
  })

  it("reads back identically through the writeback guard at every node's own position", () => {
    writeRecipeBox()
    const project = createProject()
    let checked = 0
    for (const node of load('src/views/Pantry.tsx')) {
      if (!node.fingerprint) continue
      // A `.map` row reads back at its row template (OD-8).
      const location = decodeSourceNodeId(loopTemplateNodeId(node.id) ?? node.id)!
      const sourceFile = loadSourceFile(project, path.join(tmpDir, ...location.rel.split('/')))
      expect(readSourceFingerprintAt(sourceFile, location.line, location.col)).toBe(node.fingerprint)
      checked += 1
    }
    expect(checked).toBeGreaterThan(5)
  })
})
