/**
 * styleCompileConsent — the client half of `GET/POST
 * /admin/api/studio/style-compile-consent`: whether the loaded project's
 * styling needs its own compiler run that Tier 0 will not perform, and the
 * per-project "not now" that stops the board asking again.
 *
 * A leaf wire module in the same shape as `studioPageRequests.ts` /
 * `installDeps.ts` — the schema, the two calls, and the pure show/hide rule.
 * The rule lives HERE rather than inside the banner component so it can be
 * tested without a renderer, and so there is exactly one answer to "should
 * this be on screen" for anything that later wants to ask (a status chip, a
 * project-settings row).
 *
 * The promote action is deliberately NOT here: it is
 * `promoteProjectToTier1(dir)` in `./studioProjectTrust.ts`, the one existing
 * promotion path, which this module does not wrap, mirror, or duplicate.
 */
import { apiRequest } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { TrustTierSchema } from './studioProjectTrust'

const ROUTE = '/admin/api/studio/style-compile-consent'

/**
 * A styling toolchain that can only be compiled by running the workspace's
 * own code. Mirrors `CompilableStyleToolchain` in
 * `server/handlers/studio/projectProfileSchema.ts` — this file runs in the
 * browser,
 * so (same reasoning as `studioProjectTrust.ts`'s `TrustTierSchema`) it only
 * needs to agree on the wire shape, not import the Node-only server module.
 */
export const CompilableStyleToolchainSchema = Type.Union([
  Type.Literal('tailwind'),
  Type.Literal('sass'),
  Type.Literal('postcss'),
])
export type CompilableStyleToolchain = Static<typeof CompilableStyleToolchainSchema>

export const StyleCompileConsentStatusSchema = Type.Object({
  /** The project's CURRENT trust tier. `'static'` (Tier 0) is the only one at which a compilable toolchain goes uncompiled. */
  trust: TrustTierSchema,
  /** Empty for a project whose styling is already fully renderable at Tier 0 (plain CSS, CSS Modules, vendor CSS). */
  toolchains: Type.Array(CompilableStyleToolchainSchema),
  /** The compile runs the workspace's OWN installed compiler, so without `node_modules` promoting alone changes nothing on screen. */
  dependenciesInstalled: Type.Boolean(),
  /** The user already answered "not now" for this project. */
  dismissed: Type.Boolean(),
})
export type StyleCompileConsentStatus = Static<typeof StyleCompileConsentStatusSchema>

export async function fetchStyleCompileConsent(dir: string): Promise<StyleCompileConsentStatus> {
  return apiRequest(ROUTE, { schema: StyleCompileConsentStatusSchema, query: { dir } })
}

/** Persists "do not ask about this project again" to `.studio/meta.json`. Never promotes — see the module doc. */
export async function dismissStyleCompileConsent(dir: string): Promise<void> {
  await apiRequest(ROUTE, {
    method: 'POST',
    body: { dir },
    schema: Type.Object({ ok: Type.Boolean() }),
  })
}

/**
 * The whole show/hide rule: ask only when there is genuinely something to
 * consent to, and only once.
 *
 * `dependenciesInstalled` is deliberately NOT part of it. A Tailwind project
 * with no `node_modules` is still a project whose styles are missing for a
 * reason the user cannot see, and hiding the explanation until an unrelated
 * install has happened is how the silence this prompt exists to break got
 * there in the first place — the banner says so in its own copy instead.
 */
export function shouldOfferStyleCompile(status: StyleCompileConsentStatus): boolean {
  return status.trust === 'static' && status.toolchains.length > 0 && !status.dismissed
}

const TOOLCHAIN_LABELS: Record<CompilableStyleToolchain, string> = {
  tailwind: 'Tailwind',
  sass: 'Sass',
  postcss: 'PostCSS',
}

/** `['tailwind', 'sass']` -> `'Tailwind and Sass'` — for the banner's one sentence of copy. */
export function styleToolchainLabel(toolchains: readonly CompilableStyleToolchain[]): string {
  const names = toolchains.map((toolchain) => TOOLCHAIN_LABELS[toolchain])
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
