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
