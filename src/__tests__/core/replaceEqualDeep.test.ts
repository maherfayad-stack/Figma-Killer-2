import { describe, expect, it } from 'bun:test'
import { replaceEqualDeep } from '@core/utils/replaceEqualDeep'

describe('replaceEqualDeep', () => {
  it('returns prev when next is deep-equal to it', () => {
    const prev = { a: 1, b: { c: [1, 2, { d: 'x' }] } }
    expect(replaceEqualDeep(prev, structuredClone(prev))).toBe(prev)
  })

  it('shares every unchanged subtree and replaces only the changed path', () => {
    const prev = { keep: { x: 1 }, list: [{ id: 'a' }, { id: 'b' }], edit: { y: 1 } }
    const next = structuredClone(prev)
    next.edit.y = 2
    const out = replaceEqualDeep(prev, next)
    expect(out).not.toBe(prev)
    expect(out.keep).toBe(prev.keep)
    expect(out.list).toBe(prev.list)
    expect(out.edit).toEqual({ y: 2 })
  })

  it('treats an added or removed key as a change, even an undefined one', () => {
    const prev: Record<string, unknown> = { a: 1 }
    expect(replaceEqualDeep(prev, { a: 1, b: undefined })).not.toBe(prev)
    expect(replaceEqualDeep({ a: 1, b: 2 }, { a: 1 })).toEqual({ a: 1 })
  })

  it('matches arrays by index and shares equal items of a changed array', () => {
    const prev = [{ n: 1 }, { n: 2 }]
    const out = replaceEqualDeep(prev, [{ n: 1 }, { n: 2 }, { n: 3 }])
    expect(out).not.toBe(prev)
    expect(out[0]).toBe(prev[0]!)
    expect(out[1]).toBe(prev[1]!)
    expect(out).toHaveLength(3)
  })

  it('never mutates either argument, so a frozen prev is safe', () => {
    const prev = Object.freeze({ a: Object.freeze({ b: 1 }), c: Object.freeze({ d: 1 }) })
    const next = { a: { b: 1 }, c: { d: 2 } }
    const out = replaceEqualDeep(prev, next)
    expect(out.a).toBe(prev.a)
    expect(next.a).toEqual({ b: 1 })
    expect(next.c).toEqual({ d: 2 })
  })

  it('does not descend into non-plain objects', () => {
    const prev = { when: new Date(0) }
    const next = { when: new Date(0) }
    expect(replaceEqualDeep(prev, next).when).toBe(next.when)
  })
})
