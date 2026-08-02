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
import { collectRootScopeMaps } from '../tokenExtractCssScan'

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
