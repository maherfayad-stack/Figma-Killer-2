import { describe, expect, it } from 'bun:test'
import { buildTokenPreviewCss } from '../tokenPreviewCss'

describe('buildTokenPreviewCss', () => {
  it('restates one declaration under its own gate with a doubled selector', () => {
    expect(buildTokenPreviewCss({ name: '--c', value: ' #fff ', selector: "[data-theme='dark']", atRules: [] })).toBe(
      ":is([data-theme='dark']):is([data-theme='dark']) { --c: #fff; }",
    )
  })

  it('keeps conditional at-rules, outermost first, and drops @layer and @theme', () => {
    const css = buildTokenPreviewCss({
      name: '--c',
      value: 'red',
      selector: ':root',
      atRules: ['@layer base', '@media (prefers-color-scheme: dark)', '@supports (color: red)', '@theme'],
    })
    expect(css).toBe('@media (prefers-color-scheme: dark) { @supports (color: red) { :is(:root):is(:root) { --c: red; } } }')
  })

  it('a declaration straight inside @theme previews on :root', () => {
    expect(buildTokenPreviewCss({ name: '--c', value: 'red', selector: null, atRules: ['@theme'] })).toBe(':is(:root):is(:root) { --c: red; }')
  })

  it('previews nothing for no preview, an empty value, or one that is not a single declaration value', () => {
    expect(buildTokenPreviewCss(null)).toBe('')
    expect(buildTokenPreviewCss({ name: '--c', value: '  ', selector: ':root', atRules: [] })).toBe('')
    expect(buildTokenPreviewCss({ name: '--c', value: 'red; } body { display: none', selector: ':root', atRules: [] })).toBe('')
  })
})
