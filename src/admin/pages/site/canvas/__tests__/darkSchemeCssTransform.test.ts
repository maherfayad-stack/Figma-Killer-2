/**
 * darkSchemeCssTransform.test.ts — WS-10 Phase 1 §3.2/§7.2. Proves the
 * rewrite is specificity-neutral (`:where()`), survives nested at-rules (the
 * risk a naive regex would fail), and never round-trips a whole stylesheet
 * through the CSSOM (which would silently drop any `@layer` content — see
 * the module's own doc for why that landmine matters here).
 */
import { describe, expect, it } from 'bun:test'
import { DARK_SCHEME_ATTR, rewritePrefersColorScheme } from '../darkSchemeCssTransform'

describe('rewritePrefersColorScheme', () => {
  it('rewrites a simple dark media block into a specificity-neutral :where() selector', () => {
    const css = '.btn { padding: 8px; }\n@media (prefers-color-scheme: dark) {\n  .btn { padding: 12px; }\n}\n'
    const out = rewritePrefersColorScheme(css)
    expect(out).toContain('.btn { padding: 8px; }')
    expect(out).not.toContain('@media (prefers-color-scheme: dark)')
    expect(out).toContain(`:where(html[${DARK_SCHEME_ATTR}='dark']) {`)
    expect(out).toContain('.btn { padding: 12px; }')
  })

  it('rewrites a light media block the same way, with the light scheme value', () => {
    const css = '@media (prefers-color-scheme: light) {\n  body { background: white; }\n}\n'
    const out = rewritePrefersColorScheme(css)
    expect(out).toContain(`:where(html[${DARK_SCHEME_ATTR}='light']) {`)
    expect(out).toContain('body { background: white; }')
  })

  it('is specificity-neutral — :where() carries zero specificity regardless of what it wraps', () => {
    const css = '@media (prefers-color-scheme: dark) {\n  #id.class[attr] { color: red; }\n}\n'
    const out = rewritePrefersColorScheme(css)
    // The wrapper itself must be :where(...) — not a bare selector that would
    // add specificity on top of whatever the inner rule already carries.
    expect(out).toMatch(/:where\(html\[data-studio-scheme='dark'\]\) \{/)
  })

  it('preserves a nested at-rule inside the dark block byte-for-byte — the regex failure mode this replaces', () => {
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
    expect(out).toContain('@supports (display: grid) {\n    .grid { display: grid; }\n  }')
    expect(out).toContain('.btn { padding: 12px; }')
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
    expect(out).toContain(`:where(html[${DARK_SCHEME_ATTR}='dark']) {`)
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
    expect(out).toContain(`:where(html[${DARK_SCHEME_ATTR}='dark']) {`)
    expect(out).toContain('.btn { padding: 12px; }')
  })

  it('leaves a compound media condition untouched — only the exact single-feature form is rewritten', () => {
    const css = '@media (min-width: 600px) and (prefers-color-scheme: dark) {\n  .btn { padding: 20px; }\n}\n'
    const out = rewritePrefersColorScheme(css)
    expect(out).toBe(css)
  })

  it('tolerates whitespace and case variation in the media condition', () => {
    const css = '@media  ( PREFERS-COLOR-SCHEME : Dark ) {\n  .btn { padding: 12px; }\n}\n'
    const out = rewritePrefersColorScheme(css)
    expect(out).toContain(`:where(html[${DARK_SCHEME_ATTR}='dark']) {`)
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
    expect(out.match(new RegExp(`:where\\(html\\[${DARK_SCHEME_ATTR}='dark'\\]\\)`, 'g'))).toHaveLength(2)
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
