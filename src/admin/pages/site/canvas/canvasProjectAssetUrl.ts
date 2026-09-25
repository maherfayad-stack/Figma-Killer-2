/**
 * canvasProjectAssetUrl — THE place a portal frame resolves a site-root asset
 * URL (`src="/hero.png"`, `url('/bg.png')`) to something it can load (P5-B2).
 *
 * ## Why this exists
 *
 * A portal frame (every design frame, the srcdoc "live" preview, the agent
 * capture page) is an `about:srcdoc` document on the ADMIN origin. A page's
 * own `<img src="/hero.png">` resolves against that origin, which serves
 * nothing at `/hero.png` — so every literal public image, including every
 * image a drop writes (P5-B: it lands in `public/` and writes the site-root
 * URL, `assetSiteUrl.ts`), showed broken. A bridge (Tier-2 live) frame is
 * served by the project's own dev server and was always fine; it never renders
 * through here.
 *
 * The fix is a URL, not a copy: the asset route answers
 * `?url=/hero.png` with the project file the project's own dev server would
 * answer (`siteUrlWorkspaceCandidates`, the inverse of THE site-URL rule), so
 * the canvas never derives a path from a URL — it only forwards the URL.
 *
 * ## Where it applies — render time only, never the store
 *
 * The store keeps the value the source says. Rewriting at load would put an
 * admin URL in the inspector, and the image drop's replace reads `props.src`
 * to tell a literal from an import-bound image (`studioAssetRelFromPreviewUrl`).
 * So the value is resolved at the three sinks that hand a URL to the frame's
 * document, and nowhere else:
 *
 *   - node props (`src`, `srcSet`, `poster`) and the node's inline style
 *     (`NodeRenderer`), for every module at once — not per component;
 *   - stylesheet text (`canvasFrameCss.ts`), which every CSS injector that
 *     carries project CSS runs its text through.
 *
 * Never reaches the publisher: nothing under `src/core/publisher` imports it,
 * and the published HTML keeps `/hero.png`, which is right on the real site.
 *
 * ## What is rewritten
 *
 * Only a SITE-ROOT URL: one leading `/` followed by something other than `/`
 * or `\` (those are protocol-relative to another host). Absolute URLs,
 * `data:`/`blob:` (a drop's optimistic ghost), relative paths, a URL that
 * already points at the scope's own asset route (an import the parse resolved,
 * `rewriteStudioAssetSentinels`), and the admin's own CMS media library
 * (`/uploads/…`, see `ADMIN_MEDIA_PREFIX`) are returned untouched.
 */
import { AGENT_CAPTURE_ASSET_PATH } from '@core/studio-capture'
import { STUDIO_ASSET_ROUTE } from '@site/studio/projectAssets'
import { studioWriteDir } from '@site/studio/studioWorkspaceDir'

/**
 * Which asset route a frame asks, and the query that scopes it to one project:
 * the editor's session-gated route with `dir=`, or the capture page's
 * token-gated twin with `token=` (a headless browser has no session).
 */
export interface ProjectAssetUrlScope {
  route: string
  /** `name=value` pairs already percent-encoded, without a trailing `&`; `''` for none. */
  query: string
}

let captureScope: ProjectAssetUrlScope | null = null

/**
 * The capture page's entry calls this once with its token. The editor never
 * does: its scope is the open project, read fresh per call because the
 * workspace dir is a module-level value, not React state.
 */
export function setCaptureProjectAssetScope(token: string): void {
  captureScope = { route: AGENT_CAPTURE_ASSET_PATH, query: `token=${encodeURIComponent(token)}` }
}

/** The scope every portal frame in this document resolves against. */
export function canvasProjectAssetScope(): ProjectAssetUrlScope {
  if (captureScope) return captureScope
  const dir = studioWriteDir()
  return { route: STUDIO_ASSET_ROUTE, query: dir ? `dir=${encodeURIComponent(dir)}` : '' }
}

const SITE_ROOT_URL = /^\/(?![/\\])/

/**
 * The one site-root namespace the ADMIN origin really serves to page content:
 * the CMS media library (`server/router.ts`'s `/uploads/*`). The responsive
 * background path (`useResponsiveBackgroundStyle`, `generateCanvasClassCSS`'s
 * `mediaAssets`) swaps a CMS media path for its `/uploads/…-w1024.webp`
 * variants before any text reaches here, so those URLs are already
 * loadable where they are. The cost: a project's own `public/uploads/x.png`
 * still resolves against the admin origin in a portal frame.
 */
const ADMIN_MEDIA_PREFIX = '/uploads/'

/** One URL value → the asset route when it is site-root, otherwise itself. */
export function projectAssetUrl(value: string, scope: ProjectAssetUrlScope): string {
  const url = value.trim()
  if (!SITE_ROOT_URL.test(url) || url.startsWith(ADMIN_MEDIA_PREFIX) || url.startsWith(`${scope.route}?`)) return value
  const query = scope.query ? `${scope.query}&` : ''
  return `${scope.route}?${query}url=${encodeURIComponent(url)}`
}

/**
 * A `srcset` list: each candidate's URL resolved, its descriptor (`2x`,
 * `640w`) and spacing kept. The resolved URL is percent-encoded, so it holds no
 * comma that could split a candidate.
 */
export function projectAssetSrcset(srcset: string, scope: ProjectAssetUrlScope): string {
  return srcset
    .split(',')
    .map((candidate) => {
      const match = /^(\s*)(\S+)([\s\S]*)$/.exec(candidate)
      return match ? `${match[1]}${projectAssetUrl(match[2]!, scope)}${match[3]}` : candidate
    })
    .join(',')
}

/** `url(…)` in any of its three spellings: double-quoted, single-quoted, bare. */
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi

/**
 * Every site-root `url()` in a stylesheet or a declaration value. A rewritten
 * one is emitted double-quoted; its payload is the route, a server-owned
 * query and an `encodeURIComponent` value, so it holds no `"`, `\` or
 * newline that could end the string. Anything left alone keeps its exact
 * original text.
 */
export function projectAssetCssUrls(css: string, scope: ProjectAssetUrlScope): string {
  if (!/url\(/i.test(css)) return css
  return css.replace(CSS_URL, (whole, doubleQuoted?: string, singleQuoted?: string, bare?: string) => {
    const raw = doubleQuoted ?? singleQuoted ?? bare ?? ''
    const resolved = projectAssetUrl(raw, scope)
    return resolved === raw ? whole : `url("${resolved}")`
  })
}

/** The node props that name a resource the element loads. */
const URL_PROPS = ['src', 'poster'] as const
const SRCSET_PROPS = ['srcSet', 'srcset'] as const

/**
 * A node's resolved props with their resource URLs resolved. Returns `props`
 * itself when nothing changed — this runs on every node render, and a fresh
 * object per render would defeat the module's own memoisation.
 */
export function projectAssetProps<T extends object>(props: T, scope: ProjectAssetUrlScope): T {
  const bag = props as Record<string, unknown>
  let next: Record<string, unknown> | null = null
  const set = (key: string, value: string) => {
    if (value === bag[key]) return
    next ??= { ...bag }
    next[key] = value
  }
  for (const key of URL_PROPS) {
    const value = bag[key]
    if (typeof value === 'string') set(key, projectAssetUrl(value, scope))
  }
  for (const key of SRCSET_PROPS) {
    const value = bag[key]
    if (typeof value === 'string') set(key, projectAssetSrcset(value, scope))
  }
  return (next ?? props) as T
}

/** A React inline-style object with every `url()` in its string values resolved; the same object when none changed. */
export function projectAssetStyle<T extends Record<string, string | number>>(
  style: T | undefined,
  scope: ProjectAssetUrlScope,
): T | undefined {
  if (!style) return style
  let next: Record<string, string | number> | null = null
  for (const [key, value] of Object.entries(style)) {
    if (typeof value !== 'string') continue
    const resolved = projectAssetCssUrls(value, scope)
    if (resolved === value) continue
    next ??= { ...style }
    next[key] = resolved
  }
  return (next ?? style) as T | undefined
}
