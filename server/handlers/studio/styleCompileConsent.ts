/**
 * styleCompileConsent — `GET/POST /admin/api/studio/style-compile-consent`,
 * the read/write surface behind the board's first-run "this project's styles
 * need its own compiler run" prompt (`StyleCompileConsentBanner.tsx`).
 *
 * **The gap this closes.** `styleCompile.ts` already refuses, correctly, to
 * run a workspace's own Sass/PostCSS/Tailwind compiler at Tier 0, and records
 * a `style-toolchain-requires-trust-promotion` warning when it does. But that
 * warning never reached a person: `ProbeWarning[]` is not part of the `/load`
 * wire shape the client consumes, so a freshly-imported Tailwind repo simply
 * rendered unstyled with nothing anywhere saying why or what to do. This route
 * is what a project-level prompt can ask, once, on load:
 *
 *   GET  /admin/api/studio/style-compile-consent?dir=<abs>
 *     -> `{ trust, toolchains, dependenciesInstalled, dismissed }`
 *        Everything the banner needs to decide whether to show itself, and
 *        nothing else. Read-only apart from the profile-cache heal
 *        `resolveProjectProfile` may perform (see its own doc for why that
 *        one write is not the "a GET must not write" case).
 *   POST /admin/api/studio/style-compile-consent { dir? }
 *     -> `{ ok: true }` — records "do not ask me about this project again"
 *        in `.studio/meta.json`'s `styleCompilePromptDismissed`.
 *
 * **This route never promotes anything.** Consent to run the workspace's code
 * still goes through the one existing promotion path — `POST
 * /admin/api/studio/trust-tier` (`./trustTier.ts`), called from the client by
 * `promoteProjectToTier1`. A second way to reach Tier 1 would be a second
 * place for that boundary to be got wrong, so the only thing this module can
 * write is a REFUSAL to be asked (`meta-03` decision 1: trust promotion is an
 * explicit user action, never a side effect).
 *
 * `toolchains` comes from `compilableStyleToolchains` in
 * `./projectProfileSchema.ts` — the same function `styleCompile.ts` asks to
 * decide whether it warns or compiles — so the prompt can never offer a
 * compile the compiler would decline to do, or stay silent about one it would.
 *
 * Same containment posture as every other project-scoped route:
 * `resolveProjectDir` + `isRealpathContained(dir, projectsRootDir())`.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Type } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { projectsRootDir, resolveProjectDir } from '../studioProjects'
import { joinAppRoot } from './appRoot'
import { resolveProjectProfile } from './projectProbe'
import { compilableStyleToolchains } from './projectProfileSchema'
import { DEFAULT_TRUST_TIER, mergeStudioMeta, readStudioMeta } from './studioMeta'
import { isRealpathContained } from './workspacePackageResolve'

const ROUTE_PATH = '/admin/api/studio/style-compile-consent'

const DismissBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
})

/**
 * `dependenciesInstalled` is reported rather than folded into a single
 * "can compile" boolean because the two answers need different words in the
 * prompt: a project at Tier 0 needs consent, and a project with no
 * `node_modules` needs an install first (`styleCompile.ts` warns
 * `dependencies-not-installed` for exactly that case). Collapsing them would
 * make the banner promise styles it cannot deliver.
 */
function readConsentStatus(dir: string) {
  const profile = resolveProjectProfile(dir)
  const appRootAbs = joinAppRoot(dir, profile.appRoot)
  const meta = readStudioMeta(dir)
  return {
    trust: meta.trust ?? DEFAULT_TRUST_TIER,
    toolchains: compilableStyleToolchains(profile),
    dependenciesInstalled: existsSync(join(appRootAbs, 'node_modules')),
    dismissed: meta.styleCompilePromptDismissed === true,
  }
}

/** `GET/POST /admin/api/studio/style-compile-consent` — see module doc for the full contract. */
export async function tryServeStudioStyleCompileConsent(req: Request, url: URL, pathname: string): Promise<Response | null> {
  if (pathname !== ROUTE_PATH) return null

  if (req.method === 'GET') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      if (!isRealpathContained(dir, projectsRootDir())) return new Response('Not found', { status: 404 })
      return jsonResponse(readConsentStatus(dir))
    } catch (err) {
      console.error('[studio:styleCompileConsent]', err)
      return new Response('Not found', { status: 404 })
    }
  }

  if (req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, DismissBodySchema)
      if (!body) return badRequest('invalid style-compile-consent body')
      const dir = resolveProjectDir(body.dir)
      if (!isRealpathContained(dir, projectsRootDir())) return new Response('Not found', { status: 404 })

      mergeStudioMeta(dir, { styleCompilePromptDismissed: true })
      return jsonResponse({ ok: true })
    } catch (err) {
      console.error('[studio:styleCompileConsent]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  return null
}
