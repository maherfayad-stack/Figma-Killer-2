/**
 * posterKey — what a board frame's picture is a picture OF (SB-2).
 *
 * The old poster cache keyed a `WeakMap` on the `Page` object, so it could
 * never outlive the session and could not be shared with a store on disk.
 * A poster is now keyed by CONTENT: the frame id, a hash of everything the
 * frame renders from, and the preview axes it was rendered under. Two
 * different `Page` objects with equal content (a file-watcher reload that
 * found nothing new) therefore resolve to the same picture, and an edit
 * changes the key without anyone having to remember to invalidate.
 *
 * "Everything the frame renders from" is the page's node tree plus the
 * site-level inputs `ClassStyleInjector` writes into the frame: style rules,
 * breakpoints, conditions, framework tokens and fonts. Each input object is
 * hashed once per reference (the store is structurally shared, so an
 * unchanged object is the same reference) and the combination is remembered
 * for the last set of references, so a hundred frames asking in one render
 * share one computation.
 *
 * Deliberately pure and DOM-free so it is unit-testable.
 */
import type { Page } from '@core/page-tree'
import type { PreviewAxes } from '@core/studio-board'

/** cyrb53 — a fast, well-distributed 53-bit string hash. A cache key, not a security boundary. */
export function hashString(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

const objectHashes = new WeakMap<object, string>()

/** Hash of one object's JSON, computed once per reference. `null`/`undefined` hash to a constant. */
function hashObject(value: object | null | undefined): string {
  if (value === null || value === undefined) return '0'
  const cached = objectHashes.get(value)
  if (cached !== undefined) return cached
  const hash = hashString(JSON.stringify(value))
  objectHashes.set(value, hash)
  return hash
}

const pageHashes = new WeakMap<Page, string>()

/** Hash of the part of a page a frame draws: its tree. Title, slug and ownership do not paint. */
export function pagePosterHash(page: Page): string {
  const cached = pageHashes.get(page)
  if (cached !== undefined) return cached
  const hash = hashString(`${page.rootNodeId}\n${JSON.stringify(page.nodes)}`)
  pageHashes.set(page, hash)
  return hash
}

/** The site-level objects the in-frame style injectors read. */
export interface SiteStyleInputs {
  styleRules: object | null | undefined
  breakpoints: object | null | undefined
  conditions: object | null | undefined
  framework: object | null | undefined
  fonts: object | null | undefined
}

let lastInputs: SiteStyleInputs | null = null
let lastSignature = ''

function sameInputs(a: SiteStyleInputs, b: SiteStyleInputs): boolean {
  return (
    a.styleRules === b.styleRules &&
    a.breakpoints === b.breakpoints &&
    a.conditions === b.conditions &&
    a.framework === b.framework &&
    a.fonts === b.fonts
  )
}

/** One short string that changes exactly when any style input of the site changes. */
export function siteStyleSignature(inputs: SiteStyleInputs): string {
  if (lastInputs && sameInputs(lastInputs, inputs)) return lastSignature
  lastSignature = [inputs.styleRules, inputs.breakpoints, inputs.conditions, inputs.framework, inputs.fonts]
    .map(hashObject)
    .join('.')
  lastInputs = { ...inputs }
  return lastSignature
}

/** Stable text for a frame's effective preview axes. */
export function axesKey(axes: Partial<PreviewAxes> | undefined): string {
  if (!axes) return ''
  return `${axes.direction ?? ''}|${axes.colorScheme ?? ''}|${axes.locale ?? ''}`
}

export interface PosterKeyParts {
  frameId: string
  page: Page
  /** {@link siteStyleSignature} of the site the frame renders under. */
  styleSignature: string
  axes: Partial<PreviewAxes> | undefined
  width: number
}

/** The full cache key. The frame id leads so the persistence layer can drop a frame's older pictures by prefix. */
export function posterKey({ frameId, page, styleSignature, axes, width }: PosterKeyParts): string {
  return `${frameId}::${pagePosterHash(page)}.${styleSignature}::${axesKey(axes)}::${Math.round(width)}`
}

/** The frame id a key belongs to. */
export function posterKeyFrameId(key: string): string {
  const end = key.indexOf('::')
  return end === -1 ? key : key.slice(0, end)
}
