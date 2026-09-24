/**
 * studioPublicAssets — how a design canvas DISPLAYS a site-root image URL
 * (`<img src="/hero.png">`) from the open project's `public/` directory.
 *
 * ## The gap
 *
 * A Studio image drop (a frame drop, and P5-G's free-canvas drop) writes the
 * URL every framework serves a `public/` file at: `/hero.png`. That is right in
 * the source and right in the running app. But a design frame — and the
 * free-canvas surface, which is always a static document — is a `srcDoc`
 * iframe on the ADMIN origin, where `/hero.png` names nothing: the image
 * renders broken, and a loose image layer with no intrinsic size renders as
 * nothing at all.
 *
 * ## The fix is display-only
 *
 * The `/load` response names the project's public directory (`publicRoot`,
 * relative to the project, e.g. `public` or `apps/web/public`), and the canvas
 * maps a site-root `src` to the authenticated asset route that serves that
 * file (`/admin/api/studio/asset`, whose own containment guard applies). The
 * node's `src` prop is never rewritten: the inspector, the diff writeback and
 * the agent all still see `/hero.png`, which is what the source says.
 *
 * A tiny external store, like `studioRawCssStores.ts`: one value per load,
 * never in `SiteDocument`.
 */
import { studioWriteDir } from './studioWorkspaceDir'

let publicRoot: string | null = null
const listeners = new Set<() => void>()

/** Called by every load path with the `/load` response's `publicRoot` (`null` outside Studio). */
export function setStudioPublicRoot(next: string | null): void {
  if (next === publicRoot) return
  publicRoot = next
  for (const listener of listeners) listener()
}

export function getStudioPublicRoot(): string | null {
  return publicRoot
}

export function subscribeStudioPublicRoot(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The URL a design canvas displays for `src`: the asset route for a site-root
 * path when a Studio project is loaded, `src` itself otherwise (an absolute
 * URL, a protocol-relative one, an admin route, a data URL, a CMS page).
 */
export function studioCanvasImageUrl(src: string, root: string | null = publicRoot): string {
  if (root === null) return src
  if (!src.startsWith('/') || src.startsWith('//') || src.startsWith('/admin/')) return src
  const dir = studioWriteDir()
  if (!dir) return src
  let path: string
  try {
    path = decodeURIComponent(src.slice(1).split(/[?#]/)[0] ?? '')
  } catch {
    return src
  }
  if (path.length === 0) return src
  const rel = root.length > 0 ? `${root}/${path}` : path
  return `/admin/api/studio/asset?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(rel)}`
}
