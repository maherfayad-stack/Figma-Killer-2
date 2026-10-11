/**
 * textStyleDiscovery - the pure rules for what counts as a text or effect style.
 * (The same rules over a real parse of `.css` and `*.module.css` files are in
 * `src/__tests__/editor-store/textStylesRealSource.test.ts`.)
 */
import { describe, expect, it } from 'bun:test'
import type { StyleRule } from '@core/page-tree'
import { cssValueText, discoverStyles, summarizeStyle } from '../textStyleDiscovery'

function rule(name: string, styles: Record<string, unknown>, extra: Partial<StyleRule> = {}): StyleRule {
  return { id: name, name, kind: 'class', selector: `.${name}`, order: 0, styles, contextStyles: {}, createdAt: 0, updatedAt: 0, ...extra }
}
const rules = (...list: StyleRule[]) => Object.fromEntries(list.map((r) => [r.id, r]))
const labels = (list: readonly { label: string }[]) => list.map((s) => s.label)

describe('discoverStyles', () => {
  it('needs a core typography declaration and nothing but typography', () => {
    const found = discoverStyles(
      rules(
        rule('h1', { fontSize: '2rem', fontWeight: 700 }),
        rule('with-colour', { fontSize: '1rem', lineHeight: 1.5, color: 'red', textAlign: 'center' }),
        rule('layout', { display: 'flex', fontSize: '1rem', lineHeight: 1.5 }),
        rule('align-only', { textAlign: 'center', color: 'red' }),
      ),
    )
    expect(labels(found.text)).toEqual(['h1', 'with-colour'])
  })

  it('a one-declaration size class is a utility, not a style', () => {
    expect(discoverStyles(rules(rule('text-lg', { fontSize: '18px' }))).text).toEqual([])
  })

  it('effects are only shadows and blurs, and text-shadow alone is not an effect style', () => {
    const found = discoverStyles(
      rules(
        rule('shadow-md', { boxShadow: '0 2px 4px #000' }),
        rule('glass', { backdropFilter: 'blur(8px)', boxShadow: 'inset 0 0 0 1px #fff' }),
        rule('glow', { textShadow: '0 0 4px #fff' }),
        rule('shadow-and-radius', { boxShadow: '0 1px #000', borderRadius: '4px' }),
      ),
    )
    expect(labels(found.effect)).toEqual(['glass', 'shadow-md'])
  })

  it('shows a CSS Module class by its local name and skips generated, ambient, at-rule and excluded rules', () => {
    const found = discoverStyles(
      rules(
        rule('Card_title__a1b2c', { fontSize: '20px', lineHeight: 1.3 }, { displayName: 'title' }),
        rule('text-size-lg', { fontSize: '20px', lineHeight: 1.3 }, { generated: { origin: 'framework' } as StyleRule['generated'] }),
        rule('h2', { fontSize: '20px', lineHeight: 1.3 }, { kind: 'ambient', selector: 'h2' }),
        rule('kf', { fontSize: '20px', lineHeight: 1.3 }, { rawCss: '@keyframes x {}' }),
        rule('styled_sc__x', { fontSize: '20px', lineHeight: 1.3 }),
      ),
      { excludedRuleIds: new Set(['styled_sc__x']) },
    )
    expect(labels(found.text)).toEqual(['title'])
  })

  it('records a breakpoint override and judges it on its own declarations', () => {
    const responsive = rule('fluid', { fontSize: '2rem', lineHeight: 1.1 }, { contextStyles: { mobile: { fontSize: '1.5rem' } } })
    const polluted = rule('moves', { fontSize: '2rem', lineHeight: 1.1 }, { contextStyles: { mobile: { display: 'none' } } })
    const found = discoverStyles(rules(responsive, polluted))
    expect(found.text.map((s) => [s.label, s.hasContextOverrides])).toEqual([['fluid', true]])
  })
})

describe('cssValueText', () => {
  it('turns a React pixel number into CSS text and keeps unitless properties bare', () => {
    expect(cssValueText('fontSize', 40)).toBe('40px')
    expect(cssValueText('fontSize', 0)).toBe('0')
    expect(cssValueText('lineHeight', 1.5)).toBe('1.5')
    expect(cssValueText('fontWeight', 700)).toBe('700')
    expect(cssValueText('fontSize', '  ')).toBeNull()
    expect(cssValueText('fontSize', undefined)).toBeNull()
  })
})

describe('summarizeStyle', () => {
  it('reads family, weight and size / line height for text, and the first value for an effect', () => {
    const [text] = discoverStyles(rules(rule('h', { fontFamily: "'Inter', sans-serif", fontWeight: '700', fontSize: '32px', lineHeight: '1.2' }))).text
    expect(summarizeStyle(text!)).toBe('Inter · 700 · 32px / 1.2')
    const [effect] = discoverStyles(rules(rule('s', { boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)' }))).effect
    expect(summarizeStyle(effect!)).toBe('0 1px 2px rgba(0, 0, 0, 0.2)')
  })

  it('names a token instead of printing var() syntax', () => {
    const [text] = discoverStyles(rules(rule('h', { fontFamily: 'var(--font-display, serif)', fontWeight: '700', fontSize: 'var(--step-3)', lineHeight: '1.2' }))).text
    expect(summarizeStyle(text!)).toBe('font-display · 700 · step-3 / 1.2')
  })
})
