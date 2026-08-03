/**
 * Resolving a screen the way the agent NAMES it, not the way Studio ids it.
 *
 * The agent that just wrote `pages/Checkout.tsx` knows it wrote `Checkout`.
 * Making it call `studio_list_pages` first to translate that into a page id is
 * a round trip bought with nothing, so every agent-facing tool that takes a
 * screen accepts the name — `"Checkout"`, `"Checkout.tsx"`,
 * `"pages/Checkout.tsx"` and the raw id all resolve to the same frame.
 *
 * Shared by `screenshot.ts` and `compare.ts` so the two cannot drift on what
 * `"AddMobile"` means.
 */

/**
 * Reduce a caller-supplied name to the form a page id already has.
 *
 * A page id is the KEBAB-cased file stem (`pageIdFromRelPath`: `AddMobile.tsx`
 * -> `add-mobile`), so a naive lowercase would match `Checkout` and silently
 * fail on every multi-word screen — precisely the names an agent is most
 * likely to have just written. Applying the same derivation to both sides
 * makes `"AddMobile"`, `"AddMobile.tsx"`, `"pages/AddMobile.tsx"` and the raw
 * id `add-mobile` all reduce to `add-mobile`.
 */
export function pageKey(value: string): string {
  const stem = (value.split(/[\\/]/).pop() ?? value).replace(/\.[a-z]+$/i, '')
  return stem
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export interface PageRef {
  readonly id: string
  readonly title: string
}

/**
 * Resolve ONE name to a page. An exact page-id match short-circuits ahead of
 * the fuzzy key match: an id read out of a previous tool result should never
 * be re-interpreted as a name.
 */
export function resolvePageByName<T extends PageRef>(pages: readonly T[], name: string): T | null {
  const exact = pages.find((p) => p.id === name)
  if (exact) return exact
  const key = pageKey(name)
  return pages.find((p) => pageKey(p.id) === key || pageKey(p.title) === key) ?? null
}

/** Resolve a batch of names, reporting which ones matched nothing rather than dropping them silently. */
export function resolveRequestedPages(
  pages: readonly PageRef[],
  requested: readonly string[] | undefined,
  cap: number,
): { ids: string[]; unmatched: string[] } {
  if (!requested || requested.length === 0) return { ids: pages.slice(0, cap).map((p) => p.id), unmatched: [] }
  const ids: string[] = []
  const unmatched: string[] = []
  for (const name of requested) {
    const match = resolvePageByName(pages, name)
    if (match) {
      if (!ids.includes(match.id)) ids.push(match.id)
    } else {
      unmatched.push(name)
    }
  }
  return { ids, unmatched }
}
