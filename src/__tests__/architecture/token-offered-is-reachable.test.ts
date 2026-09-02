/**
 * token-offered-is-reachable — the Track H governing invariant
 * (`STUDIO-FIGMA-PARITY-PLAN.md` §11): **anything the picker offers must be
 * reachable by a real write target.** For an EXTRACTED colour token (read out
 * of the project's own CSS — the overwhelming majority of what a real
 * project's picker shows), the only honest write target is "this name
 * already exists in the project's CSS" — there is no create-a-new-token
 * write path yet (T7, still unbuilt this pass; see the Track H handoff).
 *
 * Before Phase 0.13, `buildColorTokens` turned every extracted token's
 * `generateTransparent`/`generateShades`/`generateTints` ON, and
 * `TokenizedColorField` expanded each one into up to 19 picker entries via
 * `generateFrameworkColorVariableSets` — 18 of which (`--slug-l-2`,
 * `--slug-d-3`, `--slug-10`, …) exist ONLY inside Studio's own injected
 * `:root` block, never in the project's real CSS. Picking one rendered
 * correctly in Studio and as nothing in the user's real app — the literal
 * violation this invariant exists to catch.
 *
 * This test exercises the REAL production pipeline end to end — the same
 * `classifyCssText` -> `buildFrameworkSettings` call `tokenExtract.ts` makes,
 * then the same `generateFrameworkColorVariableSets` call
 * `TokenizedColorField` makes — and asserts every variable name the picker
 * would offer for an extracted colour is a name that is ACTUALLY declared in
 * the source CSS. A regression that re-enables variant generation for
 * extracted tokens (or any future path that mints a derived name some other
 * way) fails this test.
 *
 * Promoted from `src/__tests__/studio/` (Track H built it there because this
 * folder was owned by another agent at the time) — this is a pure
 * fixture-driven pipeline test with no filesystem/directory scan, so no
 * `toPosixPath()` normalization applies (see `pathHelpers.ts`'s doc for when
 * it does). Non-vacuousness is checked directly by this file's existence:
 * every assertion below fails if the invariant it guards regresses — see
 * the inline comments on each `it()`.
 *
 * Scope: colours only. `FrameworkSpacingGroup`/`FrameworkTypographyGroup`
 * steps are Studio's OWN generated scale (`--{namingConvention}-{step}`),
 * always re-emitted into the canvas regardless of provenance — a project
 * whose real CSS never declares that exact name is the T4 "framework
 * shadows the project's own tokens" defect, fixed on the canvas side via
 * `filterReemittableColorTokens` (`@core/framework`'s `colors.ts`) and
 * `FrameworkColorToken.origin` (`@core/framework-schema`), not a
 * colour-picker regression this test can catch by itself.
 */
import { describe, expect, it } from 'bun:test'
import { generateFrameworkColorVariableSets } from '@core/framework'
import { classifyCssText } from '../../../server/handlers/studio/tokenExtractCssScan'
import { buildFrameworkSettings } from '../../../server/handlers/studio/tokenExtractBuild'

/** Every declared custom-property name in `css`, verbatim (`--foo`, not `foo`) — what actually exists as a writable declaration in the project's source. */
function declaredCustomPropertyNames(css: string): Set<string> {
  const names = new Set<string>()
  for (const m of css.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) names.add(m[1]!)
  return names
}

const REALISTIC_PROJECT_CSS = `
:root {
  --color-aqua-100: #0c9ab0;
  --color-coral-100: #ef4550;
  --color-metal: #1c1c1c;
  --background-primary-default: var(--color-metal);
  --text-base-default: #f5f5f5;
}
`

describe('token-offered-is-reachable — extracted colours (T3/T8, STUDIO-FIGMA-PARITY-PLAN.md §11)', () => {
  it('every variable name the picker offers for an extracted colour exists verbatim in the project CSS', () => {
    const classified = classifyCssText(REALISTIC_PROJECT_CSS)
    expect(classified.colors.length).toBeGreaterThan(0) // sanity: the fixture actually produced tokens

    const framework = buildFrameworkSettings(classified, 'project-css')
    const declared = declaredCustomPropertyNames(REALISTIC_PROJECT_CSS)

    const offered = generateFrameworkColorVariableSets(framework.colors).light
    expect(offered.length).toBeGreaterThan(0)

    for (const variable of offered) {
      expect(declared.has(variable.name)).toBe(true)
    }
  })

  it('regression guard: extracted tokens must never generate derived variants (transparency/shades/tints)', () => {
    // The literal Phase 0.13 defect: one real token producing up to 19
    // picker entries, 18 of which existed only inside Studio's own iframe.
    const classified = classifyCssText(REALISTIC_PROJECT_CSS)
    const framework = buildFrameworkSettings(classified, 'project-css')
    for (const token of framework.colors.tokens) {
      expect(token.generateTransparent).toBe(false)
      expect(token.generateShades.enabled).toBe(false)
      expect(token.generateTints.enabled).toBe(false)
    }
  })

  it('a dark-mode variant is still offered by name only — no light/dark suffix invented for it', () => {
    const css = `
      :root { --color-brand: #0c9ab0; }
      @media (prefers-color-scheme: dark) { :root { --color-brand: #0a7f92; } }
    `
    const classified = classifyCssText(css)
    const framework = buildFrameworkSettings(classified, 'project-css')
    const declared = declaredCustomPropertyNames(css)
    const offered = generateFrameworkColorVariableSets(framework.colors).light
    for (const variable of offered) {
      expect(declared.has(variable.name)).toBe(true)
    }
  })

  it('every extracted colour token is stamped with a non-studio-authored origin, so the canvas does not re-declare it', () => {
    // The T4 half of the invariant: an extracted token's `:root` value
    // already exists in the project's own stylesheet. If this stamping
    // regressed (e.g. `buildColorTokens` stopped setting `origin`, or set
    // it to `'studio-authored'`), `filterReemittableColorTokens` would
    // treat every extracted token as safe to re-emit again, silently
    // reintroducing the duplicate-declaration defect this test's sibling
    // assertions above cannot see (they only check offered NAMES, not
    // re-emission).
    const classified = classifyCssText(REALISTIC_PROJECT_CSS)
    const framework = buildFrameworkSettings(classified, 'project-css')
    expect(framework.colors.tokens.length).toBeGreaterThan(0)
    for (const token of framework.colors.tokens) {
      expect(token.origin).toBe('project-css')
      expect(token.origin).not.toBe('studio-authored')
    }
  })
})
