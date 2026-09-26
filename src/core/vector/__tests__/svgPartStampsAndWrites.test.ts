import { describe, expect, it } from 'bun:test'
import {
  parseSvgCodeAttributes,
  parseSvgPartLocation,
  svgAttributeWriteRefusal,
} from '@core/vector'

describe('svgPartStamps', () => {
  it('parses a part location strictly', () => {
    expect(parseSvgPartLocation('12:7')).toEqual({ line: 12, col: 7 })
    for (const bad of ['', '0:1', '1:0', '1', '1:2:3', ' 1:2', '1:2 ', 'a:b', '-1:2']) {
      expect(parseSvgPartLocation(bad)).toBeNull()
    }
  })

  it('reads the code list', () => {
    expect([...parseSvgCodeAttributes('d,fill')]).toEqual(['d', 'fill'])
    expect(parseSvgCodeAttributes(null).size).toBe(0)
  })
})

describe('svgAttributeWriteRefusal — one rule for every SVG attribute write', () => {
  it('allows ordinary geometry and paint', () => {
    for (const [name, value] of [
      ['d', 'M0 0L10 10'], ['fill', '#f00'], ['fill', 'url(#grad-1)'], ['strokeWidth', 2],
      ['strokeDasharray', '4 2'], ['transform', 'translate(2 3)'], ['className', 'icon'],
      ['aria-label', 'url(https://example.com) is text here'], ['href', '#dot'], ['xlinkHref', '#dot'],
    ] as const) {
      expect(svgAttributeWriteRefusal(name, value)).toBeNull()
    }
  })

  it('refuses handlers, namespaces, React plumbing, stamps and malformed names', () => {
    for (const name of [
      'xmlBase', 'xmlnsXlink', 'xmlLang',
      'onClick', 'onload', 'ONLOAD', 'xmlns', 'xmlns:xlink', 'style', 'dangerouslySetInnerHTML', 'ref', 'key',
      'children', 'data-studio-svg-part', 'data-studio-svg-code', 'xlink:href', 'a b', '1x', '', 'd"',
    ]) {
      expect(svgAttributeWriteRefusal(name, 'x')?.reason).toBe('svg-attr-name')
    }
  })

  it('refuses a reference out of the SVG and a remote fetch', () => {
    for (const [name, value] of [
      ['href', 'javascript:steal()'], ['href', 'https://evil.example/x.svg#a'], ['xlinkHref', 'data:image/svg+xml,<svg/>'],
      ['href', ' #a'], ['fill', 'url(https://evil.example/p)'], ['filter', 'url(//evil.example/f)'],
      ['mask', 'image-set("x.png" 1x)'], ['fill', 'u\\72l(https://evil.example)'],
    ] as const) {
      expect(svgAttributeWriteRefusal(name, value)?.reason).toBe('svg-attr-value')
    }
    expect(svgAttributeWriteRefusal('strokeWidth', Number.NaN)?.reason).toBe('svg-attr-value')
    expect(svgAttributeWriteRefusal('d', 'M'.repeat(256 * 1024 + 1))?.reason).toBe('svg-attr-value')
  })
})
