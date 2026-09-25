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
 * ## What is rewritten, judged on the URL the browser will REQUEST
 *
 * The decision is made on the value resolved and normalized the way the frame
 * would resolve it (`new URL(value, scope.base)`: `..` and `%2e%2e` segments
 * collapsed, a relative path joined to the admin page's own URL), never on the
 * raw text. A raw prefix test is a bypass: `/uploads/../admin/api/x` starts
 * with `/uploads/` and is a cookie-carrying GET to `/admin/api/x` (security
 * review of #262, nit 1). In CSS the value is also un-escaped first
 * (`url(\2f admin/x)` is `/admin/x`).
 *
 * Every SAME-ORIGIN http(s) URL is rewritten to the asset route (root-absolute,
 * relative, protocol-relative to this host, or absolute to this host), with
 * exactly two exceptions, so nothing else on the admin origin is ever
 * requested from page content:
 *
 *   - its pathname IS the scope's own asset route (an import the parse
 *     resolved, `rewriteStudioAssetSentinels`): a GET that route answers with
 *     a media file or a 404;
 *   - its NORMALIZED pathname is under `/uploads/` (the admin's CMS media
 *     library, see `ADMIN_MEDIA_PREFIX`).
 *
 * So a URL that normalizes into `/admin/` or `/_studio/` never passes through;
 * it becomes an asset-route lookup (`public/admin/…`), which is also what a
 * project's own `public/admin/logo.png` needs. A relative URL is forwarded as
 * written and 404s: the server resolves site-root URLs only, and a relative
 * one resolved against the admin page means nothing in the project.
 * Left alone: another origin, and every non-http(s) scheme: `data:`, `blob:`
 * (a drop's optimistic ghost, whose origin IS this one), `about:`.
 */
import { AGENT_CAPTURE_ASSET_PATH } from '@core/studio-capture'
import { STUDIO_ASSET_ROUTE } from '@site/studio/projectAssets'
import { studioWriteDir } from '@site/studio/studioWorkspaceDir'

/**
 * Which asset route a frame asks, the query that scopes it to one project
 * (the editor's session-gated route with `dir=`, or the capture page's
 * token-gated twin with `token=`, since a headless browser has no session),
 * and the URL a portal frame resolves relative URLs against.
 */
export interface ProjectAssetUrlScope {
  route: string
  /** `name=value` pairs already percent-encoded, without a trailing `&`; `''` for none. */
  query: string
  /** The frame's base URL. An `about:srcdoc` frame inherits its parent's, i.e. this document's. */
  base: string
}

let captureToken: string | null = null

/**
 * The capture page's entry calls this once with its token. The editor never
 * does: its scope is the open project, read fresh per call because the
 * workspace dir is a module-level value, not React state.
 */
export function setCaptureProjectAssetScope(token: string): void {
  captureToken = token
}

/** Outside a browser (tests) there is no document URL; this stands in for the admin page. */
const FALLBACK_BASE = 'http://localhost/admin/site'

function documentBase(): string {
  const location = typeof window === 'undefined' ? null : window.location
  return location && location.origin !== 'null' ? location.href : FALLBACK_BASE
}

/** The scope every portal frame in this document resolves against. */
export function canvasProjectAssetScope(): ProjectAssetUrlScope {
  const base = documentBase()
  if (captureToken !== null) {
    return { route: AGENT_CAPTURE_ASSET_PATH, query: `token=${encodeURIComponent(captureToken)}`, base }
  }
  const dir = studioWriteDir()
  return { route: STUDIO_ASSET_ROUTE, query: dir ? `dir=${encodeURIComponent(dir)}` : '', base }
}

/**
 * The one site-root namespace the ADMIN origin really serves to page content:
 * the CMS media library (`server/router.ts`'s `/uploads/*`). The responsive
 * background path (`useResponsiveBackgroundStyle`, `generateCanvasClassCSS`'s
 * `mediaAssets`) swaps a CMS media path for its `/uploads/…-w1024.webp`
 * variants before any text reaches here, so those URLs are already loadable
 * where they are. Tested on the NORMALIZED pathname only. The cost: a
 * project's own `public/uploads/x.png` still resolves against the admin
 * origin in a portal frame.
 */
const ADMIN_MEDIA_PREFIX = '/uploads/'

/** A value with a scheme (`https:`, `data:`) or a leading `/`; anything else is relative to the page. */
const NOT_RELATIVE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/)/

/** One URL value → the asset route when the frame would request it from the admin origin, otherwise itself. */
export function projectAssetUrl(value: string, scope: ProjectAssetUrlScope): string {
  const url = value.trim()
  if (url === '' || url.startsWith('#')) return value
  let base: URL
  let resolved: URL
  try {
    base = new URL(scope.base)
    resolved = new URL(url, base)
  } catch {
    return value // not a URL the frame could request at all
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return value
  if (resolved.origin !== base.origin) return value
  if (resolved.pathname === scope.route || resolved.pathname.startsWith(ADMIN_MEDIA_PREFIX)) return value

  // Forward what the browser would have requested: the normalized path and
  // query. A relative value is forwarded as written; the server answers it
  // with nothing, which is the truth about it.
  const forwarded = NOT_RELATIVE.test(url) ? `${resolved.pathname}${resolved.search}` : url
  const query = scope.query ? `${scope.query}&` : ''
  return `${scope.route}?${query}url=${encodeURIComponent(forwarded)}`
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

/**
 * `url(…)` in any of its three spellings: double-quoted, single-quoted, bare.
 * Each body admits CSS escapes (`\2f `, `\/`), and a hex escape's trailing
 * whitespace is part of the escape. A bare body that stopped at the first
 * space would skip `url(\2f admin/x)` entirely and leave it to the browser.
 */
const CSS_URL =
  /url\(\s*(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|((?:\\[0-9a-fA-F]{1,6}[ \t\n\r\f]?|\\[^\n\r\f]|[^)"'\s\\])*))\s*\)/gi

const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd)

/** CSS Syntax §4.3.7: a hex escape (plus one whitespace), an escaped newline (dropped), or an escaped character. */
function cssUnescape(text: string): string {
  return text.replace(
    /\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|(\r\n|[\n\r\f])|([\s\S]))/g,
    (_whole, hex?: string, newline?: string, char?: string) => {
      if (hex !== undefined) {
        const codePoint = parseInt(hex, 16)
        const invalid = codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
        return invalid ? REPLACEMENT_CHARACTER : String.fromCodePoint(codePoint)
      }
      if (newline !== undefined) return ''
      return char ?? ''
    },
  )
}

/**
 * Every `url()` in a stylesheet or a declaration value the frame would
 * request from the admin origin, CSS escapes decoded first. A rewritten
 * one is emitted double-quoted; its payload is the route, a server-owned
 * query and an `encodeURIComponent` value, so it holds no `"`, `\` or
 * newline that could end the string. Anything left alone keeps its exact
 * original text.
 */
export function projectAssetCssUrls(css: string, scope: ProjectAssetUrlScope): string {
  if (!/url\(/i.test(css)) return css
  return css.replace(CSS_URL, (whole, doubleQuoted?: string, singleQuoted?: string, bare?: string) => {
    const raw = cssUnescape(doubleQuoted ?? singleQuoted ?? bare ?? '')
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
