/**
 * `frameJsxElements` (PA-6) — Frame selection's write: one sized, placed
 * container around a run of siblings, the members' offsets rebased in the same
 * write. Whole-file assertions, like the group suite: a frame whose members
 * kept their old offsets moves every one of them, and only the bytes show it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { frameJsxElements } from '../frameJsxElements'
import { wrapJsxElements } from '../wrapJsxElements'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-frame-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(source: string): string {
  const filePath = path.join(tmpDir, 'Page.tsx')
  fs.writeFileSync(filePath, source, 'utf8')
  return filePath
}

const PLACED = `export default function Page() {
  return (
    <main style={{ position: 'relative' }}>
      <h1 style={{ position: 'absolute', left: '40px', top: '30px' }}>Title</h1>
      <p style={{ position: 'absolute', right: '20px', top: '90px' }}>Body</p>
      <i style={{ position: 'absolute', left: '300px', top: '200px', width: '10px' }} />
    </main>
  )
}
`

describe('wrapJsxElements wrapperStyle', () => {
  it('writes the wrapper with an inline style and nothing else different from a plain group', () => {
    const file = writeFixture(PLACED)
    const targets = [locateTag(PLACED, 'h1', 1), locateTag(PLACED, 'p', 1)]
    expect(wrapJsxElements({ file, targets, name: 'div', wrapperStyle: { position: 'absolute', left: '10px' } })).toMatchObject({
      ok: true,
    })
    const out = fs.readFileSync(file, 'utf8')
    expect(out).toContain(`<div style={{ position: "absolute", left: "10px" }}>`)
    expect(out).toContain(`</div>`)
  })
})

describe('frameJsxElements', () => {
  it('writes the frame and rebases every member in one write', () => {
    const file = writeFixture(PLACED)
    const targets = [locateTag(PLACED, 'h1', 1), locateTag(PLACED, 'p', 1), locateTag(PLACED, 'i', 1)]
    const result = frameJsxElements({
      file,
      targets,
      name: 'div',
      wrapperStyle: { position: 'absolute', left: '40px', top: '30px', width: '270px', height: '180px' },
      memberStyles: [{ left: '0px', top: '0px' }, { right: '-250px', top: '60px' }, { left: '260px', top: '170px' }],
    })
    expect(result).toMatchObject({ ok: true })
    const out = fs.readFileSync(file, 'utf8')
    expect(out).toContain(`<div style={{ position: "absolute", left: "40px", top: "30px", width: "270px", height: "180px" }}>`)
    expect(out).toContain(`<h1 style={{ position: 'absolute', left: '0px', top: '0px' }}>`)
    expect(out).toContain(`<p style={{ position: 'absolute', right: '-250px', top: '60px' }}>`)
    expect(out).toContain(`left: '260px', top: '170px', width: '10px'`)
    // The members are INSIDE the frame, in their source order.
    expect(out.indexOf('<div')).toBeLessThan(out.indexOf('<h1'))
    expect(out.indexOf('</i>') === -1 ? out.indexOf('<i ') : out.indexOf('</i>')).toBeLessThan(out.indexOf('</div>'))
  })

  it('follows a patch to its target whatever order the targets arrive in', () => {
    const file = writeFixture(PLACED)
    const targets = [locateTag(PLACED, 'p', 1), locateTag(PLACED, 'h1', 1)]
    frameJsxElements({
      file,
      targets,
      name: 'div',
      wrapperStyle: { position: 'absolute', left: '0px', top: '0px' },
      memberStyles: [{ top: '1px' }, { top: '2px' }],
    })
    const out = fs.readFileSync(file, 'utf8')
    expect(out).toContain(`<p style={{ position: 'absolute', right: '20px', top: '1px' }}>`)
    expect(out).toContain(`<h1 style={{ position: 'absolute', left: '40px', top: '2px' }}>`)
  })

  it('removes a key a patch nulls', () => {
    const file = writeFixture(PLACED)
    frameJsxElements({
      file,
      targets: [locateTag(PLACED, 'h1', 1)],
      name: 'div',
      wrapperStyle: {},
      memberStyles: [{ left: null, top: '5px' }],
    })
    expect(fs.readFileSync(file, 'utf8')).toContain(`<h1 style={{ position: 'absolute', top: '5px' }}>`)
  })

  it('puts the file back byte for byte when a member cannot be written', () => {
    const source = PLACED.replace(`<h1 style={{ position: 'absolute', left: '40px', top: '30px' }}>`, `<h1 style="position:absolute">`)
    const file = writeFixture(source)
    const result = frameJsxElements({
      file,
      targets: [locateTag(source, 'h1', 1), locateTag(source, 'p', 1)],
      name: 'div',
      wrapperStyle: { position: 'absolute', left: '0px', top: '0px' },
      memberStyles: [{ left: '1px' }, { top: '1px' }],
    })
    expect(result).toMatchObject({ ok: false })
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('refuses a gap in the run exactly as a group does, and writes nothing', () => {
    const file = writeFixture(PLACED)
    const result = frameJsxElements({
      file,
      targets: [locateTag(PLACED, 'h1', 1), locateTag(PLACED, 'i', 1)],
      name: 'div',
      wrapperStyle: { position: 'absolute' },
      memberStyles: [{}, {}],
    })
    expect(result).toMatchObject({ ok: false, refusal: { reason: 'not-contiguous' } })
    expect(fs.readFileSync(file, 'utf8')).toBe(PLACED)
  })

  it('a frame around ONE element works (the group schema allowed a run of one)', () => {
    const file = writeFixture(PLACED)
    const result = frameJsxElements({
      file,
      targets: [locateTag(PLACED, 'p', 1)],
      name: 'div',
      wrapperStyle: { position: 'absolute', left: '0px' },
      memberStyles: [{ right: '0px' }],
    })
    expect(result).toMatchObject({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toContain(`<p style={{ position: 'absolute', right: '0px', top: '90px' }}>`)
  })
})
