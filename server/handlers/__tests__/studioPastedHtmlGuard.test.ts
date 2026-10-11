/**
 * studioPastedHtmlGuard - adversarial cases from the security review of G-10.
 * The guard is the server's only defence for a tree it cannot sanitize, so each
 * case is a way a lookup keyed on the wrong spelling would have let a script URL
 * through: attribute case, SVG's own URL attributes, animation, a control
 * character before the scheme.
 */
import { describe, expect, it } from 'bun:test'
import { isSafeUrl } from '@core/html-sanitize'
import { guardPastedNodes, type PastedNode } from '../studioPastedHtmlGuard'

const refused = (node: PastedNode) => expect(guardPastedNodes([node]).ok).toBe(false)
const accepted = (node: PastedNode) => expect(guardPastedNodes([node])).toEqual({ ok: true })
const SCRIPT = 'javascript:alert(1)'

describe('URL props are judged whatever their case', () => {
  for (const name of ['HREF', 'Href', 'href']) it(`${name} on an anchor`, () => refused({ name: 'a', props: { [name]: SCRIPT } }))
  for (const name of ['SRC', 'Src']) it(`${name} on a media element`, () => refused({ name: 'video', props: { [name]: SCRIPT } }))
  for (const name of ['ACTION', 'Action', 'action']) it(`${name} on a form`, () => refused({ name: 'form', props: { [name]: SCRIPT } }))
  for (const name of ['formaction', 'FORMACTION', 'formAction']) it(`${name} on a button`, () => refused({ name: 'button', props: { [name]: SCRIPT } }))
  it('POSTER, SRCSET and a scheme in a srcset candidate', () => {
    refused({ name: 'video', props: { POSTER: SCRIPT } })
    refused({ name: 'img', props: { SrcSet: `ok.png 1x, ${SCRIPT} 2x` } })
  })
  it('still accepts ordinary URLs in any case', () => {
    accepted({ name: 'a', props: { HREF: '/menu', title: 'x' } })
    accepted({ name: 'img', props: { Src: 'data:image/png;base64,iVBORw0KGgo=' } })
  })
})

describe('SVG URL props', () => {
  it('xlinkHref on <a> and <use>, in any case', () => {
    refused({ name: 'a', props: { xlinkHref: SCRIPT } })
    refused({ name: 'use', props: { XLINKHREF: SCRIPT } })
    refused({ name: 'a', props: { xlinkhref: ' \u0001JaVaScRiPt:alert(1)' } })
  })
  it('<use> and gradients may only point at a fragment of the same graphic', () => {
    refused({ name: 'use', props: { href: 'https://evil.example/sprite.svg#a' } })
    refused({ name: 'linearGradient', props: { xlinkHref: '/other.svg#g' } })
    accepted({ name: 'use', props: { href: '#icon-star' } })
  })
  it('<animate>/<set> values, to, from and by that carry a script URL', () => {
    refused({ name: 'animate', props: { attributeName: 'href', values: `#a;${SCRIPT}` } })
    refused({ name: 'set', props: { attributeName: 'xlink:href', to: SCRIPT } })
    refused({ name: 'animateMotion', props: { from: SCRIPT } })
    refused({ name: 'animateTransform', props: { by: SCRIPT } })
    refused({ name: 'animate', props: { VALUES: SCRIPT } })
  })
  it('a plain animation still pastes', () => {
    accepted({ name: 'animate', props: { attributeName: 'opacity', values: '0;1;0', dur: '2s', repeatCount: 'indefinite' } })
  })
  it('refuses <math> and <foreignObject> outright', () => {
    refused({ name: 'math' })
    refused({ name: 'foreignObject', children: [{ name: 'div' }] })
  })
})

describe('the allowlist', () => {
  it('refuses a prop it does not know, whatever its case', () => {
    refused({ name: 'div', props: { 'on-click': 'x' } })
    refused({ name: 'div', props: { ONCLICK: 'x' } })
    refused({ name: 'div', props: { SrcDoc: '<script>1</script>' } })
    refused({ name: 'div', props: { DangerouslySetInnerHTML: { __html: 'x' } } })
    refused({ name: 'div', props: { Key: 'x' } })
    refused({ name: 'div', props: { somethingNew: 'x' } })
  })
  it('accepts data-* and aria-*, and the ordinary attributes in JSX spelling', () => {
    accepted({ name: 'input', props: { 'data-x': '1', 'aria-label': 'x', defaultValue: 'a', maxLength: '8', readOnly: true, autoComplete: 'off' } })
    accepted({ name: 'path', props: { d: 'M0 0', strokeWidth: '2', fillRule: 'evenodd', viewBox: '0 0 1 1' } })
  })
})

describe('size is bounded before the walk goes deep', () => {
  it('refuses a paste whose summed text is past the budget', () => {
    const big = 'x'.repeat(200_000)
    const children = Array.from({ length: 8 }, () => ({ name: 'p', children: big }))
    refused({ name: 'div', children })
  })
})

describe('isSafeUrl strips what a browser strips before the scheme', () => {
  it('leading control characters, spaces, and tab/newline anywhere', () => {
    for (const url of ['\u0001javascript:alert(1)', '\u0000\u001f javascript:x', ' \u0007VBSCRIPT:x', 'java\nscript:x', '\tdata:text/html,x']) {
      expect(isSafeUrl(url)).toBe(false)
    }
    expect(isSafeUrl('/javascript:not-a-scheme')).toBe(true)
    expect(isSafeUrl('https://example.org')).toBe(true)
  })
})
