/**
 * P5-B3 (IMG-10) — `insertJsxElement` writing an image IMPORT: a direct prop
 * value `{ __assetImport: './assets/hero.png' }` becomes `src={heroPng}` plus
 * `import heroPng from './assets/hero.png'`, in the ONE splice the element
 * itself is written in. Whole-file assertions, the same bar every insert test
 * holds: nothing else in the file may move.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { insertJsxElement } from '../insertJsxElement'
import { insertJsxIntoSlotProp } from '../insertJsxIntoSlotProp'
import { assetImportBindingName } from '../jsxAssetImports'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-asset-import-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(source: string): string {
  const file = path.join(tmpDir, 'Page.tsx')
  fs.writeFileSync(file, source, 'utf8')
  return file
}

const PAGE = `import logo from './assets/logo.png'

export default function Page() {
  return (
    <main>
      <img src={logo} alt="Logo" />
    </main>
  )
}
`

describe('insertJsxElement — an image import (IMG-10)', () => {
  it('writes the default import and src={name} in one splice, nothing else moved', () => {
    const file = writeFixture(PAGE)
    const result = insertJsxElement({
      file,
      ...locateTag(PAGE, 'main'),
      name: 'img',
      props: { src: { __assetImport: './assets/hero.png' }, alt: 'hero', width: 640, height: 360 },
    })
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(`import logo from './assets/logo.png'
import heroPng from './assets/hero.png'

export default function Page() {
  return (
    <main>
      <img src={logo} alt="Logo" />
      <img src={heroPng} alt="hero" width={640} height={360} />
    </main>
  )
}
`)
  })

  it('takes a free name when the obvious one is already bound in the file', () => {
    const source = PAGE.replace('export default function Page() {', 'const heroPng = 1\n\nexport default function Page() {')
    const file = writeFixture(source)
    const result = insertJsxElement({ file, ...locateTag(source, 'main'), name: 'img', props: { src: { __assetImport: './assets/hero.png' } } })
    expect(result.ok).toBe(true)
    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain("import heroPng2 from './assets/hero.png'")
    expect(written).toContain('<img src={heroPng2} />')
    expect(written).toContain('const heroPng = 1')
  })

  it('reuses an import of the same file that is already there, adding no second line', () => {
    const file = writeFixture(PAGE)
    const result = insertJsxElement({ file, ...locateTag(PAGE, 'main'), name: 'img', props: { src: { __assetImport: './assets/logo.png' } } })
    expect(result.ok).toBe(true)
    const written = fs.readFileSync(file, 'utf8')
    expect(written.match(/assets\/logo\.png/g)).toHaveLength(1)
    expect(written).toContain('<img src={logo} />')
  })

  it('binds a run of siblings: two files that want the same name get two names', () => {
    const file = writeFixture(PAGE)
    const result = insertJsxElement({
      file,
      ...locateTag(PAGE, 'main'),
      name: 'img',
      props: { src: { __assetImport: './assets/a/hero.png' } },
      siblings: [{ name: 'img', props: { src: { __assetImport: './assets/b/hero.png' } } }],
    })
    expect(result.ok).toBe(true)
    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain("import heroPng from './assets/a/hero.png'")
    expect(written).toContain("import heroPng2 from './assets/b/hero.png'")
    expect(written).toContain('<img src={heroPng} />')
    expect(written).toContain('<img src={heroPng2} />')
  })

  const hostile: [string, string][] = [
    ['a bare package specifier', 'fs'],
    ['a non-image module', './secrets.ts'],
    ['a quote that would end the string', "./a'); alert(1); ('.png"],
    ['a newline', './a\n.png'],
    ['an absolute path', '/etc/hero.png'],
  ]
  for (const [label, specifier] of hostile) {
    it(`refuses ${label} and leaves the file byte-identical`, () => {
      const file = writeFixture(PAGE)
      const result = insertJsxElement({ file, ...locateTag(PAGE, 'main'), name: 'img', props: { src: { __assetImport: specifier } } })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.refusal.reason).toBe('asset-import')
      expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
    })
  }

  it('refuses a ref nested where no import can be spelled, byte-identical', () => {
    const file = writeFixture(PAGE)
    const result = insertJsxElement({
      file,
      ...locateTag(PAGE, 'main'),
      name: 'div',
      props: { data: [{ __assetImport: './assets/hero.png' }] },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('asset-import')
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
  })

  it('a codemod that writes no image imports refuses one rather than printing the object', () => {
    const source = `import { Sheet } from './Sheet'

export default function Page() {
  return <Sheet />
}
`
    const file = writeFixture(source)
    const result = insertJsxIntoSlotProp({
      file,
      ...locateTag(source, 'Sheet'),
      propName: 'header',
      node: { name: 'img', props: { src: { __assetImport: './hero.png' } } },
    })
    expect(result.ok).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })
})

describe('assetImportBindingName', () => {
  it('camel-cases the base name and keeps the extension', () => {
    expect(assetImportBindingName('./assets/hero.png')).toBe('heroPng')
    expect(assetImportBindingName('../img/team-photo@2x.jpg')).toBe('teamPhoto2xJpg')
    expect(assetImportBindingName('./404.svg')).toBe('img404Svg')
  })
})
