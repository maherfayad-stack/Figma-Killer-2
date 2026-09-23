/**
 * P1-D — `mapPositionThroughLineDiff`: where a line of the text the board read
 * is in the text on disk now, under EVERY optimal reading of the diff, and
 * `null` whenever some reading deleted it.
 */
import { describe, expect, it } from 'bun:test'
import { MAX_EDIT_DISTANCE, mapPositionThroughLineDiff } from '../sourceLineMap'

const lines = (...rows: string[]) => rows.join('\n')

describe('mapPositionThroughLineDiff', () => {
  it('maps a line below an insertion down by the inserted count, and one above it in place', () => {
    const before = lines('<ul>', '  <li>One</li>', '  <li>Two</li>', '</ul>')
    const after = lines('<ul>', '  <li>One</li>', '  <li>New</li>', '  <li>New 2</li>', '  <li>Two</li>', '</ul>')
    expect(mapPositionThroughLineDiff(before, after, 3, 4)).toEqual([{ line: 5, col: 4 }])
    expect(mapPositionThroughLineDiff(before, after, 2, 4)).toEqual([{ line: 2, col: 4 }])
  })

  it('maps a line above a deletion in place and one below it up', () => {
    const before = lines('a', 'b', 'c', 'd')
    const after = lines('a', 'c', 'd')
    expect(mapPositionThroughLineDiff(before, after, 1, 1)).toEqual([{ line: 1, col: 1 }])
    expect(mapPositionThroughLineDiff(before, after, 4, 1)).toEqual([{ line: 3, col: 1 }])
  })

  it('answers null for the deleted line itself', () => {
    expect(mapPositionThroughLineDiff(lines('a', 'b', 'c'), lines('a', 'c'), 2, 1)).toBeNull()
  })

  it('answers null for either of two identical lines when one of them was deleted', () => {
    const before = lines('x', '<li>A</li>', '<li>A</li>', 'y')
    const after = lines('x', '<li>A</li>', 'y')
    expect(mapPositionThroughLineDiff(before, after, 2, 2)).toBeNull()
    expect(mapPositionThroughLineDiff(before, after, 3, 2)).toBeNull()
  })

  it('answers null for identical lines separated by a deleted one ([A, X, A] -> [A])', () => {
    expect(mapPositionThroughLineDiff(lines('A', 'X', 'A'), lines('A'), 1, 1)).toBeNull()
    expect(mapPositionThroughLineDiff(lines('A', 'X', 'A'), lines('A'), 3, 1)).toBeNull()
  })

  it('reports both readings when an identical line was inserted next to the target', () => {
    const before = lines('x', '<li>A</li>', 'y')
    const after = lines('x', '<li>A</li>', '<li>A</li>', 'y')
    expect(mapPositionThroughLineDiff(before, after, 2, 2)).toEqual([
      { line: 2, col: 2 },
      { line: 3, col: 2 },
    ])
  })

  it('carries the column across a re-indent', () => {
    const before = lines('<ul>', '  <li>One</li>', '</ul>')
    const after = lines('<section>', '  <ul>', '      <li>One</li>', '  </ul>', '</section>')
    expect(mapPositionThroughLineDiff(before, after, 2, 4)).toEqual([{ line: 3, col: 8 }])
  })

  it('answers null for a position outside the text it was read from', () => {
    expect(mapPositionThroughLineDiff(lines('a'), lines('a'), 5, 1)).toBeNull()
  })

  it('refuses to align a change larger than MAX_EDIT_DISTANCE lines', () => {
    const before = ['keep', ...Array.from({ length: MAX_EDIT_DISTANCE }, (_, i) => `old ${i}`), 'target'].join('\n')
    const after = ['keep', ...Array.from({ length: MAX_EDIT_DISTANCE }, (_, i) => `new ${i}`), 'target'].join('\n')
    expect(mapPositionThroughLineDiff(before, after, MAX_EDIT_DISTANCE + 2, 1)).toBeNull()
  })
})
