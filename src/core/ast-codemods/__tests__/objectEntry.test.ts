/**
 * objectEntry — clone one entry of an object literal under a new key, or take
 * one out, as a byte-exact splice. The write behind a lookup-object or `cva`
 * variant. Generic fixtures: one entry per line, one-line objects, trailing
 * commas, quoted keys, a multi-line array value, a trailing comment.
 */
import { describe, expect, it } from 'bun:test'
import { cloneObjectEntry, removeObjectEntry } from '../objectEntry'
import { applyTextSplices } from '@core/utils/textSplice'

function at(source: string, needle: string, member: string): { line: number; column: number; member: string } {
  const offset = source.indexOf(needle)
  if (offset < 0) throw new Error(`no ${needle}`)
  const before = source.slice(0, offset)
  return { line: before.split('\n').length, column: offset - (before.lastIndexOf('\n') + 1) + 1, member }
}

function clone(source: string, needle: string, member: string, name: string): string {
  const result = cloneObjectEntry('tones.ts', source, at(source, needle, member), name)
  if (!result.ok) throw new Error(result.refusal.message)
  return result.splice ? applyTextSplices(source, [result.splice]) : source
}

function remove(source: string, needle: string, member: string): string {
  const result = removeObjectEntry('tones.ts', source, at(source, needle, member))
  if (!result.ok) throw new Error(result.refusal.message)
  return applyTextSplices(source, [result.splice])
}

describe('cloneObjectEntry', () => {
  it('copies a one-per-line entry right after itself, in the same indent, with its trailing comma', () => {
    const source = "export const toneClass = {\n  info: 'text-blue-500',\n  warn: 'text-amber-500',\n}\n"
    expect(clone(source, 'info:', 'info', 'danger')).toBe(
      "export const toneClass = {\n  info: 'text-blue-500',\n  danger: 'text-blue-500',\n  warn: 'text-amber-500',\n}\n",
    )
  })

  it('adds the comma an entry without one needs when it is last', () => {
    const source = "export const toneClass = {\n  info: 'a',\n  warn: 'b'\n}\n"
    expect(clone(source, 'warn:', 'warn', 'danger')).toBe("export const toneClass = {\n  info: 'a',\n  warn: 'b',\n  danger: 'b'\n}\n")
  })

  it('copies inside a one-line object with a single space', () => {
    const source = "const tones = { info: 'a', warn: 'b' }\n"
    expect(clone(source, 'info:', 'info', 'danger')).toBe("const tones = { info: 'a', danger: 'a', warn: 'b' }\n")
  })

  it('keeps a multi-line value (a cva class array) and quotes a key that is not an identifier', () => {
    const source =
      "const button = cva('base', {\n  variants: {\n    tone: {\n      info: [\n        'text-blue-500',\n        'hover:underline',\n      ],\n      warn: 'x',\n    },\n  },\n})\n"
    const next = clone(source, 'info:', 'info', 'soft-blue')
    expect(next).toContain(
      "      info: [\n        'text-blue-500',\n        'hover:underline',\n      ],\n      'soft-blue': [\n        'text-blue-500',\n        'hover:underline',\n      ],\n      warn: 'x',",
    )
  })

  it('writes a quoted key in the original quote', () => {
    const source = 'const t = {\n  "info": "a",\n  "warn": "b",\n}\n'
    expect(clone(source, '"info"', 'info', 'danger')).toBe('const t = {\n  "info": "a",\n  "danger": "a",\n  "warn": "b",\n}\n')
  })

  it('leaves a trailing comment on its own entry', () => {
    const source = "const t = {\n  info: 'a', // calm\n  warn: 'b',\n}\n"
    expect(clone(source, 'info:', 'info', 'danger')).toBe("const t = {\n  info: 'a', // calm\n  danger: 'a',\n  warn: 'b',\n}\n")
  })

  it('does nothing when an entry of the new name already exists', () => {
    const source = "const t = {\n  info: 'a',\n  danger: 'z',\n}\n"
    const result = cloneObjectEntry('t.ts', source, at(source, 'info:', 'info'), 'danger')
    expect(result.ok && result.existed && result.splice === null).toBe(true)
  })

  it('refuses a shorthand entry, a stale position and a wrong key', () => {
    const shorthand = 'const info = "a"\nconst t = {\n  info,\n  warn: "b",\n}\n'
    const a = cloneObjectEntry('t.ts', shorthand, at(shorthand, 'info,', 'info'), 'danger')
    expect(!a.ok && a.refusal.reason).toBe('unsupported-entry')
    const source = "const t = {\n  info: 'a',\n}\n"
    const b = cloneObjectEntry('t.ts', source, { line: 2, column: 4, member: 'info' }, 'danger')
    expect(b.ok).toBe(false)
    const c = cloneObjectEntry('t.ts', source, at(source, 'info:', 'warn'), 'danger')
    expect(!c.ok && c.refusal.reason).toBe('stale-source')
  })
})

describe('removeObjectEntry', () => {
  it('deletes an entry that owns its line, comma and all', () => {
    const source = "const t = {\n  info: 'a',\n  warn: 'b',\n  danger: 'c',\n}\n"
    expect(remove(source, 'warn:', 'warn')).toBe("const t = {\n  info: 'a',\n  danger: 'c',\n}\n")
  })

  it('deletes the last entry of a one-line object with the comma before it', () => {
    const source = "const t = { info: 'a', warn: 'b' }\n"
    expect(remove(source, 'warn:', 'warn')).toBe("const t = { info: 'a' }\n")
  })

  it('deletes a first entry of a one-line object with the comma after it', () => {
    const source = "const t = { info: 'a', warn: 'b' }\n"
    expect(remove(source, 'info:', 'info')).toBe("const t = { warn: 'b' }\n")
  })

  it('deletes a multi-line entry whole and a line comment trailing it', () => {
    const source = "const t = {\n  info: [\n    'a',\n    'b',\n  ], // calm\n  warn: 'x',\n}\n"
    expect(remove(source, 'info:', 'info')).toBe("const t = {\n  warn: 'x',\n}\n")
  })

  it('round-trips a clone', () => {
    const source = "export const toneClass = {\n  info: 'text-blue-500',\n  warn: 'text-amber-500',\n}\n"
    const cloned = clone(source, 'info:', 'info', 'danger')
    expect(remove(cloned, 'danger:', 'danger')).toBe(source)
  })
})
