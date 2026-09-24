/**
 * sanitizeSvg.test.ts — the SVG DOMPurify profile keeps vector markup but
 * strips scripting / HTML-smuggling vectors.
 */

import { describe, it, expect } from 'bun:test'
import { sanitizeRichtext, sanitizeSvg } from '@core/sanitize'

describe('sanitizeSvg', () => {
  it('keeps a normal inline SVG (svg/path/viewBox)', () => {
    const out = sanitizeSvg('<svg viewBox="0 0 24 24"><path d="M1 1h22"/></svg>')
    expect(out).toContain('<svg')
    expect(out).toContain('viewBox="0 0 24 24"')
    expect(out).toContain('<path')
    expect(out).toContain('d="M1 1h22"')
  })

  it('preserves presentation attributes (fill: currentColor styling)', () => {
    const out = sanitizeSvg('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="currentColor"/></svg>')
    expect(out).toContain('<circle')
    expect(out).toContain('currentColor')
  })

  it('strips <script> inside the SVG', () => {
    const out = sanitizeSvg('<svg><script>alert(1)</script><path d="M0 0"/></svg>')
    expect(out.toLowerCase()).not.toContain('<script')
    expect(out.toLowerCase()).not.toContain('alert(1)')
    expect(out.toLowerCase()).toContain('<svg')
  })

  it('strips inline event handlers', () => {
    const out = sanitizeSvg('<svg><path d="M0 0" onload="alert(1)"/></svg>')
    expect(out.toLowerCase()).not.toContain('onload')
  })

  it('strips <foreignObject> HTML smuggling', () => {
    const out = sanitizeSvg('<svg><foreignObject><img src=x onerror="alert(1)"></foreignObject></svg>')
    expect(out.toLowerCase()).not.toContain('foreignobject')
    expect(out.toLowerCase()).not.toContain('onerror')
  })

  it('returns empty string for empty/blank input', () => {
    expect(sanitizeSvg('')).toBe('')
    expect(sanitizeSvg('   ')).toBe('')
    expect(sanitizeSvg(null)).toBe('')
  })
})

describe('sanitizeSvg — same-document fragment references (P5-D SVG-2)', () => {
  it('keeps a <use> sprite that points at a fragment of this document', () => {
    const out = sanitizeSvg('<svg viewBox="0 0 8 8"><defs><path id="dot" d="M0 0h1"/></defs><use href="#dot"/></svg>')
    expect(out).toContain('<use href="#dot"')
  })

  it('keeps gradient inheritance by href and by xlink:href', () => {
    const out = sanitizeSvg(
      '<svg><linearGradient id="a"><stop offset="0"/></linearGradient>'
      + '<linearGradient id="b" href="#a"/><radialGradient id="c" xlink:href="#a"/></svg>',
    )
    expect(out).toContain('href="#a"')
    expect(out).toContain('xlink:href="#a"')
  })

  it.each([
    ['a remote document', 'https://evil.test/sprite.svg#dot'],
    ['a protocol-relative document', '//evil.test/sprite.svg#dot'],
    ['a same-origin document', 'sprite.svg#dot'],
    ['a data: document', 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>#x'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['an entity-encoded javascript: URL', 'jav&#x61;script:alert(1)'],
    ['a fragment behind whitespace', ' #dot'],
    ['a fragment behind a line separator', String.fromCharCode(0x2028) + '#dot'],
    ['a fragment with a path in it', '#dot/../x'],
  ])('strips a <use> href to %s', (_label, href) => {
    const escaped = href.replace(/"/g, '&quot;')
    const out = sanitizeSvg(`<svg><use href="${escaped}"/><use xlink:href="${escaped}"/></svg>`)
    expect(out).not.toMatch(/href=/i)
  })

  it('keeps refusing href on elements that have no business referencing a fragment', () => {
    const out = sanitizeSvg('<svg><path href="#a" d="M0 0"/><image href="#a"/><image href="https://evil.test/x.png"/></svg>')
    expect(out).not.toMatch(/href=/i)
  })

  it('does not widen richtext: a link keeps its own rules', () => {
    expect(sanitizeRichtext('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:')
    expect(sanitizeRichtext('<svg><use href="#a"/></svg>')).not.toContain('<use')
  })
})

describe('sanitizeSvg — a removed element does not shield the next one', () => {
  // DOMPurify under happy-dom (the server's DOM, which the publisher's
  // `escapeProps` sanitises with) skipped the node after every removed
  // element, so its handlers survived.
  it.each([
    '<svg><foo/><image href="https://evil.test/x" onload="alert(1)"/></svg>',
    '<svg><foo></foo><circle r="1" onclick="alert(1)"/></svg>',
    '<svg><script>x</script><rect width="1" onmouseover="alert(1)"/></svg>',
  ])('strips the handler after a removed element: %s', (input) => {
    const out = sanitizeSvg(input).toLowerCase()
    expect(out).not.toMatch(/\son[a-z]+=/)
    expect(out).not.toContain('evil.test')
  })
})
