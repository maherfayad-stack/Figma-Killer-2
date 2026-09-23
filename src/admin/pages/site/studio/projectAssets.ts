/**
 * projectAssets — the client half of `GET /admin/api/studio/project-assets`
 * (`server/handlers/studio/projectAssets.ts`): every image file already in the
 * open workspace, so the Fill section's image picker can offer the project's
 * OWN assets before it offers an upload or a pasted URL.
 *
 * Cached per workspace dir behind one in-flight promise, the same shape
 * `iconCatalog.ts` uses and for the same reason: this is a directory walk of
 * the user's repo, fetched when a picker first opens, never per keystroke.
 * Unlike the icon catalog the payload is only paths and URLs (no markup), so
 * it stays small even for an asset-heavy repo. Each entry carries the URL the
 * project's own site serves the file at, computed by the server's one rule
 * (`assetSiteUrl.ts`); nothing here derives a URL from a path.
 *
 * Never throws: a failed fetch resolves to an empty list (logged), which the
 * picker renders as "no images in this project" — never as a broken panel.
 * The upload and URL tabs still work in that state.
 */
import { useEffect, useState } from 'react'
import { apiRequest } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { studioWriteDir } from './studioWorkspaceDir'

const ProjectImageAssetSchema = Type.Object({
  /** Workspace-relative POSIX path — what the admin preview endpoint reads. */
  relPath: Type.String(),
  /** The URL the project's own site serves the file at, e.g. `/hero.png`. `null` when nothing serves it. */
  src: Type.Union([Type.String(), Type.Null()]),
  /** True when a production build serves `src` too; false means "dev server only". */
  buildSafe: Type.Boolean(),
})
export type ProjectImageAsset = Static<typeof ProjectImageAssetSchema>

const ProjectAssetsResponseSchema = Type.Object({
  /** Sorted by path, capped server-side. */
  assets: Type.Array(ProjectImageAssetSchema),
})

let cache: { dir: string | undefined; promise: Promise<ProjectImageAsset[]> } | null = null

export function fetchProjectImageAssets(): Promise<ProjectImageAsset[]> {
  const dir = studioWriteDir() ?? undefined
  if (cache && cache.dir === dir) return cache.promise
  const promise = apiRequest('/admin/api/studio/project-assets', {
    query: { dir },
    schema: ProjectAssetsResponseSchema,
  })
    .then((res) => res.assets)
    .catch((err) => {
      console.error('[projectAssets] fetch failed:', err)
      return []
    })
  cache = { dir, promise }
  return promise
}

/** Drops the cached list — call after an upload lands a new file. */
export function invalidateProjectImageAssets(): void {
  cache = null
}

/**
 * The authenticated URL that renders one workspace-relative asset INSIDE the
 * admin (a picker thumbnail, a layer-row swatch).
 *
 * This is deliberately NOT the value written into the user's source. What
 * goes in their stylesheet has to be what THEIR build resolves
 * (the server's `assetSiteUrl.ts`); this endpoint only exists because the admin app is
 * served from a different origin than the project's own dev server and has no
 * other way to see a file on disk.
 */
export function studioAssetPreviewUrl(relPath: string): string {
  const dir = studioWriteDir()
  const dirParam = dir ? `dir=${encodeURIComponent(dir)}&` : ''
  return `/admin/api/studio/asset?${dirParam}path=${encodeURIComponent(relPath)}`
}

/**
 * The project's image list as React state, fetched once per workspace and
 * shared through the module cache above. Returns `null` while the first fetch
 * is in flight so a caller can tell "still loading" from "this project has no
 * images" — those render differently in the picker.
 */
export function useProjectImageAssets(): readonly ProjectImageAsset[] | null {
  const [assets, setAssets] = useState<readonly ProjectImageAsset[] | null>(null)

  useEffect(() => {
    let live = true
    fetchProjectImageAssets().then((next) => {
      if (live) setAssets(next)
    })
    return () => {
      live = false
    }
  }, [])

  return assets
}

/**
 * The `src` that previews a written `url()` payload INSIDE the admin, or
 * `undefined` when nothing here can show it.
 *
 * An absolute/`data:`/`blob:` URL is already loadable as-is. A project-
 * relative one is not — the admin is a different origin from the user's dev
 * server — so it is matched against the KNOWN asset list (by the `src` the
 * server reported for each file, never by re-deriving a path from the URL)
 * and served through the authenticated read endpoint. A path that matches nothing returns
 * `undefined`: the row shows a neutral placeholder instead of a broken image,
 * which is the honest rendering of "this file is not in your project".
 */
export function imageFillPreviewSrc(
  cssUrl: string,
  assets: readonly ProjectImageAsset[] | null,
): string | undefined {
  const trimmed = cssUrl.trim()
  if (trimmed === '') return undefined
  if (/^(?:https?:|data:|blob:)/i.test(trimmed)) return trimmed
  if (assets === null) return undefined
  const asset = assets.find((candidate) => candidate.src === trimmed)
  return asset === undefined ? undefined : studioAssetPreviewUrl(asset.relPath)
}
