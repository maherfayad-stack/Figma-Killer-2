/**
 * The one attribute-name mapping, read both ways, and the one reference
 * policy (same-document fragments only).
 */
import { describe, expect, it } from 'bun:test'
import {
  cssValueLoadsExternalResource,
  isSvgFragmentReference,
  jsxToMarkupAttributeName,
  markupToJsxAttributeName,
} from '@core/vector'

describe('svgAttributeNames', () => {
  it.each([
    ['class', 'className'],
    ['stroke-width', 'strokeWidth'],
    ['viewBox', 'viewBox'],
    ['preserveAspectRatio', 'preserveAspectRatio'],
    ['xlink:href', 'xlinkHref'],
    ['xml:space', 'xmlSpace'],
    ['xmlns:xlink', 'xmlnsXlink'],
    ['tabindex', 'tabIndex'],
    ['data-name', 'data-name'],
    ['aria-hidden', 'aria-hidden'],
    ['fill', 'fill'],
  ])('%s ⇄ %s, both ways', (markup, jsx) => {
    expect(markupToJsxAttributeName(markup)).toBe(jsx)
    expect(jsxToMarkupAttributeName(jsx)).toBe(markup)
  })

  it('has no JSX spelling for a namespaced attribute React does not alias', () => {
    expect(markupToJsxAttributeName('sodipodi:docname')).toBeUndefined()
    expect(markupToJsxAttributeName('inkscape:label')).toBeUndefined()
  })
})

describe('isSvgFragmentReference', () => {
  it.each(['#a', '#paint0_linear-k3f9', '#icon.close'])('accepts %s', (value) => {
    expect(isSvgFragmentReference(value)).toBe(true)
  })

  it.each([
    '#',
    ' #a',
    '#a ',
    'a#b',
    'https://evil.test/x.svg#a',
    'data:image/svg+xml,<svg/>#a',
    'javascript:steal()',
    '#javascript:steal()',
    '#a/b',
    '#a?b',
    String.fromCharCode(0x2028) + '#a',
  ])('refuses %j', (value) => {
    expect(isSvgFragmentReference(value)).toBe(false)
  })
})

describe('cssValueLoadsExternalResource', () => {
  it.each(['url(#g)', 'url("#g")', " url( '#grad-1' ) ", 'url("data:image/png;base64,AA==")', '#fff', 'currentColor', 'none', 'rgb(0 0 0 / 50%)', 'var(--x)'])(
    'lets %j through',
    (value) => {
      expect(cssValueLoadsExternalResource(value)).toBe(false)
    },
  )

  it.each([
    'url(https://evil.test/beacon)',
    'url("//evil.test/x")',
    'url(data:text/html,<script>steal()</script>)',
    'url(/local.png)',
    'URL(https://evil.test/x)',
    '\\75 rl(https://evil.test/x)',
    'u\\72l(https://evil.test/x)',
    'url(#ok) url(https://evil.test/x)',
    'image-set("a.png" 1x)',
    '-webkit-image-set(url(#a) 1x)',
    'url(#unterminated',
  ])('refuses %j', (value) => {
    expect(cssValueLoadsExternalResource(value)).toBe(true)
  })
})
