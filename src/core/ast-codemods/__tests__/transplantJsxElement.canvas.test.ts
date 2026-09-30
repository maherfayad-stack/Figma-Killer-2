/**
 * P5-G (FC-2) — the free canvas's two transplant endpoints, held to
 * `transplantJsxElement.test.ts`'s bar: whole files asserted byte for byte,
 * and every refusal leaves every file exactly as it was.
 *
 *  - LIFT: a page element becomes the root of a NEW layer module.
 *  - PLACE: a layer module's root is written into a container in a page.
 *
 * A lift followed by a place back into the same container is the round trip
 * the owner's gesture makes (drag out of a frame, drag back in), and it has to
 * give back the page's original bytes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildCanvasLayerModule,
  canvasLayerModuleFromSpec,
  liftJsxElementToCanvasModule,
  placeCanvasLayerRoot,
} from '@core/ast-codemods'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-canvas-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(rel: string, source: string): string {
  const filePath = path.join(tmpDir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, source, 'utf8')
  return filePath
}

const read = (file: string): string => fs.readFileSync(file, 'utf8')

const HOME = `import { Badge } from '../components/Badge'
import Logo from '../components/Logo'

export default function Home() {
  return (
    <main className="home">
      <h1>Home</h1>
      <Badge tone="quiet">
        New
      </Badge>
      <Logo />
    </main>
  )
}
`

const HOME_WITHOUT_BADGE = `import { Badge } from '../components/Badge'
import Logo from '../components/Logo'

export default function Home() {
  return (
    <main className="home">
      <h1>Home</h1>
      <Logo />
    </main>
  )
}
`

const BADGE_LAYER = `/* eslint-disable */
// Studio free-canvas layer. Not part of your app: nothing imports this file.
import { Badge } from '../../components/Badge'

export default function CanvasLayer() {
  return (
    <Badge tone="quiet">
      New
    </Badge>
  )
}
`

function lift(file: string, source: string, tag: string, moduleRel: string, copy = false) {
  const at = locateTag(source, tag)
  const moduleFile = path.join(tmpDir, ...moduleRel.split('/'))
  return {
    moduleFile,
    result: liftJsxElementToCanvasModule({
      file,
      line: at.line,
      col: at.col,
      moduleFile,
      ...(copy ? { copy: true } : {}),
      writeModule: (text) => {
        fs.mkdirSync(path.dirname(moduleFile), { recursive: true })
        fs.writeFileSync(moduleFile, text, { encoding: 'utf8', flag: 'wx' })
      },
    }),
  }
}

describe('liftJsxElementToCanvasModule', () => {
  it('moves an element into a new layer module, verbatim, with its import re-specified from .studio/canvas', () => {
    const home = writeFixture('pages/Home.tsx', HOME)
    const { moduleFile, result } = lift(home, HOME, 'Badge', '.studio/canvas/cl0123456789.tsx')

    expect(result).toEqual({ ok: true, carriedImports: ['Badge'], root: { line: 7, col: 6 } })
    expect(read(moduleFile)).toBe(BADGE_LAYER)
    // The origin keeps its import: pruning it is the batch's post-pass, never the codemod's.
    expect(read(home)).toBe(HOME_WITHOUT_BADGE)
    expect(locateTag(BADGE_LAYER, 'Badge')).toEqual({ line: 7, col: 6 })
  })

  it('a copy writes the module and leaves the page byte-identical', () => {
    const home = writeFixture('pages/Home.tsx', HOME)
    const { moduleFile, result } = lift(home, HOME, 'Logo', '.studio/canvas/cl0123456789.tsx', true)

    expect(result.ok).toBe(true)
    expect(read(home)).toBe(HOME)
    expect(read(moduleFile)).toBe(`/* eslint-disable */
// Studio free-canvas layer. Not part of your app: nothing imports this file.
import Logo from '../../components/Logo'

export default function CanvasLayer() {
  return (
    <Logo />
  )
}
`)
  })

  it('refuses markup that reads the component body, and writes neither file', () => {
    const source = `export default function Card({ title }: { title: string }) {
  return (
    <section>
      <h2>{title}</h2>
    </section>
  )
}
`
    const card = writeFixture('pages/Card.tsx', source)
    const { moduleFile, result } = lift(card, source, 'h2', '.studio/canvas/cl0123456789.tsx')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('captured-scope')
    expect(read(card)).toBe(source)
    expect(fs.existsSync(moduleFile)).toBe(false)
  })

  it('writes nothing to the page when the module write itself fails', () => {
    const home = writeFixture('pages/Home.tsx', HOME)
    writeFixture('.studio/canvas/cl0123456789.tsx', 'taken\n')
    const at = locateTag(HOME, 'Badge')
    expect(() =>
      liftJsxElementToCanvasModule({
        file: home,
        line: at.line,
        col: at.col,
        moduleFile: path.join(tmpDir, '.studio', 'canvas', 'cl0123456789.tsx'),
        writeModule: (text) =>
          fs.writeFileSync(path.join(tmpDir, '.studio', 'canvas', 'cl0123456789.tsx'), text, { flag: 'wx' }),
      }),
    ).toThrow()
    expect(read(home)).toBe(HOME)
  })

  it('names the component CanvasLayer2 when a carried import is called CanvasLayer', () => {
    const built = buildCanvasLayerModule('<CanvasLayer />', new Map([['CanvasLayer', { specifier: './x' }]]))
    expect(built.text).toContain('export default function CanvasLayer2()')
  })
})

describe('placeCanvasLayerRoot', () => {
  it('places the layer root back into the page container, and a lift + place round trip is byte-exact', () => {
    const home = writeFixture('pages/Home.tsx', HOME)
    const { moduleFile } = lift(home, HOME, 'Badge', '.studio/canvas/cl0123456789.tsx')
    const main = locateTag(HOME_WITHOUT_BADGE, 'main')
    const logo = locateTag(HOME_WITHOUT_BADGE, 'Logo')

    const result = placeCanvasLayerRoot({
      moduleFile,
      destinationFile: home,
      destinationLine: main.line,
      destinationCol: main.col,
      anchorLine: logo.line,
      anchorCol: logo.col,
      position: 'before',
    })

    expect(result).toEqual({ ok: true, carriedImports: ['Badge'], created: { line: 8, col: 8 } })
    expect(read(home)).toBe(HOME)
    // The module is the caller's to delete — this codemod never touches .studio/canvas.
    expect(read(moduleFile)).toBe(BADGE_LAYER)
  })

  it('adds the import the page does not have yet, specified from the page', () => {
    const about = writeFixture(
      'pages/About.tsx',
      `export default function About() {
  return (
    <main>
      <h1>About</h1>
    </main>
  )
}
`,
    )
    const moduleFile = writeFixture('.studio/canvas/cl0123456789.tsx', BADGE_LAYER)
    const main = { line: 3, col: 6 }
    const result = placeCanvasLayerRoot({ moduleFile, destinationFile: about, destinationLine: main.line, destinationCol: main.col })

    expect(result.ok).toBe(true)
    expect(read(about)).toBe(`import { Badge } from '../components/Badge'
export default function About() {
  return (
    <main>
      <h1>About</h1>
      <Badge tone="quiet">
        New
      </Badge>
    </main>
  )
}
`)
  })

  it('refuses a module with no single root, and writes nothing', () => {
    const about = writeFixture('pages/About.tsx', `export default function About() {\n  return <main />\n}\n`)
    const broken = `export const x = 1\n`
    const moduleFile = writeFixture('.studio/canvas/cl0123456789.tsx', broken)
    const result = placeCanvasLayerRoot({ moduleFile, destinationFile: about, destinationLine: 2, destinationCol: 11 })

    expect(result.ok).toBe(false)
    expect(read(about)).toBe(`export default function About() {\n  return <main />\n}\n`)
    expect(read(moduleFile)).toBe(broken)
  })
})

describe('canvasLayerModuleFromSpec', () => {
  it('writes an image layer with the header, and refuses an unsafe tag', () => {
    const built = canvasLayerModuleFromSpec({ name: 'img', props: { src: '/cat.png', alt: 'cat', width: 640, height: 480 } })
    expect(built.ok).toBe(true)
    if (built.ok) {
      expect(built.module.text).toBe(`/* eslint-disable */
// Studio free-canvas layer. Not part of your app: nothing imports this file.

export default function CanvasLayer() {
  return (
    <img src="/cat.png" alt="cat" width={640} height={480} />
  )
}
`)
      expect(built.module.root).toEqual({ line: 6, col: 6 })
    }
    expect(canvasLayerModuleFromSpec({ name: 'script' }).ok).toBe(false)
  })
})
