/**
 * studioAsset — resolves and serves one workspace-relative asset file for
 * `GET /admin/api/studio/asset?dir=<abs>&path=<workspace-rel>` (§5.3): the
 * images an imported page's `<img src={…}/>` resolves to via
 * `STUDIO_ASSET_SENTINEL` (see `server/handlers/studio.ts`'s module doc for
 * how the sentinel gets rewritten into this endpoint's URL shape in the first
 * place). Split out of `studio.ts` as its own module because the security
 * reasoning below is a complete, self-contained unit — nothing about it
 * depends on routing or on any other studio endpoint.
 *
 * `path` is fully attacker-controlled (it comes straight off the query
 * string), so every check here is adversarial, not just a happy-path guard:
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
 *    `.git`, …) is rejected — those are never "app source" anywhere else in
 *    the studio pipeline (`listWorkspaceFiles`, `createWorkspaceProject`),
 *    and this endpoint shouldn't be a side door into them.
 *  - Finally, the path is resolved through `fs.realpathSync` and re-checked
 *    for containment. `resolve()` alone is lexical — it does not follow
 *    symlinks — so a symlink planted inside `dir` that points outside it
 *    would otherwise sail through every check above. A target that doesn't
 *    exist (or a broken symlink) fails `realpathSync` and falls through to
 *    the caller's 404, which is the correct outcome either way.
 *
 * Serving itself is delegated to `serveStaticFile` (`server/static.ts`),
 * which already owns MIME typing, compression, and range handling — this
 * function's only job is deciding whether `path` is allowed to reach it.
 */
import { isAbsolute, join, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import { EXCLUDED_WORKSPACE_DIR_NAMES } from '@core/page-parser'
import { serveStaticFile } from '../static'

export async function resolveStudioAssetResponse(dir: string, rawPath: string, req: Request): Promise<Response | null> {
  if (isAbsolute(rawPath)) return null
  if (/^[a-zA-Z]:/.test(rawPath)) return null // Windows drive path, e.g. "C:\Users\x"
  if (rawPath.startsWith('\\\\') || rawPath.startsWith('//')) return null // UNC path

  const segments = rawPath.split(/[\\/]+/).filter((segment) => segment.length > 0)
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '..')) return null
  if (segments.some((segment) => EXCLUDED_WORKSPACE_DIR_NAMES.has(segment))) return null

  const root = resolve(dir)
  const resolved = resolve(join(dir, ...segments))
  if (resolved !== root && !resolved.startsWith(root + sep)) return null

  let real: string
  try {
    real = realpathSync(resolved)
  } catch {
    return null // missing file / broken symlink — let the caller 404
  }
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return null // the project dir itself doesn't exist on disk
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return null

  // `serveStaticFile` decodes its `pathname` argument once (it expects a raw
  // URL path component) — but `rawPath` already went through one decode via
  // `url.searchParams.get`. Re-encoding each segment here means its internal
  // decode reconstructs exactly the literal segment text instead of applying
  // a SECOND decode pass (which would corrupt a segment containing a literal
  // `%`, or worse, reinterpret an already-decoded `..`-shaped byte sequence).
  return serveStaticFile(dir, `/${segments.map(encodeURIComponent).join('/')}`, req)
}
