/**
 * `codeProps` end to end: real `.tsx` source in, per-prop writability out.
 *
 * The rule these tests defend is the one that was wrong: a node whose STRUCTURE
 * is code-controlled still has ordinary, writable literal attributes. A screen
 * that opens `if (loading) return <Spinner/>` puts its entire main return behind
 * a branch, so treating "structurally locked" as "read-only" made most of a real
 * imported app uneditable.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Project } from 'ts-morph'
import { parsePageFile } from '@core/page-parser'
import { parsedPageToSitePage } from '../parsedPageToSitePage'
import { isPropWritableToSource, isStyleWritableToSource } from '@core/page-tree'
import type { PageNode } from '@core/page-tree'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-codeprops-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Parse one page file with §7 evaluation on, mapped to editor nodes. */
function load(source: string): PageNode[] {
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pages', 'Screen.jsx'), source, 'utf8')

  const parsed = parsePageFile(
    path.join(dir, 'pages', 'Screen.jsx'),
    dir,
    new Project({ useInMemoryFileSystem: false }),
    { workspaceRoot: dir },
  )
  const page = parsedPageToSitePage(parsed, {
    pageId: 'screen',
    slug: 'screen',
    title: 'Screen',
    resolveModuleId: (node) =>
      node.kind === 'component'
        ? `alm.${node.name}`
        : node.text !== undefined && node.children.length === 0
          ? 'base.text'
          : 'base.container',
    resolveTextProp: (moduleId) => (moduleId === 'base.text' ? 'text' : null),
  })
  return Object.values(page.nodes)
}

const byName = (nodes: PageNode[], text: string): PageNode | undefined =>
  nodes.find((n) => n.props.text === text)

describe('a node behind a conditional', () => {
  it('keeps its literal attributes writable', () => {
    const nodes = load(`
      export default function Screen({ isMember }) {
        return (
          <div>
            {isMember && <span title="Members only">Exclusive rates on hotels</span>}
          </div>
        )
      }
    `)

    const span = byName(nodes, 'Exclusive rates on hotels')!
    // parser-06: the parser now SELECTS the `&&`'s body — there is no "other
    // side" to choose between, so this element is no longer locked at all
    // (it used to be, under the predecessor "render every branch, lock it"
    // policy). Writability is even more directly true now than the branch-vs-
    // props split this file exists to defend, but the assertion is what
    // matters: nothing here refuses an ordinary literal attribute.
    expect(span.lockReason).toBeUndefined()
    expect(isPropWritableToSource(span, 'title')).toBe(true)
    expect(isPropWritableToSource(span, 'text')).toBe(true)
  })

  it('keeps them writable when the screen has several returns', () => {
    // The shape that locked whole screens: an early return makes the main return
    // "one of several", so every node under it inherited the branch lock.
    const nodes = load(`
      export default function Screen({ loading }) {
        if (loading) return <div>Loading…</div>
        return <div><span title="Ready">All set</span></div>
      }
    `)

    const span = byName(nodes, 'All set')!
    expect(isPropWritableToSource(span, 'title')).toBe(true)
    expect(isPropWritableToSource(span, 'text')).toBe(true)
  })
})

describe('a prop resolved from an expression', () => {
  it('is locked while its literal siblings stay writable', () => {
    const nodes = load(`
      const copy = { hotelsTag: 'Exclusive rates' }
      export default function Screen() {
        return <div><span title={copy.hotelsTag} lang="en">Hi</span></div>
      }
    `)

    const span = byName(nodes, 'Hi')!
    expect(span.props.title).toBe('Exclusive rates')
    // Still a `codeProps` entry — the JSX is NOT the writeback target...
    expect(span.codeProps).toContain('title')
    // ...but the evaluator located the literal behind it, so the prop IS
    // editable — at that literal. This is what makes i18n'd copy editable
    // instead of padlocked; see `isPropWritableToSource`.
    expect(span.resolvedProps?.title?.origin).toBeDefined()
    expect(isPropWritableToSource(span, 'title')).toBe(true)
    // The original point of this test, unchanged: one resolved attribute must
    // not take the others with it.
    expect(isPropWritableToSource(span, 'lang')).toBe(true)
    expect(isPropWritableToSource(span, 'text')).toBe(true)
  })

  it('locks a resolved inline-style property but not a literal one', () => {
    const nodes = load(`
      const ACCENT = 'var(--accent)'
      export default function Screen() {
        return <div><span style={{ color: ACCENT, margin: '4px' }}>Hi</span></div>
      }
    `)

    const span = byName(nodes, 'Hi')!
    expect(span.inlineStyles?.color).toBe('var(--accent)')
    expect(isStyleWritableToSource(span, 'color')).toBe(false)
    expect(isStyleWritableToSource(span, 'margin')).toBe(true)
  })
})

describe('a structured component prop', () => {
  it('is code-valued — there is no scalar form of an array to write', () => {
    const nodes = load(`
      export default function Screen() {
        return <Sheet title="Where to?" actions={[{ label: 'This device' }]} />
      }
    `)

    const sheet = nodes.find((n) => n.moduleId === 'alm.Sheet')!
    expect(Array.isArray(sheet.props.actions)).toBe(true)
    expect(isPropWritableToSource(sheet, 'actions')).toBe(false)
    // The literal next to it is the one the user is actually trying to edit.
    expect(isPropWritableToSource(sheet, 'title')).toBe(true)
  })
})

describe('a `.map` row', () => {
  it('has no writable prop, because one element renders every row', () => {
    const nodes = load(`
      const DEALS = [{ city: 'London' }, { city: 'Paris' }]
      export default function Screen() {
        return <div>{DEALS.map((d) => <span key={d.city} lang="en">{d.city}</span>)}</div>
      }
    `)

    const rows = nodes.filter((n) => n.id.includes('#'))
    expect(rows.length).toBe(2)
    for (const row of rows) {
      // `lang="en"` is a literal, but it is THE SAME literal for both rows.
      expect(isPropWritableToSource(row, 'lang')).toBe(false)
    }
  })
})

describe('a synthesized tag', () => {
  it('stays editable — it writes back by renaming the element', () => {
    // `props.tag` comes from the element's NAME, not an attribute, so it does not
    // go through `setJsxProp` (which would add a junk `tag="p"` and leave the
    // element an `<h1>`). The save adapter routes it to `setJsxTagName` instead,
    // so it is a real editable property and must not be listed as code-valued.
    const nodes = load(`
      export default function Screen() {
        return <div><h1>Title</h1></div>
      }
    `)

    const heading = byName(nodes, 'Title')!
    expect(heading.props.tag).toBe('h1')
    expect(isPropWritableToSource(heading, 'tag')).toBe(true)
    expect(isPropWritableToSource(heading, 'text')).toBe(true)
  })

  it('is not editable on a `.map` row, which has no location of its own', () => {
    const nodes = load(`
      const DEALS = [{ city: 'London' }, { city: 'Paris' }]
      export default function Screen() {
        return <ul>{DEALS.map((d) => <li key={d.city}>{d.city}</li>)}</ul>
      }
    `)

    const rows = nodes.filter((n) => n.id.includes('#'))
    expect(rows.length).toBe(2)
    for (const row of rows) expect(isPropWritableToSource(row, 'tag')).toBe(false)
  })
})
