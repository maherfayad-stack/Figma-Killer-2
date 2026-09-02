/**
 * darkSchemeCssTransform.test.ts — WS-10 Phase 1 §3.2/§7.2. Proves the
 * rewrite gates each rule on the Studio-controlled attribute without changing
 * specificity, survives nested at-rules (the risk a naive regex would fail),
 * and never round-trips a whole stylesheet through the CSSOM (which would
 * silently drop any `@layer` content — see the module's own doc).
 *
 * The `:root` cases are a REGRESSION suite, not a nicety. The rewrite used to
 * wrap a whole media block in `:where(html[…]) { … }` and let CSS nesting
 * scope it, which inserts a DESCENDANT combinator — so the single most common
 * dark-mode rule there is, `@media (prefers-color-scheme: dark) { :root { … } }`,
 * compiled to `:where(html[…]) :root` and matched NOTHING (`:root` is `<html>`,
 * and `<html>` is not its own descendant). Every project whose dark palette
 * lives on `:root` — which is most of them, including the ALM design system
 * this was found against — previewed permanently light.
 */
import { describe, expect, it } from 'bun:test'
import { DARK_SCHEME_ATTR, gateSelectorList, rewritePrefersColorScheme } from '../darkSchemeCssTransform'

const GATE = `html[${DARK_SCHEME_ATTR}='dark']`

describe('gateSelectorList', () => {
  it('emits both a descendant-of-root and an is-root form for an ordinary selector', () => {
    expect(gateSelectorList('.btn', GATE)).toBe(
      `:where(${GATE}) .btn, .btn:where(${GATE})`,
    )
  })

  it('gates each selector of a list independently', () => {
    expect(gateSelectorList('.a, .b', GATE)).toBe(
      `:where(${GATE}) .a, .a:where(${GATE}), :where(${GATE}) .b, .b:where(${GATE})`,
    )
  })

  it('does not split on a comma nested inside :is() or an attribute value', () => {
    expect(gateSelectorList(':is(.a, .b)', GATE)).toBe(
      `:where(${GATE}) :is(.a, .b), :is(.a, .b):where(${GATE})`,
    )
    expect(gateSelectorList('[data-x="a,b"]', GATE)).toBe(
      `:where(${GATE}) [data-x="a,b"], [data-x="a,b"]:where(${GATE})`,
    )
  })

  it('emits ONLY the descendant form for a pseudo-element selector', () => {
    // `.a::before:where(…)` is invalid — nothing may follow a pseudo-element —
    // and one invalid selector invalidates the entire list, dropping the rule.
    expect(gateSelectorList('.a::before', GATE)).toBe(`:where(${GATE}) .a::before`)
  })
})

describe('rewritePrefersColorScheme', () => {
  it('gates a simple dark media block on the studio scheme attribute', () => {
    const css = '.btn { padding: 8px; }\n@media (prefers-color-scheme: dark) {\n  .btn { padding: 12px; }\n}\n'
    const out = rewritePrefersColorScheme(css)
    expect(out).toContain('.btn { padding: 8px; }')
    expect(out).not.toContain('@media (prefers-color-scheme: dark)')
    expect(out).toContain(`:where(${GATE}) .btn, .btn:where(${GATE}) { padding: 12px; }`)
  })

  it('gates a light media block the same way, with the light scheme value', () => {
    const css = '@media (prefers-color-scheme: light) {\n  body { background: white; }\n}\n'
    const out = rewritePrefersColorScheme(css)
    expect(out).toContain(`:where(html[${DARK_SCHEME_ATTR}='light']) body`)
    expect(out).toContain('{ background: white; }')
  })

  it('keeps a :root rule matching the root element (regression — see this file\'s doc)', () => {
    const css = '@media (prefers-color-scheme: dark) {\n  :root { --bg: black; }\n}\n'
    const out = rewritePrefersColorScheme(css)
    // The is-root form is the one that does the work here; without it the rule
    // is dead CSS.
    expect(out).toContain(`:root:where(${GATE})`)
    expect(out).toContain('{ --bg: black; }')
  })

  it('keeps a :root rule with a :not() qualifier matching — the exact ALM design-system shape', () => {
    const css = '@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) { --c: #fff; }\n}\n'
    const out = rewritePrefersColorScheme(css)
    expect(out).toContain(`:root:not([data-theme="light"]):where(${GATE})`)
  })

  it('keeps an `html` selector matching the root element too', () => {
    const css = '@media (prefers-color-scheme: dark) {\n  html { color-scheme: dark; }\n}\n'
    const out = rewritePrefersColorScheme(css)
    expect(out).toContain(`html:where(${GATE})`)
  })

  it('is specificity-neutral — :where() carries zero specificity regardless of what it wraps', () => {
    const css = '@media (prefers-color-scheme: dark) {\n  #id.class[attr] { color: red; }\n}\n'
    const out = rewritePrefersColorScheme(css)
    // Both emitted forms must use :where(), never a bare selector that would
    // add specificity on top of whatever the inner rule already carries.
    expect(out).toContain(`:where(${GATE}) #id.class[attr]`)
    expect(out).toContain(`#id.class[attr]:where(${GATE})`)
    expect(out).not.toMatch(/(?<!:where\()html\[data-studio-scheme='dark'\] #id/)
  })

  it('recurses into a nested at-rule, preserving its prelude and gating its rules', () => {
    // A naive non-greedy regex (`/@media[^{]*\{[\s\S]*?\}/`) would stop at the
    // FIRST `}` here (the @supports block's own close), truncating the outer
    // block and leaving a dangling, unbalanced fragment. A greedy regex would
    // instead over-consume to the LAST `}` in the whole file. Neither is safe.
    const css = [
      '@media (prefers-color-scheme: dark) {',
      '  @supports (display: grid) {',
      '    .grid { display: grid; }',
      '  }',
      '  .btn { padding: 12px; }',
      '}',
      '.after { color: blue; }',
    ].join('\n')
    const out = rewritePrefersColorScheme(css)
    expect(out).toContain('@supports (display: grid) {')
    // The at-rule's own prelude survives; the rule INSIDE it is gated, because
    // a nested at-rule does not exempt its contents from the scheme condition.
    expect(out).toContain(`:where(${GATE}) .grid, .grid:where(${GATE}) { display: grid; }`)
    expect(out).toContain(`:where(${GATE}) .btn, .btn:where(${GATE}) { padding: 12px; }`)
    expect(out).toContain('.after { color: blue; }')
    expect(out).not.toContain('@media (prefers-color-scheme: dark)')
  })

  it('leaves an @layer wrapper elsewhere in the file completely untouched', () => {
    // happy-dom's CSSOM does not support @layer at all and silently drops any
    // rule parsed inside one — this proves the transform never round-trips
    // the WHOLE file through that CSSOM (only isolated candidate spans).
    const css = [
      '@layer base, components;',
      '@layer base {',
      '  body { margin: 0; }',
      '}',
      '@media (prefers-color-scheme: dark) {',
      '  .btn { padding: 12px; }',
      '}',
    ].join('\n')
    const out = rewritePrefersColorScheme(css)
    expect(out).toContain('@layer base, components;')
    expect(out).toContain('@layer base {\n  body { margin: 0; }\n}')
    expect(out).toContain(`:where(${GATE}) .btn`)
  })

  it('rewrites a dark block nested INSIDE an @layer block, leaving the layer wrapper intact', () => {
    const css = [
      '@layer base {',
      '  @media (prefers-color-scheme: dark) {',
      '    .btn { padding: 12px; }',
      '  }',
      '}',
    ].join('\n')
    const out = rewritePrefersColorScheme(css)
    expect(out).toContain('@layer base {')
    expect(out).toContain(`:where(${GATE}) .btn, .btn:where(${GATE}) { padding: 12px; }`)
  })

  it('leaves a compound media condition untouched — only the exact single-feature form is rewritten', () => {
    const css = '@media (min-width: 600px) and (prefers-color-scheme: dark) {\n  .btn { padding: 20px; }\n}\n'
    const out = rewritePrefersColorScheme(css)
    expect(out).toBe(css)
  })

  it('tolerates whitespace and case variation in the media condition', () => {
    const css = '@media  ( PREFERS-COLOR-SCHEME : Dark ) {\n  .btn { padding: 12px; }\n}\n'
    const out = rewritePrefersColorScheme(css)
    expect(out).toContain(`:where(${GATE}) .btn`)
  })

  it('does not touch text that only LOOKS like a dark media query inside a comment', () => {
    const css = '/* @media (prefers-color-scheme: dark) { .x { color: red; } } */\n.btn { padding: 8px; }\n'
    const out = rewritePrefersColorScheme(css)
    expect(out).toBe(css)
  })

  it('does not touch a string value containing the literal text', () => {
    const css = '.icon::before { content: "@media (prefers-color-scheme: dark) { }"; }\n'
    const out = rewritePrefersColorScheme(css)
    expect(out).toBe(css)
  })

  it('rewrites multiple independent dark blocks, leaving the CSS between them untouched', () => {
    const css = [
      '@media (prefers-color-scheme: dark) { .a { color: white; } }',
      '.between { color: green; }',
      '@media (prefers-color-scheme: dark) { .b { color: white; } }',
    ].join('\n')
    const out = rewritePrefersColorScheme(css)
    expect(out).toContain('.between { color: green; }')
    expect(out).toContain(`:where(${GATE}) .a, .a:where(${GATE})`)
    expect(out).toContain(`:where(${GATE}) .b, .b:where(${GATE})`)
  })

  it('is a no-op (same string) when the CSS has no prefers-color-scheme query', () => {
    const css = '.btn { padding: 8px; }\n@media (min-width: 600px) { .btn { padding: 16px; } }\n'
    expect(rewritePrefersColorScheme(css)).toBe(css)
  })

  it('leaves malformed (unbalanced) dark media CSS untouched rather than corrupting it', () => {
    const css = '@media (prefers-color-scheme: dark) {\n  .btn { padding: 12px; }\n'
    expect(rewritePrefersColorScheme(css)).toBe(css)
  })
})
