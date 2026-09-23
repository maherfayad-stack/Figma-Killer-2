/**
 * assetDrop — `POST /admin/api/studio/asset-drop` (D2 G15): the write behind
 * every image that is about to be referenced by a LITERAL URL. Three callers:
 * a file dropped from the operating system onto a board frame, the
 * inspector's "Replace image" on an `<img>` whose `src` is a string, and the
 * Fill section's image upload (a CSS `url()` is a literal too). IMG-1 moved
 * the last two here; before that they went through `asset-upload`, landed in
 * `src/assets/` and wrote `src="/src/assets/x.png"`, a URL that 404s in
 * production.
 *
 * ## Why this is not `asset-upload`
 *
 * It shares that route's entire security pipeline — `landAssetBytes` does the
 * sniffing, the SVG sanitisation, the containment check and the collision-safe
 * write, and nothing here duplicates a byte of it. What it does NOT share is
 * the QUESTION. `asset-upload`'s caller already knows where the file goes: the
 * inspector's image replace passes the directory an existing `import
 * heroImg from '…'` points at, because it is about to repoint that import.
 *
 * A literal has no import to repoint, and the element it is written into
 * takes `<img src="…">` — a STRING ATTRIBUTE, not a binding. So this route
 * answers the question that upload's caller answered for itself: **which
 * directory in THIS project can back a literal `src`, and what is the
 * literal?** The literal is computed by `assetSiteUrl.ts`, the one rule for
 * "file on disk → URL", and returned as `src`; the browser writes it verbatim.
 *
 * ## Response
 *
 * `{ ok: true, mode: 'public', relPath, src, width, height, deduped }`.
 * `mode` is the discriminant for the import convention (IMG-10), which will
 * add `{ mode: 'import', relPath, width, height, deduped }` with no `src`: a
 * client that reads `src` without checking `mode` will stop compiling then,
 * which is the point. `width`/`height` are the intrinsic size from the header
 * bytes, or `null`. `deduped` is true when the bytes already sat in `public/`
 * and that file was reused.
 *
 * ## Replay
 *
 * Landing is idempotent by content (`landAssetBytes` dedupes), and the route
 * is also wrapped in `withIdempotentReplay`, so a retry carrying the same
 * `X-Studio-Idempotency-Key` gets the first response back without the body
 * being read again. The path is in `apiClient.ts`'s `IDEMPOTENT_REPLAY_PATHS`.
 *
 * ## One honest location: `public/`
 *
 * `public/` is the one directory whose contents every framework Studio
 * recognises (Vite, CRA, both Next routers, Remix, Astro) serves verbatim from
 * the site root, unhashed and unprocessed. A file landed there is reachable as
 * `/<name>` from any page, in dev and in a production build alike — so the
 * element the drop writes is `<img src="/photo.png">`, one literal, one honest
 * target, no import.
 *
 * `src/assets/` — where `asset-upload` lands a file by default — deliberately
 * does NOT work here, and the reason is the invariant rather than a
 * limitation: under every bundler in that list, a file there is only reachable
 * through an `import` the bundler rewrites to a hashed URL. Writing
 * `<img src="/src/assets/photo.png">` produces a page that works in `vite dev`
 * and 404s in production. Writing `<img src={photo}>` instead needs TWO edits
 * in two places (the import and the attribute), which is exactly the "one
 * honest target" test a write has to pass. So a project with no `public/`
 * gets a refusal that names the remedy, not a guess.
 *
 * A missing `public/` in a project whose framework declares the convention is
 * CREATED, because the framework serves it whether or not it existed — the
 * directory is part of that framework's contract, not a thing Studio is
 * inventing. For `framework: 'unknown'` nothing is created and the route
 * refuses: there is no convention to appeal to.
 *
 * ## Everything the drop distrusts
 *
 * The file's declared name, its declared MIME type, its size header and the
 * project directory are all attacker-controlled in the general case, and every
 * one of them is handled by machinery that already exists rather than by a
 * second copy here:
 *
 *   - the body is capped by STREAMED byte count (`readFormDataWithLimit`), so
 *     a spoofed or absent `content-length` cannot bypass the cap;
 *   - the bytes decide the format and the extension, never the filename or the
 *     declared type (`sniffImageExtension`), and an SVG is sanitised before it
 *     touches disk (`landAssetBytes`);
 *   - the write directory is a server-derived constant (`public`), never a
 *     client string — so the traversal surface `asset-upload`'s `targetDir`
 *     has does not exist on this route at all. It still goes through
 *     `resolveAssetWriteDir`'s real-path containment check, because the
 *     project itself can arrive from GitHub and git stores symlinks.
 *
 * ## Who is allowed to ask (`sec-17`, `sec-14`)
 *
 * Nothing in this file decides it. `POST /admin/api/studio/asset-drop` is
 * declared in `routeCapabilities.ts` as a WRITE (`studio.write`), so
 * `gateStudioRequest` has already refused a forged cross-origin POST (the
 * CSRF check on `Origin` / `Sec-Fetch-Site`) and a caller who does not hold
 * the capability — both BEFORE this sub-router is reached, and therefore
 * before a 25 MB body is buffered for somebody who was going to be refused.
 *
 * `sec-17` found this route unauthenticated and added an inline
 * `originAllowed` + `requireCapability` pair, because the base it reviewed had
 * no table to declare into. That pair is gone and the declaration replaced it:
 * two checks are two policies, and `routeGate.ts`'s own doc is explicit that a
 * Studio sub-router must never run a second one. The capability `sec-17` chose
 * is unchanged — it is a table line now instead of an `if`.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse } from '../../http'
import { resolveProjectDir, rethrowProjectDirRefusal } from '../studioProjects'
import { ArchiveIngestError, readFormDataWithLimit } from './archiveIngest'
import { landAssetBytes } from './assetLanding'
import { PUBLIC_DIR, assetSiteUrlResolver } from './assetSiteUrl'
import { resolveAppRoot } from './appRoot'
import { withIdempotentReplay } from './idempotentReplay'
import { resolveProjectProfile } from './projectProbe'
import type { ProjectFramework } from './projectProfileSchema'

/**
 * Per-file cap for a dropped image — the same 25 MB `asset-upload` allows.
 * Deliberately the same number and not a tighter one: the two routes accept
 * the identical class of file, and two different limits for "the same image,
 * dropped vs. picked" would be a difference the user could only discover by
 * hitting it.
 */
export const MAX_ASSET_DROP_BYTES = 25 * 1024 * 1024

/**
 * The frameworks whose contract says `public/` is served from the site root,
 * whether or not the directory happens to exist yet. `unknown` is absent on
 * purpose: with no framework there is no convention to create a directory on
 * the strength of.
 */
const FRAMEWORKS_WITH_PUBLIC_DIR: ReadonlySet<ProjectFramework> = new Set([
  'vite',
  'next-app',
  'next-pages',
  'cra',
  'remix',
  'astro',
])

const AssetDropFieldsSchema = Type.Object({
  // Optional, same convention as every other studio route's `dir` field:
  // `resolveProjectDir(undefined)` falls back to the first project on disk, so
  // a client that has not overridden the active workspace still writes into
  // the right project.
  dir: Type.Optional(Type.String()),
})

export type AssetDropHome =
  | { ok: true; absolute: string; relToProject: string }
  | { ok: false; error: string }

/**
 * Where a dropped asset lands in THIS project, or why it cannot land at all.
 *
 * Pure apart from an `existsSync` and, for a framework that declares the
 * convention, one `mkdirSync`. Exported for its own test: "which directory,
 * and when is it created" is the whole product decision on this route, and it
 * is not observable through the HTTP shell.
 */
export function resolveDroppedAssetHome(dir: string): AssetDropHome {
  const profile = resolveProjectProfile(dir)
  // `resolveAppRoot`, never `profile.appRoot` rejoined by hand: `.studio/
  // meta.json` is a file the user (or an imported repo) can hand-edit, and
  // that helper is the one place the cached value is real-path containment-
  // checked, degrading to the project directory when it escapes.
  const appRoot = resolveAppRoot(dir)
  const absolute = join(appRoot, PUBLIC_DIR)
  // Project-relative, POSIX, because that is the vocabulary
  // `resolveAssetWriteDir` and every `relPath` on the wire already speak.
  // `sec-17` — derived from the CHECKED absolute path rather than re-joining
  // the raw `profile.appRoot`. The two must name one directory: an `appRoot`
  // of `../../elsewhere` degrades to `dir` above but would still have been
  // spelled verbatim into the relative form, so `existsSync`/`mkdirSync` and
  // the path actually written would have been talking about different places.
  // (`landAssetBytes` would still refuse the `..`; this keeps the two halves
  // from disagreeing in the first place rather than relying on that.)
  const relToProject = relative(resolve(dir), absolute).split(sep).join('/')

  if (existsSync(absolute)) return { ok: true, absolute, relToProject }

  if (!FRAMEWORKS_WITH_PUBLIC_DIR.has(profile.framework)) {
    return {
      ok: false,
      error:
        'This project has no public/ folder, and Studio could not tell which framework it uses — so there is no path it could write an <img src> against. Create a public/ folder (its contents are served from the site root) and drop the image again.',
    }
  }

  mkdirSync(absolute, { recursive: true })
  return { ok: true, absolute, relToProject }
}

/**
 * The `200` body. `mode` is the discriminant IMG-10's import convention joins
 * (see the module doc's "Response" section).
 */
export interface AssetDropPublicResponse {
  ok: true
  mode: 'public'
  relPath: string
  src: string
  width: number | null
  height: number | null
  deduped: boolean
}

export interface AssetDropDeps {
  /**
   * Overrides the real `resolveProjectDir` — test-only, mirroring
   * `AssetUploadDeps.resolveDir`. Without this seam a test that omits `dir`
   * (a supported request shape) would fall back to THIS repo's own real
   * `studio-workspace/` and could write a fixture into it.
   */
  resolveDir?: (requested: string | null | undefined) => string
  /** Overrides the replay store's root (`resolveIdempotencyRoot`). Test-only, so a keyed request never writes into this repo's `.data/`. */
  idempotencyRoot?: string
}

// `_url` is unused (this route branches on `pathname` alone) but kept in the
// signature so this sub-router matches the uniform shape `tryServeStudio`
// composes for `STUDIO_SUB_ROUTERS` — the same shape `asset-upload` has. The
// capability and CSRF checks ran in `gateStudioRequest` before this was called.
export async function tryServeStudioAssetDrop(
  req: Request,
  _url: URL,
  pathname: string,
  deps: AssetDropDeps = {},
): Promise<Response | null> {
  if (pathname !== '/admin/api/studio/asset-drop' || req.method !== 'POST') return null

  return withIdempotentReplay(req, () => landDroppedAsset(req, deps), deps.idempotencyRoot)
}

async function landDroppedAsset(req: Request, deps: AssetDropDeps): Promise<Response> {
  try {
    const form = await readFormDataWithLimit(req, MAX_ASSET_DROP_BYTES)

    const dirRaw = form.get('dir')
    const parsed = safeParseValue(AssetDropFieldsSchema, {
      dir: typeof dirRaw === 'string' ? dirRaw : undefined,
    })
    if (!parsed.ok) return badRequest('invalid asset-drop body')

    const file = form.get('file')
    if (!(file instanceof File)) return badRequest('no file was dropped')
    if (file.size === 0) return badRequest('the dropped file is empty')
    if (file.size > MAX_ASSET_DROP_BYTES) {
      return jsonResponse(
        { error: `The image is larger than the ${Math.round(MAX_ASSET_DROP_BYTES / (1024 * 1024))} MB limit.` },
        { status: 413 },
      )
    }

    const resolveDir = deps.resolveDir ?? resolveProjectDir
    const dir = resolveDir(parsed.value.dir)

    const home = resolveDroppedAssetHome(dir)
    if (!home.ok) return jsonResponse({ error: home.error }, { status: 409 })

    const bytes = new Uint8Array(await file.arrayBuffer())
    const landed = landAssetBytes(dir, home.relToProject, bytes, file.name, { dedupe: true })
    if (!landed.ok) return badRequest(landed.error)

    // The home IS `<appRoot>/public`, so the rule must call it build-safe. If
    // it ever does not, the two halves disagree about the app root, and
    // writing a dev-only URL into the user's source would be the exact bug
    // this route exists to prevent: refuse instead.
    const url = assetSiteUrlResolver(dir)(landed.relPath)
    if (url === null || !url.buildSafe) {
      console.error('[studio:asset-drop] landed outside the public root', landed.relPath)
      return jsonResponse({ error: 'Studio could not work out the public URL of the image it just saved.' }, { status: 500 })
    }

    const body: AssetDropPublicResponse = {
      ok: true,
      mode: 'public',
      relPath: landed.relPath,
      src: url.src,
      width: landed.width,
      height: landed.height,
      deduped: landed.deduped,
    }
    return jsonResponse(body)
  } catch (err) {
    rethrowProjectDirRefusal(err)
    console.error('[studio]', err)
    if (err instanceof ArchiveIngestError) {
      return jsonResponse({ error: err.message }, { status: err.status })
    }
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
