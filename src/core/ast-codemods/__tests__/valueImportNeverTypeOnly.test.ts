/**
 * r3 audit P0 - a VALUE import must never be merged into `import type { ... }`
 * (erased at build, so the hook is undefined when the page runs) nor treated as
 * satisfied by an inline `type` specifier. Fixtures: a library-checkout screen,
 * not the eSIM corpus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { transplantJsxElement } from '../transplantJsxElement'
import { locateTag } from './fixtureLocation'

let tmpDir: string
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-value-import-'))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const ORIGIN = `import { useState } from 'react'

export default function Shelf() {
  const [open, setOpen] = useState(false)
  return (
    <main>
      <button type="button" onClick={() => setOpen(!open)}>
        {open ? 'Close' : 'Open'}
      </button>
    </main>
  )
}
`

function moveInto(destinationText: string): string {
  const origin = path.join(tmpDir, 'Shelf.tsx')
  const destination = path.join(tmpDir, 'Checkout.tsx')
  fs.writeFileSync(origin, ORIGIN, 'utf8')
  fs.writeFileSync(destination, destinationText, 'utf8')
  const element = locateTag(ORIGIN, 'button')
  const container = locateTag(destinationText, 'main')
  const result = transplantJsxElement({
    file: origin,
    line: element.line,
    col: element.col,
    destinationFile: destination,
    destinationLine: container.line,
    destinationCol: container.col,
  })
  expect(result.ok).toBe(true)
  return fs.readFileSync(destination, 'utf8')
}

const BODY = `export default function Checkout() {
  return (
    <main>
      <h1>Checkout</h1>
    </main>
  )
}
`

describe('a carried hook import is a value import', () => {
  it('does not merge useState into import type { ... } from react', () => {
    const out = moveInto(`import type { FormEvent } from 'react'\n\n${BODY}`)
    expect(out).toContain("import type { FormEvent } from 'react'")
    expect(out).toMatch(/^import \{ useState \} from 'react'$/m)
    expect(out).not.toMatch(/import type \{[^}]*useState/)
  })

  it('adds a value import when react is only imported as an inline type specifier', () => {
    const out = moveInto(`import { type FormEvent } from 'react'\n\n${BODY}`)
    expect(out).toMatch(/import \{ type FormEvent, useState \} from 'react'/)
  })

  it('is not satisfied by a type-only import of the same name', () => {
    const out = moveInto(`import { type useState } from 'react'\n\n${BODY}`)
    expect(out).toMatch(/import \{ type useState, useState \} from 'react'/)
  })

  it('still merges into an existing value import', () => {
    const out = moveInto(`import { useEffect } from 'react'\n\n${BODY}`)
    expect(out).toContain("import { useEffect, useState } from 'react'")
  })
})
