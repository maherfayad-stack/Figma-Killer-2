/**
 * G-1b - a cross-file move gives the element its own copy of the state it uses
 * (owner decision OD-17). Held to the bar `transplantScopeCarry.test.ts` sets:
 * both files are asserted whole, byte for byte, and every refusal asserts BOTH
 * files are untouched.
 *
 * The fixtures share nothing with the eSIM corpus: a bike-rental fleet screen
 * and its booking screen. What matters is the shape of the state - a tuple with
 * its handler, only the setter, a reducer with a module-level reducer, a typed
 * ref - and what must keep refusing by name: a custom hook, a `useCallback`, a
 * destination a hook cannot be written into.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Project, ts } from 'ts-morph'
import { transplantJsxElement } from '../transplantJsxElement'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-state-carry-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(name: string, source: string): string {
  const filePath = path.join(tmpDir, name)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, source, 'utf8')
  return filePath
}

const read = (file: string): string => fs.readFileSync(file, 'utf8')

/** Every name and relative import in the written files must resolve - "Cannot find name" is the regression this guards. */
function nameErrors(files: string[]): string[] {
  const project = new Project({
    compilerOptions: { jsx: ts.JsxEmit.Preserve, noImplicitAny: false, strict: false, skipLibCheck: true },
    skipAddingFilesFromTsConfig: true,
  })
  for (const file of files) project.addSourceFileAtPath(file)
  return project
    .getPreEmitDiagnostics()
    .filter((d) => [2304, 2305, 2307, 2552, 2724].includes(d.getCode()))
    .map((d) => ts.flattenDiagnosticMessageText(d.getMessageText() as string, '\n'))
    .filter((message) => !message.includes("module 'react'"))
}

const BOOKING = `export default function Booking() {
  return (
    <main className="booking">
      <h1>Booking</h1>
    </main>
  )
}
`

function transplant(options: {
  origin: string
  originText: string
  tag: string
  destination: string
  destinationText?: string
  copy?: boolean
  propDefaults?: boolean
}) {
  const element = locateTag(options.originText, options.tag)
  const container = locateTag(options.destinationText ?? BOOKING, 'main')
  return transplantJsxElement({
    file: options.origin,
    line: element.line,
    col: element.col,
    destinationFile: options.destination,
    destinationLine: container.line,
    destinationCol: container.col,
    ...(options.copy ? { copy: true } : {}),
    ...(options.propDefaults ? { propDefaults: true } : {}),
  })
}

const FLEET = `import { useState } from 'react'

export default function Fleet() {
  const [open, setOpen] = useState(false)
  const toggle = () => setOpen(!open)
  return (
    <main className="fleet">
      <h1>Fleet</h1>
      <button type="button" onClick={toggle}>
        {open ? 'Hide rates' : 'Show rates'}
      </button>
    </main>
  )
}
`

function expectRefusal(originText: string, tag: string, mentions: string, destinationText = BOOKING): void {
  const origin = writeFixture('Fleet.tsx', originText)
  const destination = writeFixture('Booking.tsx', destinationText)

  const result = transplant({ origin, originText, tag, destination, destinationText })

  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.refusal.reason).toBe('captured-scope')
  expect(result.refusal.message).toContain(mentions)
  expect(read(origin)).toBe(originText)
  expect(read(destination)).toBe(destinationText)
}

describe('G-1b - useState and the handler that sets it travel together', () => {
  it('copies the tuple and the handler, adds the hook import, and leaves the origin its own state', () => {
    const origin = writeFixture('Fleet.tsx', FLEET)
    const destination = writeFixture('Booking.tsx', BOOKING)

    const result = transplant({ origin, originText: FLEET, tag: 'button', destination })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.carriedDeclarations).toEqual([
      { name: 'open', as: 'open', scope: 'body', reused: false, how: 'state' },
      { name: 'setOpen', as: 'setOpen', scope: 'body', reused: false, how: 'state' },
      { name: 'toggle', as: 'toggle', scope: 'body', reused: false, how: 'copy' },
    ])
    // The origin loses the button and nothing else: its state and handler stay.
    expect(read(origin)).toBe(FLEET.replace(
      `      <button type="button" onClick={toggle}>
        {open ? 'Hide rates' : 'Show rates'}
      </button>
`,
      '',
    ))
    expect(read(destination)).toBe(`import { useState } from 'react'
export default function Booking() {
  const [open, setOpen] = useState(false)
  const toggle = () => setOpen(!open)
  return (
    <main className="booking">
      <h1>Booking</h1>
      <button type="button" onClick={toggle}>
        {open ? 'Hide rates' : 'Show rates'}
      </button>
    </main>
  )
}
`)
    expect(nameErrors([destination])).toEqual([])
  })

  it('an Alt copy writes the same destination and leaves the origin byte-exact', () => {
    const origin = writeFixture('Fleet.tsx', FLEET)
    const destination = writeFixture('Booking.tsx', BOOKING)

    const result = transplant({ origin, originText: FLEET, tag: 'button', destination, copy: true })

    expect(result.ok).toBe(true)
    expect(read(origin)).toBe(FLEET)
    expect(read(destination)).toContain('const [open, setOpen] = useState(false)')
  })

  it('writes only the slot the element reads: a setter alone is `[, setOpen]`', () => {
    const originText = `import { useState } from 'react'

export default function Fleet() {
  const [open, setOpen] = useState(false)
  return (
    <main>
      <p>{open ? 'yes' : 'no'}</p>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
    </main>
  )
}
`
    const origin = writeFixture('Fleet.tsx', originText)
    const destination = writeFixture('Booking.tsx', BOOKING)

    const result = transplant({ origin, originText, tag: 'button', destination })

    expect(result.ok).toBe(true)
    expect(read(destination)).toBe(`import { useState } from 'react'
export default function Booking() {
  const [, setOpen] = useState(false)
  return (
    <main className="booking">
      <h1>Booking</h1>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
    </main>
  )
}
`)
  })

  it('writes only the value when only the value is read: `[open]`', () => {
    const originText = `import { useState } from 'react'

export default function Fleet() {
  const [open, setOpen] = useState(true)
  return (
    <main>
      <button type="button" onClick={() => setOpen(false)}>
        Close
      </button>
      <p>{open ? 'yes' : 'no'}</p>
    </main>
  )
}
`
    const origin = writeFixture('Fleet.tsx', originText)
    const destination = writeFixture('Booking.tsx', BOOKING)

    const result = transplant({ origin, originText, tag: 'p', destination })

    expect(result.ok).toBe(true)
    expect(read(destination)).toContain('  const [open] = useState(true)\n')
    expect(read(destination)).not.toContain('setOpen')
  })

  it('keeps the spelling the origin used: a generic, and React.useState off a namespace import', () => {
    const originText = `import * as React from 'react'

export default function Fleet() {
  const [picked, setPicked] = React.useState<string | null>(null)
  return (
    <main>
      <button type="button" onClick={() => setPicked('b1')}>
        {picked ?? 'Pick'}
      </button>
    </main>
  )
}
`
    const origin = writeFixture('Fleet.tsx', originText)
    const destination = writeFixture('Booking.tsx', BOOKING)

    const result = transplant({ origin, originText, tag: 'button', destination })

    expect(result.ok).toBe(true)
    expect(read(destination)).toBe(`import * as React from 'react'
export default function Booking() {
  const [picked, setPicked] = React.useState<string | null>(null)
  return (
    <main className="booking">
      <h1>Booking</h1>
      <button type="button" onClick={() => setPicked('b1')}>
        {picked ?? 'Pick'}
      </button>
    </main>
  )
}
`)
  })
})

describe('G-1b - a name the destination already uses gets a free one, everywhere it is read', () => {
  it('renames the slots, the handler that reads them and the markup - and reuses the destination hook import', () => {
    const destinationText = `import { useState } from 'react'

export default function Booking() {
  const [open, setOpen] = useState(true)
  return (
    <main className="booking" data-open={open}>
      <h1 onClick={() => setOpen(!open)}>Booking</h1>
    </main>
  )
}
`
    const origin = writeFixture('Fleet.tsx', FLEET)
    const destination = writeFixture('Booking.tsx', destinationText)

    const result = transplant({ origin, originText: FLEET, tag: 'button', destination, destinationText })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // The destination's own `open` stays the destination's own: an identical
    // `useState(...)` there is a DIFFERENT state, never reused.
    expect(result.carriedDeclarations).toEqual([
      { name: 'open', as: 'open2', scope: 'body', reused: false, how: 'state' },
      { name: 'setOpen', as: 'setOpen2', scope: 'body', reused: false, how: 'state' },
      { name: 'toggle', as: 'toggle', scope: 'body', reused: false, how: 'copy' },
    ])
    expect(read(destination)).toBe(`import { useState } from 'react'

export default function Booking() {
  const [open, setOpen] = useState(true)
  const [open2, setOpen2] = useState(false)
  const toggle = () => setOpen2(!open2)
  return (
    <main className="booking" data-open={open}>
      <h1 onClick={() => setOpen(!open)}>Booking</h1>
      <button type="button" onClick={toggle}>
        {open2 ? 'Hide rates' : 'Show rates'}
      </button>
    </main>
  )
}
`)
    expect(nameErrors([destination])).toEqual([])
  })
})

describe('G-1b - useReducer and useRef', () => {
  it('copies a reducer with its module-level function and initial value', () => {
    const originText = `import { useReducer } from 'react'

type Action = { type: 'add' } | { type: 'drop' }

function tally(count: number, action: Action): number {
  return action.type === 'add' ? count + 1 : count - 1
}

export default function Fleet() {
  const [count, dispatch] = useReducer(tally, 0)
  return (
    <main>
      <button type="button" onClick={() => dispatch({ type: 'add' })}>
        Add {count}
      </button>
    </main>
  )
}
`
    const origin = writeFixture('Fleet.tsx', originText)
    const destination = writeFixture('Booking.tsx', BOOKING)

    const result = transplant({ origin, originText, tag: 'button', destination })

    expect(result.ok).toBe(true)
    // The `Action` type the reducer is annotated with is copied too: a type has no runtime to share.
    expect(read(destination)).toBe(`import { useReducer } from 'react'
type Action = { type: 'add' } | { type: 'drop' }

function tally(count: number, action: Action): number {
  return action.type === 'add' ? count + 1 : count - 1
}

export default function Booking() {
  const [count, dispatch] = useReducer(tally, 0)
  return (
    <main className="booking">
      <h1>Booking</h1>
      <button type="button" onClick={() => dispatch({ type: 'add' })}>
        Add {count}
      </button>
    </main>
  )
}
`)
    expect(nameErrors([destination])).toEqual([])
  })

  it('copies a typed ref, with the import', () => {
    const originText = `import { useRef } from 'react'

export default function Fleet() {
  const field = useRef<HTMLInputElement>(null)
  return (
    <main>
      <input ref={field} placeholder="Rider name" />
    </main>
  )
}
`
    const origin = writeFixture('Fleet.tsx', originText)
    const destination = writeFixture('Booking.tsx', BOOKING)

    const result = transplant({ origin, originText, tag: 'input', destination })

    expect(result.ok).toBe(true)
    expect(read(destination)).toBe(`import { useRef } from 'react'
export default function Booking() {
  const field = useRef<HTMLInputElement>(null)
  return (
    <main className="booking">
      <h1>Booking</h1>
      <input ref={field} placeholder="Rider name" />
    </main>
  )
}
`)
  })

  it('copies a state the initializer of another state reads, dependencies first', () => {
    const originText = `import { useState } from 'react'

export default function Fleet() {
  const [seats, setSeats] = useState(2)
  const [bikes, setBikes] = useState(seats * 2)
  return (
    <main>
      <button type="button" onClick={() => { setSeats(seats + 1); setBikes(bikes + 2) }}>
        {bikes}
      </button>
    </main>
  )
}
`
    const origin = writeFixture('Fleet.tsx', originText)
    const destination = writeFixture('Booking.tsx', BOOKING)

    const result = transplant({ origin, originText, tag: 'button', destination })

    expect(result.ok).toBe(true)
    const written = read(destination)
    expect(written.indexOf('const [seats, setSeats] = useState(2)')).toBeGreaterThan(-1)
    expect(written.indexOf('const [seats, setSeats] = useState(2)')).toBeLessThan(
      written.indexOf('const [bikes, setBikes] = useState(seats * 2)'),
    )
    expect(nameErrors([destination])).toEqual([])
  })

  it('an initializer reading a module constant carries the constant with it', () => {
    const originText = `import { useState } from 'react'

const DEFAULT_SEATS = 4

export default function Fleet() {
  const [seats, setSeats] = useState(DEFAULT_SEATS)
  return (
    <main>
      <button type="button" onClick={() => setSeats(seats + 1)}>
        {seats} seats
      </button>
    </main>
  )
}
`
    const origin = writeFixture('Fleet.tsx', originText)
    const destination = writeFixture('Booking.tsx', BOOKING)

    const result = transplant({ origin, originText, tag: 'button', destination })

    expect(result.ok).toBe(true)
    const written = read(destination)
    expect(written).toContain('const DEFAULT_SEATS = 4\n')
    expect(written).toContain('  const [seats, setSeats] = useState(DEFAULT_SEATS)\n')
    expect(nameErrors([destination])).toEqual([])
  })
})

describe('G-1b - where a hook may be written', () => {
  it('writes the copy above an early return of the destination, never after it', () => {
    const destinationText = `export default function Booking({ loading }: { loading: boolean }) {
  if (loading) return null
  return (
    <main className="booking">
      <h1>Booking</h1>
    </main>
  )
}
`
    const origin = writeFixture('Fleet.tsx', FLEET)
    const destination = writeFixture('Booking.tsx', destinationText)

    const result = transplant({ origin, originText: FLEET, tag: 'button', destination, destinationText })

    expect(result.ok).toBe(true)
    expect(read(destination)).toBe(`import { useState } from 'react'
export default function Booking({ loading }: { loading: boolean }) {
  const [open, setOpen] = useState(false)
  const toggle = () => setOpen(!open)
  if (loading) return null
  return (
    <main className="booking">
      <h1>Booking</h1>
      <button type="button" onClick={toggle}>
        {open ? 'Hide rates' : 'Show rates'}
      </button>
    </main>
  )
}
`)
  })

  it('refuses an async destination component, and says why', () => {
    expectRefusal(
      FLEET,
      'button',
      'async component',
      `export default async function Booking() {
  return (
    <main className="booking">
      <h1>Booking</h1>
    </main>
  )
}
`,
    )
  })

  it("refuses a 'use client' element going into a server component, and says why", () => {
    const originText = `'use client'
${FLEET}`
    expectRefusal(originText, 'button', "server component")
  })

  it("lets a 'use client' element into another 'use client' file", () => {
    const originText = `'use client'
${FLEET}`
    const destinationText = `'use client'
${BOOKING}`
    const origin = writeFixture('Fleet.tsx', originText)
    const destination = writeFixture('Booking.tsx', destinationText)

    const result = transplant({ origin, originText, tag: 'button', destination, destinationText })

    expect(result.ok).toBe(true)
    expect(read(destination).startsWith("'use client'\n")).toBe(true)
  })

  it('refuses a destination with no component body, naming the state', () => {
    expectRefusal(
      FLEET,
      'button',
      '"open"',
      `const Booking = () => (
  <main className="booking">
    <h1>Booking</h1>
  </main>
)

export default Booking
`,
    )
  })
})

describe('G-1b - what Studio cannot copy honestly still refuses, by name', () => {
  it('a custom hook result names the hook', () => {
    expectRefusal(
      `import { useToggle } from '../lib/useToggle'

export default function Fleet() {
  const [open, toggle] = useToggle(false)
  return (
    <main>
      <button type="button" onClick={toggle}>
        {open ? 'Hide' : 'Show'}
      </button>
    </main>
  )
}
`,
      'button',
      'useToggle()',
    )
  })

  it('a useCallback handler names useCallback', () => {
    expectRefusal(
      `import { useCallback, useState } from 'react'

export default function Fleet() {
  const [open, setOpen] = useState(false)
  const toggle = useCallback(() => setOpen((value) => !value), [])
  return (
    <main>
      <button type="button" onClick={toggle}>
        {open ? 'Hide' : 'Show'}
      </button>
    </main>
  )
}
`,
      'button',
      'useCallback()',
    )
  })

  it('a state initialised from a prop refuses naming the prop - until the prop has a default to bake', () => {
    const originText = `import { useState } from 'react'

export default function Fleet({ seats = 3 }: { seats?: number }) {
  const [count, setCount] = useState(seats)
  return (
    <main>
      <button type="button" onClick={() => setCount(count + 1)}>
        {count}
      </button>
    </main>
  )
}
`
    expectRefusal(originText, 'button', '"seats" (a prop)')

    const origin = writeFixture('Fleet.tsx', originText)
    const destination = writeFixture('Booking.tsx', BOOKING)
    const result = transplant({ origin, originText, tag: 'button', destination, propDefaults: true })
    expect(result.ok).toBe(true)
    expect(read(destination)).toBe(`import { useState } from 'react'
export default function Booking() {
  const seats = 3
  const [count, setCount] = useState(seats)
  return (
    <main className="booking">
      <h1>Booking</h1>
      <button type="button" onClick={() => setCount(count + 1)}>
        {count}
      </button>
    </main>
  )
}
`)
  })

  it('copies the declaration only: an effect that sets the state in the origin stays there, so the copy starts from its initial value', () => {
    const originText = `import { useEffect, useState } from 'react'

export default function Fleet() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    setOpen(true)
  }, [])
  return (
    <main>
      <p>{open ? 'yes' : 'no'}</p>
    </main>
  )
}
`
    const origin = writeFixture('Fleet.tsx', originText)
    const destination = writeFixture('Booking.tsx', BOOKING)

    const result = transplant({ origin, originText, tag: 'p', destination })

    expect(result.ok).toBe(true)
    expect(read(destination)).toContain('const [open] = useState(false)')
    expect(read(destination)).not.toContain('useEffect')
  })
})
