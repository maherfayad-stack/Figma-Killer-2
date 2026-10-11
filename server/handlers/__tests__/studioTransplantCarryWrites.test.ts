/**
 * G-1b / G-1c through the real save batch: a `transplant` that copies the state
 * an element uses, or a `.map` row's data, is ONE write, reports what it copied
 * (`carried`), and is taken back by the undo journal's `restore` byte for byte
 * in both files.
 *
 * Driven against a temp project on disk with the journal on, exactly as the
 * editor's `/save` route runs a batch. The fixture shares nothing with the eSIM
 * corpus: a climbing gym's route board and its day-pass screen.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { applyStudioEditBatch, type StudioEdit } from '../studioWriteback'
import { locateTag } from '../../../src/core/ast-codemods/__tests__/fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-transplant-carry-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

const read = (relPath: string): string => fs.readFileSync(path.join(tmpDir, ...relPath.split('/')), 'utf8')

const BOARD_REL = 'pages/Board.tsx'
const PASS_REL = 'pages/DayPass.tsx'

const BOARD = `import { useState } from 'react'

const ROUTES = [
  { id: 'r1', grade: '5a', name: 'Slab Warmup' },
  { id: 'r2', grade: '6b', name: 'Overhang Project' },
]

export default function Board() {
  const [favourite, setFavourite] = useState<string | null>(null)
  return (
    <main className="board">
      <h1>Routes</h1>
      <button type="button" onClick={() => setFavourite('r1')}>
        {favourite ?? 'Pick a favourite'}
      </button>
      <ul>
        {ROUTES.map((route) => (
          <li key={route.id}>
            <b>{route.name}</b> {route.grade}
          </li>
        ))}
      </ul>
    </main>
  )
}
`

const PASS = `export default function DayPass() {
  return (
    <main className="pass">
      <h1>Day pass</h1>
    </main>
  )
}
`

function id(rel: string, source: string, tag: string, occurrence = 1): string {
  const { line, col } = locateTag(source, tag, occurrence)
  return `${rel}:${line}:${col}`
}

/** `rel:line:col` of the first `needle` in `source`, shifted `shift` characters right (the array's `[`). */
function idAt(rel: string, source: string, needle: string, shift: number): string {
  const before = source.slice(0, source.indexOf(needle) + shift).split('\n')
  return `${rel}:${before.length}:${before[before.length - 1]!.length + 1}`
}

const batch = (edits: StudioEdit[]) => applyStudioEditBatch(tmpDir, edits, {}, { journal: true })

describe('a transplant that copies state - one write, told, and byte-exactly undone', () => {
  beforeEach(() => {
    write(BOARD_REL, BOARD)
    write(PASS_REL, PASS)
  })

  for (const copy of [false, true]) {
    it(`${copy ? 'an Alt copy' : 'a move'} carries the state, reports it, and one restore puts both files back`, () => {
      const result = batch([
        {
          kind: 'transplant',
          nodeId: id(BOARD_REL, BOARD, 'button'),
          parentNodeId: id(PASS_REL, PASS, 'main'),
          ...(copy ? { copy: true } : {}),
        },
      ])

      expect(result.refusals).toEqual([])
      expect(result.written).toBe(1)
      expect(result.carried).toEqual([
        { name: 'favourite', as: 'favourite', how: 'state' },
        { name: 'setFavourite', as: 'setFavourite', how: 'state' },
      ])
      expect(read(PASS_REL)).toBe(`import { useState } from 'react'
export default function DayPass() {
  const [favourite, setFavourite] = useState<string | null>(null)
  return (
    <main className="pass">
      <h1>Day pass</h1>
      <button type="button" onClick={() => setFavourite('r1')}>
        {favourite ?? 'Pick a favourite'}
      </button>
    </main>
  )
}
`)
      // The origin keeps its state: a move changes only the element's place.
      expect(read(BOARD_REL).includes('useState<string | null>(null)')).toBe(true)
      expect(read(BOARD_REL).includes('<button')).toBe(copy)

      expect(result.undoToken).toBeDefined()
      const undone = batch([{ kind: 'restore', nodeId: `undo-journal:${result.undoToken}`, token: result.undoToken! }])
      expect(undone.refusals).toEqual([])
      expect(read(BOARD_REL)).toBe(BOARD)
      expect(read(PASS_REL)).toBe(PASS)
    })
  }

  it('refuses a custom hook by name and writes neither file', () => {
    const custom = BOARD.replace('useState<string | null>(null)', 'useFavourite()').replace(
      "import { useState } from 'react'",
      "import { useFavourite } from '../lib/useFavourite'",
    )
    write(BOARD_REL, custom)

    const result = batch([
      { kind: 'transplant', nodeId: id(BOARD_REL, custom, 'button'), parentNodeId: id(PASS_REL, PASS, 'main') },
    ])

    expect(result.written).toBe(0)
    expect(result.refusals[0]!.reason).toBe('captured-scope')
    expect(result.refusals[0]!.message).toContain('useFavourite()')
    expect(result.carried).toBeUndefined()
    expect(read(BOARD_REL)).toBe(custom)
    expect(read(PASS_REL)).toBe(PASS)
  })
})

describe('a transplant of a .map row element - a copy of that row', () => {
  const spanId = (): string => id(BOARD_REL, BOARD, 'b')
  const arrayId = (): string => idAt(BOARD_REL, BOARD, 'ROUTES = [', 'ROUTES = '.length)

  beforeEach(() => {
    write(BOARD_REL, BOARD)
    write(PASS_REL, PASS)
  })

  it('writes the row item as a constant, leaves the template and the array alone, and one restore undoes it', () => {
    const result = batch([
      {
        kind: 'transplant',
        nodeId: spanId(),
        parentNodeId: id(PASS_REL, PASS, 'main'),
        copy: true,
        row: { array: arrayId(), index: 1, length: 2 },
      },
    ])

    expect(result.refusals).toEqual([])
    expect(result.carried).toEqual([{ name: 'route', as: 'route', how: 'value' }])
    expect(read(BOARD_REL)).toBe(BOARD)
    expect(read(PASS_REL)).toBe(`export default function DayPass() {
  const route = { id: 'r2', grade: '6b', name: 'Overhang Project' }
  return (
    <main className="pass">
      <h1>Day pass</h1>
      <b>{route.name}</b>
    </main>
  )
}
`)

    const undone = batch([{ kind: 'restore', nodeId: `undo-journal:${result.undoToken}`, token: result.undoToken! }])
    expect(undone.refusals).toEqual([])
    expect(read(PASS_REL)).toBe(PASS)
  })

  it('refuses when the array the board named is not the one the .map iterates', () => {
    const result = batch([
      {
        kind: 'transplant',
        nodeId: spanId(),
        parentNodeId: id(PASS_REL, PASS, 'main'),
        row: { array: `${BOARD_REL}:1:1`, index: 1, length: 2 },
      },
    ])

    expect(result.written).toBe(0)
    expect(result.refusals[0]!.reason).toBe('stale-source')
    expect(read(BOARD_REL)).toBe(BOARD)
    expect(read(PASS_REL)).toBe(PASS)
  })

  it('refuses an array in another file, and a path outside the project, before reading either', () => {
    for (const array of [`${PASS_REL}:1:1`, '../outside.tsx:1:1', '/etc/passwd:1:1']) {
      const result = batch([
        {
          kind: 'transplant',
          nodeId: spanId(),
          parentNodeId: id(PASS_REL, PASS, 'main'),
          row: { array, index: 0, length: 2 },
        },
      ])
      expect(result.written).toBe(0)
      expect(result.refusals[0]!.reason).toBe('stale-source')
    }
    expect(read(BOARD_REL)).toBe(BOARD)
    expect(read(PASS_REL)).toBe(PASS)
  })
})
