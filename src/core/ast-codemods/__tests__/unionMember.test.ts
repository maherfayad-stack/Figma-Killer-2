/**
 * unionMember — add a member to, or remove one from, a string-literal union,
 * as a byte-exact splice in the union's own spelling. Generic fixtures only
 * (nothing from the eSIM corpus): inline unions, aliases, multi-line leading
 * and trailing pipes, comments, a `| undefined`, double quotes.
 */
import { describe, expect, it } from 'bun:test'
import { addUnionMember, removeUnionMember } from '../unionMember'
import { applyTextSplices } from '@core/utils/textSplice'

/** 1-based line/column of the first occurrence of `needle` — where the variant read model points a member's `origin`. */
function at(source: string, needle: string): { line: number; column: number; name: string } {
  const offset = source.indexOf(needle)
  if (offset < 0) throw new Error(`no ${needle}`)
  const before = source.slice(0, offset)
  const line = before.split('\n').length
  const column = offset - (before.lastIndexOf('\n') + 1) + 1
  return { line, column, name: needle.slice(1, -1) }
}

function add(source: string, existing: string, name: string, fileName = 'Tag.tsx'): string {
  const result = addUnionMember(fileName, source, at(source, existing), name)
  if (!result.ok) throw new Error(result.refusal.message)
  return applyTextSplices(source, [result.splice])
}

function remove(source: string, member: string, fileName = 'Tag.tsx'): string {
  const result = removeUnionMember(fileName, source, at(source, member))
  if (!result.ok) throw new Error(result.refusal.message)
  return applyTextSplices(source, [result.splice])
}

describe('addUnionMember', () => {
  it('appends to an inline one-line union, in its quote', () => {
    const source = "export function Tag({ tone }: { tone?: 'info' | 'warn' }) {\n  return <b>{tone}</b>\n}\n"
    expect(add(source, "'warn'", 'danger')).toBe("export function Tag({ tone }: { tone?: 'info' | 'warn' | 'danger' }) {\n  return <b>{tone}</b>\n}\n")
  })

  it('keeps double quotes', () => {
    const source = 'type Tone = "info" | "warn"\n'
    expect(add(source, '"warn"', 'danger')).toBe('type Tone = "info" | "warn" | "danger"\n')
  })

  it('appends to a multi-line union with leading pipes, matching its indent', () => {
    const source = "type Tone =\n  | 'info'\n  | 'warn'\n\nexport const x = 1\n"
    expect(add(source, "'info'", 'danger')).toBe("type Tone =\n  | 'info'\n  | 'warn'\n  | 'danger'\n\nexport const x = 1\n")
  })

  it('appends to a multi-line union with trailing pipes', () => {
    const source = "type Tone = 'info' |\n  'warn'\n"
    expect(add(source, "'info'", 'danger')).toBe("type Tone = 'info' |\n  'warn' |\n  'danger'\n")
  })

  it('leaves a comment that trails the last line where it was', () => {
    const source = "type Tone =\n  | 'info'\n  | 'warn' // the loud one\n"
    expect(add(source, "'info'", 'danger')).toBe("type Tone =\n  | 'info'\n  | 'warn' // the loud one\n  | 'danger'\n")
  })

  it('inserts before a trailing semicolon and after a trailing `| undefined`-less last literal', () => {
    const source = "type Tone = 'info' | 'warn';\n"
    expect(add(source, "'info'", 'danger')).toBe("type Tone = 'info' | 'warn' | 'danger';\n")
  })

  it('goes after the last LITERAL member, not after `undefined`', () => {
    const source = "export function Tag({ tone }: { tone?: 'info' | 'warn' | undefined }) {\n  return null\n}\n"
    expect(add(source, "'info'", 'danger')).toContain("'info' | 'warn' | 'danger' | undefined")
  })

  it('refuses a name that is already a member, an unusable name, and a stale position', () => {
    const source = "type Tone = 'info' | 'warn'\n"
    for (const [name, reason] of [
      ['warn', 'variant-exists'],
      ['two words', 'invalid-variant-name'],
      ["it's", 'invalid-variant-name'],
      ['9lives', 'invalid-variant-name'],
    ] as const) {
      const result = addUnionMember('Tag.ts', source, at(source, "'info'"), name)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.refusal.reason).toBe(reason)
    }
    const stale = addUnionMember('Tag.ts', source, { line: 1, column: 15, name: 'info' }, 'danger')
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.refusal.reason).toBe('stale-source')
  })

  it('refuses a literal that is not a member of a union', () => {
    const source = "type Only = 'solo'\n"
    const result = addUnionMember('Tag.ts', source, at(source, "'solo'"), 'duo')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('not-a-union')
  })
})

describe('removeUnionMember', () => {
  it('removes a last member and its separator', () => {
    expect(remove("type Tone = 'info' | 'warn' | 'danger'\n", "'danger'")).toBe("type Tone = 'info' | 'warn'\n")
  })

  it('removes a middle member', () => {
    expect(remove("type Tone = 'info' | 'warn' | 'danger'\n", "'warn'")).toBe("type Tone = 'info' | 'danger'\n")
  })

  it('removes the first member', () => {
    expect(remove("type Tone = 'info' | 'warn' | 'danger'\n", "'info'")).toBe("type Tone = 'warn' | 'danger'\n")
  })

  it('removes a whole line of a multi-line union, with its trailing comment', () => {
    const source = "type Tone =\n  | 'info'\n  | 'warn' // loud\n  | 'danger'\n"
    expect(remove(source, "'warn'")).toBe("type Tone =\n  | 'info'\n  | 'danger'\n")
  })

  it('removes the first member of a leading-pipe union and keeps the pipe style', () => {
    const source = "type Tone =\n  | 'info'\n  | 'warn'\n"
    expect(remove(source, "'info'")).toBe("type Tone =\n  | 'warn'\n")
  })

  it('refuses to remove the last remaining value', () => {
    const source = "type Tone = 'info' | undefined\n"
    const result = removeUnionMember('Tag.ts', source, at(source, "'info'"))
    expect(result.ok).toBe(false)
  })

  it('round-trips: add then remove restores the exact bytes', () => {
    const source = "export interface TagProps {\n  tone?:\n    | 'info'\n    | 'warn'\n}\n"
    const added = add(source, "'info'", 'danger')
    expect(remove(added, "'danger'")).toBe(source)
  })
})
