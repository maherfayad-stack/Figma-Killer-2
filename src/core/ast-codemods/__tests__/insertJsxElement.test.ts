/**
 * `insertJsxElement` — the write behind "add a design-system component to the
 * canvas" on a studio-imported board.
 *
 * Held to the same bar as `moveJsxElement`/`deleteJsxElement`: every assertion
 * is a WHOLE-FILE comparison against the original with exactly one element and
 * one import added. A codemod that reindents a sibling, eats a blank line, or
 * reformats an attribute list is a defect, and only a whole-file assertion
 * catches it.
 *
 * The refusals matter as much as the writes. An insert that cannot land
 * honestly must leave the file byte-identical.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Project } from 'ts-morph'
import { insertJsxElement } from '../insertJsxElement'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-insert-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(source: string, name = 'Page.tsx'): string {
  const filePath = path.join(tmpDir, name)
  fs.writeFileSync(filePath, source, 'utf8')
  return filePath
}

const DS = '@alm-design/design-system'

/** The comment, the blank line and the two-space rhythm exist to be protected. */
const PAGE = `import { Chip } from '@alm-design/design-system'

export default function Page() {
  return (
    <section className="list">
      {/* keep me exactly where I am */}
      <Chip label="First" />

      <Chip label="Second" />
    </section>
  )
}
`

describe('insertJsxElement — writes', () => {
  it('appends as the last child, at the siblings own indentation', () => {
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    const result = insertJsxElement({
      file,
      ...at,
      name: 'Button',
      props: { label: 'Buy now', variant: 'primary' },
      importSpecifier: DS,
    })

    expect(result).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      `import { Chip, Button } from '@alm-design/design-system'

export default function Page() {
  return (
    <section className="list">
      {/* keep me exactly where I am */}
      <Chip label="First" />

      <Chip label="Second" />
      <Button label="Buy now" variant="primary" />
    </section>
  )
}
`,
    )
  })

  it('writes before a named anchor sibling', () => {
    const file = writeFixture(PAGE)
    const parent = locateTag(PAGE, 'section')
    const anchor = locateTag(PAGE, 'Chip', 2)

    const result = insertJsxElement({
      file,
      ...parent,
      anchorLine: anchor.line,
      anchorCol: anchor.col,
      position: 'before',
      name: 'Button',
      props: { label: 'Buy now' },
      importSpecifier: DS,
    })

    expect(result).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      `import { Chip, Button } from '@alm-design/design-system'

export default function Page() {
  return (
    <section className="list">
      {/* keep me exactly where I am */}
      <Chip label="First" />

      <Button label="Buy now" />
      <Chip label="Second" />
    </section>
  )
}
`,
    )
  })

  it('adds a whole import line when the module is not imported yet, keeping the files quote style', () => {
    const source = `import React from "react"

export default function Page() {
  return (
    <main>
      <p>Hi</p>
    </main>
  )
}
`
    const file = writeFixture(source)
    const at = locateTag(source, 'main')

    expect(insertJsxElement({ file, ...at, name: 'Button', importSpecifier: DS })).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      `import React from "react"
import { Button } from "@alm-design/design-system"

export default function Page() {
  return (
    <main>
      <p>Hi</p>
      <Button />
    </main>
  )
}
`,
    )
  })

  it('fills an empty container without leaving a ragged line', () => {
    const source = `export default function Page() {
  return (
    <div className="slot"></div>
  )
}
`
    const file = writeFixture(source)
    const at = locateTag(source, 'div')

    expect(insertJsxElement({ file, ...at, name: 'Button', importSpecifier: DS })).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      `import { Button } from '@alm-design/design-system'
export default function Page() {
  return (
    <div className="slot">
      <Button />
    </div>
  )
}
`,
    )
  })

  it('reopens a self-closing parent into a paired tag', () => {
    const source = `export default function Page() {
  return (
    <div className="slot" />
  )
}
`
    const file = writeFixture(source)
    const at = locateTag(source, 'div')

    expect(insertJsxElement({ file, ...at, name: 'Button', importSpecifier: DS })).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      `import { Button } from '@alm-design/design-system'
export default function Page() {
  return (
    <div className="slot">
      <Button />
    </div>
  )
}
`,
    )
  })

  it('joins the line when the siblings share one', () => {
    const source = `import { Chip } from '@alm-design/design-system'

export default function Page() {
  return <div><Chip label="a" /></div>
}
`
    const file = writeFixture(source)
    const at = locateTag(source, 'div')

    expect(insertJsxElement({ file, ...at, name: 'Button', importSpecifier: DS })).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      `import { Chip, Button } from '@alm-design/design-system'

export default function Page() {
  return <div><Chip label="a" /> <Button /></div>
}
`,
    )
  })

  it('writes number and boolean props in their JSX spelling, and omits false', () => {
    const source = `export default function Page() {
  return (
    <div>
      <span>x</span>
    </div>
  )
}
`
    const file = writeFixture(source)
    const at = locateTag(source, 'div')

    insertJsxElement({
      file,
      ...at,
      name: 'Stepper',
      props: { value: 3, disabled: true, compact: false, label: 'Qty' },
      importSpecifier: DS,
    })

    expect(fs.readFileSync(file, 'utf8')).toContain('<Stepper value={3} disabled label="Qty" />')
  })

  it('is a no-op on the import when the binding is already imported from that module', () => {
    const source = `import { Button } from '@alm-design/design-system'

export default function Page() {
  return (
    <div>
      <Button label="a" />
    </div>
  )
}
`
    const file = writeFixture(source)
    const at = locateTag(source, 'div')

    expect(insertJsxElement({ file, ...at, name: 'Button', importSpecifier: DS })).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      `import { Button } from '@alm-design/design-system'

export default function Page() {
  return (
    <div>
      <Button label="a" />
      <Button />
    </div>
  )
}
`,
    )
  })

  it('keeps a tab-indented file tab-indented', () => {
    const source = 'export default function Page() {\n\treturn (\n\t\t<div>\n\t\t\t<span>x</span>\n\t\t</div>\n\t)\n}\n'
    const file = writeFixture(source)
    const at = locateTag(source, 'div')

    insertJsxElement({ file, ...at, name: 'Button', importSpecifier: DS })
    expect(fs.readFileSync(file, 'utf8')).toContain('\n\t\t\t<Button />\n')
  })
})

describe('insertJsxElement — refusals leave the file byte-identical', () => {
  it('refuses when the name is already bound to a different import', () => {
    const source = `import { Button } from './ui/Button'

export default function Page() {
  return (
    <div>
      <Button />
    </div>
  )
}
`
    const file = writeFixture(source)
    const at = locateTag(source, 'div')

    const result = insertJsxElement({ file, ...at, name: 'Button', importSpecifier: DS })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.refusal.reason).toBe('binding-conflict')
      expect(result.refusal.message).toContain('./ui/Button')
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('refuses when the name is a locally declared component', () => {
    const source = `function Button() {
  return <button />
}

export default function Page() {
  return (
    <div>
      <Button />
    </div>
  )
}
`
    const file = writeFixture(source)
    const at = locateTag(source, 'div')

    const result = insertJsxElement({ file, ...at, name: 'Button', importSpecifier: DS })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('binding-conflict')
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('refuses when the parent location does not name a JSX element', () => {
    const file = writeFixture(PAGE)
    // Line 1 is the import statement — a real position in the file, but not a tag.
    const result = insertJsxElement({ file, line: 1, col: 1, name: 'Button', importSpecifier: DS })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('not-found')
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
  })

  it('refuses when the anchor is not a child of the container', () => {
    const source = `export default function Page() {
  return (
    <section>
      <div className="a">
        <span>inner</span>
      </div>
      <p>outer</p>
    </section>
  )
}
`
    const file = writeFixture(source)
    const parent = locateTag(source, 'div')
    const anchor = locateTag(source, 'p')

    const result = insertJsxElement({
      file,
      ...parent,
      anchorLine: anchor.line,
      anchorCol: anchor.col,
      position: 'after',
      name: 'Button',
      importSpecifier: DS,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('not-siblings')
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('measures its splice against the file on disk, not a stale parsed copy', () => {
    const file = writeFixture(PAGE)
    // Parse once, then change the file underneath the parsed copy. `loadSourceFile`
    // re-reads before locating, so the write lands against the CURRENT bytes —
    // which is what `verbatimSourceText`'s `stale-source` guard is there to
    // enforce if that ever stops being true.
    const project = new Project({ useInMemoryFileSystem: false })
    project.addSourceFileAtPath(file)
    const shifted = `// touched\n${PAGE}`
    fs.writeFileSync(file, shifted, 'utf8')
    const at = locateTag(shifted, 'section')

    expect(insertJsxElement({ file, ...at, name: 'Button', importSpecifier: DS, project })).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      `// touched
import { Chip, Button } from '@alm-design/design-system'

export default function Page() {
  return (
    <section className="list">
      {/* keep me exactly where I am */}
      <Chip label="First" />

      <Chip label="Second" />
      <Button />
    </section>
  )
}
`,
    )
  })
})

/**
 * Intrinsic tags — the no-import path. Same whole-file bar as everything
 * above: an intrinsic insert must add exactly one element and NO import line,
 * and a refused one must leave the file byte-identical.
 */
describe('insertJsxElement — intrinsic tags', () => {
  it('writes a plain tag with no import when importSpecifier is omitted', () => {
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    expect(insertJsxElement({ file, ...at, name: 'div' })).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      `import { Chip } from '@alm-design/design-system'

export default function Page() {
  return (
    <section className="list">
      {/* keep me exactly where I am */}
      <Chip label="First" />

      <Chip label="Second" />
      <div />
    </section>
  )
}
`,
    )
  })

  it('writes literal text as the only child', () => {
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    expect(
      insertJsxElement({ file, ...at, name: 'span', props: { className: 'cta' }, children: 'Sign in' }),
    ).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toContain('<span className="cta">Sign in</span>')
  })

  it('escapes text that would otherwise leave JSX text mode', () => {
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    expect(insertJsxElement({ file, ...at, name: 'p', children: 'a {b} <c> & d' })).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toContain('<p>a &#123;b&#125; &lt;c&gt; &amp; d</p>')
  })

  it('does not treat a same-named local binding as a conflict', () => {
    // `<div />` is the string "div" to JSX, never a reference to this const,
    // so the binding-conflict check must not fire on the intrinsic path.
    const source = `export default function Page() {
  const div = 1
  return (
    <section>
      <b />
    </section>
  )
}
`
    const file = writeFixture(source)
    const at = locateTag(source, 'section')

    expect(insertJsxElement({ file, ...at, name: 'div' })).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toContain('<div />')
    expect(fs.readFileSync(file, 'utf8')).not.toContain('import')
  })

  it('refuses a capitalised name with no importSpecifier, and says why', () => {
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    const result = insertJsxElement({ file, ...at, name: 'Buton' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('unsafe-tag')
    expect(result.refusal.message).toContain('importSpecifier')
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
  })

  it('refuses a tag that executes script or loads external resources', () => {
    for (const name of ['script', 'iframe', 'object']) {
      const file = writeFixture(PAGE)
      const at = locateTag(PAGE, 'section')

      const result = insertJsxElement({ file, ...at, name })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.refusal.reason).toBe('unsafe-tag')
      expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
    }
  })

  it('refuses a malformed tag name rather than writing broken JSX', () => {
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    const result = insertJsxElement({ file, ...at, name: 'div onload="x"' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('unsafe-tag')
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
  })

  it('refuses children on a void element', () => {
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    const result = insertJsxElement({ file, ...at, name: 'img', children: 'nope' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('void-element-children')
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
  })

  it('still writes the import when a component name IS given a specifier', () => {
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    expect(insertJsxElement({ file, ...at, name: 'Button', importSpecifier: DS })).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toContain(`import { Chip, Button } from '${DS}'`)
  })
})

/**
 * Nested subtrees — one insert, one splice, no intermediate node ids.
 *
 * This is the path that replaced ~30 sequential round trips per screen, so the
 * assertions are whole-file: indentation of every level, one import pass for
 * the whole tree, and an all-or-nothing refusal when any descendant is invalid.
 */
describe('insertJsxElement — nested subtrees', () => {
  it('writes a multi-level tree in one call, indented from the placement', () => {
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    expect(
      insertJsxElement({
        file,
        ...at,
        name: 'div',
        props: { className: 'card' },
        children: [
          { name: 'h2', children: 'Sign in' },
          {
            name: 'div',
            props: { className: 'row' },
            children: [
              { name: 'span', children: 'or' },
              { name: 'Button', importSpecifier: DS, props: { label: 'Go' } },
            ],
          },
        ],
      }),
    ).toEqual({ ok: true })

    expect(fs.readFileSync(file, 'utf8')).toBe(
      `import { Chip, Button } from '@alm-design/design-system'

export default function Page() {
  return (
    <section className="list">
      {/* keep me exactly where I am */}
      <Chip label="First" />

      <Chip label="Second" />
      <div className="card">
        <h2>Sign in</h2>
        <div className="row">
          <span>or</span>
          <Button label="Go" />
        </div>
      </div>
    </section>
  )
}
`,
    )
  })

  it('writes one import line per new specifier, for components anywhere in the tree', () => {
    const source = `export default function Page() {
  return (
    <main>
      <b />
    </main>
  )
}
`
    const file = writeFixture(source)
    const at = locateTag(source, 'main')

    expect(
      insertJsxElement({
        file,
        ...at,
        name: 'div',
        children: [
          { name: 'Button', importSpecifier: DS },
          { name: 'Card', importSpecifier: DS },
          { name: 'Icon', importSpecifier: './icons' },
        ],
      }),
    ).toEqual({ ok: true })

    const written = fs.readFileSync(file, 'utf8')
    // Both DS components collapse onto ONE declaration, not two.
    expect(written).toContain(`import { Button, Card } from '${DS}'`)
    expect(written).toContain("import { Icon } from './icons'")
    expect(written.match(/^import /gm)).toHaveLength(2)
  })

  it('copies the file\'s own indent unit into the nested levels', () => {
    const source = [
      'export default function Page() {',
      '    return (',
      '        <main>',
      '            <b />',
      '        </main>',
      '    )',
      '}',
      '',
    ].join('\n')
    const file = writeFixture(source)
    const at = locateTag(source, 'main')

    expect(
      insertJsxElement({ file, ...at, name: 'div', children: [{ name: 'span', children: 'x' }] }),
    ).toEqual({ ok: true })

    // Four-space file: the new div sits at 12, its child at 16.
    expect(fs.readFileSync(file, 'utf8')).toContain('            <div>\n                <span>x</span>\n            </div>')
  })

  it('refuses on an invalid DESCENDANT without writing anything', () => {
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    const result = insertJsxElement({
      file,
      ...at,
      name: 'div',
      children: [
        { name: 'span', children: 'fine' },
        { name: 'div', children: [{ name: 'script' }] },
      ],
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('unsafe-tag')
    // All-or-nothing: the valid siblings must not have landed either.
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
  })

  it('refuses a nested capitalised name with no importSpecifier', () => {
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    const result = insertJsxElement({ file, ...at, name: 'div', children: [{ name: 'Mystery' }] })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('unsafe-tag')
    expect(result.refusal.message).toContain('importSpecifier')
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
  })

  it('treats an empty children array as a childless element', () => {
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    expect(insertJsxElement({ file, ...at, name: 'div', children: [] })).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toContain('<div />')
  })

  it('refuses a void element given nested children', () => {
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    const result = insertJsxElement({ file, ...at, name: 'img', children: [{ name: 'span' }] })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('void-element-children')
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
  })

  it('escapes text inside nested levels too', () => {
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    expect(
      insertJsxElement({ file, ...at, name: 'div', children: [{ name: 'p', children: 'a {b} <c>' }] }),
    ).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toContain('<p>a &#123;b&#125; &lt;c&gt;</p>')
  })

  it('builds a deep subtree into an EMPTY parent', () => {
    const source = `export default function Page() {
  return <main></main>
}
`
    const file = writeFixture(source)
    const at = locateTag(source, 'main')

    expect(
      insertJsxElement({
        file,
        ...at,
        name: 'div',
        children: [{ name: 'div', children: [{ name: 'div', children: [{ name: 'span', children: 'deep' }] }] }],
      }),
    ).toEqual({ ok: true })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('<span>deep</span>')
    // Four nesting levels, each one unit deeper than the last.
    expect(written.match(/^\s+<div>$/gm)).toHaveLength(3)
  })
})

describe('insertJsxElement — structured prop values', () => {
  /**
   * A design system's CONTENT is often an array or an object, not a string:
   * `<TabBar items={[{ label: 'Home' }]}/>` — `items` is the entire content of
   * a tab bar. Every one of these used to be dropped on the way to disk, one
   * layer above this codemod, so an inserted TabBar was written as `<TabBar
   * platform="ios" value={0}/>` and the canvas — which reloads from source, as
   * it must — drew an empty bar. That was the whole of "the tab bar renders
   * with nothing in it", and it survived two rounds of fixes upstream because
   * the seeded value never reached the file.
   */
  it('writes an array of objects as a JSX expression', () => {
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    const result = insertJsxElement({
      file,
      ...at,
      name: 'TabBar',
      props: { platform: 'ios', value: 0, items: [{ label: 'Home' }, { label: 'Explore' }] },
      importSpecifier: DS,
    })

    expect(result).toEqual({ ok: true })
    // Bare keys and spaced braces: this lands in the user's own repository and
    // is the first thing they read after inserting, so `{"label":"Home"}` —
    // which is what a plain `JSON.stringify` would have written — is not good
    // enough, even though it parses.
    expect(fs.readFileSync(file, 'utf8')).toContain(
      '<TabBar platform="ios" value={0} items={[{ label: "Home" }, { label: "Explore" }]} />',
    )
  })

  it('writes a nested object prop', () => {
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    insertJsxElement({
      file,
      ...at,
      name: 'Dialog',
      props: { primaryAction: { label: 'Primary' }, dismissOnScrim: true },
      importSpecifier: DS,
    })

    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('primaryAction={{ label: "Primary" }}')
    // A `true` boolean is still the bare-attribute shorthand.
    expect(written).toContain('dismissOnScrim ')
  })

  it('quotes a key that is not a plain identifier', () => {
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    insertJsxElement({
      file,
      ...at,
      name: 'IconButton',
      props: { action: { 'aria-label': 'Share' } },
      importSpecifier: DS,
    })

    expect(fs.readFileSync(file, 'utf8')).toContain('action={{ "aria-label": "Share" }}')
  })

  it('escapes a string inside a structured value the same way JSON does', () => {
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    insertJsxElement({
      file,
      ...at,
      name: 'TabBar',
      props: { items: [{ label: 'He said "go"' }] },
      importSpecifier: DS,
    })

    expect(fs.readFileSync(file, 'utf8')).toContain('items={[{ label: "He said \\"go\\"" }]}')
  })

  it('writes an empty array and an empty object without inventing content', () => {
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    insertJsxElement({ file, ...at, name: 'TabBar', props: { items: [], meta: {} }, importSpecifier: DS })

    expect(fs.readFileSync(file, 'utf8')).toContain('items={[]} meta={{}}')
  })

  it('writes null as an expression, not the string "null"', () => {
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    insertJsxElement({ file, ...at, name: 'Cell', props: { visual: null }, importSpecifier: DS })

    expect(fs.readFileSync(file, 'utf8')).toContain('visual={null}')
  })
})

describe('insertJsxElement — a React element inside a prop', () => {
  /**
   * `<TabBar items={[{ icon: <svg…/>, label: 'Home' }]}/>` is the documented
   * shape of a tab bar, and an icon that cannot be written is an empty icon
   * slot on every tab. The element arrives as a validated TREE, never as source
   * text, and goes through the same `validateSubtree` tag-safety refusal every
   * child element already does.
   */
  const HOME_ICON = {
    __jsx: {
      name: 'svg',
      props: { viewBox: '0 0 24 24', fill: 'none' },
      children: [{ name: 'path', props: { d: 'M4 12L9 17' } }],
    },
  }

  it('writes it as a real element, not as data', () => {
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    const result = insertJsxElement({
      file,
      ...at,
      name: 'TabBar',
      props: { items: [{ icon: HOME_ICON, label: 'Home' }] },
      importSpecifier: DS,
    })

    expect(result).toEqual({ ok: true })
    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('<svg viewBox="0 0 24 24" fill="none">')
    expect(written).toContain('<path d="M4 12L9 17" />')
    // The marker is plumbing and must never reach the user's file.
    expect(written).not.toContain('__jsx')
  })

  it('refuses a prop element with an unsafe tag, leaving the file untouched', () => {
    // The same gate that protects the child list. A prop element carries no
    // `importSpecifier`, so a capitalised tag is refused here too.
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    const result = insertJsxElement({
      file,
      ...at,
      name: 'TabBar',
      // The TAG is what is refused, so the payload is irrelevant — and kept
      // innocuous on purpose: `no-native-browser-dialogs.test.ts` text-scans
      // this repo for `alert(`, and a realistic-looking one here would trip it.
      props: { items: [{ icon: { __jsx: { name: 'script', children: 'boom' } } }] },
      importSpecifier: DS,
    })

    expect(result).toEqual({ ok: false, refusal: expect.objectContaining({ reason: 'unsafe-tag' }) })
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
  })

  it('writes no import for an intrinsic prop element', () => {
    const file = writeFixture(PAGE)
    const at = locateTag(PAGE, 'section')

    insertJsxElement({ file, ...at, name: 'TabBar', props: { items: [{ icon: HOME_ICON }] }, importSpecifier: DS })

    // `TabBar` is imported; `svg` and `path` are host tags and are not.
    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain("import { Chip, TabBar } from '@alm-design/design-system'")
    expect(written).not.toContain('svg }')
  })
})
