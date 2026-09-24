import { describe, expect, it } from 'bun:test'
import { sanitizeSvgBytes } from '../svgSanitize'

const enc = new TextEncoder()
const dec = new TextDecoder()

function clean(svg: string): string {
  return dec.decode(sanitizeSvgBytes(enc.encode(svg)))
}

describe('sanitizeSvgBytes', () => {
  it('keeps benign SVG geometry intact', () => {
    const out = clean('<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>')
    expect(out).toContain('<rect')
    expect(out).toContain('viewBox')
  })

  it('strips a plain <script> block', () => {
    const out = clean('<svg><script>alert(1)</script><rect/></svg>')
    expect(out.toLowerCase()).not.toContain('<script')
    expect(out).toContain('<rect')
  })

  // Regression for CodeQL js/bad-tag-filter (#34): the HTML parser ends a tag
  // at the first `>`, so these close-tag variants must all be recognised.
  it.each([
    '<svg><script>alert(1)</script >x</svg>',
    '<svg><script>alert(1)</script\t\nbar>x</svg>',
    '<svg><script>alert(1)</script/>x</svg>',
  ])('strips scripts with awkward close tags: %s', (input) => {
    const out = clean(input).toLowerCase()
    expect(out).not.toContain('alert(1)')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('</script')
  })

  // Regression for CodeQL js/incomplete-multi-character-sanitization (#33): a
  // single strip pass leaves a nested payload behind; the fixpoint loop must
  // collapse it fully.
  it('collapses split-tag obfuscation to a fixpoint', () => {
    const out = clean('<svg><scr<script>ipt>alert(1)</scr</script>ipt><rect/></svg>').toLowerCase()
    expect(out).not.toContain('<script')
    expect(out).not.toContain('alert(1)')
    expect(out).toContain('<rect')
  })

  it('strips <foreignObject> and <style> wrappers', () => {
    const out = clean(
      '<svg><foreignObject><div>x</div></foreignObject><style>@import url(javascript:alert(1))</style><rect/></svg>',
    ).toLowerCase()
    expect(out).not.toContain('<foreignobject')
    expect(out).not.toContain('<style')
    expect(out).toContain('<rect')
  })

  it('strips on* event handlers and javascript: URLs', () => {
    const out = clean('<svg onload="alert(1)"><a href="javascript:alert(1)"><rect/></a></svg>').toLowerCase()
    expect(out).not.toContain('onload')
    expect(out).not.toContain('javascript:')
  })

  it('returns empty bytes for empty / whitespace input', () => {
    expect(sanitizeSvgBytes(enc.encode('   ')).length).toBe(0)
    expect(sanitizeSvgBytes(new Uint8Array(0)).length).toBe(0)
  })
})

/**
 * Security review of #248, finding 1: four payload families survived the
 * sanitizer unchanged. Each case is the reviewer's own payload (built with
 * String.fromCharCode where it needs a control character). The response CSP
 * is the boundary; these hold the defence-in-depth layer to its job.
 */
describe('sanitizeSvgBytes — the #248 review payloads', () => {
  const TAB = String.fromCharCode(9)
  const NS = 'xmlns="http://www.w3.org/2000/svg"'

  it.each([
    `<svg ${NS}><x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script><rect/></svg>`,
    `<svg ${NS}><h:script xmlns:h="http://www.w3.org/1999/xhtml">alert(1)</h:script><rect/></svg>`,
    `<svg ${NS}><x:script xmlns:x="http://www.w3.org/2000/svg" href="data:,alert(1)"/><rect/></svg>`,
  ])('1. strips a namespace-prefixed script element: %s', (input) => {
    const out = clean(input).toLowerCase()
    expect(out).not.toContain('script')
    expect(out).not.toContain('alert(1)')
    expect(out).toContain('<rect')
  })

  it.each([
    `<svg ${NS}><a href="jav&#x61;script:alert(1)"><rect/></a></svg>`,
    `<svg ${NS}><a href="&#106;avascript:alert(1)"><rect/></a></svg>`,
    `<svg ${NS}><a xlink:href="javascript&colon;alert(1)"><rect/></a></svg>`,
    `<svg ${NS}><a href="java${TAB}script:alert(1)"><rect/></a></svg>`,
    `<svg ${NS}><a href=" &#x0A;javascript:alert(1)"><rect/></a></svg>`,
  ])('2. drops an entity-encoded or whitespace-split javascript: URL: %s', (input) => {
    const out = clean(input)
    expect(out).not.toContain('alert(1)')
    expect(out).toContain('<rect')
  })

  it.each([
    `<svg ${NS}><a><animate attributeName="href" values="javascript:alert(1)"/><rect/></a></svg>`,
    `<svg ${NS}><a><set attributeName="onmouseover" to="alert(1)"/><rect/></a></svg>`,
    `<svg ${NS}><a><animate attributeName="xlink:href" to="https://x.example/">x</animate><rect/></a></svg>`,
  ])('3. removes a SMIL animation of a link or an event handler: %s', (input) => {
    const out = clean(input)
    expect(out).not.toContain('alert(1)')
    expect(out).not.toMatch(/<(animate|set)\b/)
    expect(out).toContain('<rect')
  })

  it('3. keeps an ordinary geometry animation', () => {
    const out = clean(`<svg ${NS}><circle r="5"><animate attributeName="r" from="5" to="9" dur="1s"/></circle></svg>`)
    expect(out).toContain('<animate attributeName="r"')
  })

  it.each([
    `<svg ${NS}><a/onmouseover="alert(1)"><rect/></a></svg>`,
    `<svg ${NS}><rect x="1"onclick="alert(1)"/></svg>`,
  ])('4. strips an event handler not preceded by whitespace: %s', (input) => {
    const out = clean(input)
    expect(out).not.toContain('alert(1)')
    expect(out).toContain('<rect')
  })
})
