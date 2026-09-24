/**
 * assetSiteUrl — THE rule that turns a file in a Studio project into the URL
 * the project's own site serves it at. Server-side, one copy.
 *
 * Before IMG-1 this rule had three copies that disagreed: the drop route's
 * `droppedAssetSrc` (anything after the LAST `public/` in the path), the
 * client's `cssUrlForAssetPath` (a leading `public/` or `static/`, joined to
 * the PROJECT dir, blind to a monorepo's app root), and a bare `'/' + relPath`
 * in the inspector's image replace — which is how `src="/src/assets/x.png"`
 * got written: a URL that works in `vite dev` and 404s in production.
 *
 * Now every landing response (`asset-drop`, `asset-upload`) and every listed
 * project image (`project-assets`) carries the URL this module computed, and
 * the browser writes that string verbatim. The client derives nothing.
 *
 * ## The rule
 *
 * Relative to the project's APP ROOT (`resolveAppRoot` — the directory holding
 * the real `package.json`, which in a monorepo is not the project dir):
 *
 *   - a file under `<appRoot>/public/` is served verbatim from the site root
 *     by every framework Studio recognises (Vite, CRA, both Next routers,
 *     Remix, Astro), in dev and in a production build: `public/img/a.png` is
 *     `/img/a.png`, `buildSafe: true`;
 *   - any other file under the app root is reachable by URL only through a
 *     dev server that serves its source tree (Vite does); a production build
 *     only emits a file some `import` referenced, so the URL is real but
 *     `buildSafe: false`, and the UI must say "dev only" next to it;
 *   - a file outside the app root is served by nothing: `null`.
 *
 * Every segment of the URL is percent-encoded (`siteRootUrl`): the name comes
 * from the user's repo, and the URL is pasted into their source verbatim.
 *
 * `static/` (Gatsby, and a Next convention that served at `/static/…`, not at
 * the root) is deliberately not a public root: no framework Studio detects
 * serves it from `/`, so it falls into the dev-only case like any other path.
 */
import { relative, resolve, sep } from 'node:path'
import { resolveAppRoot } from './appRoot'

/** The one directory whose files every recognised framework serves from the site root. `asset-drop` lands here. */
export const PUBLIC_DIR = 'public'

export interface AssetSiteUrl {
  /** The site-root-relative URL, e.g. `/hero.png`. What an `<img src>` or a CSS `url()` is written with. */
  src: string
  /** True when a production build serves `src` too, not only the dev server. */
  buildSafe: boolean
}

/**
 * A resolver for one project: reads the app root once, then maps any number
 * of PROJECT-relative POSIX paths (the vocabulary every `relPath` on the wire
 * speaks) to their URL, or `null` when nothing serves the file.
 *
 * `relPath` is always a path this server produced (a landing result or a
 * directory walk), never client input.
 */
export function assetSiteUrlResolver(dir: string): (relPath: string) => AssetSiteUrl | null {
  const appRootRel = relative(resolve(dir), resolveAppRoot(dir)).split(sep).join('/')
  const appPrefix = appRootRel === '' ? '' : `${appRootRel}/`
  const publicPrefix = `${projectPublicRootFrom(appRootRel)}/`

  return (relPath) => {
    if (relPath.startsWith(publicPrefix) && relPath.length > publicPrefix.length) {
      const src = siteRootUrl(relPath.slice(publicPrefix.length))
      return src === null ? null : { src, buildSafe: true }
    }
    if (relPath.startsWith(appPrefix) && relPath.length > appPrefix.length) {
      const src = siteRootUrl(relPath.slice(appPrefix.length))
      return src === null ? null : { src, buildSafe: false }
    }
    return null
  }
}

/**
 * The project-relative POSIX path of the directory served at the site root —
 * `public`, or `apps/web/public` in a monorepo. The `/load` response carries
 * it so a design canvas can DISPLAY a site-root `<img src="/hero.png">` through
 * the authenticated asset route (`studioPublicAssets.ts`); nothing writes it.
 */
export function projectPublicRoot(dir: string): string {
  return projectPublicRootFrom(relative(resolve(dir), resolveAppRoot(dir)).split(sep).join('/'))
}

function projectPublicRootFrom(appRootRel: string): string {
  return appRootRel === '' ? PUBLIC_DIR : `${appRootRel}/${PUBLIC_DIR}`
}

/**
 * `/` + each segment percent-encoded, or `null` when the path has an empty
 * segment (a leading, trailing or doubled `/`).
 *
 * The URL is written VERBATIM into the user's source: into an `<img src="…">`
 * JSX string and into a CSS `url('…')` (`wrapUrlPayload`). A file name from an
 * imported repo is untrusted, so any byte that means something in either
 * syntax must not survive. A name like `a'), url(evil.png), url('.png` would
 * otherwise close the CSS string and inject declarations, and on Linux/macOS
 * a file name may also hold `;`, `{`, `}`, `:` and `\`. `encodeURIComponent`
 * leaves `!'()*` alone, so those are encoded here as well. The result can only
 * contain `[A-Za-z0-9._~%-]` and `/` separators, and it always starts with a
 * single `/` followed by a non-empty segment, so it can never be `//host` or
 * `/\host` (which the WHATWG URL parser reads as protocol-relative).
 */
function siteRootUrl(pathUnderRoot: string): string | null {
  const segments = pathUnderRoot.split('/')
  if (segments.some((segment) => segment.length === 0)) return null
  const encoded = segments.map((segment) =>
    encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
  )
  return `/${encoded.join('/')}`
}
