/**
 * `canvasUserStylesheetCss` — the cross-frame memo behind
 * `UserStylesheetInjector`, and the ordering property it depends on.
 *
 * Two separate claims:
 *  1. Of the three transforms in the chain, only the viewport-unit resolution
 *     re-runs per frame, and even that only once per distinct viewport.
 *  2. Reordering the scheme rewrite AHEAD of the viewport resolution — which
 *     is what makes claim 1 possible at all — is output-preserving. The cases
 *     below are the ones where it could plausibly not be: viewport units
 *     inside a `prefers-color-scheme` block (the rewrite moves that text),
 *     units inside a quoted attribute selector and inside `url()` (both
 *     regions the resolver must skip, and the rewrite rewrites SELECTORS).
 */
import { describe, expect, it } from 'bun:test'
import type { SiteDocument } from '@core/page-tree'
import { createUserStylesheetCssMemo } from '@site/canvas/canvasUserStylesheetCss'
import { rewritePrefersColorScheme } from '@site/canvas/darkSchemeCssTransform'
import { resolveViewportUnitsForCanvas } from '@site/canvas/resolveViewportUnits'

function makeSite(css: string): SiteDocument {
  return {
    files: [{ id: 'f1', name: 'app.css', path: 'app.css', type: 'style', content: css, enabled: true }],
    runtime: undefined,
    pages: [],
    visualComponents: [],
    layouts: [],
  } as unknown as SiteDocument
}

const SCOPE = { id: 'page-1', template: false }

interface Counts {
  collect: number
  rewriteScheme: number
  resolveViewport: number
}

function countingMemo() {
  const counts: Counts = { collect: 0, rewriteScheme: 0, resolveViewport: 0 }
  const build = createUserStylesheetCssMemo({
    collect: (site) => {
      counts.collect++
      const files = (site as unknown as { files: { content: string }[] }).files
      return files.map((f) => f.content).join('\n')
    },
    rewriteScheme: (css) => {
      counts.rewriteScheme++
      return `${css}\n/* scheme */`
    },
    resolveViewport: (css, viewport) => {
      counts.resolveViewport++
      return `${css.replaceAll('100vh', `${viewport.height}px`)}\n/* w:${viewport.width} */`
    },
  })
  return { build, counts }
}

describe('canvasUserStylesheetCss memo', () => {
  it('collects + scheme-rewrites ONCE for a whole board, and resolves units once per distinct viewport', () => {
    const { build, counts } = countingMemo()
    const site = makeSite('.a { min-height: 100vh }')

    // Six frames in one commit: four phones, one tablet, one desktop.
    const viewports = [
      { width: 390, height: 800 },
      { width: 390, height: 800 },
      { width: 390, height: 800 },
      { width: 390, height: 800 },
      { width: 744, height: 800 },
      { width: 1280, height: 800 },
    ]
    const outputs = viewports.map((viewport) => build(site, SCOPE, viewport))

    expect(counts.collect).toBe(1)
    expect(counts.rewriteScheme).toBe(1)
    expect(counts.resolveViewport).toBe(3) // one per distinct viewport, not per frame

    // Frames that share a width share the exact string, so each iframe's
    // `textContent` assignment is a no-op comparison away.
    expect(outputs[0]).toBe(outputs[1])
    expect(outputs[0]).not.toBe(outputs[4])
  })

  it('rebuilds the frame-invariant stage when the document changes', () => {
    const { build, counts } = countingMemo()
    const first = makeSite('.a { color: red }')
    build(first, SCOPE, { width: 390, height: 800 })
    build(first, SCOPE, { width: 744, height: 800 })
    expect(counts.collect).toBe(1)

    const second = makeSite('.a { color: blue }')
    const out = build(second, SCOPE, { width: 390, height: 800 })
    expect(counts.collect).toBe(2)
    expect(counts.rewriteScheme).toBe(2)
    expect(out).toContain('blue')
  })

  it('keys the scope on its FIELDS, not its object identity', () => {
    const { build, counts } = countingMemo()
    const site = makeSite('.a { color: red }')

    // Each `UserStylesheetInjector` has its own `useShallow` subscription and
    // therefore its own object for the same two values — keying on identity
    // would miss for every frame after the first.
    build(site, { id: 'page-1', template: false }, { width: 390, height: 800 })
    build(site, { id: 'page-1', template: false }, { width: 390, height: 800 })
    expect(counts.collect).toBe(1)

    // A genuinely different scope does rebuild.
    build(site, { id: 'page-2', template: false }, { width: 390, height: 800 })
    expect(counts.collect).toBe(2)
  })

  it('emits nothing (and collects nothing) with no site or no scope', () => {
    const { build, counts } = countingMemo()
    expect(build(null, SCOPE, { width: 390, height: 800 })).toBe('\n/* scheme */\n/* w:390 */')
    expect(build(makeSite('.a{}'), null, { width: 390, height: 800 })).toBe('\n/* scheme */\n/* w:390 */')
    expect(counts.collect).toBe(0)
  })

  it('gives an absent viewport its own slot rather than reusing a sized one', () => {
    const { build, counts } = countingMemo()
    const site = makeSite('.a { min-height: 100vh }')

    const sized = build(site, SCOPE, { width: 390, height: 800 })
    const unsized = build(site, SCOPE, undefined)

    expect(counts.resolveViewport).toBe(1) // the unsized path skips it entirely
    expect(sized).toContain('800px')
    expect(unsized).toContain('100vh')
  })
})

describe('scheme rewrite / viewport resolution commute', () => {
  const viewport = { width: 390, height: 800 }
  const cases: Record<string, string> = {
    'viewport units inside a dark-mode block': `@media (prefers-color-scheme: dark) { :root { --pad: 5vh; background: #000 } }`,
    'viewport units inside a light-mode block on a nested at-rule': `@supports (display: grid) { @media (prefers-color-scheme: light) { .a { height: 100vh } } }`,
    'a quoted attribute selector that looks like a unit': `@media (prefers-color-scheme: dark) { [data-size="100vh"] { color: red } }`,
    'a url() token that looks like a unit': `@media (prefers-color-scheme: dark) { .a { background: url(a-100vh.png); height: 50vmax } }`,
    'a pseudo-element selector (only one gated form is emitted)': `@media (prefers-color-scheme: dark) { .a::before { content: "10vh"; width: 10vw } }`,
    'no dark-mode query at all': `.a { min-height: 100vh }`,
  }

  for (const [label, css] of Object.entries(cases)) {
    it(`is order-independent for ${label}`, () => {
      const oldOrder = rewritePrefersColorScheme(resolveViewportUnitsForCanvas(css, viewport))
      const newOrder = resolveViewportUnitsForCanvas(rewritePrefersColorScheme(css), viewport)
      expect(newOrder).toBe(oldOrder)
    })
  }
})
