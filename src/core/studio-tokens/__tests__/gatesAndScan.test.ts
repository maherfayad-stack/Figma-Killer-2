/**
 * Gate classification fixtures: what a declaration's selector and at-rules
 * mean as a MODE, and the gated scan that finds every declaration (not only
 * the cascade winner).
 */
import { describe, expect, it } from 'bun:test'
import { classifyGates, gateKey, gateSelector, isDarkSchemeGate, modeOfGate, scanGatedDeclarations, lineOfOffset } from '..'

const NEWLINE = String.fromCharCode(10)
const keys = (selector: string | null, atRules: string[] = []): string[] => classifyGates(selector, atRules).map(gateKey)

describe('classifyGates', () => {
  it('reads :root, html and body as the base gate, even inside @layer or @supports', () => {
    expect(keys(':root')).toEqual(['base'])
    expect(keys('html')).toEqual(['base'])
    expect(keys(':where(html)')).toEqual(['base'])
    expect(keys(':root', ['@layer base'])).toEqual(['base'])
    expect(keys(':root', ['@supports (color: oklch(0 0 0))'])).toEqual(['base'])
  })

  it('reads attribute, class and :lang gates, with or without a root host prefix', () => {
    expect(keys("[data-theme='dark']")).toEqual(['attr:data-theme=dark'])
    expect(keys(':root[data-theme="dark"]')).toEqual(['attr:data-theme=dark'])
    expect(keys('[dir=rtl]')).toEqual(['attr:dir=rtl'])
    expect(keys(':lang(ar)')).toEqual(['attr:lang=ar'])
    expect(keys('.dark')).toEqual(['class:dark'])
    expect(keys('html.compact')).toEqual(['class:compact'])
  })

  it('reads :not([data-theme=light]) as a negated attribute gate, the dark scheme', () => {
    const [gate] = classifyGates(':root:not([data-theme=light])', [])
    expect(gate).toEqual({ kind: 'attr', attr: 'data-theme', value: 'light', negate: true })
    expect(isDarkSchemeGate(gate!)).toBe(true)
  })

  it('reads a root declaration inside @media as a media gate', () => {
    expect(keys(':root', ['@media (prefers-color-scheme: dark)'])).toEqual(['media:(prefers-color-scheme: dark)'])
    expect(keys(':root', ['@media (min-width: 768px)'])).toEqual(['media:(min-width: 768px)'])
  })

  it('splits a comma group into one gate per segment', () => {
    expect(keys(":root, [data-theme='dark']")).toEqual(['base', 'attr:data-theme=dark'])
  })

  it('treats a component class as a scope, not a mode', () => {
    expect(keys('.btn')).toEqual(['scope:.btn'])
    expect(keys('.card:hover')).toEqual(['scope:.card:hover'])
    expect(keys('[data-theme=dark] .card')).toEqual(['scope:[data-theme=dark] .card'])
  })

  it('treats a declaration straight inside @theme as base', () => {
    expect(keys(null, ['@theme'])).toEqual(['base'])
  })
})

describe('modeOfGate', () => {
  it('groups every dark spelling into the colour-scheme axis', () => {
    const dark = [
      { kind: 'attr', attr: 'data-theme', value: 'dark' },
      { kind: 'class', className: 'dark' },
      { kind: 'media', query: '(prefers-color-scheme: dark)' },
    ] as const
    for (const gate of dark) expect(modeOfGate(gate)).toMatchObject({ axisId: 'color-scheme', modeId: 'dark' })
  })

  it('infers locale, direction, density and breakpoint axes', () => {
    expect(modeOfGate({ kind: 'attr', attr: 'lang', value: 'ar' })).toMatchObject({ axisId: 'locale', modeId: 'ar' })
    expect(modeOfGate({ kind: 'attr', attr: 'dir', value: 'rtl' })).toMatchObject({ axisId: 'direction' })
    expect(modeOfGate({ kind: 'attr', attr: 'data-density', value: 'compact' })).toMatchObject({ axisId: 'density', modeId: 'compact' })
    expect(modeOfGate({ kind: 'media', query: '(min-width: 768px)' })).toMatchObject({ axisId: 'breakpoint' })
  })

  it('has no mode for base or a component scope', () => {
    expect(modeOfGate({ kind: 'base' })).toBeNull()
    expect(modeOfGate({ kind: 'scope', selector: '.btn' })).toBeNull()
  })
})

describe('gateSelector', () => {
  it('writes the selector that declares a gate', () => {
    expect(gateSelector({ kind: 'base' })).toBe(':root')
    expect(gateSelector({ kind: 'attr', attr: 'data-theme', value: 'dark' })).toBe('[data-theme="dark"]')
    expect(gateSelector({ kind: 'attr', attr: 'lang', value: 'ar' })).toBe(':lang(ar)')
    expect(gateSelector({ kind: 'class', className: 'dark' })).toBe('.dark')
  })
})

describe('scanGatedDeclarations', () => {
  const css = [
    '/* tokens */',
    ':root {',
    '  --brand: #0c9ab0; /* teal */',
    '  --surface: var(--brand);',
    '  --font: "A;B", serif;',
    '}',
    "[data-theme='dark'] { --brand: #5fd3e4 }",
    '@media (min-width: 768px) { :root { --gap: 24px } }',
    '@layer base { :root { --layered: 1px } }',
    '@theme { --color-accent: red; }',
    '@keyframes spin { from { --nope: 1 } }',
    '.btn { --btn-pad: 8px; color: red; }',
    '',
  ].join('\n')

  it('finds every declaration with its gate, in source order', () => {
    const found = scanGatedDeclarations(css).map((d) => `${d.name}|${gateKey(d.gate)}|${d.raw}`)
    expect(found).toEqual([
      '--brand|base|#0c9ab0',
      '--surface|base|var(--brand)',
      '--font|base|"A;B", serif',
      '--brand|attr:data-theme=dark|#5fd3e4',
      '--gap|media:(min-width: 768px)|24px',
      '--layered|base|1px',
      '--color-accent|base|red',
      '--btn-pad|scope:.btn|8px',
    ])
  })

  it('flags @theme declarations', () => {
    const accent = scanGatedDeclarations(css).find((d) => d.name === '--color-accent')!
    expect(accent.inTheme).toBe(true)
    expect(accent.selector).toBeNull()
  })

  it('reports offsets that map back to the declaration line', () => {
    const lines = css.split('\n')
    for (const d of scanGatedDeclarations(css)) {
      expect(lines[lineOfOffset(css, d.offset) - 1]).toContain(d.name)
    }
  })

  it('emits one declaration per gate of a comma group', () => {
    const found = scanGatedDeclarations(":root, [data-theme='dark'] { --x: 1px }")
    expect(found.map((d) => gateKey(d.gate))).toEqual(['base', 'attr:data-theme=dark'])
  })

  it('ignores declarations inside a nested block of a rule', () => {
    const found = scanGatedDeclarations('.a { --outer: 1px; .b { --inner: 2px } }')
    expect(found.map((d) => d.name)).toEqual(['--outer'])
  })

  it('does not let a statement at-rule (@import, @charset, @layer a, b;) glue itself onto the next rule', () => {
    const css = ['@charset "utf-8";', '@import url("a;b.css");', '@layer reset, base;', ':root { --a: 1px }', '@theme { --b: 2px }'].join(NEWLINE)
    const found = scanGatedDeclarations(css)
    expect(found.map((d) => [d.name, gateKey(d.gate), d.inTheme])).toEqual([['--a', 'base', false], ['--b', 'base', true]])
  })

  it('never throws on unbalanced input', () => {
    expect(() => scanGatedDeclarations(':root { --a: 1px; ')).not.toThrow()
    expect(() => scanGatedDeclarations('} } {{')).not.toThrow()
  })
})
