/**
 * vectorPaintModel — what the Vector section reads out of a stamped inline
 * `<svg>` and the `svg-attr` writes it plans. The markup here is what the
 * parser emits (`inlineSvg.ts` with `stampParts`): parts carry
 * `data-studio-svg-part`, anything from code `data-studio-svg-code`.
 */
import { describe, expect, it } from 'bun:test'
import { planVectorWrite, readVectorField, readVectorGraphic, vectorTargetOptions, viewBoxAspect } from '../vectorPaintModel'

const HOST = 'pages/Home.tsx:6:8'

const ICON =
  '<svg class="logo" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2">' +
  '<path data-studio-svg-part="7:10" d="M4 4h16v16H4z"/>' +
  '<circle data-studio-svg-part="8:10" cx="12" cy="12" r="4" fill="red"/>' +
  '</svg>'

function graphic(markup = ICON) {
  const read = readVectorGraphic(markup)
  if (!read) throw new Error('not a graphic')
  return read
}

describe('reading the graphic', () => {
  it('lists the root and every stamped part, in document order', () => {
    const parts = graphic().parts
    expect(parts.map((part) => [part.part, part.tag])).toEqual([
      ['', 'svg'],
      ['7:10', 'path'],
      ['8:10', 'circle'],
    ])
    expect(vectorTargetOptions(graphic()).map((option) => option.label)).toEqual(['Whole graphic', 'path 1', 'circle 1'])
  })

  it('refuses markup that is not one <svg> document', () => {
    expect(readVectorGraphic('<div></div>')).toBeNull()
    expect(readVectorGraphic('<svg></svg><svg></svg>')).toBeNull()
  })

  it('the whole graphic shows what its shapes draw with, and Mixed when they differ', () => {
    // path inherits the root's `none`, circle sets its own red.
    expect(readVectorField(graphic(), 'all', 'fill')).toMatchObject({ value: null, lockedReason: null })
    // Both inherit the root's stroke and weight.
    expect(readVectorField(graphic(), 'all', 'stroke')).toMatchObject({ value: 'black', inherited: false })
    expect(readVectorField(graphic(), 'all', 'strokeWidth')).toMatchObject({ value: '2' })
  })

  it('one part shows its own value, or what it inherits (marked inherited), or SVG’s initial value', () => {
    expect(readVectorField(graphic(), '8:10', 'fill')).toEqual({ value: 'red', inherited: false, lockedReason: null })
    expect(readVectorField(graphic(), '7:10', 'fill')).toEqual({ value: 'none', inherited: true, lockedReason: null })
    expect(readVectorField(graphic(), '7:10', 'strokeLinecap')).toEqual({ value: 'butt', inherited: true, lockedReason: null })
  })

  it('opacity does not inherit — a part without one is fully opaque, whatever the root says', () => {
    const faded = graphic('<svg opacity="0.5"><path data-studio-svg-part="2:3" d="M0 0"/></svg>')
    expect(readVectorField(faded, '2:3', 'opacity').value).toBe('1')
    expect(readVectorField(faded, 'all', 'opacity').value).toBe('0.5')
  })

  it('reads the root’s size and viewBox (the HTML parser keeps viewBox’s case)', () => {
    expect(readVectorField(graphic(), 'all', 'width').value).toBe('48')
    expect(readVectorField(graphic(), 'all', 'viewBox').value).toBe('0 0 24 24')
    expect(viewBoxAspect('0 0 24 12')).toBe(2)
    expect(viewBoxAspect('nonsense')).toBeNull()
  })
})

describe('code is never overwritten', () => {
  const coded =
    '<svg data-studio-svg-code="stroke" fill="none" stroke="#123456">' +
    '<path data-studio-svg-part="2:3" data-studio-svg-code="fill" d="M0 0" fill="#ff0000"/>' +
    '<rect data-studio-svg-part="3:3" data-studio-svg-code="*" width="4"/>' +
    '</svg>'

  it('an attribute a part takes from code locks that control for the part, with the reason', () => {
    expect(readVectorField(graphic(coded), '2:3', 'fill').lockedReason).toContain('set from code')
    expect(planVectorWrite(graphic(coded), HOST, '2:3', 'fill', 'blue')).toMatchObject({ ok: false })
  })

  it('a spread locks every attribute of its element', () => {
    expect(readVectorField(graphic(coded), '3:3', 'strokeWidth').lockedReason).toContain('spread')
  })

  it('the root’s own code list locks the whole graphic’s control', () => {
    expect(readVectorField(graphic(coded), 'all', 'stroke').lockedReason).toContain('on the <svg> is set from code')
  })

  it('the whole graphic cannot be refilled while any part’s fill (or a spread) could hide it', () => {
    expect(planVectorWrite(graphic(coded), HOST, 'all', 'fill', '#00ff00')).toMatchObject({ ok: false })
  })
})

describe('planning writes', () => {
  it('whole-graphic fill: the root takes the value, each shape’s own literal fill gives way — one gesture', () => {
    const plan = planVectorWrite(graphic(), HOST, 'all', 'fill', '#ff0000')
    expect(plan).toEqual({
      ok: true,
      writes: [
        { hostNodeId: HOST, part: '', partTag: 'svg', set: { fill: '#ff0000' }, previous: { fill: 'none' } },
        { hostNodeId: HOST, part: '8:10', partTag: 'circle', set: {}, remove: ['fill'], previous: { fill: 'red' } },
      ],
    })
  })

  it('one part: only that element, a number stays a number (`strokeWidth={3}`)', () => {
    const plan = planVectorWrite(graphic(), HOST, '7:10', 'strokeWidth', '3')
    expect(plan).toEqual({
      ok: true,
      writes: [{ hostNodeId: HOST, part: '7:10', partTag: 'path', set: { strokeWidth: 3 }, previous: { strokeWidth: undefined } }],
    })
  })

  it('opacity on the whole graphic is the root’s alone — shapes are not cleared', () => {
    const plan = planVectorWrite(graphic(), HOST, 'all', 'opacity', '0.5')
    expect(plan.ok && plan.writes.map((write) => write.part)).toEqual([''])
  })

  it('null removes the attribute (back to inheriting), and removing an absent one is no write at all', () => {
    expect(planVectorWrite(graphic(), HOST, '8:10', 'fill', null)).toEqual({
      ok: true,
      writes: [{ hostNodeId: HOST, part: '8:10', partTag: 'circle', set: {}, remove: ['fill'], previous: { fill: 'red' } }],
    })
    expect(planVectorWrite(graphic(), HOST, '7:10', 'fill', null)).toEqual({ ok: true, writes: [] })
  })

  it('size writes land on the root whatever the target', () => {
    const plan = planVectorWrite(graphic(), HOST, '7:10', 'width', '96')
    expect(plan.ok && plan.writes).toEqual([{ hostNodeId: HOST, part: '', partTag: 'svg', set: { width: 96 }, previous: { width: 48 } }])
  })
})
