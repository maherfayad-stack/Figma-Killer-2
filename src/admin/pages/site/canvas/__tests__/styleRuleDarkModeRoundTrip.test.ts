/**
 * styleRuleDarkModeRoundTrip.test.ts — WS-10 Phase 1 defect fix (coordinator
 * audit, 2026-08-01): an imported project's OWN `@media
 * (prefers-color-scheme: dark)` (from its own `.css`, or hand-authored via
 * `ConditionBuilder.tsx`'s "Dark mode" preset) is parsed into the structured
 * `site.styleRules` registry and re-emitted through
 * `generateCanvasClassCSS`/`generateClassCSS` — the SAME engine
 * `ClassStyleInjector.tsx` (canvas) and the publisher both call. This proves
 * the full chain end to end:
 *
 *   1. A real project stylesheet containing `@media (prefers-color-scheme:
 *      dark)` parses through `cssToStyleRules` (the exact engine
 *      `studioCss.ts` uses) into a `StyleRule` + `ConditionDef` — NOT
 *      stripped, NOT normalized away (answers the "does the structured
 *      registry even preserve this" question the coordinator raised).
 *   2. The PUBLISHER path (`generateClassCSS`, `@core/publisher` — never
 *      touched by this change) emits the real, untouched `@media` query.
 *      This is deliberate: a real browser resolves `prefers-color-scheme`
 *      correctly per visitor, so the published page must keep the genuine
 *      media query.
 *   3. The CANVAS path (the same generated CSS text, piped through
 *      `rewritePrefersColorScheme` — exactly what `ClassStyleInjector.tsx`
 *      now does) rewrites it into the `:where(html[data-studio-scheme=...])`
 *      form the preview-axes toggle can actually drive.
 *
 * If someone later "simplifies" this by moving the rewrite down into
 * `generateClassCSS`/`createStyleRuleCssEmitter` itself, assertion (2) below
 * fails — that is the point of asserting it explicitly rather than only
 * asserting the canvas side.
 */
import { describe, expect, it } from 'bun:test'
import { cssToStyleRules } from '@core/siteImport'
import { generateClassCSS } from '@core/publisher'
import type { StyleRule } from '@core/page-tree'
import { generateCanvasClassCSS } from '../canvasClassCss'
import { rewritePrefersColorScheme } from '../darkSchemeCssTransform'

const PROJECT_CSS = [
  '.hero { color: black; }',
  '@media (prefers-color-scheme: dark) {',
  '  .hero { color: white; }',
  '}',
].join('\n')

function buildStyleRules(): { styleRules: Record<string, StyleRule>; conditions: ReturnType<typeof cssToStyleRules>['conditions'] } {
  const { rules, conditions, warnings } = cssToStyleRules(PROJECT_CSS)
  expect(warnings).toEqual([])
  const heroRule = rules.find((r) => r.name === 'hero')!
  const styleRule: StyleRule = { ...heroRule, id: 'hero-rule', createdAt: 0, updatedAt: 0 }
  return { styleRules: { [styleRule.id]: styleRule }, conditions }
}

describe('an imported project\'s own prefers-color-scheme survives the styleRules round trip', () => {
  it('the parser preserves the dark-mode condition as a real ConditionDef — not stripped', () => {
    const { conditions } = buildStyleRules()
    expect(conditions).toHaveLength(1)
    expect(conditions[0]!.condition).toEqual({ kind: 'media', query: '(prefers-color-scheme: dark)' })
  })

  it('the PUBLISHER path emits the real, untouched @media query', () => {
    const { styleRules, conditions } = buildStyleRules()
    const published = generateClassCSS(styleRules, [], conditions)
    expect(published).toContain('.hero {')
    expect(published).toContain('color: black')
    expect(published).toContain('@media (prefers-color-scheme: dark)')
    expect(published).toContain('color: white')
    // Never rewritten — the publisher must keep shipping the genuine media
    // query, because a real browser resolves it correctly per visitor.
    expect(published).not.toContain('data-studio-scheme')
  })

  it('the CANVAS path — the exact call ClassStyleInjector.tsx makes, then rewritePrefersColorScheme — responds to data-studio-scheme instead', () => {
    const { styleRules, conditions } = buildStyleRules()
    const canvasGenerated = generateCanvasClassCSS(styleRules, [], conditions)
    const canvasCss = rewritePrefersColorScheme(canvasGenerated)

    expect(canvasCss).toContain('.hero {')
    expect(canvasCss).toContain('color: black')
    expect(canvasCss).not.toContain('@media (prefers-color-scheme: dark)')
    expect(canvasCss).toMatch(/:where\(html\[data-studio-scheme='dark'\]\)\s*\{/)
    expect(canvasCss).toContain('color: white')
  })

  it('the two paths diverge from the SAME generated string — proof the rewrite lives at the canvas boundary, not inside the shared emitter', () => {
    const { styleRules, conditions } = buildStyleRules()
    const generated = generateCanvasClassCSS(styleRules, [], conditions)
    // Untouched (what the publisher effectively renders, modulo font/framework
    // prelude blocks generateCanvasClassCSS adds and generateClassCSS doesn't):
    expect(generated).toContain('@media (prefers-color-scheme: dark)')
    // Rewritten only when the canvas explicitly asks for it:
    expect(rewritePrefersColorScheme(generated)).not.toContain('@media (prefers-color-scheme: dark)')
  })
})
