import { describe, it, expect } from 'bun:test'
import { decodeJsxTextEntities } from '../jsxTextEntities'

describe('decodeJsxTextEntities', () => {
  // The exact string that shipped to a real canvas reading "it&apos;s ready".
  it('decodes the apostrophe that started this', () => {
    expect(decodeJsxTextEntities('Activate it now so it&apos;s ready before you travel.'))
      .toBe("Activate it now so it's ready before you travel.")
  })

  it('decodes the five XML predefined entities', () => {
    expect(decodeJsxTextEntities('&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;'))
      .toBe(`<a> & "b" 'c'`)
  })

  it('decodes the typographic entities people type in copy', () => {
    expect(decodeJsxTextEntities('SAR 69 &mdash; 12&deg; &hellip; Almosafer&trade;'))
      .toBe('SAR 69 — 12° … Almosafer™')
  })

  it('decodes decimal and hex numeric references', () => {
    expect(decodeJsxTextEntities('it&#39;s')).toBe("it's")
    expect(decodeJsxTextEntities('it&#x27;s')).toBe("it's")
    expect(decodeJsxTextEntities('&#x1F600;')).toBe('\u{1F600}')
  })

  // `&amp;lt;` means the author wanted to SHOW `&lt;`. Decoding twice would
  // turn their escaped example into an actual `<`.
  it('decodes each entity exactly once', () => {
    expect(decodeJsxTextEntities('&amp;lt;')).toBe('&lt;')
    expect(decodeJsxTextEntities('&amp;amp;')).toBe('&amp;')
  })

  it('leaves an unknown entity exactly as authored rather than guessing', () => {
    expect(decodeJsxTextEntities('R&D;')).toBe('R&D;')
    expect(decodeJsxTextEntities('&notarealentity;')).toBe('&notarealentity;')
  })

  it('is case-sensitive, as HTML named entities are', () => {
    expect(decodeJsxTextEntities('&AMP;')).toBe('&AMP;')
  })

  it('leaves bare ampersands and malformed references alone', () => {
    expect(decodeJsxTextEntities('Tom & Jerry')).toBe('Tom & Jerry')
    expect(decodeJsxTextEntities('a &amp b')).toBe('a &amp b')
    expect(decodeJsxTextEntities('100% & more')).toBe('100% & more')
  })

  it('rejects an out-of-range code point instead of throwing', () => {
    expect(decodeJsxTextEntities('&#1114112;')).toBe('&#1114112;')
    expect(decodeJsxTextEntities('&#xFFFFFFF;')).toBe('&#xFFFFFFF;')
  })

  it('returns text with no ampersand untouched', () => {
    expect(decodeJsxTextEntities('Your booking is confirmed')).toBe('Your booking is confirmed')
    expect(decodeJsxTextEntities('')).toBe('')
  })
})
