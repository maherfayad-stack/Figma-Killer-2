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
  const publicPrefix = `${appPrefix}${PUBLIC_DIR}/`

  return (relPath) => {
    if (relPath.startsWith(publicPrefix) && relPath.length > publicPrefix.length) {
      return { src: `/${relPath.slice(publicPrefix.length)}`, buildSafe: true }
    }
    if (relPath.startsWith(appPrefix) && relPath.length > appPrefix.length) {
      return { src: `/${relPath.slice(appPrefix.length)}`, buildSafe: false }
    }
    return null
  }
}
