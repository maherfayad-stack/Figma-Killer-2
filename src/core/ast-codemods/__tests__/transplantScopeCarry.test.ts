/**
 * G-1a - a cross-file move carries the plain constants and handlers the element
 * reads. Held to the bar `transplantJsxElement.test.ts` sets: both files are
 * asserted whole, byte for byte, and every refusal asserts BOTH files are
 * untouched.
 *
 * The fixtures share nothing with the eSIM corpus: a bakery's order screen and
 * its receipt screen, with the reads that matter - body constants, a handler
 * closing over them, helpers the file keeps private, and the things that must
 * keep refusing (state, props, list rows, components).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { liftJsxElementToCanvasModule, transplantJsxElement } from '../transplantJsxElement'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-scope-carry-'))
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

const RECEIPT = `export default function Receipt() {
  return (
    <main className="receipt">
      <h1>Receipt</h1>
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
  container?: string
  copy?: boolean
}) {
  const element = locateTag(options.originText, options.tag)
  const container = locateTag(options.destinationText ?? RECEIPT, options.container ?? 'main')
  return transplantJsxElement({
    file: options.origin,
    line: element.line,
    col: element.col,
    destinationFile: options.destination,
    destinationLine: container.line,
    destinationCol: container.col,
    ...(options.copy ? { copy: true } : {}),
  })
}

const ORDER = `import { formatPrice } from './lib/format'

const TAX_RATE = 0.2
const money = (n: number) => formatPrice(n)

export default function Order() {
  const price = 40
  const qty = 3
  const total = price * qty * (1 + TAX_RATE)
  function pay() {
    console.log(money(total))
  }
  return (
    <main className="order">
      <h1>Order</h1>
      <button type="button" onClick={pay}>
        Pay {money(total)}
      </button>
    </main>
  )
}
`

describe('G-1a - a move copies the plain constants and handlers the element reads', () => {
  it('copies a const chain, the handler closing over it, and the private helpers they use', () => {
    const origin = writeFixture('Order.tsx', ORDER)
    const destination = writeFixture('Receipt.tsx', RECEIPT)

    const result = transplant({ origin, originText: ORDER, tag: 'button', destination })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.carriedDeclarations).toEqual([
      { name: 'money', as: 'money', scope: 'module', reused: false, how: 'copy' },
      { name: 'TAX_RATE', as: 'TAX_RATE', scope: 'module', reused: false, how: 'copy' },
      { name: 'price', as: 'price', scope: 'body', reused: false, how: 'copy' },
      { name: 'qty', as: 'qty', scope: 'body', reused: false, how: 'copy' },
      { name: 'total', as: 'total', scope: 'body', reused: false, how: 'copy' },
      { name: 'pay', as: 'pay', scope: 'body', reused: false, how: 'copy' },
    ])
    // The origin loses the element and nothing else: its constants stay (the
    // heading still renders, and unused-local cleanup is the user's call).
    expect(read(origin)).toBe(ORDER.replace(
      `      <button type="button" onClick={pay}>
        Pay {money(total)}
      </button>
`,
      '',
    ))
    // Dependencies first: the private helper and the rate at module scope, then
    // the constants in dependency order, then the handler - all before the
    // statement that holds the container.
    expect(read(destination)).toBe(`import { formatPrice } from './lib/format'
const money = (n: number) => formatPrice(n)

const TAX_RATE = 0.2

export default function Receipt() {
  const price = 40
  const qty = 3
  const total = price * qty * (1 + TAX_RATE)
  function pay() {
    console.log(money(total))
  }
  return (
    <main className="receipt">
      <h1>Receipt</h1>
      <button type="button" onClick={pay}>
        Pay {money(total)}
      </button>
    </main>
  )
}
`)
  })

  it('an Alt-copy carries the same declarations and leaves the origin byte for byte', () => {
    const origin = writeFixture('Order.tsx', ORDER)
    const destination = writeFixture('Receipt.tsx', RECEIPT)

    const result = transplant({ origin, originText: ORDER, tag: 'button', destination, copy: true })

    expect(result.ok).toBe(true)
    expect(read(origin)).toBe(ORDER)
    expect(read(destination)).toContain('const total = price * qty * (1 + TAX_RATE)')
    expect(read(destination)).toContain('const TAX_RATE = 0.2')
  })

  it('reports the created element where the re-parsed destination has it', () => {
    const origin = writeFixture('Order.tsx', ORDER)
    const destination = writeFixture('Receipt.tsx', RECEIPT)

    const result = transplant({ origin, originText: ORDER, tag: 'button', destination })

    expect(result.ok).toBe(true)
    if (!result.ok || !result.created) throw new Error('unreachable')
    const lines = read(destination).split('\n')
    expect(lines[result.created.line - 1]!.slice(result.created.col - 1)).toStartWith('button')
  })

  it('gives a clashing name a free one and re-points every read of it', () => {
    const origin = writeFixture('Order.tsx', ORDER)
    const destinationText = `export default function Receipt() {
  const total = 'not the same thing'
  return (
    <main className="receipt">
      <h1>{total}</h1>
    </main>
  )
}
`
    const destination = writeFixture('Receipt.tsx', destinationText)

    const result = transplant({ origin, originText: ORDER, tag: 'button', destination, destinationText })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.carriedDeclarations).toContainEqual({ name: 'total', as: 'total2', scope: 'body', reused: false, how: 'copy' })
    const written = read(destination)
    // The destination's own `total` keeps meaning what it meant.
    expect(written).toContain("const total = 'not the same thing'")
    expect(written).toContain('<h1>{total}</h1>')
    // The copy is renamed everywhere it is read: declaration, handler, markup.
    expect(written).toContain('const total2 = price * qty * (1 + TAX_RATE)')
    expect(written).toContain('console.log(money(total2))')
    expect(written).toContain('Pay {money(total2)}')
  })

  it('writes nothing twice when the destination already declares the identical constant', () => {
    const originText = `export default function Order() {
  const greeting = 'Welcome back'
  return (
    <main>
      <p>{greeting}</p>
    </main>
  )
}
`
    const origin = writeFixture('Order.tsx', originText)
    const destinationText = `export default function Receipt() {
  const greeting = 'Welcome back'
  return (
    <main className="receipt">
      <h1>{greeting}</h1>
    </main>
  )
}
`
    const destination = writeFixture('Receipt.tsx', destinationText)

    const result = transplant({ origin, originText, tag: 'p', destination, destinationText })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.carriedDeclarations).toEqual([{ name: 'greeting', as: 'greeting', scope: 'body', reused: true, how: 'copy' }])
    const written = read(destination)
    expect(written.match(/const greeting/g)).toHaveLength(1)
    expect(written).toContain('<p>{greeting}</p>')
  })

  it('re-establishes a context hook BEFORE a copied constant that reads it', () => {
    const originText = `import { useCurrency } from './lib/useCurrency'

export default function Order() {
  const { symbol } = useCurrency()
  const label = symbol + '40'
  return (
    <main>
      <p>{label}</p>
    </main>
  )
}
`
    writeFixture('lib/useCurrency.tsx', `import { createContext, useContext } from 'react'
const CurrencyContext = createContext({ symbol: '$' })
export function useCurrency() {
  return useContext(CurrencyContext)
}
`)
    const origin = writeFixture('Order.tsx', originText)
    const destination = writeFixture('Receipt.tsx', RECEIPT)

    const result = transplant({ origin, originText, tag: 'p', destination })

    expect(result.ok).toBe(true)
    const written = read(destination)
    expect(written.indexOf('useCurrency()')).toBeGreaterThan(-1)
    expect(written.indexOf('useCurrency()')).toBeLessThan(written.indexOf("const label = symbol + '40'"))
    expect(written).toContain('<p>{label}</p>')
  })

  it('copies a private module-level constant into the destination instead of demanding an export', () => {
    const originText = `const SIZES = ['S', 'M', 'L']

export default function Order() {
  return (
    <main>
      <ul>
        {SIZES.map((size) => (
          <li key={size}>{size}</li>
        ))}
      </ul>
    </main>
  )
}
`
    const origin = writeFixture('Order.tsx', originText)
    const destination = writeFixture('Receipt.tsx', RECEIPT)

    const result = transplant({ origin, originText, tag: 'ul', destination })

    expect(result.ok).toBe(true)
    expect(read(destination)).toBe(`const SIZES = ['S', 'M', 'L']

export default function Receipt() {
  return (
    <main className="receipt">
      <h1>Receipt</h1>
      <ul>
        {SIZES.map((size) => (
          <li key={size}>{size}</li>
        ))}
      </ul>
    </main>
  )
}
`)
    // Nothing was exported from the origin: the move edits it in one place.
    expect(read(origin)).not.toContain('export const')
  })

  it('does not duplicate a private helper the destination already declares identically', () => {
    const originText = `const SIZES = ['S', 'M', 'L']

export default function Order() {
  return (
    <main>
      <p>{SIZES.length}</p>
    </main>
  )
}
`
    const origin = writeFixture('Order.tsx', originText)
    const destinationText = `const SIZES = ['S', 'M', 'L']

export default function Receipt() {
  return (
    <main className="receipt">
      <h1>Receipt</h1>
    </main>
  )
}
`
    const destination = writeFixture('Receipt.tsx', destinationText)

    const result = transplant({ origin, originText, tag: 'p', destination, destinationText })

    expect(result.ok).toBe(true)
    expect(read(destination).match(/const SIZES/g)).toHaveLength(1)
  })

  it('lifts an element onto the canvas with its constants and handlers in the new module', () => {
    const origin = writeFixture('pages/Order.tsx', ORDER)
    const element = locateTag(ORDER, 'button')
    const moduleFile = path.join(tmpDir, '.studio', 'canvas', 'cl0123456789.tsx')
    let moduleText = ''

    const result = liftJsxElementToCanvasModule({
      file: origin,
      line: element.line,
      col: element.col,
      moduleFile,
      writeModule: (text) => {
        moduleText = text
      },
    })

    expect(result.ok).toBe(true)
    expect(moduleText).toContain('const money = (n: number) => formatPrice(n)')
    expect(moduleText).toContain('const TAX_RATE = 0.2')
    expect(moduleText.indexOf('const money')).toBeLessThan(moduleText.indexOf('export default function'))
    expect(moduleText).toContain('  const total = price * qty * (1 + TAX_RATE)\n')
    expect(moduleText).toContain('  function pay() {\n    console.log(money(total))\n  }\n')
    expect(moduleText).toContain('onClick={pay}')
  })
})

describe('G-1a - what cannot be carried still refuses by name and writes neither file', () => {
  // State and refs are no longer on this list: G-1b copies them (transplantStateCarry.test.ts).
  function expectRefusal(
    originText: string,
    tag: string,
    reason: 'captured-scope' | 'unexported-binding',
    mentions: string,
    destinationText = RECEIPT,
  ): void {
    const origin = writeFixture('Order.tsx', originText)
    const destination = writeFixture('Receipt.tsx', destinationText)

    const result = transplant({ origin, originText, tag, destination, destinationText })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe(reason)
    expect(result.refusal.message).toContain(mentions)
    expect(read(origin)).toBe(originText)
    expect(read(destination)).toBe(destinationText)
  }

  it('a constant computed from a prop refuses, naming the prop', () => {
    expectRefusal(
      `export default function Order({ qty }: { qty: number }) {
  const label = qty + ' items'
  return (
    <main>
      <p>{label}</p>
    </main>
  )
}
`,
      'p',
      'captured-scope',
      '"qty"',
    )
  })

  it('a reassignable binding (let) refuses', () => {
    expectRefusal(
      `export default function Order() {
  let draft = 'a'
  return (
    <main>
      <p>{draft}</p>
    </main>
  )
}
`,
      'p',
      'captured-scope',
      '"draft"',
    )
  })

  it('a .map row value refuses', () => {
    expectRefusal(
      `export default function Order({ rows }: { rows: string[] }) {
  return (
    <main>
      {rows.map((row) => (
        <li key={row}>
          <span>{row}</span>
        </li>
      ))}
    </main>
  )
}
`,
      'span',
      'captured-scope',
      '"row"',
    )
  })

  it('a private COMPONENT is not copied - two copies would be two components', () => {
    expectRefusal(
      `function Sticker() {
  return <b>new</b>
}

export default function Order() {
  return (
    <main>
      <Sticker />
    </main>
  )
}
`,
      'Sticker',
      'unexported-binding',
      '"Sticker"',
    )
  })

  it('a private helper that reads a prop-bound value stays refused through the helper', () => {
    expectRefusal(
      `export default function Order({ currency }: { currency: string }) {
  const show = (n: number) => n + currency
  return (
    <main>
      <p>{show(4)}</p>
    </main>
  )
}
`,
      'p',
      'captured-scope',
      '"currency"',
    )
  })

  it('a destination without a component body has nowhere to put a copied constant', () => {
    const originText = `export default function Order() {
  const greeting = 'Hi'
  return (
    <main>
      <p>{greeting}</p>
    </main>
  )
}
`
    expectRefusal(
      originText,
      'p',
      'captured-scope',
      '"greeting"',
      `const Receipt = () => (
  <main className="receipt">
    <h1>Receipt</h1>
  </main>
)

export default Receipt
`,
    )
  })
})
