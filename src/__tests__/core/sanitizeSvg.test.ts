/**
 * sanitizeSvg.test.ts — the SVG DOMPurify profile keeps vector markup but
 * strips scripting / HTML-smuggling vectors.
 */

import { describe, it, expect } from 'bun:test'
import { sanitizeRichtext, sanitizeSvg } from '@core/sanitize'
import { cssTextLoadsExternalResource, svgStyleLoadsExternalResource, type SvgStyleChildNode } from '@core/vector'

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

  // security review of #264: a removed svg-namespace `head`/`body`/`html` was
  // mistaken for DOMPurify's own document wrapper, so the pass it shielded was
  // reported clean.
  it.each([
    '<svg><head></head><svg onload="alert(1)"/></svg>',
    '<svg><desc><head></head></desc><rect width="1" onclick="alert(1)"/></svg>',
    '<svg><title><html></html></title><svg onload="alert(1)"/></svg>',
    '<svg><desc><body></body></desc><svg onload="alert(1)"/></svg>',
  ])('strips the handler after a removed wrapper-named element: %s', (input) => {
    expect(sanitizeSvg(input).toLowerCase()).not.toMatch(/\son[a-z]+=/)
  })

  it('does not keep a data: document href shielded by a removed <body>', () => {
    const out = sanitizeSvg('<svg><body></body><use href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=#x"/></svg>')
    expect(out).not.toContain('data:')
  })
})

describe('sanitizeSvg — nothing is loaded from outside the document (security review of #264, N1)', () => {
  // The same rule the importer refuses on (`cssValueLoadsExternalResource`)
  // and the same outcome `sanitizeSvgBytes` gives a served file.
  it.each([
    ['<svg><rect fill="url(https://evil.test/p.svg#g)" width="1"/></svg>', 'evil.test'],
    ['<svg><rect style="fill:url(//evil.test/b)" width="1"/></svg>', 'evil.test'],
    ['<svg><rect style="background:image-set(\'x.png\' 1x)" width="1"/></svg>', 'image-set'],
  ])('drops the remote reference: %s', (input, marker) => {
    const out = sanitizeSvg(input)
    expect(out.toLowerCase()).not.toContain(marker)
    expect(out.toLowerCase()).not.toContain('@import')
    expect(out).toContain('<rect')
  })

  it('keeps fragment url()s and inline data images', () => {
    const out = sanitizeSvg(
      '<svg><defs><linearGradient id="g"/></defs>' +
        '<rect fill="url(#g)" style="stroke:url(#g)" width="1"/>' +
        '<rect style="fill:url(data:image/png;base64,AAAA)" width="2"/></svg>',
    )
    expect(out).toContain('fill="url(#g)"')
    expect(out).toContain('stroke:url(#g)')
    expect(out).toContain('data:image/png')
  })

  // `<style>` blocks: happy-dom's HTML parser swallows everything after a
  // `<style>` inside `<svg>` as raw text, so no `sanitizeSvg` case here can
  // reach the hook's `<style>` branch. The rule it applies is the shared
  // predicate, pinned below.
  it.each([
    ['@import url(https://evil.test/x.css);', true],
    ['@import "https://evil.test/x.css";', true],
    ['@\\69mport "//evil.test/x.css";', true],
    ['.a{fill:url(https://evil.test/p.svg#g)}', true],
    ['.a{fill:url(#g)} .b{stroke:currentColor}', false],
  ] as const)('the <style> rule: %s loads externally = %p', (css, loads) => {
    expect(cssTextLoadsExternalResource(css)).toBe(loads)
  })

  // Security re-review of #264: the sheet is built from a `<style>`'s DIRECT
  // text; `textContent` adds nested text, so a kept child element split the
  // token and the old check read `@imxport`. The three payloads that fetched
  // in real Chromium, as the child-node lists that browser builds for them
  // (happy-dom parses an svg `<style>` as raw text, so it cannot build them).
  const text = (value: string): SvgStyleChildNode => ({ nodeType: 3, nodeValue: value })
  const element = (): SvgStyleChildNode => ({ nodeType: 1, nodeValue: null })
  it.each([
    ['@im<tspan>x</tspan>port "https://evil/c.css";', [text('@im'), element(), text('port "https://evil/c.css";')]],
    ['@im<title>x</title>port "https://evil/n.css";', [text('@im'), element(), text('port "https://evil/n.css";')]],
    ['rect{fill:u<tspan>x</tspan>rl(https://evil/d)}', [text('rect{fill:u'), element(), text('rl(https://evil/d)}')]],
  ] as const)('a <style> split by a child element loads externally: %s', (_markup, children) => {
    expect(svgStyleLoadsExternalResource(children)).toBe(true)
  })

  it('a <style> of text only is judged on that text', () => {
    expect(svgStyleLoadsExternalResource([text('.a{fill:url(#g)}'), text(' .b{stroke:red}')])).toBe(false)
    expect(svgStyleLoadsExternalResource([text('@imp'), text('ort "//evil/x.css";')])).toBe(true)
    expect(svgStyleLoadsExternalResource([text('.a{}'), { nodeType: 8, nodeValue: 'x' }])).toBe(true)
  })
})
