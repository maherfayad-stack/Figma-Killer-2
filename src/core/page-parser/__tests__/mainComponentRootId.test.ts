/**
 * "Where can the MAIN component be selected, and does its root get a writable
 * id?" — the open question of the components/variants plan
 * (`plan-components-tokens.md`, CV-OD-2), answered with the parser's own output
 * instead of a reading of the docs.
 *
 * Three ways a component's markup reaches the board today, each pinned here:
 *
 *   1. INSIDE AN INSTANCE — the call site is a `studio.instance`; the
 *      component's root element is its child, with a composite id
 *      `<page>:l:c~<component file>:l:c`. The id's TAIL is the component's own
 *      root JSX position (writable, via `decodeSourceNodeId`). Every instance
 *      of the component carries a DIFFERENT head and the SAME tail, which is why
 *      an edit there is shared (`dedupeStudioEdits` collapses them).
 *   2. AS A PAGE — a component file inside `pagesDir` is parsed standalone:
 *      its root has a plain `rel:l:c` id (no `~`). This is the only shape with
 *      an UNshared writable root.
 *   3. A component reached through a nested call (an instance inside another
 *      component's file) has TWO `~` segments; its tail is still the innermost
 *      component's own position.
 *
 * No test here asserts a feature exists that does not: there is no "main
 * component" node, no "go to main component" action and no Components board in
 * the tree. The roots below are reachable only as instance children or as pages.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { decodeSourceNodeId, hasWritableSourceLocation } from '@core/page-tree'
import { parsePageFile } from '../parsePageFile'
import { createWorkspaceProject, resolveComponentSources } from '../componentSources'
import { inlineLocalComponents } from '../inlineLocalComponents'
import type { ParsedNode, ParsedPage } from '../types'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-component-root-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): string {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
  return full
}

function load(pageFile: string): ParsedPage {
  const project = createWorkspaceProject(tmpDir)
  const parsed = parsePageFile(pageFile, tmpDir, project)
  return inlineLocalComponents(parsed, resolveComponentSources(project, pageFile, tmpDir, parsed), project, tmpDir)
}

const PILL = [
  "export function Pill({ tone = 'quiet' }: { tone?: 'quiet' | 'loud' }) {",
  "  return <b className={tone}>pill</b>",
  '}',
  '',
].join('\n')

function childrenOf(page: ParsedPage, node: ParsedNode): ParsedNode[] {
  return node.children.map((id) => page.nodes[id]!)
}

describe('the main component root, as the board exposes it today', () => {
  it('inside an instance: the root child has a composite id whose tail is the component root, and it is writable', () => {
    write('components/Pill.tsx', PILL)
    const pageFile = write(
      'pages/Home.tsx',
      [
        "import { Pill } from '../components/Pill'",
        'export default function Home() {',
        '  return <main><Pill /><Pill tone="loud" /></main>',
        '}',
        '',
      ].join('\n'),
    )
    const page = load(pageFile)
    const instances = Object.values(page.nodes).filter((n) => n.name === 'Pill')
    expect(instances).toHaveLength(2)

    const roots = instances.map((instance) => childrenOf(page, instance)[0]!)
    for (const root of roots) {
      expect(root.id).toContain('~')
      expect(hasWritableSourceLocation(root.id)).toBe(true)
      // The tail is the component's own `<b …>` tag name — line 2, column 11 of Pill.tsx.
      expect(decodeSourceNodeId(root.id)).toEqual({ rel: 'components/Pill.tsx', line: 2, col: 11 })
    }
    // Two instances, two distinct ids, ONE write target.
    expect(new Set(roots.map((r) => r.id)).size).toBe(2)
    expect(new Set(roots.map((r) => JSON.stringify(decodeSourceNodeId(r.id)))).size).toBe(1)
  })

  it('as a page: a component file parsed standalone has a plain, unshared, writable root id', () => {
    const pillFile = write('pages/Pill.tsx', PILL)
    const page = parsePageFile(pillFile, tmpDir, createWorkspaceProject(tmpDir))
    const element = page.nodes[page.rootIds[0] ?? '']!
    // The component's own element is a plain `rel:l:c` id with no call-site prefix.
    expect(element.id).not.toContain('~')
    expect(decodeSourceNodeId(element.id)).toEqual({ rel: 'pages/Pill.tsx', line: 2, col: 11 })
  })

  it('nested: an instance inside a component carries two segments, and the tail is the innermost component', () => {
    write('components/Pill.tsx', PILL)
    write(
      'components/Card.tsx',
      [
        "import { Pill } from './Pill'",
        'export function Card() {',
        '  return <section><Pill /></section>',
        '}',
        '',
      ].join('\n'),
    )
    const pageFile = write(
      'pages/Home.tsx',
      ["import { Card } from '../components/Card'", 'export default function Home() {', '  return <Card />', '}', ''].join('\n'),
    )
    const page = load(pageFile)
    const pillRoot = Object.values(page.nodes).find((n) => n.id.split('~').length === 3 && n.name === 'b')
    expect(pillRoot).toBeDefined()
    expect(decodeSourceNodeId(pillRoot!.id)?.rel).toBe('components/Pill.tsx')
  })
})
