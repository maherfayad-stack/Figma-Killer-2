import { describe, expect, it } from 'bun:test'
import { findTokenMentions, rewriteTokenMentions } from '../references'

describe('findTokenMentions', () => {
  it('separates declarations from reads and ignores longer names', () => {
    const text = '.a { --x: 1; color: var(--x); } .b--x { y: var(--x-2) } bg-[--x] p-(--x) i-- "a" --> {"--x": v}'
    expect(findTokenMentions(text).map((m) => [m.name, m.declaration])).toEqual([
      ['--x', true],
      ['--x', false],
      ['--x-2', false],
      ['--x', false],
      ['--x', false],
      ['--x', false],
    ])
  })
})

describe('rewriteTokenMentions', () => {
  it('rewrites only the mentions decide() names, leaving every other byte', () => {
    const text = 'a { --x: 1; b: var(--x); c: var(--x-2); }'
    const out = rewriteTokenMentions(text, (m) => (m.name === '--x' && !m.declaration ? '--y' : null))
    expect(out).toEqual({ text: 'a { --x: 1; b: var(--y); c: var(--x-2); }', count: 1 })
  })
})
