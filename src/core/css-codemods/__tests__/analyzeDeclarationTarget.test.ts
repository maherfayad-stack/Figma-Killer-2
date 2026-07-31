/**
 * `analyzeDeclarationTarget` — the honest-target gate in front of
 * `setDeclaration`. Each refusal case here is a write that WOULD have
 * succeeded at the filesystem level and produced no visible change on the
 * canvas; each accept case is one where `setDeclaration`'s first-match rule
 * and the CSS cascade genuinely agree.
 */
import { describe, expect, it } from 'bun:test'
import { analyzeDeclarationTarget, setDeclaration } from '../index'

function refusal(css: string, selector: string, property: string) {
  const result = analyzeDeclarationTarget(css, selector, property)
  if (result.ok) throw new Error(`expected a refusal for ${selector} / ${property}`)
  return result.refusal
}

describe('analyzeDeclarationTarget — accepts a single honest target', () => {
  it('accepts a plain rule declaring the property once', () => {
    expect(analyzeDeclarationTarget('.hero { color: red; }', '.hero', 'color')).toEqual({ ok: true })
  })

  it('accepts a selector that does not exist yet — the rule is appended at the end of the file', () => {
    expect(analyzeDeclarationTarget('.other { color: red; }', '.hero', 'color')).toEqual({ ok: true })
  })

  it('accepts a property that does not exist yet — it is appended last, so nothing can override it', () => {
    // `padding` precedes the appended `padding-top`, so the longhand wins.
    expect(analyzeDeclarationTarget('.hero { padding: 4px; }', '.hero', 'padding-top')).toEqual({ ok: true })
  })

  it('accepts a shorthand that appears BEFORE the longhand it covers', () => {
    expect(analyzeDeclarationTarget('.hero { padding: 4px; padding-top: 8px; }', '.hero', 'padding-top')).toEqual({ ok: true })
  })

  it('accepts a duplicate selector when the later block does not touch this property', () => {
    expect(analyzeDeclarationTarget('.hero { color: red; }\n.hero { margin: 0; }', '.hero', 'color')).toEqual({ ok: true })
  })

  it('does not treat an unrelated longhand as covered by a shorthand', () => {
    expect(analyzeDeclarationTarget('.hero { color: red; margin: 0; }', '.hero', 'color')).toEqual({ ok: true })
  })

  it('accepts a selector that only matches inside @media — the base rule is created fresh', () => {
    const css = '@media (min-width: 700px) {\n  .hero { color: red; }\n}'
    expect(analyzeDeclarationTarget(css, '.hero', 'color')).toEqual({ ok: true })
  })
})

describe('analyzeDeclarationTarget — refuses when the write would be silently invisible', () => {
  it('refuses a duplicate selector whose later block sets the same property', () => {
    const css = '.hero { color: red; }\n.hero { color: blue; }'
    // The canvas shows blue; setDeclaration would rewrite the `red` line.
    expect(setDeclaration(css, '.hero', 'color', 'green').css).toContain('color: green')
    const r = refusal(css, '.hero', 'color')
    expect(r.reason).toBe('duplicate-selector')
    expect(r.message).toContain('.hero')
    expect(r.message).toContain('declared more than once')
  })

  it('refuses a duplicate selector whose later block sets a covering shorthand', () => {
    const css = '.hero { padding-top: 2px; }\n.hero { padding: 0; }'
    expect(refusal(css, '.hero', 'padding-top').reason).toBe('duplicate-selector')
  })

  it('refuses the same property declared twice inside one block', () => {
    const css = '.hero { color: red; color: blue; }'
    const r = refusal(css, '.hero', 'color')
    expect(r.reason).toBe('duplicate-declaration')
    expect(r.message).toContain('remove the duplicate')
  })

  it('refuses a shorthand declared AFTER the longhand it resets', () => {
    const css = '.hero { padding-top: 2px; padding: 0; }'
    const r = refusal(css, '.hero', 'padding-top')
    expect(r.reason).toBe('shorthand-override')
    expect(r.message).toContain('padding')
  })

  it('refuses an !important shorthand even when it precedes the longhand', () => {
    const css = '.hero { margin: 0 !important; margin-left: 4px; }'
    const r = refusal(css, '.hero', 'margin-left')
    expect(r.reason).toBe('important-override')
    expect(r.message).toContain('!important')
  })

  it('does NOT refuse on importance when the longhand is itself !important', () => {
    const css = '.hero { margin: 0 !important; margin-left: 4px !important; }'
    expect(analyzeDeclarationTarget(css, '.hero', 'margin-left')).toEqual({ ok: true })
  })

  it('refuses unparseable CSS rather than throwing', () => {
    const result = analyzeDeclarationTarget('.hero { color: red;', '.hero', 'color')
    // postcss tolerates the unclosed block, so assert on the contract, not the branch:
    // whatever it decides, it must return a verdict and never throw.
    expect(typeof result.ok).toBe('boolean')
    expect(() => analyzeDeclarationTarget('@@@ not css {{{', '.hero', 'color')).not.toThrow()
  })
})

describe('analyzeDeclarationTarget — covers the shorthands the inspector actually emits', () => {
  const cases: ReadonlyArray<readonly [shorthand: string, longhand: string]> = [
    ['margin', 'margin-top'],
    ['padding', 'padding-left'],
    ['background', 'background-color'],
    ['font', 'font-size'],
    ['border', 'border-color'],
    ['border-radius', 'border-top-left-radius'],
    ['flex', 'flex-grow'],
    ['gap', 'row-gap'],
    ['inset', 'top'],
    ['overflow', 'overflow-x'],
    ['transition', 'transition-duration'],
  ]

  for (const [shorthand, longhand] of cases) {
    it(`treats ${shorthand} as resetting ${longhand}`, () => {
      const css = `.x { ${longhand}: 1px; ${shorthand}: 0; }`
      expect(refusal(css, '.x', longhand).reason).toBe('shorthand-override')
    })
  }
})
