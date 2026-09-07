/**
 * projectAssets — `GET /admin/api/studio/project-assets?dir=<abs>`, the READ
 * side of the inspector's image-fill picker: "which images does this project
 * already contain?".
 *
 * The three routes this sits between were all already here, and none of them
 * answered that question:
 *
 *   - `studioAsset.ts` serves ONE known workspace-relative file.
 *   - `assetUpload.ts` LANDS a new file (sniffed, contained, collision-safe).
 *   - `iconCatalog.ts` lists the SVGs a design-system *package* ships.
 *
 * So the Fill section's image picker had nothing to enumerate. This route is
 * that enumeration and nothing else: `listWorkspaceFiles` (the same walk the
 * download-zip and the parser use, which already skips `node_modules`, `.git`,
 * `dist`, `.next`, `.turbo`, `.studio`, and never follows a symlink) filtered
 * to image extensions.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 *   - **No file contents, no stat, no thumbnails.** The response is a list of
 *     workspace-relative POSIX paths. Each one becomes a `<img src>` pointed
 *     at `/admin/api/studio/asset`, which already owns the adversarial path
 *     resolution — this route must not grow a second copy of it.
 *   - **No `prototype/`.** That directory is Studio's own preview scaffold
 *     sitting inside the user's repo (`isPrototypeShellPath`); its images are
 *     not the user's design assets and offering them would put Studio's own
 *     chrome into the user's stylesheet.
 *   - **No trust tier.** This is `readdir`. Nothing is imported, bundled or
 *     evaluated — "parse, never execute" holds trivially.
 */
import { isPrototypeShellPath, listWorkspaceFiles } from '@core/page-parser'
import { jsonResponse } from '../../http'
import { resolveProjectDir, rethrowProjectDirRefusal } from '../studioProjects'

const ROUTE_PATH = '/admin/api/studio/project-assets'

/**
 * Extensions offered as a CSS `background-image`. Matches the formats
 * `sniffImageExtension` (`assetLanding.ts`) is willing to WRITE, so the picker
 * can never list a kind of file the upload path would have refused — with
 * `.jpeg` added, because that spelling exists on disk in real repos even
 * though the landing pipeline normalises new writes to `.jpg`.
 */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'])

/**
 * Ceiling on one response. A design-heavy repo can hold thousands of exported
 * frames; the picker is a scrolling grid with a filter, not a file manager,
 * and an unbounded list would be a slow request for a panel nobody scrolls to
 * the end of.
 */
export const MAX_PROJECT_ASSETS = 500

/** Every image file in the workspace, workspace-relative POSIX paths, sorted, capped. */
export function listProjectImageAssets(dir: string): string[] {
  const assets: string[] = []
  for (const rel of listWorkspaceFiles(dir)) {
    if (assets.length >= MAX_PROJECT_ASSETS) break
    if (isPrototypeShellPath(rel)) continue
    const dot = rel.lastIndexOf('.')
    if (dot === -1) continue
    if (!IMAGE_EXTENSIONS.has(rel.slice(dot + 1).toLowerCase())) continue
    assets.push(rel)
  }
  return assets
}

/** `GET /admin/api/studio/project-assets?dir=<abs>` — see module doc. */
export async function tryServeStudioProjectAssets(
  req: Request,
  url: URL,
  pathname: string,
): Promise<Response | null> {
  if (pathname !== ROUTE_PATH || req.method !== 'GET') return null

  try {
    const dir = resolveProjectDir(url.searchParams.get('dir'))
    return jsonResponse({ assets: listProjectImageAssets(dir) })
  } catch (err) {
    rethrowProjectDirRefusal(err)
    console.error('[studio:project-assets]', err)
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
