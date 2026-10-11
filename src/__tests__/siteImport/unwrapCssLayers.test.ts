/**
 * unwrapCssLayers — the postcss-free `@layer` flattening pre-pass.
 *
 * `cssToStyleRules.test.ts` covers it end to end through the CSSOM; these pin
 * the text-level behaviour a brace scanner could get wrong: what it must NOT
 * touch (strings, comments, parens, lookalike at-rules), and unbalanced input.
 */
import { describe, it, expect } from 'bun:test'
import { unwrapCssLayers } from '@core/siteImport/unwrapCssLayers'
import type { ImportWarning } from '@core/siteImport'

function run(css: string): { css: string; warnings: ImportWarning[] } {
  const warnings: ImportWarning[] = []
  return { css: unwrapCssLayers(css, warnings), warnings }
}

describe('unwrapCssLayers', () => {
  it('returns CSS without @layer byte-for-byte', () => {
    const css = '.a{color:red}\n/* @layer in a comment */ .b{content:"@layer x {"}'
    expect(run(css)).toEqual({ css, warnings: [] })
  })

  it('drops a bare statement and keeps the rest of the text', () => {
    expect(run('@layer a, b;\n.x{color:red}').css.trim()).toBe('.x{color:red}')
  })

  it('splices a named block out and leaves its rules in place', () => {
    const { css } = run('.before{a:b}@layer base{.x{color:red}.y{color:blue}}.after{c:d}')
    expect(css).toBe('.before{a:b}.x{color:red}.y{color:blue}.after{c:d}')
  })

  it('unwraps nested layers, and @media in both directions', () => {
    expect(run('@layer a{@layer b{.z{color:green}}}').css).toBe('.z{color:green}')
    expect(run('@media (max-width:1px){@layer l{.m{color:red}}}').css).toBe('@media (max-width:1px){.m{color:red}}')
    expect(run('@layer l{@media (max-width:1px){.n{color:red}}}').css).toBe('@media (max-width:1px){.n{color:red}}')
  })

  it('is not fooled by braces inside strings, comments or url()', () => {
    const { css } = run('@layer l{.a{content:"}";background:url(a}b)}/* } */.b{c:d}}')
    expect(css).toBe('.a{content:"}";background:url(a}b)}/* } */.b{c:d}')
  })

  it('does not treat a lookalike at-rule as a layer rule', () => {
    const css = '@layers{.a{b:c}}'
    expect(run(css).css).toBe(css)
  })

  it('warns on layers written out of declared order', () => {
    const { warnings } = run('@layer base, utilities;@layer utilities{.a{b:c}}@layer base{.a{b:d}}')
    expect(warnings.map((w) => w.kind)).toEqual(['layer-order-flattened'])
  })

  it('hands unbalanced text back untouched with one invalid-rule warning', () => {
    const css = '@layer base{.a{b:c}'
    const { css: out, warnings } = run(css)
    expect(out).toBe(css)
    expect(warnings.map((w) => w.kind)).toEqual(['invalid-rule'])
    expect(run('@layer l{.a{b:c}}}').warnings.map((w) => w.kind)).toEqual(['invalid-rule'])
  })
})
