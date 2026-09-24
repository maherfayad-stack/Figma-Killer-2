/**
 * P3-B — the component codemods (detach, duplicate-as-new-file) against the
 * shapes P3-B taught the parser to read: `memo(…)`, `forwardRef(…)`, a default
 * export re-exported through a barrel, and a namespace member tag.
 *
 * The brief's rule for each: detach must still WORK on a shape it can honestly
 * inline, and otherwise REFUSE with every file byte-identical. A detach of a
 * `memo` component inlines the function `memo` wraps — `memo` changes nothing
 * about what renders, so the inlined markup renders exactly what the instance
 * did. A namespace member (`<UI.Chip/>`) is refused: the codemods rewrite and
 * de-import the tag's ROOT identifier, which here is the whole namespace.
 *
 * Fixture: a small weather app, sharing nothing with the eSIM corpus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { detachComponentInstance } from '../detachComponent'
import { extractComponentCopy } from '../extractComponentCopy'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapped-codemods-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, lines: readonly string[]): string {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, `${lines.join('\n')}\n`, 'utf8')
  return full
}

function read(relPath: string): string {
  return fs.readFileSync(path.join(tmpDir, ...relPath.split('/')), 'utf8')
}

function snapshotWorkspace(): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.set(full, fs.readFileSync(full, 'latin1'))
    }
  }
  walk(tmpDir)
  return out
}

function at(pageRel: string, tag: string) {
  const file = path.join(tmpDir, ...pageRel.split('/'))
  const { line, col } = locateTag(read(pageRel), tag)
  return { file, line, col, workspaceRoot: tmpDir }
}

describe('detach — a memo() component inlines the function memo wraps', () => {
  it('detaches <Forecast/> declared as memo(function Forecast({ city }) …)', () => {
    write('ui/Forecast.tsx', [
      "import { memo } from 'react'",
      'export const Forecast = memo(function Forecast({ city }: { city: string }) {',
      '  return <section className="forecast"><h2>{city}</h2></section>',
      '})',
    ])
    write('pages/Today.tsx', [
      "import { Forecast } from '../ui/Forecast'",
      'export default function Today() {',
      '  return (',
      '    <main>',
      '      <Forecast city="Oslo" />',
      '    </main>',
      '  )',
      '}',
    ])
    const result = detachComponentInstance(at('pages/Today.tsx', 'Forecast'))
    expect(result.ok).toBe(true)
    const page = read('pages/Today.tsx')
    expect(page).toContain('<section className="forecast"><h2>Oslo</h2></section>')
    // The component's last usage is gone, so is its import; the component file is untouched.
    expect(page).not.toContain("from '../ui/Forecast'")
    expect(read('ui/Forecast.tsx')).toContain('memo(function Forecast')
  })

  it('detaches a React.memo(Inner) default export', () => {
    write('ui/Badge.tsx', [
      "import React from 'react'",
      'function BadgeInner() {',
      '  return <em className="badge">Sunny</em>',
      '}',
      'export default React.memo(BadgeInner)',
    ])
    write('pages/Today.tsx', [
      "import Badge from '../ui/Badge'",
      'export default function Today() {',
      '  return (',
      '    <main>',
      '      <Badge />',
      '    </main>',
      '  )',
      '}',
    ])
    const result = detachComponentInstance(at('pages/Today.tsx', 'Badge'))
    expect(result.ok).toBe(true)
    expect(read('pages/Today.tsx')).toContain('<em className="badge">Sunny</em>')
  })
})

describe('detach — refusals leave every file byte-identical', () => {
  it('refuses a forwardRef component whose markup reads its ref', () => {
    write('ui/CityInput.tsx', [
      "import { forwardRef } from 'react'",
      'export const CityInput = forwardRef<HTMLInputElement, { hint: string }>(({ hint }, ref) => (',
      '  <input ref={ref} placeholder={hint} />',
      '))',
    ])
    write('pages/Today.tsx', [
      "import { CityInput } from '../ui/CityInput'",
      'export default function Today() {',
      '  return (',
      '    <main>',
      '      <CityInput hint="City" />',
      '    </main>',
      '  )',
      '}',
    ])
    const before = snapshotWorkspace()
    const result = detachComponentInstance(at('pages/Today.tsx', 'CityInput'))
    expect(result.ok).toBe(false)
    expect(snapshotWorkspace()).toEqual(before)
  })

  it('refuses a namespace member tag', () => {
    write('ui/Chip.tsx', ['export function Chip() {', '  return <small>Windy</small>', '}'])
    write('ui/index.ts', ["export { Chip } from './Chip'"])
    write('pages/Today.tsx', [
      "import * as UI from '../ui'",
      'export default function Today() {',
      '  return (',
      '    <main>',
      '      <UI.Chip />',
      '    </main>',
      '  )',
      '}',
    ])
    const before = snapshotWorkspace()
    const result = detachComponentInstance(at('pages/Today.tsx', 'UI.Chip'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('unresolvable')
    expect(snapshotWorkspace()).toEqual(before)
  })
})

describe('duplicate as a new file — a default-exported component keeps a default import', () => {
  it('repoints a call site reached through `export { default as X }` with a DEFAULT import of the copy', () => {
    write('ui/Gauge.tsx', ['const Gauge = () => <meter value={0.4} />', 'export default Gauge'])
    write('ui/index.ts', ["export { default as Gauge } from './Gauge'"])
    write('pages/Today.tsx', [
      "import { Gauge } from '../ui'",
      'export default function Today() {',
      '  return (',
      '    <main>',
      '      <Gauge />',
      '    </main>',
      '  )',
      '}',
    ])
    const result = extractComponentCopy(at('pages/Today.tsx', 'Gauge'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.newComponentName).toBe('Gauge2')
    const page = read('pages/Today.tsx')
    // A named import of a default export binds nothing; the copy is still its file's default export.
    expect(page).toContain("import Gauge2 from '../ui/Gauge2'")
    expect(page).toContain('<Gauge2 />')
    expect(read('ui/Gauge2.tsx')).toContain('export default Gauge2')
  })

  it('keeps a named import for a named memo() export', () => {
    write('ui/Forecast.tsx', [
      "import { memo } from 'react'",
      'export const Forecast = memo(function Forecast() {',
      '  return <p>Rain</p>',
      '})',
    ])
    write('pages/Today.tsx', [
      "import { Forecast } from '../ui/Forecast'",
      'export default function Today() {',
      '  return (',
      '    <main>',
      '      <Forecast />',
      '    </main>',
      '  )',
      '}',
    ])
    const result = extractComponentCopy(at('pages/Today.tsx', 'Forecast'))
    expect(result.ok).toBe(true)
    expect(read('pages/Today.tsx')).toContain("import { Forecast2 } from '../ui/Forecast2'")
    expect(read('ui/Forecast2.tsx')).toContain('export const Forecast2 = memo(')
  })
})
