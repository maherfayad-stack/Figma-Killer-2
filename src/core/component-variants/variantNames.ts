/**
 * variantNames — what may be typed as a variant value or a component prop name,
 * and the ids the variants gallery gives its scaffolding. Pure strings, so the
 * editor's name popover, the server's wire schemas and the codemods all ask the
 * SAME rule instead of keeping three mirrors in step.
 */

/**
 * A variant value becomes a CSS class, an object key and a string literal in
 * the user's source: letters, digits, `_` and `-`, starting with a letter.
 */
export const VARIANT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/

/** A prop name is a plain identifier (a destructuring binds it); reserved words are the codemod's to refuse. */
export const PROP_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/

/** The sentence under a name field that cannot be submitted yet, or `null` when it can. */
export function variantNameError(name: string, existing: readonly string[]): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return null
  if (!VARIANT_NAME_PATTERN.test(trimmed)) return 'Start with a letter, then letters, digits, "-" or "_".'
  if (existing.includes(trimmed)) return `"${trimmed}" already exists.`
  return null
}

/** Same, for a new property's name. */
export function propNameError(name: string, existing: readonly string[]): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return null
  if (!PROP_NAME_PATTERN.test(trimmed)) return 'Use a plain name: letters, digits, "_" or "$", not starting with a digit.'
  if (existing.includes(trimmed)) return `"${trimmed}" already exists.`
  return null
}

/** Every id the gallery mints for its own scaffolding starts with this, then the gallery's page id. */
export const GALLERY_NODE_ID_PREFIX = 'component-gallery:'

/** The prefix of one gallery's scaffold ids (`component-gallery:<pageId>:grid`, `…:header`, `…:cell:3`). */
export function galleryNodeIdPrefix(pageId: string): string {
  return `${GALLERY_NODE_ID_PREFIX}${pageId}`
}

/** Whether a node id is a variants gallery's grid — the first child of its page's body, and the one fact that tells a gallery frame from any other. */
export function isGalleryGridNodeId(nodeId: string): boolean {
  return nodeId.startsWith(GALLERY_NODE_ID_PREFIX) && nodeId.endsWith(':grid')
}

/** The part of a page `isGalleryPage` reads; `Page` satisfies it. */
interface PageShape {
  rootNodeId: string
  nodes: Readonly<Record<string, { children?: readonly string[] } | undefined>>
}

/**
 * Whether a page is a component's variants gallery: its body's first child is
 * the gallery grid. A gallery is DERIVED on every load and placed on its own
 * Components board by the server, so nothing that lays out "every page" (the
 * default board's seed) may treat it as one of the project's pages.
 */
export function isGalleryPage(page: PageShape): boolean {
  const grid = page.nodes[page.rootNodeId]?.children?.[0]
  return grid !== undefined && isGalleryGridNodeId(grid)
}
