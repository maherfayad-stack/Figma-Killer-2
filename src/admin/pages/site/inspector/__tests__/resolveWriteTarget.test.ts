import { describe, expect, it } from 'bun:test'
import { resolveExistingWriteTarget, resolveWriteTarget } from '../resolveWriteTarget'
import type { PropertyProvenance } from '../../panels/PropertiesPanel/stylePropertyProvenance'

function provenance(sources: PropertyProvenance['sources']): PropertyProvenance {
  return {
    property: 'width',
    sources,
    confidence: sources.some((s) => s.winner) ? 'exact-match' : 'none',
    computedValue: undefined,
    inherited: false,
  }
}

describe('resolveWriteTarget', () => {
  it('targets inline when inline already wins and is writable', () => {
    const target = resolveWriteTarget({
      provenance: provenance([
        { kind: 'class', classId: 'c1', label: '.card', value: '10px', winner: false },
        { kind: 'inline', label: 'Element', value: '20px', winner: true },
      ]),
      inlineWritable: true,
      writableClasses: [{ classId: 'c1', selector: '.card' }],
    })
    expect(target).toEqual({ kind: 'inline' })
  })

  it('targets the winning class when it is writable', () => {
    const target = resolveWriteTarget({
      provenance: provenance([{ kind: 'class', classId: 'c1', label: '.card', value: '10px', winner: true }]),
      inlineWritable: true,
      writableClasses: [{ classId: 'c1', selector: '.card' }],
    })
    expect(target).toEqual({ kind: 'class', classId: 'c1', selector: '.card' })
  })

  it('falls through to inline when the winning class is locked', () => {
    const target = resolveWriteTarget({
      provenance: provenance([{ kind: 'class', classId: 'locked', label: '.utility', value: '10px', winner: true }]),
      inlineWritable: true,
      writableClasses: [],
    })
    expect(target).toEqual({ kind: 'inline' })
  })

  it('defaults to the one editable class when nothing sets the property yet', () => {
    const target = resolveWriteTarget({
      provenance: undefined,
      inlineWritable: true,
      writableClasses: [{ classId: 'c1', selector: '.card' }],
    })
    expect(target).toEqual({ kind: 'class', classId: 'c1', selector: '.card' })
  })

  it('defaults to inline when there are zero or several editable classes', () => {
    expect(
      resolveWriteTarget({ provenance: undefined, inlineWritable: true, writableClasses: [] }),
    ).toEqual({ kind: 'inline' })
    expect(
      resolveWriteTarget({
        provenance: undefined,
        inlineWritable: true,
        writableClasses: [
          { classId: 'c1', selector: '.card' },
          { classId: 'c2', selector: '.primary' },
        ],
      }),
    ).toEqual({ kind: 'inline' })
  })

  it('refuses when nothing is writable', () => {
    const target = resolveWriteTarget({ provenance: undefined, inlineWritable: false, writableClasses: [] })
    expect(target.kind).toBe('none')
  })

  it('never picks an ambiguous winner (provenance crowned none)', () => {
    const target = resolveWriteTarget({
      provenance: provenance([
        { kind: 'class', classId: 'c1', label: '.card', value: '10px', winner: false },
        { kind: 'class', classId: 'c2', label: '.primary', value: '20px', winner: false },
      ]),
      inlineWritable: true,
      writableClasses: [
        { classId: 'c1', selector: '.card' },
        { classId: 'c2', selector: '.primary' },
      ],
    })
    // No winner attributed -> falls to the default rule -> 2 editable classes -> inline.
    expect(target).toEqual({ kind: 'inline' })
  })
})

describe('resolveExistingWriteTarget', () => {
  it('has nothing to remove when no source declares the property', () => {
    const target = resolveExistingWriteTarget({ provenance: undefined, inlineWritable: true, writableClasses: [] })
    expect(target.kind).toBe('none')
  })

  it('targets the winner, never a fallback', () => {
    const target = resolveExistingWriteTarget({
      provenance: provenance([{ kind: 'class', classId: 'c1', label: '.card', value: '10px', winner: true }]),
      inlineWritable: true,
      writableClasses: [],
    })
    expect(target.kind).toBe('none')
  })
})

describe('resolveWriteTarget — a class that cannot hold the value steps aside (G-5)', () => {
  const template = {
    classId: 'toggle',
    selector: '.Toggle_sc',
    // What a styled template says: no semicolon, brace, backtick or `${`.
    holds: (value: string | number | null) => typeof value !== 'string' || !/[;{}`]/.test(value),
  }
  const winner = provenance([{ kind: 'class', classId: 'toggle', label: '.Toggle_sc', value: 'red', winner: true }])

  it('lands the value on the class when the class can spell it', () => {
    expect(
      resolveWriteTarget({ provenance: winner, inlineWritable: true, writableClasses: [template], values: ['navy'] }),
    ).toEqual({ kind: 'class', classId: 'toggle', selector: '.Toggle_sc' })
  })

  it('lands it on the element when the class cannot, instead of sending it to a refusal', () => {
    expect(
      resolveWriteTarget({ provenance: winner, inlineWritable: true, writableClasses: [template], values: ['red; margin: 0'] }),
    ).toEqual({ kind: 'inline' })
  })

  it('judges every value of a multi-property commit', () => {
    expect(
      resolveWriteTarget({ provenance: winner, inlineWritable: true, writableClasses: [template], values: ['navy', 'a}b'] }),
    ).toEqual({ kind: 'inline' })
  })

  it('keeps the class when the element is locked too, so the server says why rather than the edit vanishing', () => {
    expect(
      resolveWriteTarget({ provenance: winner, inlineWritable: false, writableClasses: [template], values: ['a;b'] }),
    ).toEqual({ kind: 'class', classId: 'toggle', selector: '.Toggle_sc' })
  })

  it('a clear (null) and a number always fit', () => {
    expect(resolveWriteTarget({ provenance: winner, inlineWritable: true, writableClasses: [template], values: [null, 4] })).toEqual({
      kind: 'class',
      classId: 'toggle',
      selector: '.Toggle_sc',
    })
  })
})
