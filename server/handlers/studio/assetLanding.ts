/**
 * assetLanding — the single choke point that writes an image (or SVG) byte
 * buffer into a Studio project as a new, collision-safe file.
 *
 * Three callers converge here:
 *   - `assetUpload.ts` (`POST /admin/api/studio/asset-upload`) — bytes come
 *     from a multipart upload the browser has already read into memory.
 *   - `remoteAssetFetch.ts` (`studio_fetch_remote_asset`) — bytes come from a
 *     server-side fetch of a caller-supplied URL. Different transport, same
 *     destination, same threat model.
 *   - `designReferenceStore.ts` (`studio_register_design_reference`) — same
 *     sniff/sanitize/collision-safe write, but the ONE caller allowed to
 *     target `.studio/` (see `DESIGN_REFERENCE_ASSET_DIR`) instead of an
 *     app-code asset directory, because a design reference is Studio's own
 *     state, never an `<img>` import target.
 *
 * Every input here is adversarial regardless of caller: the target directory
 * may not exist yet, the declared filename is never trusted, and the actual
 * bytes decide both whether to accept the file and which extension to write
 * it with — never the declared MIME type or filename extension.
 *
 * SVG is sanitized before it ever touches disk. This module was extracted
 * FROM `assetUpload.ts`, which — before this extraction — sniffed SVG
 * content and happily wrote it verbatim, with no sanitization step at all.
 * That was a real gap, not a deliberate choice: `server/handlers/cms/
 * mediaUpload.ts` (the CMS media-library upload path) already runs every
 * SVG through `sanitizeSvgBytes` before it lands on disk, for exactly the
 * reason `svgSanitize.ts`'s own doc comment states — SVG is XML with a
 * script surface, and a project's own dev server serves a written .svg file
 * as `image/svg+xml`, which executes inline `<script>`/event-handler
 * content if the file is ever navigated to directly. Landing this pipeline
 * in ONE shared function, used by both write paths into the workspace, means
 * a future third caller inherits the same protection instead of needing its
 * own copy — and closes the gap for the two that already exist.
 *
 * Deliberately `sanitizeSvgBytes` (the server-safe STRING sanitizer), never
 * `sanitizeSvg` from `@core/sanitize` (the DOMPurify-based one) — that
 * file's SVG profile is documented as unusable under this server's happy-dom
 * runtime (DOMPurify drops every SVG child element, leaving an empty
 * `<svg></svg>` wrapper). `svgSanitize.ts`'s own doc comment explains why a
 * targeted string sanitizer is the correct, dependency-free choice here.
 */
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { EXCLUDED_WORKSPACE_DIR_NAMES } from '@core/page-parser'
import { sanitizeSvgBytes } from '../cms/svgSanitize'

/** Where a bare (no `targetDir`) asset write lands — the conventional home for local images in a Vite/CRA-shaped repo. */
export const DEFAULT_ASSET_TARGET_DIR = 'src/assets'

/**
 * The ONE deliberate exception to the `.studio` entry in
 * `EXCLUDED_WORKSPACE_DIR_NAMES` below — see `resolveAssetWriteDir`. A design
 * reference (`server/handlers/studio/designReferenceStore.ts`) is Studio's
 * own state, not app code the parser would ever walk, so it belongs beside
 * `boards.json`/`meta.json` under `.studio/`, not under `src/assets` where an
 * ordinary upload lands to become an `<img>` import. Every OTHER `.studio`
 * target (and every other excluded dir name) stays refused exactly as before.
 */
export const DESIGN_REFERENCE_ASSET_DIR = '.studio/references'

export type LandAssetResult =
  | { ok: true; relPath: string }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Target-directory containment — the target directory may not exist yet (a
// fresh `src/assets`), so containment is checked on the nearest EXISTING
// ancestor's real path rather than the target's own.
// ---------------------------------------------------------------------------

export function resolveAssetWriteDir(dir: string, targetDirRaw: string | undefined): string | null {
  const rel = targetDirRaw && targetDirRaw.trim().length > 0 ? targetDirRaw.trim() : DEFAULT_ASSET_TARGET_DIR
  if (isAbsolute(rel)) return null
  if (/^[a-zA-Z]:/.test(rel)) return null // Windows drive path, e.g. "C:\Users\x"
  if (rel.startsWith('\\\\') || rel.startsWith('//')) return null // UNC path

  const segments = rel.split(/[\\/]+/).filter((segment) => segment.length > 0)
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '..' || segment === '.')) return null
  // `.studio` is excluded for every OTHER target (it is editor-owned spatial
  // metadata, never app code) — `DESIGN_REFERENCE_ASSET_DIR` is the one
  // literal path allowed to land there. Matched on the whole normalized
  // relative path, not just a segment name, so a caller can't smuggle an
  // unrelated `.studio/<anything else>` write through this exception.
  const isDesignReferenceTarget = segments.join('/') === DESIGN_REFERENCE_ASSET_DIR
  if (!isDesignReferenceTarget && segments.some((segment) => EXCLUDED_WORKSPACE_DIR_NAMES.has(segment))) return null

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

/** `(magic bytes) -> canonical extension`, checked in order. `null` when nothing recognizes the content — an upload/fetch nothing here can vouch for is refused, never guessed at. */
export function sniffImageExtension(bytes: Uint8Array): string | null {
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

/** Strips path separators and anything outside a conservative safe set — the caller-declared filename is untrusted input, used only for its base name. */
export function sanitizeAssetBaseName(rawName: string): string {
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

/**
 * Land `bytes` into `dir`/`targetDirRaw` (or the default asset dir) as a new,
 * collision-safe file. `declaredFilename` is used ONLY for its base name (a
 * hint for the written filename) — the actual bytes decide the extension,
 * and SVG bytes are sanitized before the write. Never throws.
 */
export function landAssetBytes(
  dir: string,
  targetDirRaw: string | undefined,
  bytes: Uint8Array,
  declaredFilename: string,
): LandAssetResult {
  const writeDir = resolveAssetWriteDir(dir, targetDirRaw)
  if (writeDir === null) return { ok: false, error: 'Invalid target directory.' }

  const ext = sniffImageExtension(bytes)
  if (ext === null) return { ok: false, error: 'The content is not a recognized image format.' }

  let finalBytes = bytes
  if (ext === 'svg') {
    const sanitized = sanitizeSvgBytes(bytes)
    if (sanitized.length === 0) {
      return { ok: false, error: 'SVG content is empty after sanitisation (likely contains only disallowed elements).' }
    }
    finalBytes = sanitized
  }

  mkdirSync(writeDir, { recursive: true })
  const finalPath = uniqueAssetPath(writeDir, sanitizeAssetBaseName(declaredFilename), ext)
  writeFileSync(finalPath, Buffer.from(finalBytes))

  const relPath = relative(resolve(dir), finalPath).split(sep).join('/')
  return { ok: true, relPath }
}
