/**
 * prototypeRouteIndex — turning "the string the code navigates to" into "which
 * page on the board that is".
 *
 * The code says `navigate('/details')`, `<Link to="details">`, or (React
 * Navigation) `navigation.navigate('Details')`. The board knows pages by the id
 * `studioPageIds.ts` derives from where the file lives. Nothing in the user's
 * project connects those two, so this module states every spelling a page can
 * legitimately answer to and refuses the rest.
 *
 * WHY AN AMBIGUOUS KEY IS DROPPED, NOT RESOLVED
 * ─────────────────────────────────────────────
 * Studio's own invariant is that a write needs exactly one honest target. A
 * connector is not a write, but it is a CLAIM about the user's code, drawn as a
 * fact they cannot edit — so it earns the same bar. When two pages both answer
 * to `details` (`pages/Details.tsx` and `pages/account/details.tsx`), picking
 * one would draw an arrow at a screen the code may never reach. The key is
 * withdrawn instead, both pages keep their other, unambiguous spellings, and
 * that one edge simply is not drawn.
 *
 * WHY THE KEYS ARE SPELLED OUT RATHER THAN MATCHED FUZZILY
 * ────────────────────────────────────────────────────────
 * A near-match heuristic ("does the route contain the page name") produces
 * arrows nobody wrote, which is the one failure mode this feature cannot
 * afford — the whole promise is that the flow map is TRUE. An exact lookup over
 * a stated key set fails toward drawing nothing, which costs a missing arrow
 * the user can still see in their code.
 */

/** A page as this module needs to see it: its id, and the file it came from. */
export interface RoutePage {
  pageId: string
  /** POSIX path relative to the project's pages/app dir — `Details.tsx`, `account/details.tsx`. */
  relPath: string
}

/** Schemes that are never a route into this project. */
const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

/**
 * Strip a target down to the form the key set is built in: no query, no hash,
 * no leading `./`, no leading or trailing `/`, lower case.
 *
 * `'/'` (the site root) normalizes to `''`, which is a real key — see
 * `routeKeysForPage`, where an index file claims it.
 */
export function normalizeNavTarget(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  // `#`, `#section`, `mailto:`, `https://`, `//cdn…` — all leave the project.
  if (trimmed.startsWith('#') || EXTERNAL_TARGET.test(trimmed)) return null

  const withoutFragment = trimmed.split(/[?#]/)[0] ?? ''
  const withoutDotSlash = withoutFragment.replace(/^\.\//, '')
  const trimmedSlashes = withoutDotSlash.replace(/^\/+/, '').replace(/\/+$/, '')
  return trimmedSlashes.toLowerCase()
}

/** `Details.tsx` -> `details`; `account/Details.tsx` -> `account/details`. */
function relPathKey(relPath: string): string {
  return relPath.replace(/\.(tsx|jsx|ts|js)$/i, '').toLowerCase()
}

/** The basename with no extension — `account/Details.tsx` -> `details`. */
function basenameKey(relPath: string): string {
  return relPathKey(relPath).split('/').pop() ?? ''
}

/** Names a framework treats as the directory's own route rather than a child of it. */
const INDEX_BASENAMES: ReadonlySet<string> = new Set(['index', 'home', 'page'])

/**
 * Every spelling `page` legitimately answers to.
 *
 * The four sources, and why each is a real spelling rather than a guess:
 *
 *   - The page id itself. App Router ids ARE the route (`/pricing`), so this is
 *     the only key that matters there; for every other framework it is the
 *     kebab-cased path, which is what Studio's own URLs use.
 *   - The file path without its extension (`account/details`). This is what a
 *     file-routed framework serves, and what a relative `<Link to>` spells.
 *   - The basename (`details`). This is what React Navigation registers a
 *     screen as, and what a flat `pages/` project's routes look like.
 *   - `''` — the site root — but ONLY for an index-shaped file at the top
 *     level. A nested `account/index.tsx` serves `/account`, not `/`, and the
 *     path key above already covers it.
 */
export function routeKeysForPage(page: RoutePage): string[] {
  const keys = [
    normalizeNavTarget(page.pageId),
    relPathKey(page.relPath),
    basenameKey(page.relPath),
  ]
  const base = basenameKey(page.relPath)
  const nested = relPathKey(page.relPath).includes('/')
  if (!nested && INDEX_BASENAMES.has(base)) keys.push('')
  return keys.filter((key): key is string => key !== null)
}

/**
 * `target string -> pageId`, with every ambiguous key withdrawn.
 *
 * `null` for a key two pages both claim: the map is a lookup table for a claim
 * about the user's code, and "one of these two" is not a claim worth drawing.
 */
export function buildRouteIndex(pages: readonly RoutePage[]): Map<string, string | null> {
  const index = new Map<string, string | null>()
  for (const page of pages) {
    for (const key of routeKeysForPage(page)) {
      const existing = index.get(key)
      if (existing === undefined) {
        index.set(key, page.pageId)
        continue
      }
      // A page re-claiming its own key (the id and the basename can coincide)
      // is not a collision.
      if (existing !== page.pageId) index.set(key, null)
    }
  }
  return index
}

/** The page a navigation target lands on, or `null` when it leaves the project or is ambiguous. */
export function resolveNavTarget(index: ReadonlyMap<string, string | null>, raw: string): string | null {
  const key = normalizeNavTarget(raw)
  if (key === null) return null
  return index.get(key) ?? null
}
