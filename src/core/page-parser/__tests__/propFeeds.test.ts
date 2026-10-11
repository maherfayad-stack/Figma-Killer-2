/**
 * OD-19 — `ParsedNode.propFeeds`: which of the component's own props a value
 * inside an inlined instance is the BARE forward of.
 *
 * The fixture is a plain TypeScript dashboard app (a `Stat` tile, an arrow
 * component with a typed props interface, a `.map` row, a numeric prop) that
 * shares nothing with the eSIM corpus. The assertions are about what the
 * parser refuses to claim as much as what it claims: a feed is the write target
 * for a value that has no literal of its own, so it must be exactly right or
 * absent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createPageEvalBudget, createWorkspaceProject, inlineLocalComponents, parsePageFile, resolveComponentSources, type ParsedNode, type StaticEvalOptions } from '@core/page-parser'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prop-feeds-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, lines: string[]): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, lines.join('\n'), 'utf8')
}

function load(pageRel: string): ParsedNode[] {
  const file = path.join(tmpDir, ...pageRel.split('/'))
  const project = createWorkspaceProject(tmpDir)
  const options: StaticEvalOptions = { pageBudget: createPageEvalBudget(), workspaceRoot: tmpDir }
  const parsed = parsePageFile(file, tmpDir, project, options)
  const sources = resolveComponentSources(project, file, tmpDir, parsed)
  return Object.values(inlineLocalComponents(parsed, sources, project, tmpDir, { evalOptions: options }).nodes)
}

/** The nodes inlined out of `Stat`, by the tag they render. */
const inlined = (nodes: ParsedNode[], tag: string): ParsedNode[] =>
  nodes.filter((node) => node.fromComponent === 'Stat' && node.name === tag).sort((a, b) => a.id.localeCompare(b.id))

const STAT = [
  'interface StatProps { label?: string; value?: number; hint?: string; accent?: string }',
  "export const Stat = ({ label = 'Visits', value = 0, hint = 'last 7 days', accent = 'teal' }: StatProps) => (",
  '  <section>',
  '    <h4>{label}</h4>',
  '    <strong style={{ width: value, color: accent }}>{value}</strong>',
  '    <small title={hint}>{hint.toUpperCase()}</small>',
  '  </section>',
  ')',
  '',
]

describe('which values are the bare forward of a prop', () => {
  beforeEach(() => {
    write('src/Stat.tsx', STAT)
    write('src/Dashboard.tsx', [
      "import { Stat } from './Stat'",
      'export default function Dashboard() {',
      '  return (',
      '    <main>',
      '      <Stat />',
      '      <Stat label="Signups" value={12} />',
      '    </main>',
      '  )',
      '}',
      '',
    ])
  })

  it('a default-fed text and style property name their prop; a call-site STRING literal already has its origin and is not a feed', () => {
    const nodes = load('src/Dashboard.tsx')
    const [plain, passing] = inlined(nodes, 'h4')
    // `<Stat />`: the label comes from the destructure default.
    expect(plain!.text).toBe('Visits')
    expect(plain!.propFeeds).toEqual({ text: 'label' })
    expect(plain!.textOrigin).toBeUndefined()
    // `<Stat label="Signups" />`: the call site's own literal is the write target, as since P3-C.
    expect(passing!.text).toBe('Signups')
    expect(passing!.textOrigin).toBeDefined()
    expect(passing!.propFeeds).toBeUndefined()
  })

  it('a style property that is a param is a feed whether the default or a numeric call-site literal fed it', () => {
    const nodes = load('src/Dashboard.tsx')
    const strongs = inlined(nodes, 'strong')
    expect(strongs).toHaveLength(2)
    for (const strong of strongs) {
      // `width: value` and `color: accent` are both bare reads, and each prop is read once in the component... except
      // `value`, which is also the strong's TEXT: two reads, so it is NOT offered. `accent` is.
      expect(strong.propFeeds).toEqual({ 'style:color': 'accent' })
    }
  })

  it('a computed read is never a feed: `{hint.toUpperCase()}` and the `title={hint}` both read the prop, so neither is offered', () => {
    const nodes = load('src/Dashboard.tsx')
    for (const small of inlined(nodes, 'small')) {
      expect(small.propFeeds).toBeUndefined()
    }
  })
})

describe('a component the parser cannot read props from', () => {
  it('an undestructured props parameter yields no feeds at all', () => {
    write('src/Stat.tsx', [
      'export function Stat(props: { label?: string }) {',
      '  return <h4>{props.label}</h4>',
      '}',
      '',
    ])
    write('src/Page.tsx', ["import { Stat } from './Stat'", 'export default function Page() {', '  return <Stat />', '}', ''])
    for (const node of load('src/Page.tsx')) expect(node.propFeeds).toBeUndefined()
  })

  it('a prop with no default that the call site omits has no value to feed, so no feed', () => {
    write('src/Stat.tsx', [
      'export function Stat({ label }: { label?: string }) {',
      '  return <h4>{label}</h4>',
      '}',
      '',
    ])
    write('src/Page.tsx', ["import { Stat } from './Stat'", 'export default function Page() {', '  return <Stat />', '}', ''])
    for (const node of load('src/Page.tsx')) expect(node.propFeeds).toBeUndefined()
  })
})
