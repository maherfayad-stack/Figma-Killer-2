/**
 * r3 audit P2 - wrapped children were indented one space short. `indentUnit`
 * took the smallest non-zero leading whitespace anywhere in the file, and a
 * block comment's ` * line` (one space) is exactly that: unit 1, so children
 * landed at base+1 instead of base+2. The unit is code indentation only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { wrapJsxElements } from '../wrapJsxElements'
import { indentUnit } from '../jsxChildPlacement'
import { locateTag } from './fixtureLocation'

let tmpDir: string
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-wrap-indent-'))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const SOURCE = `/**
 * The reading-list shelf.
 * Two blurbs sit side by side.
 */
export default function Shelf() {
  return (
    <section>
      <p className="a">One</p>
      <p className="b">Two</p>
    </section>
  )
}
`

describe('wrap indents children by the code unit, not by a comment gutter', () => {
  it('indentUnit ignores block-comment continuation lines', () => {
    expect(indentUnit(SOURCE)).toBe('  ')
  })

  it('writes the wrapped paragraphs one full level in', () => {
    const file = path.join(tmpDir, 'Shelf.tsx')
    fs.writeFileSync(file, SOURCE, 'utf8')
    const a = locateTag(SOURCE, 'p', 1)
    const b = locateTag(SOURCE, 'p', 2)
    const result = wrapJsxElements({ file, name: 'div', targets: [a, b] })
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(
      SOURCE.replace(
        `      <p className="a">One</p>
      <p className="b">Two</p>
`,
        `      <div>
        <p className="a">One</p>
        <p className="b">Two</p>
      </div>
`,
      ),
    )
  })
})
