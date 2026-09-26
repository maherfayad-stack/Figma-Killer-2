/**
 * studioAsset — resolves and serves one project asset file for
 * `GET /admin/api/studio/asset?dir=<abs>&(path=<workspace-rel>|url=<site-root>)`
 * (§5.3), and for the capture page's token-gated twin
 * (`/admin/api/agent-capture/asset`, `captureRoute.ts`). The request names the
 * file in one of two ways ({@link StudioAssetTarget}):
 *
 *  - `path` — a workspace-relative path: the images an imported page's
 *    `<img src={…}/>` resolves to via `STUDIO_ASSET_SENTINEL` (see
 *    `server/handlers/studio.ts`'s module doc for how the sentinel gets
 *    rewritten into this endpoint's URL shape), a picker thumbnail;
 *  - `url` — a SITE-ROOT URL as the page's source writes it, `src="/hero.png"`
 *    (P5-B2). A design frame is served by the admin origin, which has nothing
 *    at `/hero.png`; the canvas asks for it here instead
 *    (`canvasProjectAssetUrl.ts`), and `siteUrlWorkspaceCandidates`
 *    (`assetSiteUrl.ts`, the inverse of THE site-URL rule) maps it to the
 *    project files the project's own dev server would answer with.
 *
 * One route, not two: both shapes end in the same guard, the same MIME gate
 * and the same inert headers, so there is one place to audit. Split out of
 * `studio.ts` as its own module because the security reasoning below is a
 * complete, self-contained unit — nothing about it depends on routing or on
 * any other studio endpoint.
 *
 * Both `path` and `url` are fully attacker-controlled (they come straight off
 * the query string), so every check here is adversarial, not just a
 * happy-path guard.
 * They live in ONE decoder, `resolveWorkspaceReadPath` (`@core/page-parser`),
 * shared with `studioEditTargets.ts` so the two read paths cannot drift:
 *
 *  - An absolute path (POSIX `/etc/passwd`, a Windows drive path
 *    `C:\Users\...`, or a UNC path `\\host\share`) is rejected outright.
 *    `path.isAbsolute` is platform-specific (it would NOT flag `C:\...` on a
 *    Linux host), so the drive-letter/UNC forms are matched explicitly too —
 *    this server can run on either OS.
 *  - Every path segment is split on BOTH `/` and `\` before inspection —
 *    Windows accepts backslash separators even inside a value that looks
 *    like a POSIX path, so a check that only splits on `/` misses
 *    `..\\..\\secret`.
 *  - Any segment that is exactly `..` is rejected. Decoy segments that merely
 *    *look* suspicious (`....`, `...`) are NOT rejected by this check — they
 *    are legal (if unusual) file/dir names — but they can't escape `dir`
 *    either, because of the next check:
 *  - The final `resolve(join(dir, ...segments))` must sit at-or-under
 *    `resolve(dir)` — a belt-and-braces containment check independent of the
 *    segment scan above, so a normalization quirk in the scan can't be the
 *    only thing standing between a request and the rest of the filesystem.
 *  - Any segment named in `EXCLUDED_WORKSPACE_DIR_NAMES` (`node_modules`,
 *    `.git`, …) is rejected, compared the way the filesystem resolves it —
 *    case-folded, trailing dots and NTFS stream suffixes dropped, so `.GIT`
 *    and `.git.` are `.git` on Windows. Those are never "app source" anywhere
 *    else in the studio pipeline (`listWorkspaceFiles`,
 *    `createWorkspaceProject`), and this endpoint shouldn't be a side door
 *    into them.
 *  - Finally, the path is resolved through `fs.realpathSync` and re-checked
 *    for containment AND for an excluded directory (a link `pics -> .git`).
 *    `resolve()` alone is lexical — it does not follow
 *    symlinks — so a symlink planted inside `dir` that points outside it
 *    would otherwise sail through every check above. A target that doesn't
 *    exist (or a broken symlink) fails `realpathSync` and falls through to
 *    the caller's 404, which is the correct outcome either way.
 *
 *  - Only an EMBEDDABLE file is served: an image, a font, audio or video
 *    (`isEmbeddableMediaPath`), judged on the requested name AND on the real
 *    path a link resolves to, so `logo.png -> ../src/config.ts` is refused.
 *    Everything this route exists for is loaded by an `<img>`, a CSS `url()`,
 *    an `@font-face` or a `<video>`; nothing it exists for is source, config
 *    or HTML, and the route is not a way to read those.
 *
 * Serving itself is delegated to `serveStaticFile` (`server/static.ts`),
 * which already owns MIME typing, compression, and range handling — this
 * function decides whether the request is allowed to reach it, and stamps the
 * response with `INERT_FILE_CSP` (`default-src 'none'; sandbox`, `nosniff`):
 * the file is the project's, not Studio's, and must never act as a document
 * on this origin. That is what keeps an SVG inert when opened directly.
 */
import { posix } from 'node:path'
import { STUDIO_ASSET_SENTINEL, resolveWorkspaceReadPath } from '@core/page-parser'
import type { Page } from '@core/page-tree'
import { inertFileResponse, isEmbeddableMediaPath, serveStaticFile } from '../static'
import { siteUrlWorkspaceCandidates } from './studio/assetSiteUrl'

/** What one asset request names: a workspace-relative `path`, or a site-root `url` as the page's source writes it. */
export type StudioAssetTarget = { path: string } | { url: string }

/**
 * Reads the request shape off a query string: exactly one of `path` / `url`,
 * non-empty. Both, or neither, is no request at all (`null` → the caller's
 * 404) — an ambiguous request is never guessed at.
 */
export function readStudioAssetTarget(params: URLSearchParams): StudioAssetTarget | null {
  const path = params.get('path')
  const url = params.get('url')
  if (path && !url) return { path }
  if (url && !path) return { url }
  return null
}

export async function resolveStudioAssetResponse(
  dir: string,
  request: StudioAssetTarget,
  req: Request,
): Promise<Response | null> {
  const candidates = 'path' in request ? [request.path] : siteUrlWorkspaceCandidates(dir, request.url)
  for (const candidate of candidates) {
    // The guard answers `null` for a missing file and for a refused one
    // alike, so either falls through to the next candidate. That is safe
    // because the candidates differ only by a fixed, server-chosen prefix
    // (`public/` or none): a `..`, an absolute form or an excluded segment in
    // the client's part is refused in every one of them.
    const target = resolveWorkspaceReadPath(dir, candidate)
    if (!target) continue
    // The first file that EXISTS decides; a non-media file ends the request
    // rather than letting a later rule serve something else under its name.
    // `target.real` is the path the guard itself resolved and approved; no
    // second lookup, so no window to swap a link in between (review of #262).
    if (!isEmbeddableMediaPath(target.rel) || !isEmbeddableMediaPath(target.real)) return null
    return serveContainedFile(dir, target.rel, req)
  }
  return null
}

async function serveContainedFile(dir: string, rel: string, req: Request): Promise<Response | null> {
  const segments = rel.split('/')

  // `serveStaticFile` decodes its `pathname` argument once (it expects a raw
  // URL path component) — but `rawPath` already went through one decode via
  // `url.searchParams.get`. Re-encoding each segment here means its internal
  // decode reconstructs exactly the literal segment text instead of applying
  // a SECOND decode pass (which would corrupt a segment containing a literal
  // `%`, or worse, reinterpret an already-decoded `..`-shaped byte sequence).
  const served = await serveStaticFile(dir, `/${segments.map(encodeURIComponent).join('/')}`, req)
  // A project file is untrusted content served on the admin origin: an SVG or
  // HTML file opened directly would otherwise run its script with the admin
  // session. `INERT_FILE_CSP` is the boundary (review of #248, F1).
  return served ? inertFileResponse(served) : null
}

/**
 * Rewrites every `studio-asset:<workspace-rel>` sentinel prop value (§5.1 —
 * `parsePageFile`'s image-import resolution) into a URL the browser can
 * actually fetch: `/admin/api/studio/asset?dir=<encoded>&path=<encoded>`.
 *
 * Lives here, beside the endpoint it points at, not in `@core/page-parser` or
 * `@core/studio-sync/parsedPageToSitePage` (§5.2's other option): turning a
 * workspace-relative path into a URL is a route-shape decision — the query
 * param names, the endpoint path itself — that belongs with the endpoint that
 * owns that shape (`/admin/api/studio/asset`, served by
 * `resolveStudioAssetResponse` above), not with the pure page-tree converter,
 * which has no notion of `dir` or HTTP routing at all today. Keeping it here
 * means a future route change never touches the parser or the converter.
 * `studioPageLoad.ts` calls it on every page it builds.
 *
 * Mutates `page.nodes` in place — the pages array was just built fresh by
 * `parsedPageToSitePage` for this same request, so there is no shared/cached
 * object to accidentally corrupt.
 */
export function rewriteStudioAssetSentinels(page: Page, dir: string): void {
  const dirParam = encodeURIComponent(dir)
  for (const node of Object.values(page.nodes)) {
    for (const [key, value] of Object.entries(node.props)) {
      if (typeof value === 'string' && value.startsWith(STUDIO_ASSET_SENTINEL)) {
        const relPath = value.slice(STUDIO_ASSET_SENTINEL.length)
        node.props[key] = `/admin/api/studio/asset?dir=${dirParam}&path=${encodeURIComponent(relPath)}`
      }
    }
  }
}

/** `url(…)` with a plain quoted or bare body — an escaped body is left for the browser, which is where it was before. */
const CSS_URL_PLAIN = /url\(\s*(?:"([^"\\\n]*)"|'([^'\\\n]*)'|([^)"'\s\\]*))\s*\)/gi

/** A URL with a scheme (`https:`, `data:`), a site-root or protocol-relative path, or a fragment: not relative to the sheet. */
const NOT_SHEET_RELATIVE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/|#)/

/**
 * P5-B3 — every RELATIVE `url(./bg.png)` in a project stylesheet, as the
 * `studio-asset:<workspace-rel>` sentinel of the file it names.
 *
 * The project's own bundler resolves `url(./bg.png)` in `src/styles/app.css`
 * to `src/styles/bg.png`. A design frame cannot: its stylesheet is injected
 * as text into an `about:srcdoc` document on the admin origin, where a
 * relative URL resolves against the admin page and 404s (found by P5-B2,
 * #262). The sheet's path is known only HERE, when the text is read, so this
 * is where the reference is pinned to a file; the canvas turns the sentinel
 * into its project-asset route (`canvasProjectAssetUrl.ts`), exactly as it
 * does an imported image's. Only the canvas copy of the CSS
 * (`StudioStyles.authoredCss`) is rewritten — never the user's file, never a
 * publish. A reference that climbs out of the project, or carries a
 * character that would need escaping in a CSS string, is left as written.
 */
export function relativeCssUrlsToAssetSentinels(css: string, sheetRel: string): string {
  if (!/url\(/i.test(css)) return css
  const sheetDir = posix.dirname(sheetRel)
  const rewrite = (whole: string, doubleQuoted?: string, singleQuoted?: string, bare?: string): string => {
    const raw = (doubleQuoted ?? singleQuoted ?? bare ?? '').trim()
    if (raw === '' || NOT_SHEET_RELATIVE.test(raw)) return whole
    const pathPart = raw.split(/[?#]/)[0]!
    let decoded: string
    try {
      decoded = decodeURIComponent(pathPart)
    } catch {
      return whole
    }
    const rel = posix.normalize(posix.join(sheetDir, decoded))
    if (rel === '.' || rel === '..' || rel.startsWith('../') || /["\\\n\r]/.test(rel)) return whole
    return `url("${STUDIO_ASSET_SENTINEL}${rel}")`
  }

  // A `url(` inside a comment or a string is TEXT, not a reference: rewriting
  // `content: "url(./a)"` would break the string (review of #275, N4). So the
  // sheet is walked token by token and only a bare `url(` is considered.
  const urlAt = new RegExp(CSS_URL_PLAIN.source, 'iy')
  let out = ''
  let i = 0
  while (i < css.length) {
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2)
      const next = end === -1 ? css.length : end + 2
      out += css.slice(i, next)
      i = next
      continue
    }
    const char = css[i]!
    if (char === '"' || char === "'") {
      let j = i + 1
      while (j < css.length && css[j] !== char && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1
      const next = Math.min(css.length, j + 1)
      out += css.slice(i, next)
      i = next
      continue
    }
    if ((char === 'u' || char === 'U') && !/[\w-]/.test(css[i - 1] ?? '')) {
      urlAt.lastIndex = i
      const match = urlAt.exec(css)
      if (match) {
        out += rewrite(match[0], match[1], match[2], match[3])
        i += match[0].length
        continue
      }
    }
    out += char
    i += 1
  }
  return out
}
