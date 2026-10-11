/**
 * G-1c - a cross-file move carries the values the element reads from the
 * `.map` row it sits in and from its component's props, as `const name =
 * <literal>` at the destination. The values are read off the SOURCE TEXT (the
 * array element, the parameter's default) - never evaluated and never taken from
 * the browser - and a row is COPIED: the template and the array stay byte-exact.
 *
 * Held to the bar the sibling G-1 suites set: both files whole, byte for byte;
 * every refusal leaves both untouched. The fixtures share nothing with the eSIM
 * corpus: a trail-running club's race list and its sign-up screen.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Project, ts } from 'ts-morph'
import { transplantJsxElement, type TransplantJsxElementParams } from '../transplantJsxElement'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-prop-bake-'))
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

/** 1-based line/col of the first `needle` in `source`, shifted `shift` characters right. */
function locateText(source: string, needle: string, shift = 0): { line: number; col: number } {
  const at = source.indexOf(needle)
  if (at === -1) throw new Error(`locateText: ${needle} not found`)
  const before = source.slice(0, at + shift)
  const lines = before.split('\n')
  return { line: lines.length, col: lines[lines.length - 1]!.length + 1 }
}

const SIGNUP = `export default function SignUp() {
  return (
    <main className="signup">
      <h1>Sign up</h1>
    </main>
  )
}
`

function transplant(options: {
  origin: string
  originText: string
  tag: string
  occurrence?: number
  destination: string
  destinationText?: string
  row?: TransplantJsxElementParams['row']
  propDefaults?: boolean
}) {
  const element = locateTag(options.originText, options.tag, options.occurrence)
  const container = locateTag(options.destinationText ?? SIGNUP, 'main')
  return transplantJsxElement({
    file: options.origin,
    line: element.line,
    col: element.col,
    destinationFile: options.destination,
    destinationLine: container.line,
    destinationCol: container.col,
    ...(options.row ? { row: options.row } : {}),
    ...(options.propDefaults ? { propDefaults: true } : {}),
  })
}

const RACES = `import { Flag } from './Flag'

const RACES = [
  { id: 'fell', name: 'Fell Run', km: 21, icon: Flag },
  { id: 'ridge', name: 'Ridge Ultra', km: 50, icon: Flag },
  { id: 'dash', name: 'Valley Dash', km: 10, icon: Flag },
]

export default function Races() {
  return (
    <main className="races">
      <h1>Races</h1>
      <ul>
        {RACES.map((race, position) => (
          <li key={race.id}>
            <span>
              {position + 1}. {race.name}
            </span>
            <race.icon />
          </li>
        ))}
      </ul>
    </main>
  )
}
`

const FLAG = `export function Flag() {
  return <i>flag</i>
}
`

function racesRow(index: number) {
  const array = locateText(RACES, 'RACES = [', 'RACES = '.length)
  return { arrayLine: array.line, arrayCol: array.col, index, length: 3 }
}

describe('G-1c - an element of a .map row becomes a copy of that row', () => {
  it('writes the row item and index as constants at the destination and leaves the template and the array byte-exact', () => {
    const origin = writeFixture('Races.tsx', RACES)
    writeFixture('Flag.tsx', FLAG)
    const destination = writeFixture('SignUp.tsx', SIGNUP)

    const result = transplant({ origin, originText: RACES, tag: 'span', destination, row: racesRow(1) })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.carriedDeclarations).toEqual([
      { name: 'position', as: 'position', scope: 'body', reused: false, how: 'value' },
      { name: 'race', as: 'race', scope: 'body', reused: false, how: 'value' },
    ])
    expect(read(origin)).toBe(RACES)
    expect(read(destination)).toBe(`export default function SignUp() {
  const position = 1
  const race = { id: 'ridge', name: 'Ridge Ultra', km: 50, icon: Flag }
  return (
    <main className="signup">
      <h1>Sign up</h1>
      <span>
        {position + 1}. {race.name}
      </span>
    </main>
  )
}
`.replace('export default', "import { Flag } from './Flag'\nexport default"))
    expect(nameErrors([destination])).toEqual([])
  })

  it('copies a whole row root the same way, keeping its key and the component it renders', () => {
    const origin = writeFixture('Races.tsx', RACES)
    writeFixture('Flag.tsx', FLAG)
    const destination = writeFixture('SignUp.tsx', SIGNUP)

    const result = transplant({ origin, originText: RACES, tag: 'li', destination, row: racesRow(2) })

    expect(result.ok).toBe(true)
    expect(read(origin)).toBe(RACES)
    const written = read(destination)
    expect(written).toContain("const race = { id: 'dash', name: 'Valley Dash', km: 10, icon: Flag }")
    expect(written).toContain('const position = 2')
    expect(written).toContain('<li key={race.id}>')
    expect(written).toContain("import { Flag } from './Flag'")
    expect(nameErrors([destination])).toEqual([])
  })

  it('gives a clashing name a free one and re-points the markup', () => {
    const destinationText = `export default function SignUp() {
  const race = 'sprint'
  return (
    <main className="signup">
      <h1>{race}</h1>
    </main>
  )
}
`
    const origin = writeFixture('Races.tsx', RACES)
    writeFixture('Flag.tsx', FLAG)
    const destination = writeFixture('SignUp.tsx', destinationText)

    const result = transplant({ origin, originText: RACES, tag: 'span', destination, destinationText, row: racesRow(0) })

    expect(result.ok).toBe(true)
    const written = read(destination)
    expect(written).toContain("const race = 'sprint'")
    expect(written).toContain("const race2 = { id: 'fell', name: 'Fell Run', km: 21, icon: Flag }")
    expect(written).toContain('{position + 1}. {race2.name}')
    expect(nameErrors([destination])).toEqual([])
  })

  it('reads an array written inside the component, not only at module level', () => {
    const originText = `export default function Races() {
  const legs = ['north', 'south']
  return (
    <main>
      {legs.map((leg) => (
        <p key={leg}>{leg}</p>
      ))}
    </main>
  )
}
`
    const origin = writeFixture('Races.tsx', originText)
    const destination = writeFixture('SignUp.tsx', SIGNUP)
    const array = locateText(originText, 'legs = [', 'legs = '.length)

    const result = transplant({
      origin,
      originText,
      tag: 'p',
      destination,
      row: { arrayLine: array.line, arrayCol: array.col, index: 1, length: 2 },
    })

    expect(result.ok).toBe(true)
    expect(read(origin)).toBe(originText)
    expect(read(destination)).toContain("  const leg = 'south'\n")
  })

  it('refuses when the list is not the one the board named, and writes neither file', () => {
    const origin = writeFixture('Races.tsx', RACES)
    writeFixture('Flag.tsx', FLAG)
    const destination = writeFixture('SignUp.tsx', SIGNUP)

    const result = transplant({ origin, originText: RACES, tag: 'span', destination, row: { ...racesRow(1), length: 4 } })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('stale-source')
    expect(read(origin)).toBe(RACES)
    expect(read(destination)).toBe(SIGNUP)
  })

  it('refuses a row whose array is somewhere else than the one the board named', () => {
    const origin = writeFixture('Races.tsx', RACES)
    writeFixture('Flag.tsx', FLAG)
    const destination = writeFixture('SignUp.tsx', SIGNUP)

    const result = transplant({ origin, originText: RACES, tag: 'span', destination, row: { ...racesRow(1), arrayLine: 1 } })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('stale-source')
    expect(read(origin)).toBe(RACES)
    expect(read(destination)).toBe(SIGNUP)
  })

  it('without a row to read it from, an element that reads its item still refuses by name', () => {
    const origin = writeFixture('Races.tsx', RACES)
    writeFixture('Flag.tsx', FLAG)
    const destination = writeFixture('SignUp.tsx', SIGNUP)

    const result = transplant({ origin, originText: RACES, tag: 'span', destination })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('captured-scope')
    expect(result.refusal.message).toContain('"race" (a list row)')
    expect(read(origin)).toBe(RACES)
    expect(read(destination)).toBe(SIGNUP)
  })

  it('an item that reads something only the component owns refuses through the item', () => {
    const originText = `export default function Races({ units }: { units: string }) {
  const RACES = [{ id: 'a', km: units }]
  return (
    <main>
      {RACES.map((race) => (
        <p key={race.id}>{race.km}</p>
      ))}
    </main>
  )
}
`
    const origin = writeFixture('Races.tsx', originText)
    const destination = writeFixture('SignUp.tsx', SIGNUP)
    const array = locateText(originText, 'RACES = [', 'RACES = '.length)

    const result = transplant({
      origin,
      originText,
      tag: 'p',
      destination,
      row: { arrayLine: array.line, arrayCol: array.col, index: 0, length: 1 },
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('captured-scope')
    expect(result.refusal.message).toContain('"units" (a prop)')
    expect(read(origin)).toBe(originText)
    expect(read(destination)).toBe(SIGNUP)
  })
})

describe('G-1c - a prop with a default is written down as that default', () => {
  const BADGE = `export default function Badge({
  label = 'New',
  count = 3,
  shown = true,
  tags = ['trail', 'road'],
  onPick,
}: {
  label?: string
  count?: number
  shown?: boolean
  tags?: string[]
  onPick?: () => void
}) {
  return (
    <main>
      {shown && <p>{label}: {count} ({tags.join(', ')})</p>}
      <button type="button" onClick={onPick}>
        Pick
      </button>
    </main>
  )
}
`

  it('bakes a string, a number, a boolean and an array default', () => {
    const origin = writeFixture('Badge.tsx', BADGE)
    const destination = writeFixture('SignUp.tsx', SIGNUP)

    const result = transplant({ origin, originText: BADGE, tag: 'p', destination, propDefaults: true })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.carriedDeclarations.map((entry) => `${entry.name}:${entry.how}`)).toEqual([
      'shown:value',
      'label:value',
      'count:value',
      'tags:value',
    ])
    expect(read(destination)).toBe(`export default function SignUp() {
  const shown = true
  const label = 'New'
  const count = 3
  const tags = ['trail', 'road']
  return (
    <main className="signup">
      <h1>Sign up</h1>
      {shown && <p>{label}: {count} ({tags.join(', ')})</p>}
    </main>
  )
}
`)
    expect(read(origin)).toBe(BADGE.replace("      {shown && <p>{label}: {count} ({tags.join(', ')})</p>}\n", ''))
  })

  it('refuses a function prop with no default, by name', () => {
    const origin = writeFixture('Badge.tsx', BADGE)
    const destination = writeFixture('SignUp.tsx', SIGNUP)

    const result = transplant({ origin, originText: BADGE, tag: 'button', destination, propDefaults: true })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.reason).toBe('captured-scope')
    expect(result.refusal.message).toContain('"onPick" (a prop)')
    expect(read(origin)).toBe(BADGE)
    expect(read(destination)).toBe(SIGNUP)
  })

  it('refuses a default that is a function, by name', () => {
    const originText = `export default function Badge({ onPick = () => console.log('hi') }: { onPick?: () => void }) {
  return (
    <main>
      <button type="button" onClick={onPick}>
        Pick
      </button>
    </main>
  )
}
`
    const origin = writeFixture('Badge.tsx', originText)
    const destination = writeFixture('SignUp.tsx', SIGNUP)

    const result = transplant({ origin, originText, tag: 'button', destination, propDefaults: true })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.message).toContain('"onPick" (a function prop)')
    expect(read(destination)).toBe(SIGNUP)
  })

  it('does not read a default at all unless the caller says the element is the page itself', () => {
    const origin = writeFixture('Badge.tsx', BADGE)
    const destination = writeFixture('SignUp.tsx', SIGNUP)

    const result = transplant({ origin, originText: BADGE, tag: 'p', destination })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.refusal.message).toContain('"label" (a prop)')
    expect(read(origin)).toBe(BADGE)
    expect(read(destination)).toBe(SIGNUP)
  })
})
