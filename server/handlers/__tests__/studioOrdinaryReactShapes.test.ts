/**
 * P3-B — ordinary React renders (audit 03: WB-3, WB-4, WB-26, WB-5).
 *
 * Every shape here is how a hand-written React repo is normally spelled, and
 * every one of them used to reach the canvas as something other than what the
 * source says:
 *
 * - WB-3  text inside `<li>`/`<div>`/`<label>`/`<td>`/`<section>` was dropped
 *         (the element became a text-less `base.container`);
 * - WB-4  `memo()`, `forwardRef()`, `React.memo(X)`, an `export { default as X }`
 *         barrel and an `import * as UI` namespace became "Unknown module" boxes;
 * - WB-26 `<React.Fragment>` / an imported `<Fragment>` became a `pkg.react.*`
 *         package node wrapping its children;
 * - WB-5  a HOC-wrapped or class page rendered a blank frame with no reason.
 *
 * Each case is loaded through the real `loadStudioPages` and, where the shape
 * newly exposes an editable target, written through the real
 * `applyStudioEditBatch` with the file BYTES asserted — the brief's "one honest
 * target" rule. (`setJsxText` writes its `{"…"}` expression form; that
 * spelling is its own contract, not this bundle's.) The fixture is a festival
 * line-up app and shares nothing with the eSIM corpus
 * (`genericRepoShapes.test.ts`'s discipline).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page, PageNode } from '@core/page-tree'
import { clearPageParseCache } from '../studio/pageParseCache'
import { clearStudioLoadMemo } from '../studio/studioLoadMemo'
import { clearWorkspaceProjects } from '../studio/workspaceProject'
import { loadStudioPages } from '../studioPageLoad'
import { applyStudioEditBatch } from '../studioWriteback'

let wsDir: string

function write(relPath: string, contents: string): void {
  const full = path.join(wsDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

function read(relPath: string): string {
  return fs.readFileSync(path.join(wsDir, ...relPath.split('/')), 'utf8')
}

function pageTitled(pages: readonly Page[], title: string): Page {
  const page = pages.find((candidate) => candidate.title === title)
  if (!page) throw new Error(`no page titled ${title}`)
  return page
}

function nodeWithText(page: Page, text: string): PageNode {
  const node = Object.values(page.nodes).find((candidate) => candidate.props?.text === text)
  if (!node) throw new Error(`no node with text ${JSON.stringify(text)}`)
  return node
}

function tagOf(node: PageNode): unknown {
  return node.props.customTag || node.props.tag
}

/** Writes one text edit through the real batch path, guarded by the node's own fingerprint. */
function writeText(node: PageNode, text: string) {
  const expectFingerprints = node.sourceFingerprint ? { [node.id]: node.sourceFingerprint } : {}
  return applyStudioEditBatch(wsDir, [{ kind: 'text', nodeId: node.id, text }], expectFingerprints)
}

beforeEach(() => {
  clearPageParseCache()
  clearStudioLoadMemo()
  clearWorkspaceProjects()
  wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ordinary-react-'))

  write('ui/StageCard.tsx', [
    "import { memo } from 'react'",
    'export const StageCard = memo(function StageCard({ title }: { title: string }) {',
    '  return <section className="stage"><h4>{title}</h4><p>Line-up soon</p></section>',
    '})',
    '',
  ].join('\n'))
  write('ui/TicketInput.tsx', [
    "import { forwardRef } from 'react'",
    'const TicketInput = forwardRef<HTMLInputElement, { hint: string }>(({ hint }, ref) => (',
    '  <span className="ticket"><input ref={ref} placeholder={hint} /></span>',
    '))',
    'export default TicketInput',
    '',
  ].join('\n'))
  write('ui/Badge.tsx', [
    "import React from 'react'",
    'function BadgeInner() {',
    '  return <em>VIP</em>',
    '}',
    'export default React.memo(BadgeInner)',
    '',
  ].join('\n'))
  write('ui/Arrow.tsx', ['const Arrow = () => <b className="arrow">Next</b>', 'export default Arrow', ''].join('\n'))
  write('ui/Chip.tsx', ['export function Chip() {', '  return <small>Live</small>', '}', ''].join('\n'))
  write('ui/index.ts', [
    "export { default as Arrow } from './Arrow'",
    "export { Chip } from './Chip'",
    "export { StageCard } from './StageCard'",
    '',
  ].join('\n'))

  write('pages/Lineup.tsx', [
    "import React, { Fragment } from 'react'",
    "import { StageCard } from '../ui/StageCard'",
    "import TicketInput from '../ui/TicketInput'",
    "import Badge from '../ui/Badge'",
    "import { Arrow } from '../ui'",
    "import * as UI from '../ui'",
    'export default function Lineup() {',
    '  return (',
    '    <main>',
    '      <ul>',
    '        <li>Opening act</li>',
    '        <li>Headliner</li>',
    '      </ul>',
    '      <div>Doors at seven</div>',
    '      <label>Your name</label>',
    '      <table><tbody><tr><td>Friday</td></tr></tbody></table>',
    '      <section>Food trucks all day</section>',
    '      <React.Fragment><h2>Stage A</h2></React.Fragment>',
    '      <Fragment><h3>Stage B</h3></Fragment>',
    '      <StageCard title="Main" />',
    '      <TicketInput hint="Code" />',
    '      <Badge />',
    '      <Arrow />',
    '      <UI.Chip />',
    '    </main>',
    '  )',
    '}',
    '',
  ].join('\n'))
})

afterEach(() => {
  clearPageParseCache()
  clearStudioLoadMemo()
  clearWorkspaceProjects()
  fs.rmSync(wsDir, { recursive: true, force: true })
})

describe('WB-3 — text inside a container tag is an editable text node', () => {
  it('renders each text-only element as base.text on its real host tag', async () => {
    const page = pageTitled((await loadStudioPages(wsDir)).pages, 'Lineup')
    for (const [text, tag] of [
      ['Opening act', 'li'],
      ['Doors at seven', 'div'],
      ['Your name', 'label'],
      ['Friday', 'td'],
      ['Food trucks all day', 'section'],
    ] as const) {
      const node = nodeWithText(page, text)
      expect(node.moduleId).toBe('base.text')
      expect(tagOf(node)).toBe(tag)
      // A literal JSX text child: writable at the element itself, nothing code-valued.
      expect(node.codeProps ?? []).not.toContain('text')
    }
  })

  it('writes a text edit to exactly that element, and nothing else in the file', async () => {
    const page = pageTitled((await loadStudioPages(wsDir)).pages, 'Lineup')
    const before = read('pages/Lineup.tsx')
    const result = writeText(nodeWithText(page, 'Headliner'), 'Closing act')
    expect(result.refusals ?? []).toEqual([])
    expect(result.written).toBe(1)
    expect(read('pages/Lineup.tsx')).toBe(before.replace('<li>Headliner</li>', '<li>{"Closing act"}</li>'))
  })

  it('keeps an element with element children a container', async () => {
    const page = pageTitled((await loadStudioPages(wsDir)).pages, 'Lineup')
    const list = Object.values(page.nodes).find((node) => tagOf(node) === 'ul')
    expect(list?.moduleId).toBe('base.container')
    expect(list?.children.length).toBe(2)
  })
})

describe('WB-4 — memo, forwardRef, React.memo, a default re-export barrel and a namespace import all unwrap', () => {
  it('expands every wrapped or re-exported component into an instance, never an "Unknown module"', async () => {
    const page = pageTitled((await loadStudioPages(wsDir)).pages, 'Lineup')
    const opaque = Object.values(page.nodes).filter((node) => node.moduleId.startsWith('alm.') || node.moduleId.startsWith('pkg.'))
    expect(opaque.map((node) => node.moduleId)).toEqual([])

    const instances = Object.values(page.nodes).filter((node) => node.moduleId === 'studio.instance')
    expect(instances.map((node) => node.props.componentName).sort()).toEqual(
      ['Arrow', 'Badge', 'StageCard', 'TicketInput', 'UI.Chip'].sort(),
    )
    for (const instance of instances) expect(instance.children.length).toBeGreaterThan(0)

    // Each one's own JSX is what renders — read out of the file that declares it.
    expect(nodeWithText(page, 'Line-up soon').id).toContain('~ui/StageCard.tsx:')
    expect(nodeWithText(page, 'Main').id).toContain('~ui/StageCard.tsx:')
    expect(nodeWithText(page, 'VIP').id).toContain('~ui/Badge.tsx:')
    expect(nodeWithText(page, 'Next').id).toContain('~ui/Arrow.tsx:')
    expect(nodeWithText(page, 'Live').id).toContain('~ui/Chip.tsx:')
    const input = Object.values(page.nodes).find((node) => node.id.includes('~ui/TicketInput.tsx:') && tagOf(node) === 'input')
    expect(input).toBeDefined()
  })

  it('writes an edit inside a memo() component to the component file, byte for byte', async () => {
    const page = pageTitled((await loadStudioPages(wsDir)).pages, 'Lineup')
    const before = read('ui/StageCard.tsx')
    const result = writeText(nodeWithText(page, 'Line-up soon'), 'Line-up announced')
    expect(result.refusals ?? []).toEqual([])
    expect(result.written).toBe(1)
    expect(read('ui/StageCard.tsx')).toBe(before.replace('<p>Line-up soon</p>', '<p>{"Line-up announced"}</p>'))
  })

  it('writes an edit inside React.memo(Inner) to the inner function, byte for byte', async () => {
    const page = pageTitled((await loadStudioPages(wsDir)).pages, 'Lineup')
    const before = read('ui/Badge.tsx')
    const result = writeText(nodeWithText(page, 'VIP'), 'Backstage')
    expect(result.written).toBe(1)
    expect(read('ui/Badge.tsx')).toBe(before.replace('<em>VIP</em>', '<em>{"Backstage"}</em>'))
  })

  it('writes an edit reached through a default re-export barrel to the declaring file', async () => {
    const page = pageTitled((await loadStudioPages(wsDir)).pages, 'Lineup')
    const barrel = read('ui/index.ts')
    const before = read('ui/Arrow.tsx')
    const result = writeText(nodeWithText(page, 'Next'), 'Onward')
    expect(result.written).toBe(1)
    expect(read('ui/Arrow.tsx')).toBe(before.replace('>Next<', '>{"Onward"}<'))
    expect(read('ui/index.ts')).toBe(barrel)
  })

  it('re-renders when the barrel between the page and the component is re-pointed', async () => {
    // The route's parse is cached on the files it depends on. The barrel is not
    // the page and not the component, but it decides WHICH component renders:
    // it has to be one of those files, or this edit is invisible until restart.
    expect(nodeWithText(pageTitled((await loadStudioPages(wsDir)).pages, 'Lineup'), 'Next').moduleId).toBe('base.text')
    write('ui/index.ts', [
      "export { Chip as Arrow } from './Chip'",
      "export { Chip } from './Chip'",
      "export { StageCard } from './StageCard'",
      '',
    ].join('\n'))
    const later = new Date(Date.now() + 5000)
    fs.utimesSync(path.join(wsDir, 'ui', 'index.ts'), later, later)
    const page = pageTitled((await loadStudioPages(wsDir)).pages, 'Lineup')
    expect(Object.values(page.nodes).some((node) => node.props?.text === 'Next')).toBe(false)
    const arrow = Object.values(page.nodes).find((node) => node.props.componentName === 'Arrow')!
    expect(arrow.children.map((id) => page.nodes[id]!.props.text)).toEqual(['Live'])
  })

  it('substitutes a call-site prop through memo() exactly as through a plain function', async () => {
    const page = pageTitled((await loadStudioPages(wsDir)).pages, 'Lineup')
    const heading = nodeWithText(page, 'Main')
    expect(tagOf(heading)).toBe('h4')
  })
})

describe('WB-26 — React.Fragment is a fragment', () => {
  it('flattens <React.Fragment> and an imported <Fragment> into their parent, with no package node', async () => {
    const page = pageTitled((await loadStudioPages(wsDir)).pages, 'Lineup')
    const main = Object.values(page.nodes).find((node) => tagOf(node) === 'main')!
    const stageA = nodeWithText(page, 'Stage A')
    const stageB = nodeWithText(page, 'Stage B')
    expect(main.children).toContain(stageA.id)
    expect(main.children).toContain(stageB.id)
    expect(Object.values(page.nodes).some((node) => node.moduleId.includes('Fragment'))).toBe(false)
  })

  it('still writes a child of a fragment at its own location', async () => {
    const page = pageTitled((await loadStudioPages(wsDir)).pages, 'Lineup')
    const before = read('pages/Lineup.tsx')
    const result = writeText(nodeWithText(page, 'Stage A'), 'Stage North')
    expect(result.written).toBe(1)
    expect(read('pages/Lineup.tsx')).toBe(before.replace('<h2>Stage A</h2>', '<h2>{"Stage North"}</h2>'))
  })
})

describe('WB-5 — a wrapped or class page renders, or says why it cannot', () => {
  beforeEach(() => {
    write('pages/Tickets.tsx', [
      "import { withLayout } from '../ui/withLayout'",
      'function TicketsBody() {',
      '  return <article><h1>Tickets</h1><p>On sale Monday</p></article>',
      '}',
      'export default withLayout(TicketsBody)',
      '',
    ].join('\n'))
    write('ui/withLayout.tsx', 'export const withLayout = (C: unknown) => C\n')
    write('pages/Archive.tsx', [
      "import { Component } from 'react'",
      'export default class Archive extends Component {',
      '  render() {',
      '    return <article><h1>Archive</h1><p>Past years</p></article>',
      '  }',
      '}',
      '',
    ].join('\n'))
    write('pages/Later.tsx', [
      "import { lazy } from 'react'",
      "export default lazy(() => import('../ui/Chip'))",
      '',
    ].join('\n'))
    write('pages/Memoized.tsx', [
      "import { memo } from 'react'",
      'function Memoized() {',
      '  return <p>Cached page</p>',
      '}',
      'export default memo(Memoized)',
      '',
    ].join('\n'))
  })

  it('renders a page whose default export is an unknown HOC around a component, and says what is not shown', async () => {
    const page = pageTitled((await loadStudioPages(wsDir)).pages, 'Tickets')
    const heading = nodeWithText(page, 'Tickets')
    expect(heading.moduleId).toBe('base.text')
    const root = page.nodes[page.nodes[page.rootNodeId]!.children[0]!]!
    expect(root.resolution?.note).toContain('withLayout')
  })

  it('writes an edit on a HOC-wrapped page to the wrapped component', async () => {
    const page = pageTitled((await loadStudioPages(wsDir)).pages, 'Tickets')
    const before = read('pages/Tickets.tsx')
    const result = writeText(nodeWithText(page, 'On sale Monday'), 'On sale Friday')
    expect(result.written).toBe(1)
    expect(read('pages/Tickets.tsx')).toBe(before.replace('On sale Monday', '{"On sale Friday"}'))
  })

  it('renders a class page from the JSX its render() returns, and writes there', async () => {
    const page = pageTitled((await loadStudioPages(wsDir)).pages, 'Archive')
    const before = read('pages/Archive.tsx')
    const result = writeText(nodeWithText(page, 'Past years'), 'Every year')
    expect(result.written).toBe(1)
    expect(read('pages/Archive.tsx')).toBe(before.replace('Past years', '{"Every year"}'))
  })

  it('renders a memo() page with no note — memo changes nothing about what renders', async () => {
    const page = pageTitled((await loadStudioPages(wsDir)).pages, 'Memoized')
    const text = nodeWithText(page, 'Cached page')
    expect(text.resolution).toBeUndefined()
  })

  it('names the shape of a default export it cannot read, instead of a silent blank frame', async () => {
    const result = await loadStudioPages(wsDir)
    const page = pageTitled(result.pages, 'Later')
    expect(page.nodes[page.rootNodeId]!.children).toEqual([])
    const warning = result.warnings.find((candidate) => candidate.code === 'unreadable-page-export')
    expect(warning).toMatchObject({ pageId: page.id, file: 'pages/Later.tsx', line: 2 })
    expect(warning?.message).toContain('lazy()')
    // A readable page never carries one.
    expect(result.warnings.filter((candidate) => candidate.code === 'unreadable-page-export')).toHaveLength(1)
  })
})
