/**
 * boardAnnotations.test.ts — the shared geometry and stacking transforms notes
 * and doc cards use (`resizeAnnotation`, `reorderAnnotations`,
 * `annotationPaintOrder`), plus the `DocBlock.markdown -> html` read-boundary
 * migration in `serialize.ts`.
 *
 * All pure `Board -> Board`, so none of this needs a store or a DOM.
 */
import { describe, expect, test } from 'bun:test'
import {
  MIN_ANNOTATION_SIZE,
  DEFAULT_DOC_WIDTH,
  docContentScale,
  annotationPaintOrder,
  createBoard,
  parseBoardsFile,
  reorderAnnotations,
  resizeAnnotation,
  upsertDoc,
  upsertNote,
  type Board,
  type DocBlock,
  type StickyNote,
} from '../index'

const note = (overrides: Partial<StickyNote> = {}): StickyNote => ({
  id: 'n1', x: 0, y: 0, w: 200, h: 120, text: '', color: 'yellow', ...overrides,
})
const doc = (overrides: Partial<DocBlock> = {}): DocBlock => ({
  id: 'd1', x: 0, y: 0, w: 320, h: 200, html: '', ...overrides,
})

function boardWith(notes: StickyNote[], docs: DocBlock[] = []): Board {
  let board = createBoard('b1', 'Board 1')
  for (const n of notes) board = upsertNote(board, n)
  for (const d of docs) board = upsertDoc(board, d)
  return board
}

describe('resizeAnnotation', () => {
  test('sets the full rect on a note', () => {
    const board = resizeAnnotation(boardWith([note()]), { kind: 'note', id: 'n1' }, { x: 10, y: 20, w: 300, h: 400 })
    expect(board.notes[0]).toMatchObject({ x: 10, y: 20, w: 300, h: 400 })
  })

  test('sets the full rect on a doc', () => {
    const board = resizeAnnotation(boardWith([], [doc()]), { kind: 'doc', id: 'd1' }, { x: 5, y: 5, w: 500, h: 600 })
    expect(board.docs[0]).toMatchObject({ x: 5, y: 5, w: 500, h: 600 })
  })

  test('clamps below the minimum size — a card smaller than its own chrome cannot be grabbed again', () => {
    const board = resizeAnnotation(boardWith([note()]), { kind: 'note', id: 'n1' }, { x: 0, y: 0, w: 1, h: 2 })
    expect(board.notes[0]!.w).toBe(MIN_ANNOTATION_SIZE)
    expect(board.notes[0]!.h).toBe(MIN_ANNOTATION_SIZE)
  })

  test('is a no-op for an unknown id', () => {
    const board = boardWith([note()])
    expect(resizeAnnotation(board, { kind: 'note', id: 'nope' }, { x: 1, y: 1, w: 300, h: 300 })).toEqual(board)
  })
})

describe('annotationPaintOrder', () => {
  test('puts unordered items first, in array order, then ordered items ascending', () => {
    const items = [{ z: 5 }, {}, { z: 1 }, {}]
    expect(annotationPaintOrder(items)).toEqual([items[1], items[3], items[2], items[0]])
  })

  test('is stable for equal z — raising one item never reshuffles its neighbours', () => {
    const a = { z: 2 }
    const b = { z: 2 }
    expect(annotationPaintOrder([a, b])).toEqual([a, b])
  })
})

describe('reorderAnnotations', () => {
  test('bring-to-front puts the moved item above every other annotation, notes and docs alike', () => {
    const board = boardWith([note({ id: 'n1' }), note({ id: 'n2' })], [doc({ id: 'd1' })])
    const next = reorderAnnotations(board, [{ kind: 'note', id: 'n1' }], 'front')
    const zOf = (id: string) =>
      next.notes.find((n) => n.id === id)?.z ?? next.docs.find((d) => d.id === id)?.z
    expect(zOf('n1')).toBeGreaterThan(zOf('n2')!)
    expect(zOf('n1')).toBeGreaterThan(zOf('d1')!)
  })

  test('send-to-back puts the moved item below every other annotation', () => {
    const board = boardWith([note({ id: 'n1' }), note({ id: 'n2' })], [doc({ id: 'd1' })])
    const next = reorderAnnotations(board, [{ kind: 'doc', id: 'd1' }], 'back')
    const zOf = (id: string) =>
      next.notes.find((n) => n.id === id)?.z ?? next.docs.find((d) => d.id === id)?.z
    expect(zOf('d1')).toBeLessThan(zOf('n1')!)
    expect(zOf('d1')).toBeLessThan(zOf('n2')!)
  })

  test('assigns absolute z values, so a second front-raise cannot land in a tie', () => {
    let board = boardWith([note({ id: 'n1' }), note({ id: 'n2' })])
    board = reorderAnnotations(board, [{ kind: 'note', id: 'n1' }], 'front')
    board = reorderAnnotations(board, [{ kind: 'note', id: 'n2' }], 'front')
    const n1 = board.notes.find((n) => n.id === 'n1')!
    const n2 = board.notes.find((n) => n.id === 'n2')!
    expect(n2.z).toBeGreaterThan(n1.z!)
  })

  test('preserves relative order within the moved set', () => {
    const board = boardWith([note({ id: 'n1' }), note({ id: 'n2' }), note({ id: 'n3' })])
    const next = reorderAnnotations(board, [{ kind: 'note', id: 'n1' }, { kind: 'note', id: 'n2' }], 'front')
    const z = (id: string) => next.notes.find((n) => n.id === id)!.z!
    expect(z('n1')).toBeLessThan(z('n2'))
    expect(z('n3')).toBeLessThan(z('n1'))
  })

  test('an empty ref list leaves the board alone', () => {
    const board = boardWith([note()])
    expect(reorderAnnotations(board, [], 'front')).toEqual(board)
  })
})

describe('DocBlock markdown -> html migration', () => {
  test('a pre-rich-text boards.json has its markdown rendered to html at the read boundary', () => {
    const parsed = parseBoardsFile({
      version: 1,
      boards: [{ id: 'b', name: 'B', frames: [], notes: [], docs: [{ id: 'd1', markdown: '# Title' }] }],
    })
    const migrated = parsed.boards[0]!.docs[0]!
    expect(migrated.html).toContain('<h1')
    expect(migrated.html).toContain('Title')
    // The old field never survives into the parsed shape — nothing downstream
    // is allowed to see two shapes.
    expect('markdown' in migrated).toBe(false)
  })

  test('an html doc is passed through unchanged, and wins over a stale markdown sibling', () => {
    const parsed = parseBoardsFile({
      version: 1,
      boards: [{ id: 'b', name: 'B', frames: [], notes: [], docs: [{ id: 'd1', html: '<p>kept</p>', markdown: '# ignored' }] }],
    })
    expect(parsed.boards[0]!.docs[0]!.html).toBe('<p>kept</p>')
  })

  test('z round-trips, and is omitted entirely when absent (pre-stacking files stay byte-identical)', () => {
    const parsed = parseBoardsFile({
      version: 1,
      boards: [{ id: 'b', name: 'B', frames: [], notes: [{ id: 'n1', z: 3 }, { id: 'n2' }], docs: [] }],
    })
    expect(parsed.boards[0]!.notes[0]!.z).toBe(3)
    expect('z' in parsed.boards[0]!.notes[1]!).toBe(false)
  })
})

/**
 * `docContentScale` — how much a doc card magnifies its text.
 *
 * The behaviour a user is promised: a card twice as wide reads twice as big,
 * and one dragged to an extreme is still legible rather than either a smear or
 * two words filling the board.
 */
describe('docContentScale', () => {
  test('renders at 1x at the width a doc is created with', () => {
    expect(docContentScale(DEFAULT_DOC_WIDTH)).toBe(1)
  })

  test('magnifies in proportion to width — twice as wide reads twice as big', () => {
    expect(docContentScale(DEFAULT_DOC_WIDTH * 2)).toBe(2)
    expect(docContentScale(DEFAULT_DOC_WIDTH * 0.75)).toBeCloseTo(0.75)
  })

  test('clamps both ends, so no card is unreadable or absurd', () => {
    // MIN_ANNOTATION_SIZE (80) would otherwise be 0.25x — a smear.
    expect(docContentScale(MIN_ANNOTATION_SIZE)).toBe(0.5)
    expect(docContentScale(20_000)).toBe(4)
  })

  test('never returns a scale that would blank a card', () => {
    // A width of 0/NaN is not reachable through the UI, but a CSS `zoom: 0`
    // would make the doc invisible with no way back, so it is refused here
    // rather than trusted not to happen.
    expect(docContentScale(0)).toBe(1)
    expect(docContentScale(Number.NaN)).toBe(1)
  })
})
