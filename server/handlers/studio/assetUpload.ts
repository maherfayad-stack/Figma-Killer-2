/**
 * assetUpload — `POST /admin/api/studio/asset-upload`, the write-side sibling
 * of `studioAsset.ts`'s read-only asset endpoint (WS-8.3). Lands one image
 * file into the workspace so it can back either:
 *
 *   - a `kind: 'asset'` studio edit (`studioWriteback.ts`), which repoints an
 *     EXISTING `import heroImg from '...'` at the new file, or
 *   - a literal `src="..."` prop, written through the ordinary `kind: 'prop'`
 *     edit the client already has.
 *
 * Exported as its own sub-router (`tryServeStudioAssetUpload`) rather than
 * added inline to `studio.ts` — see that file's module doc and
 * `STUDIO_SUB_ROUTERS` for the composition pattern every parallel-wave route
 * follows; wiring this one in is the orchestrator's job (`meta-04`).
 *
 * Body is `multipart/form-data`:
 *   - `dir`       — the project directory (same field every studio route uses).
 *   - `targetDir` — optional, workspace-relative. Defaults to `src/assets`
 *     when omitted; the caller is expected to pass the directory an existing
 *     import already points at when replacing that import's target.
 *   - `file`      — the uploaded image.
 *
 * Response: `{ ok: true, relPath }` — the new file's workspace-relative POSIX
 * path, exactly the shape `kind: 'asset'`'s `assetPath` field expects and
 * `resolveContainedAssetPath` (`studioWriteback.ts`) re-validates before it is
 * ever used to rewrite an import.
 *
 * SECURITY — this is a write path into the user's repo, so every input is
 * adversarial, not just the happy path:
 *
 *   - `targetDir` gets the full guard set `resolveStudioAssetResponse` (the
 *     READ side) already established: absolute/UNC/drive-letter rejection,
 *     `..`/empty segments on EITHER separator, `EXCLUDED_WORKSPACE_DIR_NAMES`,
 *     lexical containment under `dir`, THEN containment on the REAL path of
 *     the nearest EXISTING ancestor (the target dir itself may not exist yet)
 *     — a workspace can arrive from GitHub, and git stores symlinks, so a
 *     textual check alone is bypassable.
 *   - The request body is capped by STREAMED byte count
 *     (`readFormDataWithLimit`), not `content-length` — a spoofed/missing
 *     header can't bypass the cap.
 *   - The file's declared name and MIME type are never trusted. The actual
 *     bytes are sniffed against real image magic numbers (`sniffImageExtension`)
 *     to decide both whether to accept it AND which extension to write it
 *     with — a `.png`-named, `image/png`-declared upload whose bytes are
 *     something else is rejected outright, not written with a lying
 *     extension.
 *   - The final filename is DERIVED (sanitized base name + sniffed
 *     extension), never the raw client-supplied name — no path separators,
 *     no traversal, no surprise overwrite of an unrelated file (collisions
 *     get a numeric suffix instead of clobbering).
 */
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { EXCLUDED_WORKSPACE_DIR_NAMES } from '@core/page-parser'
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse } from '../../http'
import { ArchiveIngestError, readFormDataWithLimit } from './archiveIngest'
import { resolveProjectDir } from '../studioProjects'

/** Per-file cap for an asset upload — tighter than the general archive-import cap; a single image has no business exceeding this. */
export const MAX_ASSET_UPLOAD_BYTES = 25 * 1024 * 1024 // 25 MB

/** Where a bare (no `targetDir`) upload lands — the conventional home for local images in a Vite/CRA-shaped repo. */
const DEFAULT_ASSET_TARGET_DIR = 'src/assets'

const AssetUploadFieldsSchema = Type.Object({
  // Optional, same convention as every other studio route's `dir` field
  // (`SaveBodySchema` etc.) — `resolveProjectDir(undefined)` falls back to
  // the first project on disk, so a client that hasn't overridden the active
  // workspace still uploads against the right project.
  dir: Type.Optional(Type.String()),
  targetDir: Type.Optional(Type.String()),
})

// ---------------------------------------------------------------------------
// Target-directory containment — mirrors `resolveStudioAssetResponse`
// (`studioAsset.ts`), adapted for a WRITE: the target directory may not exist
// yet (a fresh `src/assets`), so containment is checked on the nearest
// EXISTING ancestor's real path rather than the target's own.
// ---------------------------------------------------------------------------

function resolveWriteDir(dir: string, targetDirRaw: string | undefined): string | null {
  const rel = targetDirRaw && targetDirRaw.trim().length > 0 ? targetDirRaw.trim() : DEFAULT_ASSET_TARGET_DIR
  if (isAbsolute(rel)) return null
  if (/^[a-zA-Z]:/.test(rel)) return null // Windows drive path, e.g. "C:\Users\x"
  if (rel.startsWith('\\\\') || rel.startsWith('//')) return null // UNC path

  const segments = rel.split(/[\\/]+/).filter((segment) => segment.length > 0)
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '..' || segment === '.')) return null
  if (segments.some((segment) => EXCLUDED_WORKSPACE_DIR_NAMES.has(segment))) return null

  const root = resolve(dir)
  const target = resolve(join(dir, ...segments))
  if (target !== root && !target.startsWith(root + sep)) return null

  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return null // the project dir itself doesn't exist on disk
  }

  // Walk up to the nearest EXISTING ancestor (could be `dir` itself when
  // `targetDir` is entirely new) and verify ITS real path is contained — this
  // is what catches a symlinked intermediate directory (`src` -> outside the
  // workspace) even though the leaf path itself has never been written.
  let probe = target
  for (;;) {
    if (existsSync(probe)) break
    const parent = dirname(probe)
    if (parent === probe) return null // reached the filesystem root without finding an existing ancestor
    probe = parent
  }
  let realProbe: string
  try {
    realProbe = realpathSync(probe)
  } catch {
    return null
  }
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) return null

  return target
}

// ---------------------------------------------------------------------------
// Content sniffing — the declared filename/MIME type is never trusted for
// deciding what gets written; the actual bytes are.
// ---------------------------------------------------------------------------

function looksLikeSvg(bytes: Uint8Array): boolean {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 2048))
  } catch {
    return false
  }
  text = text.replace(/^\uFEFF/, '').trimStart()
  // Skip a leading XML declaration / comments / doctype — real SVG exports
  // routinely carry one or more of these before the `<svg` root element.
  for (let i = 0; i < 10; i += 1) {
    if (text.startsWith('<?xml')) {
      const end = text.indexOf('?>')
      if (end === -1) return false
      text = text.slice(end + 2).trimStart()
      continue
    }
    if (text.startsWith('<!--')) {
      const end = text.indexOf('-->')
      if (end === -1) return false
      text = text.slice(end + 3).trimStart()
      continue
    }
    if (/^<!doctype/i.test(text)) {
      const end = text.indexOf('>')
      if (end === -1) return false
      text = text.slice(end + 1).trimStart()
      continue
    }
    break
  }
  return /^<svg[\s>]/i.test(text)
}

/** `(magic bytes) -> canonical extension`, checked in order. `null` when nothing recognizes the content — an upload nothing here can vouch for is refused, never guessed at. */
function sniffImageExtension(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg'
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'gif'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'webp'
  }
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70 &&
    bytes[8] === 0x61 && bytes[9] === 0x76 && bytes[10] === 0x69 && (bytes[11] === 0x66 || bytes[11] === 0x73)
  ) {
    return 'avif'
  }
  if (looksLikeSvg(bytes)) return 'svg'
  return null
}

/** Strips path separators and anything outside a conservative safe set — the client-declared filename is untrusted input, used only for its base name. */
function sanitizeBaseName(rawName: string): string {
  const base = rawName.split(/[\\/]+/).pop() ?? 'asset'
  const withoutExt = base.replace(/\.[^./\\]+$/, '')
  const cleaned = withoutExt.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
  const truncated = cleaned.slice(0, 80)
  return truncated.length > 0 ? truncated : 'asset'
}

/** First non-colliding `<base>[-N].<ext>` inside `writeDir` — never silently overwrites an unrelated existing file. */
function uniqueAssetPath(writeDir: string, base: string, ext: string): string {
  let candidate = join(writeDir, `${base}.${ext}`)
  for (let n = 2; existsSync(candidate); n += 1) {
    candidate = join(writeDir, `${base}-${n}.${ext}`)
    if (n > 1000) break // pathological — stop guessing rather than loop forever
  }
  return candidate
}

export interface AssetUploadDeps {
  /**
   * Overrides the real `resolveProjectDir` — test-only, mirrors
   * `ImportUploadDeps.projectsRoot` in `studio/importUpload.ts`. Without this
   * seam, a test that omits `dir` (a real, supported request shape — see
   * `SaveBodySchema`'s identical `Type.Optional`) would fall back to THIS
   * repo's own real `studio-workspace/` and could write a test fixture into
   * it, which is never allowed.
   */
  resolveDir?: (requested: string | null | undefined) => string
}

// `_url` is unused (this route only branches on `pathname`) but kept in the
// signature so this sub-router matches the shape `tryServeStudio` already
// composes (`req, url, pathname`) — see `server/handlers/studio.ts`.
export async function tryServeStudioAssetUpload(
  req: Request,
  _url: URL,
  pathname: string,
  deps: AssetUploadDeps = {},
): Promise<Response | null> {
  if (pathname !== '/admin/api/studio/asset-upload' || req.method !== 'POST') return null

  try {
    const form = await readFormDataWithLimit(req, MAX_ASSET_UPLOAD_BYTES)

    const dirRaw = form.get('dir')
    const targetDirRaw = form.get('targetDir')
    const parsedFields = safeParseValue(AssetUploadFieldsSchema, {
      dir: typeof dirRaw === 'string' ? dirRaw : undefined,
      targetDir: typeof targetDirRaw === 'string' ? targetDirRaw : undefined,
    })
    if (!parsedFields.ok) return badRequest('invalid asset-upload body')

    const file = form.get('file')
    if (!(file instanceof File)) return badRequest('no file was uploaded')
    if (file.size === 0) return badRequest('the uploaded file is empty')
    if (file.size > MAX_ASSET_UPLOAD_BYTES) {
      return jsonResponse(
        { error: `The image is larger than the ${Math.round(MAX_ASSET_UPLOAD_BYTES / (1024 * 1024))} MB upload limit.` },
        { status: 413 },
      )
    }

    const resolveDir = deps.resolveDir ?? resolveProjectDir
    const dir = resolveDir(parsedFields.value.dir)
    const writeDir = resolveWriteDir(dir, parsedFields.value.targetDir)
    if (writeDir === null) return badRequest('invalid target directory')

    const bytes = new Uint8Array(await file.arrayBuffer())
    const ext = sniffImageExtension(bytes)
    if (ext === null) return badRequest('the uploaded file is not a recognized image format')

    mkdirSync(writeDir, { recursive: true })
    const finalPath = uniqueAssetPath(writeDir, sanitizeBaseName(file.name), ext)
    writeFileSync(finalPath, Buffer.from(bytes))

    const relPath = relative(resolve(dir), finalPath).split(sep).join('/')
    return jsonResponse({ ok: true, relPath })
  } catch (err) {
    console.error('[studio]', err)
    if (err instanceof ArchiveIngestError) {
      return jsonResponse({ error: err.message }, { status: err.status })
    }
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
