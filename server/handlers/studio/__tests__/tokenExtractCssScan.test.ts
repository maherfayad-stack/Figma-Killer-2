/**
 * tokenExtractCssScan.ts — `collectRootScopeMaps`'s at-rule descent and dark-
 * selector recognition.
 *
 * The fixtures below mirror shapes actually shipped in
 * `node_modules/@alm-design/design-system/dist/index.css` — every
 * `prefers-color-scheme:dark` block in that file is
 * `@media (prefers-color-scheme:dark){:root:not([data-theme=light]){…}}`,
 * confirmed by direct inspection of the compiled CSS before this file's fix
 * landed (six such blocks; the old scanner treated the whole `@media{…}` as
 * one opaque top-level rule and contributed NOTHING from any of them, to
 * either the light or dark map).
 */
import { describe, expect, it } from 'bun:test'
import { classifyCssText, classifyDesignTokenFamily, collectRootScopeMaps, detectRootFontSizePx, toPx } from '../tokenExtractCssScan'

describe('collectRootScopeMaps — at-rule descent', () => {
  it('descends into @media (prefers-color-scheme:dark) and classifies a nested :root:not([data-theme=light]) as dark (the real design-system shape)', () => {
    const css = '@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--a:#111}}'
    const { light, dark } = collectRootScopeMaps(css)
    expect(dark.get('--a')).toBe('#111')
    expect(light.has('--a')).toBe(false)
  })

  it('classifies a bare :root nested under prefers-color-scheme:dark as dark, even though a bare :root at top level (or under @layer) is light', () => {
    const css = '@media (prefers-color-scheme:dark){:root{--a:#111}}'
    const { light, dark } = collectRootScopeMaps(css)
    expect(dark.get('--a')).toBe('#111')
    expect(light.has('--a')).toBe(false)
  })

  it('classifies a :root nested under prefers-color-scheme:light as light', () => {
    const css = '@media (prefers-color-scheme:light){:root{--a:#eee}}'
    const { light, dark } = collectRootScopeMaps(css)
    expect(light.get('--a')).toBe('#eee')
    expect(dark.has('--a')).toBe(false)
  })

  it('descends into @layer with no colour-scheme prelude and classifies its own :root as light, exactly as an unwrapped top-level rule would (Tailwind v4 token host)', () => {
    const css = '@layer theme{:root{--a:#111}}'
    const { light, dark } = collectRootScopeMaps(css)
    expect(light.get('--a')).toBe('#111')
    expect(dark.has('--a')).toBe(false)
  })

  it('propagates colour-scheme context through nested @layer wrappers — @layer a { @media (prefers-color-scheme:dark) { @layer b { :root {...} } } } still lands in dark', () => {
    const css = '@layer a{@media (prefers-color-scheme:dark){@layer b{:root{--a:#111}}}}'
    const { light, dark } = collectRootScopeMaps(css)
    expect(dark.get('--a')).toBe('#111')
    expect(light.has('--a')).toBe(false)
  })

  it('terminates on deeply/pathologically nested at-rules instead of hanging or overflowing the stack', () => {
    const depth = 5000
    const css = '@media (prefers-color-scheme:dark){'.repeat(depth) + ':root{--a:#111}' + '}'.repeat(depth)
    // Must simply return — the recursion ceiling (`MAX_AT_RULE_DEPTH`) stops
    // descent long before `depth`, so the innermost `:root` is never reached
    // and neither map gets `--a`. The point of this test is that the call
    // completes at all, not any particular result for input this hostile.
    const { light, dark } = collectRootScopeMaps(css)
    expect(light.has('--a')).toBe(false)
    expect(dark.has('--a')).toBe(false)
  })
})

describe('collectRootScopeMaps — Tailwind v4 @theme (T6, STUDIO-FIGMA-PARITY-PLAN.md §11)', () => {
  it('collects a bare @theme block directly — no nested :root selector exists in real Tailwind v4 output', () => {
    const css = '@theme{--color-brand:#0c9ab0;--font-sans:ui-sans-serif, system-ui, sans-serif;}'
    const { light, dark } = collectRootScopeMaps(css)
    expect(light.get('--color-brand')).toBe('#0c9ab0')
    expect(light.get('--font-sans')).toBe('ui-sans-serif, system-ui, sans-serif')
    expect(dark.size).toBe(0)
  })

  it('collects @theme inline / @theme reference / @theme static — every declared modifier form', () => {
    for (const modifier of ['inline', 'reference', 'static']) {
      const { light } = collectRootScopeMaps(`@theme ${modifier}{--a:#111}`)
      expect(light.get('--a')).toBe('#111')
    }
  })

  it('a realistic Tailwind v4 stylesheet — @layer theme, base, components, utilities; followed by @theme — imports the theme block', () => {
    const css = [
      '@layer theme, base, components, utilities;',
      '@layer theme{@theme{--color-brand:#0c9ab0;--radius-md:8px}}',
      '@layer base{*{box-sizing:border-box}}',
    ].join('\n')
    const { light } = collectRootScopeMaps(css)
    expect(light.get('--color-brand')).toBe('#0c9ab0')
    expect(light.get('--radius-md')).toBe('8px')
  })

  it('a colour-scheme-only @media wrapping @theme routes its declarations to dark', () => {
    const css = '@media (prefers-color-scheme:dark){@theme{--color-brand:#0a7f92}}'
    const { light, dark } = collectRootScopeMaps(css)
    expect(dark.get('--color-brand')).toBe('#0a7f92')
    expect(light.has('--color-brand')).toBe(false)
  })

  it('is unconditional even at top level, with no surrounding @layer at all', () => {
    const { light } = collectRootScopeMaps('@theme{--space-md:16px}')
    expect(light.get('--space-md')).toBe('16px')
  })
})

describe('classifyDesignTokenFamily — the 9-way classifier behind the new DesignToken model (T6/T12)', () => {
  it('promotes radius (--rounded-*, not just --radius-*, matching designSystemDigest.ts before this change)', () => {
    expect(classifyDesignTokenFamily('--rounded-md', '8px')).toBe('radius')
    expect(classifyDesignTokenFamily('--radius-sm', '4px')).toBe('radius')
  })

  it('promotes elevation by name — a shadow shorthand has no single-literal shape to test by value', () => {
    expect(classifyDesignTokenFamily('--shadow-md', '0px 4px 16px rgba(0,0,0,0.2)')).toBe('elevation')
    expect(classifyDesignTokenFamily('--elevation-2', '0px 2px 4px rgba(0,0,0,0.1)')).toBe('elevation')
  })

  it('splits typography-detail into its own real families instead of one discard bucket', () => {
    expect(classifyDesignTokenFamily('--type-headline-family', "'Open Sans', system-ui")).toBe('font-family')
    expect(classifyDesignTokenFamily('--type-headline-weight', '700')).toBe('font-weight')
    expect(classifyDesignTokenFamily('--type-headline-lh', '40px')).toBe('line-height')
    expect(classifyDesignTokenFamily('--type-headline-ls', '0.02em')).toBe('letter-spacing')
  })

  it('names a Tailwind v4 @theme font token with no -family suffix (--font-sans) as font-family by its stack-shaped value', () => {
    expect(classifyDesignTokenFamily('--font-sans', 'ui-sans-serif, system-ui, sans-serif')).toBe('font-family')
    expect(classifyDesignTokenFamily('--font-mono', 'ui-monospace, monospace')).toBe('font-family')
  })

  it('still classifies color/font-size/space exactly as classifyDeclaration does', () => {
    expect(classifyDesignTokenFamily('--color-aqua-100', '#0c9ab0')).toBe('color')
    expect(classifyDesignTokenFamily('--type-title-size', '18px')).toBe('font-size')
    expect(classifyDesignTokenFamily('--space-md', '16px')).toBe('space')
  })

  it('reports unclassified honestly rather than guessing', () => {
    expect(classifyDesignTokenFamily('--z-index-modal', '50')).toBe('unclassified')
  })
})

describe('detectRootFontSizePx / toPx — non-16px root (T6, STUDIO-FIGMA-PARITY-PLAN.md §11)', () => {
  it('defaults to 16 when no root font-size declaration exists', () => {
    expect(detectRootFontSizePx(':root{--a:8px}')).toBe(16)
  })

  it('reads an explicit html{font-size} in px', () => {
    expect(detectRootFontSizePx('html{font-size:10px}')).toBe(10)
  })

  it('reads the common 62.5% trick (10px root, so 1rem === 10px)', () => {
    expect(detectRootFontSizePx('html{font-size:62.5%}')).toBe(10)
  })

  it('reads :root{font-size} too, not just html', () => {
    expect(detectRootFontSizePx(':root{font-size:20px}')).toBe(20)
  })

  it('ignores a @media-conditional font-size override — not the canonical base', () => {
    expect(detectRootFontSizePx('html{font-size:16px}@media (min-width:900px){html{font-size:20px}}')).toBe(16)
  })

  it('toPx converts rem against the detected root, not a hardcoded 16', () => {
    const rootPx = detectRootFontSizePx('html{font-size:62.5%}')
    expect(toPx('1.6rem', rootPx)).toBe(16)
    expect(toPx('1.6rem')).toBe(25.6) // the default-root behaviour is unchanged when the caller doesn't pass one
  })
})

describe('collectRootScopeMaps — conditional at-rules must never contaminate the base map', () => {
  it('a @media (min-width:...) override does NOT overwrite the base value — the base :root value survives', () => {
    const css = ':root{--fs:32px}@media (min-width:900px){:root{--fs:48px}}'
    const { light, dark } = collectRootScopeMaps(css)
    expect(light.get('--fs')).toBe('32px')
    expect(dark.has('--fs')).toBe(false)
  })

  it('a @media print override does NOT overwrite the base value', () => {
    const css = ':root{--c:#000}@media print{:root{--c:#fff}}'
    const { light, dark } = collectRootScopeMaps(css)
    expect(light.get('--c')).toBe('#000')
    expect(dark.has('--c')).toBe(false)
  })

  it('a @media (orientation:...) override does NOT overwrite the base value', () => {
    const css = ':root{--g:8px}@media (orientation:landscape){:root{--g:16px}}'
    const { light, dark } = collectRootScopeMaps(css)
    expect(light.get('--g')).toBe('8px')
    expect(dark.has('--g')).toBe(false)
  })

  it('a combined "(min-width:...) and (prefers-color-scheme:dark)" prelude is NOT colour-scheme-only — it is still conditional on width, so it must not be treated as the canonical dark value', () => {
    const css = ':root{--fs:32px}@media (min-width:900px) and (prefers-color-scheme:dark){:root{--fs:48px}}'
    const { light, dark } = collectRootScopeMaps(css)
    expect(light.get('--fs')).toBe('32px')
    expect(dark.has('--fs')).toBe(false)
  })

  it('does NOT descend into @supports, even when nested under a colour-scheme:dark context', () => {
    const css = ':root{--a:#111}@media (prefers-color-scheme:dark){@supports (color:red){:root{--a:#222}}}'
    const { light, dark } = collectRootScopeMaps(css)
    expect(light.get('--a')).toBe('#111')
    expect(dark.has('--a')).toBe(false)
  })

  it('does NOT descend into @container', () => {
    const css = ':root{--a:#111}@container (min-width:400px){:root{--a:#222}}'
    const { light, dark } = collectRootScopeMaps(css)
    expect(light.get('--a')).toBe('#111')
    expect(dark.has('--a')).toBe(false)
  })
})

describe('collectRootScopeMaps — widened dark-selector recognition', () => {
  it('pins existing behavior: :root[data-theme=dark] classifies as dark', () => {
    const { dark } = collectRootScopeMaps(':root[data-theme=dark]{--a:#111}')
    expect(dark.get('--a')).toBe('#111')
  })

  it('pins existing behavior: :root.dark classifies as dark', () => {
    const { dark } = collectRootScopeMaps(':root.dark{--a:#111}')
    expect(dark.get('--a')).toBe('#111')
  })

  it('pins existing behavior: :root:not([data-theme=light]) classifies as dark', () => {
    const { dark } = collectRootScopeMaps(':root:not([data-theme=light]){--a:#111}')
    expect(dark.get('--a')).toBe('#111')
  })

  it('classifies a bare [data-theme=dark] (no :root prefix) as dark — previously missed', () => {
    const { light, dark } = collectRootScopeMaps('[data-theme=dark]{--a:#111}')
    expect(dark.get('--a')).toBe('#111')
    expect(light.has('--a')).toBe(false)
  })

  it('classifies html.dark as dark — previously missed', () => {
    const { dark } = collectRootScopeMaps('html.dark{--a:#111}')
    expect(dark.get('--a')).toBe('#111')
  })

  it('classifies body.dark as dark', () => {
    const { dark } = collectRootScopeMaps('body.dark{--a:#111}')
    expect(dark.get('--a')).toBe('#111')
  })

  it('classifies a bare .dark class as dark', () => {
    const { dark } = collectRootScopeMaps('.dark{--a:#111}')
    expect(dark.get('--a')).toBe('#111')
  })

  it('does NOT classify .darkened or .dark-blue as dark, or as light — a wrong token is worse than a missing one', () => {
    const { light, dark } = collectRootScopeMaps('.darkened{--a:#111}.dark-blue{--b:#222}')
    expect(dark.has('--a')).toBe(false)
    expect(light.has('--a')).toBe(false)
    expect(dark.has('--b')).toBe(false)
    expect(light.has('--b')).toBe(false)
  })
})

describe('collectRootScopeMaps — regression coverage for behavior this change must not disturb', () => {
  it('still reads an unwrapped top-level :root as light', () => {
    const { light } = collectRootScopeMaps(':root{--brand:#3366ff}')
    expect(light.get('--brand')).toBe('#3366ff')
  })

  it('still supports :where(html)/:is(:root) as a light host', () => {
    expect(collectRootScopeMaps(':where(html){--a:#111}').light.get('--a')).toBe('#111')
    expect(collectRootScopeMaps(':is(:root){--b:#222}').light.get('--b')).toBe('#222')
  })

  it('still skips a :root written inside a comment', () => {
    const css = '/* :root { --fake: red; } */\n:root { --real: blue; }'
    const { light } = collectRootScopeMaps(css)
    expect(light.get('--real')).toBe('blue')
    expect(light.has('--fake')).toBe(false)
  })

  it('still resyncs after a stray unmatched close brace instead of corrupting the rest of the scan', () => {
    const css = '}:root{--a:#111}'
    const { light } = collectRootScopeMaps(css)
    expect(light.get('--a')).toBe('#111')
  })

  it('later declarations still win on a name collision (cascade order)', () => {
    const css = ':root{--a:#111}:root{--a:#222}'
    const { light } = collectRootScopeMaps(css)
    expect(light.get('--a')).toBe('#222')
  })
})

/**
 * A design system expresses dark mode for its SEMANTIC layer through aliasing:
 * `--background-base-default: var(--color-light)` is declared once, and only
 * the raw `--color-light` is re-declared inside the dark block. Reading a dark
 * value only for names the dark block itself names therefore captured the raw
 * palette and missed every alias built on it — measured against the real
 * `@alm-design/design-system`: 27 of 171 colour tokens, none of them ones a
 * page actually references. Those flattened light literals are emitted by the
 * framework engine into `@layer user-authored`, which outranks the `@layer
 * vendor` bucket the package's own `:root[data-theme=dark]` palette lands in —
 * so a dark preview rendered fully light. See `board-08` in `STATE.md`.
 */
describe('classifyCssText — dark values through var() aliases', () => {
  it('gives an alias the dark value of the palette entry it points at', () => {
    const css = ':root{--color-light:#FFFFFF;--background-base-default:var(--color-light)}\n:root[data-theme=dark]{--color-light:#1C1C1C}'
    const { colors } = classifyCssText(css)
    expect(colors.find((c) => c.name === '--background-base-default')).toEqual({
      name: '--background-base-default',
      light: '#FFFFFF',
      dark: '#1C1C1C',
    })
  })

  it('leaves a token whose chain never darkens without a dark value', () => {
    const css = ':root{--white-static:#FFFFFF;--scrim:var(--white-static)}\n:root[data-theme=dark]{--other:#111}'
    const { colors } = classifyCssText(css)
    expect(colors.find((c) => c.name === '--scrim')).toEqual({ name: '--scrim', light: '#FFFFFF' })
  })

  it('keeps an explicit dark re-declaration winning over the inherited one', () => {
    const css = ':root{--color-light:#FFFFFF;--surface:var(--color-light)}\n:root[data-theme=dark]{--color-light:#1C1C1C;--surface:#000000}'
    const { colors } = classifyCssText(css)
    expect(colors.find((c) => c.name === '--surface')?.dark).toBe('#000000')
  })
})
