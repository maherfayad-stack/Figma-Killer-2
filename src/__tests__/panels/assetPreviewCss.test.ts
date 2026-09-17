/**
 * assetPreviewCss — the design-system stylesheet, rewritten for a shadow root.
 *
 * The risk this guards is one-directional and expensive: the design system's
 * class names are unprefixed (`.btn`, `.card`), so a sheet that reached the
 * admin document would restyle the editor itself. Hence the shadow root — and
 * hence these cases, which pin the three edits that make the sheet legal
 * inside one.
 */
import { describe, expect, it } from 'bun:test'
import { transformDesignSystemCssForShadow } from '@site/panels/AssetsPanel/assetPreviewCss'

describe('transformDesignSystemCssForShadow', () => {
  it('rewrites :root token declarations onto :host', () => {
    const out = transformDesignSystemCssForShadow(':root { --color-a: #fff; }')

    expect(out).toContain(':host {')
    expect(out).not.toContain(':root')
    expect(out).toContain('--color-a: #fff;')
  })

  it('carries a :root attribute gate into the functional :host form', () => {
    const out = transformDesignSystemCssForShadow(':root[data-theme="dark"] { --color-a: #000; }')

    expect(out).toContain(':host([data-theme="dark"])')
  })

  it('carries a :root :not() gate too — the light-by-default convention', () => {
    const out = transformDesignSystemCssForShadow(':root:not([data-theme=light]) { --x: 1; }')

    expect(out).toContain(':host(:not([data-theme=light]))')
  })

  it('drops page-level body and html rules', () => {
    const out = transformDesignSystemCssForShadow(
      'body { margin: 0; }\nhtml { min-height: 100%; }\nhtml, body { background: red; }',
    )

    expect(out.trim()).toBe('')
  })

  it('keeps a component rule that merely mentions body in a descendant selector', () => {
    const out = transformDesignSystemCssForShadow('body .btn { color: red; }')

    expect(out).toContain('body .btn')
  })

  it('keeps every other rule verbatim', () => {
    const out = transformDesignSystemCssForShadow('.btn { padding: 4px; }\n.card > .title { font-weight: 600; }')

    expect(out).toContain('.btn {')
    expect(out).toContain('padding: 4px;')
    expect(out).toContain('.card > .title {')
  })

  it('transforms rules nested inside a media query', () => {
    const out = transformDesignSystemCssForShadow(
      '@media (min-width: 600px) { :root { --gap: 8px; } body { margin: 0; } .btn { gap: 2px; } }',
    )

    expect(out).toContain('@media (min-width: 600px)')
    expect(out).toContain(':host {')
    expect(out).toContain('.btn {')
    expect(out).not.toContain('body')
  })

  it('leaves keyframes and font-face blocks untouched', () => {
    const out = transformDesignSystemCssForShadow(
      '@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }\n' +
        "@font-face { font-family: 'X'; src: url(x.woff2); }",
    )

    expect(out).toContain('@keyframes spin')
    expect(out).toContain('from {')
    expect(out).toContain('@font-face')
    expect(out).toContain("font-family: 'X';")
  })

  it('keeps a block-less at-rule', () => {
    const out = transformDesignSystemCssForShadow('@layer base, components;\n.btn { color: red; }')

    expect(out).toContain('@layer base, components;')
    expect(out).toContain('.btn {')
  })

  it('strips comments rather than letting a brace inside one derail the scan', () => {
    const out = transformDesignSystemCssForShadow('/* a { fake } rule */ .btn { color: red; }')

    expect(out).toContain('.btn {')
    expect(out).not.toContain('fake')
  })
})
