/**
 * `editListItems` — OD-8: a `.map` row's reorder / delete / duplicate / paste
 * written to the array literal it iterates. Byte-for-byte, like every
 * structural codemod: formatting, comments and commas are the user's.
 *
 * Fixtures are a recipe box and a kanban board — nothing from the eSIM corpus
 * (`genericRepoShapes.test.ts`'s discipline).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ListItemOpSchema, type ListItemOp } from '@core/page-tree'
import { Value } from '@core/utils/typeboxHelpers'
import { editListItems } from '../editListItems'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-list-items-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(source: string, name = 'Recipes.tsx'): string {
  const file = path.join(tmpDir, name)
  fs.writeFileSync(file, source, 'utf8')
  return file
}

const read = (file: string) => fs.readFileSync(file, 'utf8')

/** 1-based line/col of the `[` that follows `marker` in `source`. */
function arrayAt(source: string, marker: string): { line: number; col: number } {
  const offset = source.indexOf('[', source.indexOf(marker))
  const before = source.slice(0, offset)
  const line = before.split('\n').length
  return { line, col: offset - before.lastIndexOf('\n') }
}

function run(source: string, marker: string, length: number, op: ListItemOp) {
  const file = writeFixture(source)
  const result = editListItems({ file, ...arrayAt(source, marker), length, op })
  return { file, result, text: read(file) }
}

const RECIPES = `import { Card } from './Card'

// Weeknight rotation — keep the fish first.
const RECIPES = [
  // Fast one
  { slug: 'miso-salmon', title: 'Miso salmon', minutes: 20 }, // family favourite
  {
    slug: 'dal',
    title: 'Red lentil dal',
    minutes: 35,
  },

  { slug: 'tacos', title: 'Fish tacos', minutes: 25 }
]

export default function Recipes() {
  return (
    <ul>
      {RECIPES.map((recipe) => (
        <li key={recipe.slug}>{recipe.title}</li>
      ))}
    </ul>
  )
}
`

describe('editListItems — one element per line', () => {
  it('reorders whole blocks: comments and the blank line after an element travel with it, the last keeps no comma', () => {
    const { result, text } = run(RECIPES, 'const RECIPES', 3, { kind: 'reorder', order: [2, 0, 1] })
    expect(result).toEqual({ ok: true })
    expect(text).toBe(`import { Card } from './Card'

// Weeknight rotation — keep the fish first.
const RECIPES = [
  { slug: 'tacos', title: 'Fish tacos', minutes: 25 },
  // Fast one
  { slug: 'miso-salmon', title: 'Miso salmon', minutes: 20 }, // family favourite
  {
    slug: 'dal',
    title: 'Red lentil dal',
    minutes: 35,
  }

]

export default function Recipes() {
  return (
    <ul>
      {RECIPES.map((recipe) => (
        <li key={recipe.slug}>{recipe.title}</li>
      ))}
    </ul>
  )
}
`)
  })

  it('keeps a trailing comma a trailing comma', () => {
    const source = `const LANES = [\n  'todo',\n  'doing',\n  'done',\n]\n`
    const { text } = run(source, 'const LANES', 3, { kind: 'reorder', order: [1, 2, 0] })
    expect(text).toBe(`const LANES = [\n  'doing',\n  'done',\n  'todo',\n]\n`)
  })

  it('removes the last element and takes the comma off the new last one', () => {
    const { result, text } = run(RECIPES, 'const RECIPES', 3, { kind: 'remove', indices: [2] })
    expect(result.ok).toBe(true)
    expect(text).toContain(`    minutes: 35,\n  }\n\n]`)
    expect(text).not.toContain('tacos')
  })

  it('removes a middle element with its own lines and nothing else', () => {
    const { result, text } = run(RECIPES, 'const RECIPES', 3, { kind: 'remove', indices: [1] })
    expect(result).toEqual({ ok: true })
    expect(text).not.toContain('Red lentil dal')
    expect(text).toContain(`  { slug: 'miso-salmon', title: 'Miso salmon', minutes: 20 }, // family favourite\n  { slug: 'tacos'`)
  })

  it('duplicates an element right after itself, its key field made unique inside its own quotes', () => {
    const { text } = run(RECIPES, 'const RECIPES', 3, { kind: 'copy', from: [0], at: 1, key: { kind: 'field', field: 'slug' } })
    expect(text).toContain(`  // Fast one
  { slug: 'miso-salmon', title: 'Miso salmon', minutes: 20 }, // family favourite
  // Fast one
  { slug: 'miso-salmon-copy', title: 'Miso salmon', minutes: 20 }, // family favourite
  {
    slug: 'dal',`)
  })

  it('a second copy of the same element gets the next free key', () => {
    const first = run(RECIPES, 'const RECIPES', 3, { kind: 'copy', from: [2], at: 3, key: { kind: 'field', field: 'slug' } })
    const again = editListItems({ file: first.file, ...arrayAt(first.text, 'const RECIPES'), length: 4, op: { kind: 'copy', from: [2], at: 3, key: { kind: 'field', field: 'slug' } } })
    expect(again.ok).toBe(true)
    const text = read(first.file)
    expect(text).toContain(`  { slug: 'tacos', title: 'Fish tacos', minutes: 25 },\n  { slug: 'tacos-copy-2', title: 'Fish tacos', minutes: 25 },\n  { slug: 'tacos-copy', title: 'Fish tacos', minutes: 25 }\n]`)
  })

  it('a numeric key becomes the next free number', () => {
    const source = `const CARDS = [\n  { id: 7, title: 'Write brief' },\n  { id: 9, title: 'Review' },\n]\n`
    const { text } = run(source, 'const CARDS', 2, { kind: 'copy', from: [0], at: 1, key: { kind: 'field', field: 'id' } })
    expect(text).toBe(`const CARDS = [\n  { id: 7, title: 'Write brief' },\n  { id: 10, title: 'Write brief' },\n  { id: 9, title: 'Review' },\n]\n`)
  })

  it('removing every element leaves an empty array', () => {
    const source = `const LANES = [
  'todo',
  'doing',
]
`
    expect(run(source, 'const LANES', 2, { kind: 'remove', indices: [0, 1] }).text).toBe(`const LANES = [
]
`)
  })
})

describe('editListItems — inline arrays', () => {
  const INLINE = `export const Tabs = () => <nav>{['Board', 'List', 'Calendar'].map((tab, i) => <a key={i}>{tab}</a>)}</nav>\n`

  it('moves elements between the separators, which stay where they are', () => {
    const { text } = run(INLINE, 'nav>{', 3, { kind: 'reorder', order: [2, 0, 1] })
    expect(text).toBe(`export const Tabs = () => <nav>{['Calendar', 'Board', 'List'].map((tab, i) => <a key={i}>{tab}</a>)}</nav>\n`)
  })

  it('removes an element with one separator, and a trailing comma stays one', () => {
    expect(run(INLINE, 'nav>{', 3, { kind: 'remove', indices: [0] }).text).toContain(`{['List', 'Calendar'].map`)
    expect(run(`const X = [1, 2, 3,]\n`, 'const X', 3, { kind: 'remove', indices: [2] }).text).toBe(`const X = [1, 2,]\n`)
    expect(run(`const X = [1, 2,]\n`, 'const X', 2, { kind: 'remove', indices: [0, 1] }).text).toBe(`const X = []\n`)
  })

  it('copies an element with the separators the array already uses', () => {
    expect(run(INLINE, 'nav>{', 3, { kind: 'copy', from: [1], at: 2 }).text).toContain(`{['Board', 'List', 'List', 'Calendar'].map`)
  })

})

describe('editListItems — refusals leave the file byte-identical', () => {
  const refusal = (source: string, marker: string, length: number, op: ListItemOp, at?: { line: number; col: number }) => {
    const file = writeFixture(source)
    const result = editListItems({ file, ...(at ?? arrayAt(source, marker)), length, op })
    expect(read(file)).toBe(source)
    return result.ok ? null : result.refusal.reason
  }

  it('no array at the position', () => {
    expect(refusal(RECIPES, '', 3, { kind: 'remove', indices: [0] }, { line: 1, col: 1 })).toBe('not-found')
  })

  it('the array has a different number of items than the board read', () => {
    expect(refusal(RECIPES, 'const RECIPES', 4, { kind: 'remove', indices: [0] })).toBe('list-changed')
    expect(refusal(`const A = [...B, 1]\n`, 'const A', 2, { kind: 'remove', indices: [0] })).toBe('list-changed')
  })

  it('an index outside the array, or an order that is not a permutation', () => {
    expect(refusal(RECIPES, 'const RECIPES', 3, { kind: 'remove', indices: [3] })).toBe('bad-index')
    expect(refusal(RECIPES, 'const RECIPES', 3, { kind: 'reorder', order: [0, 0, 1] })).toBe('bad-index')
    expect(refusal(RECIPES, 'const RECIPES', 3, { kind: 'reorder', order: [0, 1] })).toBe('bad-index')
  })

  it('a copy whose key field is not a plain value', () => {
    const source = `const CARDS = [\n  { id: makeId(), title: 'A' },\n]\n`
    expect(refusal(source, 'const CARDS', 1, { kind: 'copy', from: [0], at: 1, key: { kind: 'field', field: 'id' } })).toBe('duplicate-key')
    expect(refusal(`const T = ['a']\n`, 'const T', 1, { kind: 'copy', from: [0], at: 1, key: { kind: 'item' } })).toBe('duplicate-key')
  })

  it('the wire has no op that writes caller-supplied text — a remove is undone by the undo journal (P3-F)', () => {
    expect(Value.Check(ListItemOpSchema, { kind: 'insert', at: [0], texts: ['2'] })).toBe(false)
  })
})
