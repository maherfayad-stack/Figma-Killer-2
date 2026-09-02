/**
 * `insertJsxIntoSlotProp` in `mode: 'replace'` — "choose a DIFFERENT icon".
 *
 * The codemod only ever appended, so a second pick left the first icon
 * beside it in a fragment and the component rendered both. There was no
 * write in the system that swapped a slot's value, which made changing your
 * mind about an icon impossible from the panel.
 *
 * The import cases are the ones worth pinning: swapping one package icon for
 * another must not leave the first one imported and unused, or Studio hands
 * back a file that fails `noUnusedLocals` — and it must not over-reach and
 * strip an import something else in the file still uses.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { insertJsxIntoSlotProp } from '@core/ast-codemods'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slot-replace-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(source: string): string {
  const file = join(dir, 'Page.tsx')
  writeFileSync(file, source, 'utf8')
  return file
}

const CHEVRON = { name: 'ChevronLeftIcon', importSpecifier: '@alm-design/design-system' }

describe('slot replace', () => {
  it('swaps the value instead of appending a second one', () => {
    const file = write(
      [
        "import { Cell, ChevronRightIcon } from '@alm-design/design-system'",
        '',
        'export default function Page() {',
        '  return <Cell label="Wi-Fi" icon={<ChevronRightIcon />} />',
        '}',
        '',
      ].join('\n'),
    )

    const result = insertJsxIntoSlotProp({ file, line: 4, col: 11, propName: 'icon', node: CHEVRON, mode: 'replace' })
    expect(result.ok).toBe(true)

    const written = readFileSync(file, 'utf8')
    expect(written).toContain('icon={<ChevronLeftIcon />}')
    // The old glyph is gone from BOTH the call site and the import — an
    // append would have left a fragment holding the two of them.
    expect(written).not.toContain('ChevronRightIcon')
    expect(written).not.toContain('<>')
    // ...and the package import survives, carrying the two names still used.
    expect(written).toContain("import { Cell, ChevronLeftIcon } from '@alm-design/design-system'")
  })

  it('keeps an import the rest of the file still uses', () => {
    const file = write(
      [
        "import { Cell, ChevronRightIcon } from '@alm-design/design-system'",
        '',
        'export default function Page() {',
        '  return (',
        '    <div>',
        '      <Cell label="Wi-Fi" icon={<ChevronRightIcon />} />',
        '      <Cell label="Bluetooth" icon={<ChevronRightIcon />} />',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const result = insertJsxIntoSlotProp({ file, line: 6, col: 8, propName: 'icon', node: CHEVRON, mode: 'replace' })
    expect(result.ok).toBe(true)

    const written = readFileSync(file, 'utf8')
    // The second call site still references it, so the import stays.
    expect(written).toContain('ChevronRightIcon')
    expect(written).toContain('ChevronLeftIcon')
  })

  it('replaces an inline SVG with a component, dropping nothing that was not imported', () => {
    const file = write(
      [
        "import { Cell } from '@alm-design/design-system'",
        '',
        'export default function Page() {',
        '  return <Cell label="Wi-Fi" icon={<svg viewBox="0 0 24 24"><path d="M0 0" /></svg>} />',
        '}',
        '',
      ].join('\n'),
    )

    const result = insertJsxIntoSlotProp({ file, line: 4, col: 11, propName: 'icon', node: CHEVRON, mode: 'replace' })
    expect(result.ok).toBe(true)

    const written = readFileSync(file, 'utf8')
    expect(written).toContain('icon={<ChevronLeftIcon />}')
    expect(written).not.toContain('<svg')
    expect(written).toContain("import { Cell, ChevronLeftIcon } from '@alm-design/design-system'")
  })

  it('still appends by default, so the existing behaviour is unchanged', () => {
    const file = write(
      [
        "import { Cell, ChevronRightIcon } from '@alm-design/design-system'",
        '',
        'export default function Page() {',
        '  return <Cell label="Wi-Fi" icon={<ChevronRightIcon />} />',
        '}',
        '',
      ].join('\n'),
    )

    expect(insertJsxIntoSlotProp({ file, line: 4, col: 11, propName: 'icon', node: CHEVRON }).ok).toBe(true)

    const written = readFileSync(file, 'utf8')
    expect(written).toContain('ChevronRightIcon')
    expect(written).toContain('ChevronLeftIcon')
    expect(written).toContain('<>')
  })

  it('refuses to overwrite an expression it cannot read', () => {
    const file = write(
      [
        "import { Cell } from '@alm-design/design-system'",
        '',
        'export default function Page({ glyph }) {',
        '  return <Cell label="Wi-Fi" icon={glyph} />',
        '}',
        '',
      ].join('\n'),
    )

    const result = insertJsxIntoSlotProp({ file, line: 4, col: 11, propName: 'icon', node: CHEVRON, mode: 'replace' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('slot-ambiguous')
    // Refused BEFORE any write — the binding is still there.
    expect(readFileSync(file, 'utf8')).toContain('icon={glyph}')
  })

  it('refuses replace on the default slot, where children are real nodes', () => {
    const file = write(
      ["export default function Page() {", '  return <Sheet><span>hi</span></Sheet>', '}', ''].join('\n'),
    )
    const result = insertJsxIntoSlotProp({ file, line: 2, col: 11, propName: 'children', node: CHEVRON, mode: 'replace' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('replace-not-supported')
  })
})
