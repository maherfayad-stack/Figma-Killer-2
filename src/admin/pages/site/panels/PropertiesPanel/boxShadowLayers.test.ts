/**
 * boxShadowLayers — exhaustive parse/serialise coverage
 * (STUDIO-INSPECTOR-DISCLOSURE-PLAN §4 G8).
 *
 * The load-bearing property under test: `parseBoxShadowValue` only ever
 * returns `'layers'` when `serializeBoxShadowLayers(layers)` reproduces the
 * INPUT byte-for-byte. Every `'layers'` case below asserts that identity
 * directly, not just "some layers came out".
 */
import { describe, expect, it } from 'bun:test'
import {
  appendBoxShadowLayer,
  createDefaultBoxShadowLayer,
  parseBoxShadowLayers,
  parseBoxShadowValue,
  removeBoxShadowLayer,
  reorderBoxShadowLayers,
  serializeBoxShadowLayer,
  serializeBoxShadowLayers,
  updateBoxShadowLayer,
} from './boxShadowLayers'

describe('parseBoxShadowValue — empty', () => {
  it('treats undefined/null as empty', () => {
    expect(parseBoxShadowValue(undefined)).toEqual({ kind: 'empty' })
    expect(parseBoxShadowValue(null)).toEqual({ kind: 'empty' })
  })

  it('treats an empty string and "none" as empty', () => {
    expect(parseBoxShadowValue('')).toEqual({ kind: 'empty' })
    expect(parseBoxShadowValue('   ')).toEqual({ kind: 'empty' })
    expect(parseBoxShadowValue('none')).toEqual({ kind: 'empty' })
    expect(parseBoxShadowValue('None')).toEqual({ kind: 'empty' })
  })
})

describe('parseBoxShadowValue — single layer, structured', () => {
  it('parses "0 4px 4px rgba(0, 0, 0, 0.25)" — offsets + blur + trailing colour, no spread', () => {
    const result = parseBoxShadowValue('0 4px 4px rgba(0, 0, 0, 0.25)')
    expect(result.kind).toBe('layers')
    if (result.kind !== 'layers') throw new Error('expected layers')
    expect(result.layers).toHaveLength(1)
    const [layer] = result.layers
    expect(layer).toMatchObject({
      inset: false,
      offsetX: '0',
      offsetY: '4px',
      blurRadius: '4px',
      spreadRadius: '',
      color: 'rgba(0, 0, 0, 0.25)',
      colorPosition: 'trailing',
    })
    // The core guarantee: re-serialising reproduces the exact input.
    expect(serializeBoxShadowLayers(result.layers)).toBe('0 4px 4px rgba(0, 0, 0, 0.25)')
  })

  it('parses a 4-length layer with spread', () => {
    const raw = 'inset 0 -2px 4px 1px rgba(255, 255, 255, 0.1)'
    const result = parseBoxShadowValue(raw)
    expect(result.kind).toBe('layers')
    if (result.kind !== 'layers') throw new Error('expected layers')
    expect(result.layers[0]).toMatchObject({
      inset: true,
      insetPosition: 'leading',
      offsetX: '0',
      offsetY: '-2px',
      blurRadius: '4px',
      spreadRadius: '1px',
      color: 'rgba(255, 255, 255, 0.1)',
      colorPosition: 'trailing',
    })
    expect(serializeBoxShadowLayers(result.layers)).toBe(raw)
  })

  it('parses a leading colour', () => {
    const raw = 'rgba(0, 0, 0, 0.5) 0 4px 4px'
    const result = parseBoxShadowValue(raw)
    expect(result.kind).toBe('layers')
    if (result.kind !== 'layers') throw new Error('expected layers')
    expect(result.layers[0]).toMatchObject({
      color: 'rgba(0, 0, 0, 0.5)',
      colorPosition: 'leading',
      offsetX: '0',
      offsetY: '4px',
      blurRadius: '4px',
      spreadRadius: '',
    })
    expect(serializeBoxShadowLayers(result.layers)).toBe(raw)
  })

  it('parses a trailing "inset" keyword', () => {
    const raw = '0 4px 4px black inset'
    const result = parseBoxShadowValue(raw)
    expect(result.kind).toBe('layers')
    if (result.kind !== 'layers') throw new Error('expected layers')
    expect(result.layers[0]).toMatchObject({ inset: true, insetPosition: 'trailing' })
    expect(serializeBoxShadowLayers(result.layers)).toBe(raw)
  })

  it('parses a minimal 2-length layer with no blur, no spread, no colour', () => {
    const raw = '2px 2px'
    const result = parseBoxShadowValue(raw)
    expect(result.kind).toBe('layers')
    if (result.kind !== 'layers') throw new Error('expected layers')
    expect(result.layers[0]).toMatchObject({
      offsetX: '2px',
      offsetY: '2px',
      blurRadius: '',
      spreadRadius: '',
      color: '',
      colorPosition: 'none',
    })
    expect(serializeBoxShadowLayers(result.layers)).toBe(raw)
  })

  it('accepts a hex colour and a var() colour token', () => {
    expect(parseBoxShadowValue('0 4px 4px #000000').kind).toBe('layers')
    const raw = '0 4px 4px var(--shadow-color)'
    const result = parseBoxShadowValue(raw)
    expect(result.kind).toBe('layers')
    if (result.kind !== 'layers') throw new Error('expected layers')
    expect(result.layers[0]!.color).toBe('var(--shadow-color)')
    expect(serializeBoxShadowLayers(result.layers)).toBe(raw)
  })
})

describe('parseBoxShadowValue — two layers, commas inside rgba() are not layer separators', () => {
  it('splits exactly two layers and re-serialises byte-identically', () => {
    const raw = '0 4px 4px rgba(0, 0, 0, 0.25), inset 0 -2px 0 rgba(255, 255, 255, 0.1)'
    const result = parseBoxShadowValue(raw)
    expect(result.kind).toBe('layers')
    if (result.kind !== 'layers') throw new Error('expected layers')
    expect(result.layers).toHaveLength(2)
    expect(result.layers[0]).toMatchObject({ inset: false, color: 'rgba(0, 0, 0, 0.25)' })
    expect(result.layers[1]).toMatchObject({ inset: true, color: 'rgba(255, 255, 255, 0.1)' })
    expect(serializeBoxShadowLayers(result.layers)).toBe(raw)
  })

  it('handles three layers mixing hex, rgba() and a leading colour', () => {
    const raw = '0 1px 2px #000, rgba(0, 0, 0, 0.2) 0 2px 4px, inset 0 0 0 1px black'
    const result = parseBoxShadowValue(raw)
    expect(result.kind).toBe('layers')
    if (result.kind !== 'layers') throw new Error('expected layers')
    expect(result.layers).toHaveLength(3)
    expect(serializeBoxShadowLayers(result.layers)).toBe(raw)
  })
})

describe('parseBoxShadowValue — refuses rather than guesses (stays raw, loses nothing)', () => {
  it('refuses a colour interleaved between lengths', () => {
    const raw = '0 rgba(0,0,0,.5) 4px 4px'
    const result = parseBoxShadowValue(raw)
    expect(result.kind).toBe('raw')
    if (result.kind !== 'raw') throw new Error('expected raw')
    expect(result.raw).toBe(raw)
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it('refuses more than one non-length, non-inset token', () => {
    const result = parseBoxShadowValue('0 4px 4px black potato')
    expect(result.kind).toBe('raw')
  })

  it('refuses fewer than 2 or more than 4 length tokens', () => {
    expect(parseBoxShadowValue('4px').kind).toBe('raw')
    expect(parseBoxShadowValue('0 4px 4px 0 8px black').kind).toBe('raw')
  })

  it('refuses a comma-joined value where one segment is garbage', () => {
    const raw = '0 4px 4px black, potato'
    const result = parseBoxShadowValue(raw)
    expect(result.kind).toBe('raw')
    if (result.kind !== 'raw') throw new Error('expected raw')
    // The full original text is preserved — nothing is dropped or partially parsed.
    expect(result.raw).toBe(raw)
  })

  it('refuses "inset" appearing anywhere other than the first or last token', () => {
    expect(parseBoxShadowValue('0 inset 4px 4px black').kind).toBe('raw')
  })

  it('falls back to raw when the value parses but does not re-serialise byte-identically (unusual whitespace)', () => {
    // Double space between the first two lengths: tokenises fine, but the
    // canonical serialiser joins with single spaces, so the round trip fails
    // and the honest behaviour is to leave the original text untouched.
    const raw = '0  4px 4px black'
    const result = parseBoxShadowValue(raw)
    expect(result.kind).toBe('raw')
    if (result.kind !== 'raw') throw new Error('expected raw')
    expect(result.raw).toBe(raw)
  })
})

describe('serializeBoxShadowLayer', () => {
  it('omits blur/spread/colour when they are unset, and only prefixes inset when leading', () => {
    const layer = createDefaultBoxShadowLayer(false)
    expect(serializeBoxShadowLayer({ ...layer, blurRadius: '', spreadRadius: '', color: '', colorPosition: 'none' }))
      .toBe('0 4px')
  })

  it('round-trips the default drop shadow and default inner shadow layers', () => {
    const drop = createDefaultBoxShadowLayer(false)
    expect(serializeBoxShadowLayer(drop)).toBe('0 4px 4px rgba(0, 0, 0, 0.25)')
    const inner = createDefaultBoxShadowLayer(true)
    expect(serializeBoxShadowLayer(inner)).toBe('inset 0 4px 4px rgba(0, 0, 0, 0.25)')
  })
})

describe('appendBoxShadowLayer', () => {
  it('returns just the new layer when nothing is set', () => {
    expect(appendBoxShadowLayer(undefined, '0 4px 4px black')).toBe('0 4px 4px black')
    expect(appendBoxShadowLayer('none', '0 4px 4px black')).toBe('0 4px 4px black')
    expect(appendBoxShadowLayer('', '0 4px 4px black')).toBe('0 4px 4px black')
  })

  it('is always safe to append even onto a value this module cannot parse', () => {
    const unparseable = '0 4px 4px black, potato'
    expect(appendBoxShadowLayer(unparseable, '0 2px 2px red')).toBe(
      '0 4px 4px black, potato, 0 2px 2px red',
    )
  })

  it('joins with ", " onto an existing parseable value', () => {
    expect(appendBoxShadowLayer('0 4px 4px black', '0 2px 2px red')).toBe(
      '0 4px 4px black, 0 2px 2px red',
    )
  })
})

describe('layer-list edit helpers', () => {
  it('removeBoxShadowLayer drops exactly the targeted index', () => {
    const layers = [createDefaultBoxShadowLayer(false), createDefaultBoxShadowLayer(true)]
    const next = removeBoxShadowLayer(layers, 0)
    expect(next).toHaveLength(1)
    expect(next[0]!.inset).toBe(true)
  })

  it('reorderBoxShadowLayers moves an entry and changes paint order', () => {
    const a = createDefaultBoxShadowLayer(false)
    const b = createDefaultBoxShadowLayer(true)
    const layers = [a, b]
    const reordered = reorderBoxShadowLayers(layers, 0, 1)
    expect(reordered).toEqual([b, a])
    expect(serializeBoxShadowLayers(reordered)).toBe(
      'inset 0 4px 4px rgba(0, 0, 0, 0.25), 0 4px 4px rgba(0, 0, 0, 0.25)',
    )
  })

  it('updateBoxShadowLayer patches only the targeted layer', () => {
    const layers = [createDefaultBoxShadowLayer(false), createDefaultBoxShadowLayer(false)]
    const next = updateBoxShadowLayer(layers, 1, { offsetX: '10px' })
    expect(next[0]!.offsetX).toBe('0')
    expect(next[1]!.offsetX).toBe('10px')
  })
})

describe('parseBoxShadowLayers — grammar-only parse (no round-trip check)', () => {
  it('is used internally by parseBoxShadowValue but is exposed for direct grammar testing', () => {
    const layers = parseBoxShadowLayers('0 4px 4px black')
    expect(layers).not.toBeNull()
    expect(layers).toHaveLength(1)
    expect(parseBoxShadowLayers('potato')).toBeNull()
  })
})
