/**
 * The line-ending primitives every codemod's CRLF safety rests on.
 *
 * Written against strings only — a fixture FILE on this repo's own Windows
 * checkout would be rewritten by `core.autocrlf` before the test ever saw it,
 * so a CRLF corpus that lives on disk cannot test CRLF. Every case here builds
 * its bytes in the test.
 */
import { describe, expect, it } from 'bun:test'
import { CRLF, LF, applyLineEnding, detectLineEnding, splitLines, toLf } from '@core/utils/lineEndings'

describe('detectLineEnding', () => {
  it('reports LF for a file with no line ending at all', () => {
    expect(detectLineEnding('')).toBe(LF)
    expect(detectLineEnding('const a = 1')).toBe(LF)
  })

  it('reports the uniform ending of a uniform file', () => {
    expect(detectLineEnding('a\nb\nc\n')).toBe(LF)
    expect(detectLineEnding('a\r\nb\r\nc\r\n')).toBe(CRLF)
  })

  it('reports the MAJORITY ending of a mixed file', () => {
    expect(detectLineEnding('a\r\nb\r\nc\nd\r\n')).toBe(CRLF)
    expect(detectLineEnding('a\nb\nc\r\nd\n')).toBe(LF)
  })

  it('breaks a tie toward CRLF — the repairing direction for a half-converted file', () => {
    expect(detectLineEnding('a\r\nb\n')).toBe(CRLF)
  })

  it('does not count a lone \\r as a line ending it would write back', () => {
    expect(detectLineEnding('a\rb\rc')).toBe(LF)
  })
})

describe('toLf', () => {
  it('normalises CRLF and lone CR', () => {
    expect(toLf('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
  })

  it('is idempotent and returns LF text untouched', () => {
    const lf = 'a\nb\nc\n'
    expect(toLf(lf)).toBe(lf)
    expect(toLf(toLf('a\r\nb\r\n'))).toBe('a\nb\n')
  })

  it('leaves a byte-order mark alone', () => {
    expect(toLf('\uFEFFa\r\nb')).toBe('\uFEFFa\nb')
  })
})

describe('applyLineEnding', () => {
  it('round-trips a uniform file byte-for-byte', () => {
    const crlf = 'const a = 1\r\nconst b = 2\r\n'
    expect(applyLineEnding(toLf(crlf), detectLineEnding(crlf))).toBe(crlf)
    const lf = 'const a = 1\nconst b = 2\n'
    expect(applyLineEnding(toLf(lf), detectLineEnding(lf))).toBe(lf)
  })

  it('normalises text spliced together from both forms', () => {
    expect(applyLineEnding('a\r\nb\nc', CRLF)).toBe('a\r\nb\r\nc')
    expect(applyLineEnding('a\r\nb\nc', LF)).toBe('a\nb\nc')
  })

  it('never doubles a CR', () => {
    expect(applyLineEnding(applyLineEnding('a\nb', CRLF), CRLF)).toBe('a\r\nb')
  })
})

describe('splitLines', () => {
  it('leaves no \\r on any line, so an anchored regex still matches', () => {
    expect(splitLines('## Button\r\ntext\r\n')).toEqual(['## Button', 'text', ''])
    // The exact failure `server-24` recorded: `.` does not match `\r`, so a
    // bare `'\n'` split silently matches zero headings in a CRLF document.
    const heading = /^(#{1,6})\s+(.*)$/
    expect(splitLines('### Chip\r\n').map((line) => heading.exec(line)?.[2])).toContain('Chip')
    expect('### Chip\r\n'.split('\n').map((line) => heading.exec(line)?.[2])).not.toContain('Chip')
  })

  it('splits a lone CR too', () => {
    expect(splitLines('a\rb')).toEqual(['a', 'b'])
  })
})
