/**
 * Every `return` in a component contributes nodes — not just the shallowest one.
 *
 * The old rule sorted returns by block depth and took the shallowest, which
 * systematically preferred the FALLBACK and dropped the special case. On the eSIM
 * corpus `EsimAddonIcon`'s data-usage ring — an `<svg>` plus a percentage label,
 * behind `if (type === 'ring')` — never appeared on any of the four cards that
 * use it, and multi-stage screens collapsed to their last `return`.
 *
 * Rendering all of them is the same rule the parser already applies one level
 * down, where a ternary contributes nodes for both sides: conditional content is
 * shown and locked, never silently chosen between. Choosing would mean evaluating
 * the condition, which is the tier §7 does not enter.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createPageEvalBudget,
  createWorkspaceProject,
  parsePageFile,
  type ParsedNode,
  type StaticEvalOptions,
} from '@core/page-parser'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-return-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

function evalOptions(): StaticEvalOptions {
  return { pageBudget: createPageEvalBudget(), workspaceRoot: tmpDir }
}

function load(pageRel: string): { rootIds: string[]; nodes: ParsedNode[] } {
  const file = path.join(tmpDir, ...pageRel.split('/'))
  const project = createWorkspaceProject(tmpDir)
  const parsed = parsePageFile(file, tmpDir, project, evalOptions())
  return { rootIds: parsed.rootIds, nodes: Object.values(parsed.nodes) }
}

const names = (nodes: ParsedNode[]): string[] => nodes.map((n) => n.name)

describe('components with more than one return', () => {
  it('renders every branch, in source order', () => {
    write(
      'pages/Addon.jsx',
      [
        'export default function Addon({ type }) {',
        '  if (type === "ring") {',
        '    return <div className="ring"><svg viewBox="0 0 40 40" /></div>',
        '  }',
        '  return <img src="/chip.png" alt="" />',
        '}',
        '',
      ].join('\n'),
    )

    const { rootIds, nodes } = load('pages/Addon.jsx')
    expect(names(nodes)).toContain('div')
    expect(names(nodes)).toContain('img')
    // Both are page roots — neither is nested in the other.
    expect(rootIds).toHaveLength(2)
  })

  it('locks every branch, naming why', () => {
    write(
      'pages/Addon.jsx',
      [
        'export default function Addon({ type }) {',
        '  if (type === "ring") return <div className="ring" />',
        '  return <img src="/chip.png" alt="" />',
        '}',
        '',
      ].join('\n'),
    )

    const { nodes } = load('pages/Addon.jsx')
    expect(nodes.every((n) => n.locked)).toBe(true)
    expect(nodes.every((n) => n.lockReason === 'one branch of several — chosen in code')).toBe(true)
  })

  it('locks the branch subtree\'s descendants too', () => {
    write(
      'pages/Stages.jsx',
      [
        'export default function Stages({ stage }) {',
        '  if (stage === "loading") {',
        '    return <div className="loading"><span>Loading…</span></div>',
        '  }',
        '  return <section><h1>Done</h1></section>',
        '}',
        '',
      ].join('\n'),
    )

    const { nodes } = load('pages/Stages.jsx')
    const span = nodes.find((n) => n.name === 'span')
    const heading = nodes.find((n) => n.name === 'h1')
    expect(span?.locked).toBe(true)
    expect(heading?.locked).toBe(true)
    // The text is still captured — a locked node that renders blank tells the
    // user nothing about their screen.
    expect(span?.text).toBe('Loading…')
    expect(heading?.text).toBe('Done')
  })

  it('leaves a single-return component completely unlocked', () => {
    write(
      'pages/Plain.jsx',
      [
        'export default function Plain() {',
        '  return <div className="plain"><p>Hi</p></div>',
        '}',
        '',
      ].join('\n'),
    )

    const { nodes } = load('pages/Plain.jsx')
    expect(nodes.every((n) => !n.locked)).toBe(true)
  })

  it('does not let a `return null` guard lock the real tree', () => {
    write(
      'pages/Guarded.jsx',
      [
        'export default function Guarded({ data }) {',
        '  if (!data) return null',
        '  return <div className="real"><p>Content</p></div>',
        '}',
        '',
      ].join('\n'),
    )

    // `return null` contributes no nodes, so it is not a branch anyone can see —
    // counting it would lock an entire editable screen for a guard clause. This
    // shape is everywhere.
    const { rootIds, nodes } = load('pages/Guarded.jsx')
    expect(rootIds).toHaveLength(1)
    expect(nodes.every((n) => !n.locked)).toBe(true)
  })

  it('ignores returns belonging to a nested callback', () => {
    write(
      'pages/List.jsx',
      [
        'const ITEMS = ["a", "b"]',
        'export default function List() {',
        '  return (',
        '    <ul>',
        '      {ITEMS.map((item) => {',
        '        return <li key={item}>{item}</li>',
        '      })}',
        '    </ul>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    // The callback's `return` belongs to the callback, not the component — the
    // `<ul>` is the component's only branch and stays editable.
    const { rootIds, nodes } = load('pages/List.jsx')
    expect(rootIds).toHaveLength(1)
    expect(nodes.find((n) => n.name === 'ul')?.locked).toBe(false)
  })
})
