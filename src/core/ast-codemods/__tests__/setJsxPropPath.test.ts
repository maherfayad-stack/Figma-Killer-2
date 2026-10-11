import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { JsxPropTargetError } from '../setJsxProp'
import { setJsxPropPath } from '../setJsxPropPath'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-path-'))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Writes `jsx` as the body of a component, runs the codemod on `<Navbar`, returns the file. */
function run(jsx: string, prop: string, pathToLeaf: (string | number)[], value: string | number | boolean): string {
  const source = `import { Navbar } from '../design-system'\n\nexport function App() {\n  return (\n    ${jsx}\n  )\n}\n`
  const file = path.join(tmpDir, 'App.tsx')
  fs.writeFileSync(file, source, 'utf8')
  const { line, col } = locateTag(source, 'Navbar')
  setJsxPropPath({ file, line, col, prop, path: pathToLeaf, value })
  return fs.readFileSync(file, 'utf8')
}

describe('setJsxPropPath', () => {
  it('replaces one number inside an object attribute and nothing else', () => {
    const out = run(`<Navbar title="Trips" segmentedControl={{ items: ['Flights', 'Stays'], value: 0 }} />`, 'segmentedControl', ['value'], 1)
    expect(out).toContain(`<Navbar title="Trips" segmentedControl={{ items: ['Flights', 'Stays'], value: 1 }} />`)
  })

  it('flips a boolean in one entry of a list and keeps its siblings byte for byte', () => {
    const out = run(`<Navbar chips={[{ label: 'Dates', selected: false }, { label: 'Guests', selected: true }]} />`, 'chips', [0, 'selected'], true)
    expect(out).toContain(`chips={[{ label: 'Dates', selected: true }, { label: 'Guests', selected: true }]}`)
  })

  it('writes a string in the quote the file already uses', () => {
    const out = run(`<Navbar chips={[{ label: 'Dates' }]} />`, 'chips', [0, 'label'], "Check-in")
    expect(out).toContain(`chips={[{ label: 'Check-in' }]}`)
  })

  it('appends a missing key inline, in the object own layout', () => {
    const out = run(`<Navbar chips={[{ label: 'Dates' }]} />`, 'chips', [0, 'selected'], true)
    expect(out).toContain(`chips={[{ label: 'Dates', selected: true }]}`)
  })

  it('appends a missing key to a multi-line object under its siblings', () => {
    const out = run(`<Navbar chips={[\n      {\n        label: 'Dates',\n      },\n    ]} />`, 'chips', [0, 'selected'], true)
    expect(out).toContain(`        label: 'Dates',\n        selected: true,\n      },`)
  })

  it('refuses a list that is a binding, by name, and writes nothing', () => {
    const source = `import { Navbar } from '../design-system'\nconst CHIPS = [{ label: 'Dates' }]\nexport function App() {\n  return <Navbar chips={CHIPS} />\n}\n`
    const file = path.join(tmpDir, 'Bound.tsx')
    fs.writeFileSync(file, source, 'utf8')
    const { line, col } = locateTag(source, 'Navbar')
    expect(() => setJsxPropPath({ file, line, col, prop: 'chips', path: [0, 'label'], value: 'x' })).toThrow(JsxPropTargetError)
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('refuses a leaf that is code, and an entry the list does not hold', () => {
    const jsx = `<Navbar chips={[{ label: t('dates') }]} />`
    expect(() => run(jsx, 'chips', [0, 'label'], 'x')).toThrow(JsxPropTargetError)
    expect(() => run(`<Navbar chips={[{ label: 'a' }]} />`, 'chips', [3, 'label'], 'x')).toThrow(JsxPropTargetError)
  })
})
