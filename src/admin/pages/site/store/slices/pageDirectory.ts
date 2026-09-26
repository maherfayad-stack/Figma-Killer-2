/**
 * The page LIST, as always-mounted chrome needs it — never the pages array
 * itself (P2-I, PERF-12).
 *
 * Mutative replaces `site.pages` whenever any node on any page changes, so a
 * component subscribed to the array re-renders on every keystroke. The
 * Explorer's page list, the document switcher, the template preview picker
 * and the live-path hook only ever read a page's identity and name. These
 * selectors hand them exactly that, with a stable identity for as long as
 * those facts are unchanged:
 *
 * - The work runs once per `pages` array change (single-slot memo on the
 *   array's identity), not once per subscriber per `set()`.
 * - The result is the PREVIOUS array whenever it is entry-for-entry equal, so
 *   a keystroke re-renders none of its readers.
 *
 * Gated by `no-full-site-scan-in-selectors.test.ts` (the whole-pages and
 * pages-derivation detectors).
 */
import type { Page } from '@core/page-tree'
import { isTemplatePage } from '@core/templates'
import type { EditorStore } from '@site/store/types'

export interface PageDirectoryEntry {
  readonly id: string
  readonly title: string
  readonly slug: string
  /** The page's source location lives in its root id (`relFile:line:col`) — see `pageRelPath`. */
  readonly rootNodeId: string
  readonly isTemplate: boolean
}

const EMPTY_DIRECTORY: readonly PageDirectoryEntry[] = []
const EMPTY_PAGES: readonly Page[] = []

function sameEntry(a: PageDirectoryEntry, b: PageDirectoryEntry): boolean {
  return a.id === b.id && a.title === b.title && a.slug === b.slug && a.rootNodeId === b.rootNodeId && a.isTemplate === b.isTemplate
}

let directorySource: readonly Page[] | null = null
let directory: readonly PageDirectoryEntry[] = EMPTY_DIRECTORY

/** Every page's id, title, slug, root id and template flag, in `site.pages` order. */
export function selectPageDirectory(state: Pick<EditorStore, 'site'>): readonly PageDirectoryEntry[] {
  const pages = state.site?.pages ?? null
  if (pages === directorySource) return directory
  directorySource = pages
  if (!pages || pages.length === 0) {
    directory = EMPTY_DIRECTORY
    return directory
  }
  const next = pages.map((page) => ({
    id: page.id,
    title: page.title,
    slug: page.slug,
    rootNodeId: page.rootNodeId,
    isTemplate: isTemplatePage(page),
  }))
  if (next.length !== directory.length || next.some((entry, i) => !sameEntry(entry, directory[i]!))) directory = next
  return directory
}

let templateSource: readonly Page[] | null = null
let templatePages: readonly Page[] = EMPTY_PAGES

/**
 * The template pages themselves (a wrapper renders their node trees), with
 * the same two properties: one filter per `pages` change, and the previous
 * array back whenever every template page object is unchanged — so an edit to
 * an ordinary page re-renders no frame's composed tree.
 */
export function selectTemplatePages(state: Pick<EditorStore, 'site'>): readonly Page[] {
  const pages = state.site?.pages ?? null
  if (pages === templateSource) return templatePages
  templateSource = pages
  const next = pages ? pages.filter(isTemplatePage) : EMPTY_PAGES
  if (next.length !== templatePages.length || next.some((page, i) => page !== templatePages[i])) {
    templatePages = next.length === 0 ? EMPTY_PAGES : next
  }
  return templatePages
}
