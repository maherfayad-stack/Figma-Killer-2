/**
 * `insertJsxIntoSlotProp` — E2.4's write behind "put something in a
 * component's slot prop". Held to the same "refusals leave the file
 * untouched" bar as its siblings; the four table rows from the work order
 * (absent / single element / expression-valued / `children`) each get a
 * success test, and `slot-ambiguous` gets its own describe block because it
 * is the one row this codemod must never guess its way past.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { insertJsxIntoSlotProp } from '../insertJsxIntoSlotProp'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-slot-'))
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

describe('insertJsxIntoSlotProp — prop absent', () => {
  it('adds the attribute as a single JSX value, no fragment wrapper', () => {
    const source = `import { Sheet } from './Sheet'

export default function Page() {
  return (
    <Sheet title="Where to?" />
  )
}
`
    const file = writeFixture(source)
    const at = locateTag(source, 'Sheet')

    const result = insertJsxIntoSlotProp({
      file,
      ...at,
      propName: 'header',
      node: { name: 'Icon', importSpecifier: DS, props: { size: 24 } },
    })

    expect(result).toEqual({ ok: true })
    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('<Sheet title="Where to?" header={<Icon size={24} />} />')
    // The new import declaration is synthesized by ts-morph's own structural
    // API (`addImportDeclaration`), so its exact punctuation (semicolon) is
    // ts-morph's own default rather than something this codemod controls —
    // same posture `extractComponentCopy.ts`/`extractSubtreeToComponent.ts`
    // already take for their own synthesized imports.
    expect(written).toContain(`from '${DS}'`)
    expect(written).toContain('import { Icon }')
  })
})

describe('insertJsxIntoSlotProp — prop present, single element', () => {
  it('wraps the existing value and the new one in a fragment', () => {
    const source = `import { Sheet } from './Sheet'
import { Icon } from '@alm-design/design-system'

export default function Page() {
  return (
    <Sheet header={<Icon size={24} />} />
  )
}
`
    const file = writeFixture(source)
    const at = locateTag(source, 'Sheet')

    const result = insertJsxIntoSlotProp({
      file,
      ...at,
      propName: 'header',
      node: { name: 'Label', importSpecifier: './Label' },
    })

    expect(result).toEqual({ ok: true })
    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('header={<>')
    expect(written).toContain('<Icon size={24} />')
    expect(written).toContain('<Label />')
    expect(written).toContain('</>}')
    expect(written).toContain("import { Label } from './Label'")
  })

  it('appends into an already-multi-element (fragment) slot — proves a second insert round-trips', () => {
    // This shape is exactly the `studio.slot` fragment E2.3's parser captures
    // — a SECOND insert into it must append, not refuse or re-wrap.
    const source = `import { Sheet } from './Sheet'
import { Icon } from '@alm-design/design-system'
import { Title } from './Title'

export default function Page() {
  return (
    <Sheet
      header={
        <>
          <Icon size={24} />
          <Title />
        </>
      }
    />
  )
}
`
    const file = writeFixture(source)
    const at = locateTag(source, 'Sheet')

    const result = insertJsxIntoSlotProp({
      file,
      ...at,
      propName: 'header',
      node: { name: 'Badge', importSpecifier: './Badge' },
    })

    expect(result).toEqual({ ok: true })
    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('<Icon size={24} />')
    expect(written).toContain('<Title />')
    expect(written).toContain('<Badge />')
    expect(written).toContain("import { Badge } from './Badge'")
    // Still exactly one fragment, not a fragment-of-fragments.
    expect(written.match(/<>/g)).toHaveLength(1)
  })
})

describe('insertJsxIntoSlotProp — prop is expression-valued: refuses slot-ambiguous', () => {
  it('refuses an identifier value rather than guess', () => {
    const source = `import { Sheet } from './Sheet'

export default function Page({ headerNode }) {
  return (
    <Sheet header={headerNode} />
  )
}
`
    const file = writeFixture(source)
    const at = locateTag(source, 'Sheet')

    const result = insertJsxIntoSlotProp({
      file,
      ...at,
      propName: 'header',
      node: { name: 'Icon', importSpecifier: DS },
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('slot-ambiguous')
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('refuses a function call value', () => {
    const source = `import { Sheet } from './Sheet'

export default function Page() {
  return (
    <Sheet header={renderHeader()} />
  )
}
`
    const file = writeFixture(source)
    const at = locateTag(source, 'Sheet')

    const result = insertJsxIntoSlotProp({
      file,
      ...at,
      propName: 'header',
      node: { name: 'Icon', importSpecifier: DS },
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('slot-ambiguous')
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('refuses a plain string literal value', () => {
    const source = `import { Sheet } from './Sheet'

export default function Page() {
  return (
    <Sheet header="Untitled" />
  )
}
`
    const file = writeFixture(source)
    const at = locateTag(source, 'Sheet')

    const result = insertJsxIntoSlotProp({
      file,
      ...at,
      propName: 'header',
      node: { name: 'Icon', importSpecifier: DS },
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('slot-ambiguous')
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('refuses a valueless shorthand', () => {
    const source = `import { Sheet } from './Sheet'

export default function Page() {
  return (
    <Sheet header />
  )
}
`
    const file = writeFixture(source)
    const at = locateTag(source, 'Sheet')

    const result = insertJsxIntoSlotProp({
      file,
      ...at,
      propName: 'header',
      node: { name: 'Icon', importSpecifier: DS },
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('slot-ambiguous')
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  // `element.getAttribute('header')` only ever returns a `JsxSpreadAttribute`
  // when its literal text happens to equal the string "...expr" — which a
  // real spread never produces — so `{...props}` on the call site is
  // invisible to a lookup by the NAME `header`, exactly like `setJsxStyle`'s
  // and `setJsxClassName`'s identical spread guards (both documented
  // "effectively unreachable" in their own test files). The `spread-attribute`
  // branch above stays as defensive code with the same precedent, not a
  // reachable case to assert here.
})

describe('insertJsxIntoSlotProp — children delegates to insertJsxElement', () => {
  it('writes into the ordinary child list, not an attribute', () => {
    const source = `import { Sheet } from './Sheet'

export default function Page() {
  return (
    <Sheet title="Where to?"></Sheet>
  )
}
`
    const file = writeFixture(source)
    const at = locateTag(source, 'Sheet')

    const result = insertJsxIntoSlotProp({
      file,
      ...at,
      propName: 'children',
      node: { name: 'Icon', importSpecifier: DS },
    })

    expect(result).toEqual({ ok: true })
    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('<Sheet title="Where to?">')
    expect(written).toContain('<Icon />')
    expect(written).not.toContain('children={')
  })

  it('reopens a self-closing call site into a paired tag — a shape only insertJsxElement itself produces', () => {
    const source = `import { Sheet } from './Sheet'

export default function Page() {
  return (
    <Sheet title="Where to?" />
  )
}
`
    const file = writeFixture(source)
    const at = locateTag(source, 'Sheet')

    const result = insertJsxIntoSlotProp({
      file,
      ...at,
      propName: 'children',
      node: { name: 'span' },
    })
    expect(result).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toContain('<Sheet title="Where to?">\n      <span />\n    </Sheet>')
  })

  it('propagates a refusal from insertJsxElement unchanged', () => {
    const source = `import { Sheet } from './Sheet'

export default function Page() {
  return (
    <Sheet title="Where to?"></Sheet>
  )
}
`
    const file = writeFixture(source)
    const at = locateTag(source, 'Sheet')

    const result = insertJsxIntoSlotProp({
      file,
      ...at,
      propName: 'children',
      // Capitalised, no importSpecifier — `insertJsxElement`'s own
      // `unsafe-tag` refusal, proving it flows through untranslated.
      node: { name: 'Mystery' },
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('unsafe-tag')
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })
})

describe('insertJsxIntoSlotProp — not found', () => {
  it('refuses when the location does not name a JSX element', () => {
    const source = `import { Sheet } from './Sheet'

export default function Page() {
  return <Sheet title="Where to?" />
}
`
    const file = writeFixture(source)

    const result = insertJsxIntoSlotProp({
      file,
      line: 1,
      col: 1,
      propName: 'header',
      node: { name: 'Icon', importSpecifier: DS },
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('not-found')
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })
})

describe('insertJsxIntoSlotProp — binding conflict', () => {
  it('refuses rather than shadow an existing binding', () => {
    const source = `import { Sheet } from './Sheet'
import { Icon } from './local/Icon'

export default function Page() {
  return (
    <Sheet title="Where to?" />
  )
}
`
    const file = writeFixture(source)
    const at = locateTag(source, 'Sheet')

    const result = insertJsxIntoSlotProp({
      file,
      ...at,
      propName: 'header',
      node: { name: 'Icon', importSpecifier: DS },
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('binding-conflict')
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })
})
