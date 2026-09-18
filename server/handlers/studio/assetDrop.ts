/**
 * assetDrop — `POST /admin/api/studio/asset-drop` (D2 G15): the write behind
 * dropping an image file from the operating system onto a board frame.
 *
 * ## Why this is not `asset-upload`
 *
 * It shares that route's entire security pipeline — `landAssetBytes` does the
 * sniffing, the SVG sanitisation, the containment check and the collision-safe
 * write, and nothing here duplicates a byte of it. What it does NOT share is
 * the QUESTION. `asset-upload`'s caller already knows where the file goes: the
 * inspector's image-fill picker passes the directory an existing `import
 * heroImg from '…'` points at, because it is about to repoint that import.
 *
 * A dropped file has no import to repoint and no picker to say where it
 * belongs, and the element the drop is about to write is `<img src="…">` — a
 * STRING ATTRIBUTE, not a binding. So this route answers the question that
 * upload's caller answered for itself: **which directory in THIS project can
 * back a literal `src`, and what is the literal?**
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
 * ## Who is allowed to ask (`sec-17`)
 *
 * Two gates, both BEFORE the body is read, because a 25 MB body buffered for a
 * caller who is about to be refused is itself the cost:
 *
 *   - **`originAllowed`** — the CSRF check `studio/git.ts` and the git-sync
 *     routes already apply to every POST they own. Without it any page the
 *     user happens to have open can reach this route with a plain
 *     `<form enctype="multipart/form-data">`: no preflight, no JavaScript, and
 *     a file of the attacker's choosing lands in the repository the user is
 *     currently editing. The browser writes `Origin` and a page cannot forge
 *     it, which is the whole value of the check.
 *   - **`requireCapability('studio.write')`** — the same gate `/delete`,
 *     `/duplicate` and the trash writes carry, and the capability whose own
 *     doc says it "gates install/save/frame/codemod mutations". Writing a file
 *     into someone's repository is one of those. This is why the route rides
 *     `STUDIO_SESSION_SUB_ROUTERS` (it needs the `DbClient`) rather than the
 *     plain `(req, url, pathname)` list `asset-upload` is still on.
 *
 * When `sec-14`'s table-driven gating (`routeCapabilities.ts`, PR #167) lands,
 * this route belongs in it as a WRITE — `studio.write` — and the inline
 * `requireCapability` below should become that table's entry rather than a
 * second, parallel check.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import { isStateChangingMethod, originAllowed } from '../../auth/security'
import { requireCapability } from '../../auth/authz'
import type { DbClient } from '../../db/client'
import { badRequest, jsonResponse } from '../../http'
import { resolveProjectDir, rethrowProjectDirRefusal } from '../studioProjects'
import { ArchiveIngestError, readFormDataWithLimit } from './archiveIngest'
import { landAssetBytes } from './assetLanding'
import { resolveAppRoot } from './appRoot'
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

/** The one directory a dropped asset may land in. See this module's own doc. */
const PUBLIC_DIR = 'public'

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
 * The literal a `public/` file is reachable at — its name, at the site root.
 *
 * `relPath` comes back from `landAssetBytes` as a PROJECT-relative path
 * (`public/photo.png`, or `apps/web/public/photo.png` in a monorepo), and the
 * part that matters is only ever what follows `public/`: everything above it
 * is where the app lives on disk, which the browser never sees.
 */
export function droppedAssetSrc(relPath: string): string {
  const marker = `${PUBLIC_DIR}/`
  const at = relPath.lastIndexOf(marker)
  const tail = at === -1 ? relPath : relPath.slice(at + marker.length)
  return `/${tail}`
}

export interface AssetDropDeps {
  /**
   * Overrides the real `resolveProjectDir` — test-only, mirroring
   * `AssetUploadDeps.resolveDir`. Without this seam a test that omits `dir`
   * (a supported request shape) would fall back to THIS repo's own real
   * `studio-workspace/` and could write a fixture into it.
   */
  resolveDir?: (requested: string | null | undefined) => string
  /**
   * Overrides the `studio.write` capability check — test-only, so the
   * behavioural tests below it (which directory, which bytes, which refusal)
   * can drive the route without standing up a real `sessions` table.
   *
   * Returns a `Response` to refuse, `null` to allow. Production never passes
   * one: `tryServeStudio` calls this sub-router with no `deps` at all, so the
   * default — the real {@link requireCapability} — is what every real request
   * meets. The "no deps, no session → 401" test is what pins that.
   */
  authorize?: (req: Request, db: DbClient) => Promise<Response | null>
}

async function defaultAuthorize(req: Request, db: DbClient): Promise<Response | null> {
  const user = await requireCapability(req, db, 'studio.write')
  return user instanceof Response ? user : null
}

// `_url` is unused (this route branches on `pathname` alone) but kept in the
// signature so this sub-router matches the shape `tryServeStudio` composes for
// `STUDIO_SESSION_SUB_ROUTERS` — the list that additionally carries the
// `DbClient`, which this route needs for its capability check.
export async function tryServeStudioAssetDrop(
  req: Request,
  runtime: { db: DbClient },
  _url: URL,
  pathname: string,
  deps: AssetDropDeps = {},
): Promise<Response | null> {
  if (pathname !== '/admin/api/studio/asset-drop' || req.method !== 'POST') return null

  // Both gates run BEFORE the body is touched: a caller who is about to be
  // refused must not get 25 MB of server memory spent on them first, and a
  // forged cross-origin POST must not reach the filesystem at all. The
  // response says nothing about the workspace — see the git routes' own CSRF
  // tests for why the message is deliberately bare.
  if (isStateChangingMethod(req.method) && !originAllowed(req)) {
    return jsonResponse({ error: 'Forbidden' }, { status: 403 })
  }
  const refusal = await (deps.authorize ?? defaultAuthorize)(req, runtime.db)
  if (refusal) return refusal

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
    const landed = landAssetBytes(dir, home.relToProject, bytes, file.name)
    if (!landed.ok) return badRequest(landed.error)

    return jsonResponse({ ok: true, relPath: landed.relPath, src: droppedAssetSrc(landed.relPath) })
  } catch (err) {
    rethrowProjectDirRefusal(err)
    console.error('[studio]', err)
    if (err instanceof ArchiveIngestError) {
      return jsonResponse({ error: err.message }, { status: err.status })
    }
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
