/**
 * canvasClipboardData — what is on the operating system's clipboard, reduced
 * to what a canvas paste can act on, and which of those things ⌘V means
 * (P5-A: IMG-4's base, SVG-5's clipboard part).
 *
 * Pure: no store, no DOM beyond reading a `DataTransfer` / `ClipboardItem`
 * handed in. The bridge (`canvasClipboardBridge.ts`) collects a snapshot from
 * a `paste` event or from `navigator.clipboard.read()`, and `canvasPaste.ts`
 * carries out the decision.
 *
 * ## The Studio marker
 *
 * Studio's copied LAYERS never leave the browser: they are the clipboard
 * slice's entry (and its localStorage mirror). The operating system's
 * clipboard is a different store that anything can overwrite — a screenshot,
 * "Copy image" in another tab, "Copy as SVG" in another design tool. Without
 * a way to tell the two apart, ⌘V after copying a layer and then taking a
 * screenshot would paste the stale layer; or, the other way, a layer copied
 * a moment ago would lose to a days-old image still on the OS clipboard.
 *
 * So every copy also writes a MARKER to the OS clipboard, carrying the
 * entry's `copiedAt`. On paste, a marker whose `copiedAt` matches the entry
 * says "the OS clipboard still holds the layers I copied", and anything else
 * on it is newer than that copy. It is written twice, because the two ways
 * of writing it can each read back different types:
 *
 *   - `application/x-studio-nodes` (the `copiedAt` digits) — through the
 *     `copy` event's `clipboardData`, which a paste event in the same browser
 *     reads back exactly;
 *   - `text/html` (`<span data-studio-nodes="…">`) — the one custom-free type
 *     the async Clipboard API can both write (the Safari path, where no
 *     `copy` event fires without a text selection) and read.
 *
 * ## Untrusted input
 *
 * Everything read here is untrusted, and this module parses none of it as
 * markup: the marker is a bounded regex over at most {@link MARKER_SCAN_CHARS}
 * characters that extracts digits, and the SVG sniff only looks at the first
 * and last few KB to decide whether text is shaped like an `<svg>` document.
 * The SVG itself is sanitised by `svgToJsxNode` (`sanitizeSvg`, P5-D part 1)
 * or, when it lands as a file, by the server's `sanitizeSvgBytes`. HTML on the
 * clipboard is never inserted.
 */

/** The custom clipboard type the `copy` event writes the marker under. */
export const STUDIO_NODES_MIME = 'application/x-studio-nodes'

const MARKER_ATTRIBUTE = 'data-studio-nodes'
/** A `copiedAt` is `Date.now()`: 13 digits today; 16 bounds it. */
const COPIED_AT_DIGITS = /^\d{1,16}$/
const MARKER_IN_HTML = new RegExp(`${MARKER_ATTRIBUTE}="(\\d{1,16})"`)
/** How much of a `text/html` payload is searched for the marker — Studio writes it first, and a browser prepends at most a `<meta charset>`. */
const MARKER_SCAN_CHARS = 512

/** The `text/html` form of the marker. */
export function studioMarkerHtml(copiedAt: number): string {
  return `<span ${MARKER_ATTRIBUTE}="${copiedAt}"></span>`
}

/** The `copiedAt` a custom-type marker carries, or `null`. */
export function readMarkerDigits(value: string | null | undefined): number | null {
  if (!value) return null
  const trimmed = value.trim()
  return COPIED_AT_DIGITS.test(trimmed) ? Number(trimmed) : null
}

/** The `copiedAt` a `text/html` marker carries, or `null`. */
export function readMarkerHtml(html: string | null | undefined): number | null {
  if (!html) return null
  const match = MARKER_IN_HTML.exec(html.slice(0, MARKER_SCAN_CHARS))
  return match ? Number(match[1]) : null
}

/** An SVG on the clipboard: as text (`text/plain`, "Copy as SVG") or as a file. */
export type ClipboardSvgSource = { kind: 'text'; markup: string } | { kind: 'file'; file: File }

/** Everything a paste can act on, read out of one clipboard. */
export interface ClipboardSnapshot {
  /** `false` when the clipboard could not be read at all (the async API was refused or is missing). */
  readable: boolean
  /** The Studio marker's `copiedAt`, when the clipboard carries one. */
  marker: number | null
  /** Raster images, in clipboard order. An SVG is never here — see `svg`. */
  images: File[]
  svg: ClipboardSvgSource | null
}

export const UNREADABLE_CLIPBOARD: ClipboardSnapshot = { readable: false, marker: null, images: [], svg: null }

const SVG_MIME = 'image/svg+xml'
/** How far into the text an `<svg` root may start (a prolog, a DOCTYPE, comments). */
const SVG_HEAD_CHARS = 4096
const SVG_TAIL_CHARS = 256
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff)
const SVG_HEAD =
  /^\s*(?:<\?xml[^>]{0,256}\?>\s*)?(?:<!--[\s\S]{0,1024}?-->\s*)*(?:<!DOCTYPE[^>[]{0,512}(?:\[[^\]]{0,2048}\])?\s*>\s*)?(?:<!--[\s\S]{0,1024}?-->\s*)*<svg[\s>/]/i
const SVG_TAIL = /(?:<\/svg\s*>|\/>)\s*$/i

/**
 * Whether clipboard text is an SVG DOCUMENT — an optional XML prolog,
 * DOCTYPE and comments, then an `<svg` root, and nothing after its close.
 * Only the head and the tail are read, with bounded quantifiers, so a
 * multi-megabyte paste costs the same as a small one. Shape, not safety: the
 * sanitiser decides what of it survives.
 */
export function looksLikeSvgDocument(text: string): boolean {
  const body = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text
  return SVG_HEAD.test(body.slice(0, SVG_HEAD_CHARS)) && SVG_TAIL.test(body.slice(-SVG_TAIL_CHARS))
}

function isRasterImage(type: string): boolean {
  return type.startsWith('image/') && type !== SVG_MIME
}

/**
 * The snapshot a `paste` event carries. Synchronous — `getData` and `files`
 * are only readable while the event is being dispatched — so an SVG FILE is
 * kept as a `File` and read later.
 */
export function snapshotFromDataTransfer(data: DataTransfer | null): ClipboardSnapshot {
  if (!data) return UNREADABLE_CLIPBOARD
  const marker = readMarkerDigits(data.getData(STUDIO_NODES_MIME)) ?? readMarkerHtml(data.getData('text/html'))
  const files = Array.from(data.files ?? [])
  const images = files.filter((file) => isRasterImage(file.type))
  const svgFile = files.find((file) => file.type === SVG_MIME)
  const text = data.getData('text/plain')
  const svg: ClipboardSvgSource | null =
    text && looksLikeSvgDocument(text) ? { kind: 'text', markup: text } : svgFile ? { kind: 'file', file: svgFile } : null
  return { readable: true, marker, images, svg }
}

/** The subset of `ClipboardItem` read here, so the tests can hand in plain objects. */
export interface ClipboardItemLike {
  readonly types: readonly string[]
  getType(type: string): Promise<Blob>
}

/** The extension a pasted raster image's file name gets, from its type. */
function extensionFor(type: string): string {
  const subtype = type.slice('image/'.length).split(/[+;]/)[0] ?? ''
  return subtype === 'jpeg' ? 'jpg' : subtype || 'png'
}

/**
 * The snapshot `navigator.clipboard.read()` returns — the keydown fallback,
 * for the engines that fire no `paste` event outside an editable target
 * (Safari). Asynchronous, and it reads only the three types every engine
 * exposes there (`text/plain`, `text/html`, raster images).
 */
export async function snapshotFromClipboardItems(items: readonly ClipboardItemLike[]): Promise<ClipboardSnapshot> {
  let marker: number | null = null
  let svg: ClipboardSvgSource | null = null
  const images: File[] = []
  for (const item of items) {
    for (const type of item.types) {
      if (type === 'text/html' && marker === null) {
        marker = readMarkerHtml(await (await item.getType(type)).text())
      } else if (type === 'text/plain' && svg === null) {
        const text = await (await item.getType(type)).text()
        if (looksLikeSvgDocument(text)) svg = { kind: 'text', markup: text }
      } else if (type === SVG_MIME && svg === null) {
        svg = { kind: 'file', file: new File([await item.getType(type)], 'pasted.svg', { type }) }
      } else if (isRasterImage(type)) {
        const blob = await item.getType(type)
        images.push(new File([blob], `pasted-image.${extensionFor(type)}`, { type }))
      }
    }
  }
  return { readable: true, marker, images, svg }
}

/** What one ⌘V means. */
export type CanvasPasteDecision =
  /** The layers the clipboard slice holds. */
  | { kind: 'nodes' }
  | { kind: 'svg'; source: ClipboardSvgSource }
  | { kind: 'images'; files: File[] }
  /**
   * Nothing to paste. `foreign-marker`: the OS clipboard holds layers, but not
   * the ones this editor copied (another Studio tab copied since).
   * `unreadable`: the browser would not let Studio read the clipboard.
   */
  | { kind: 'none'; reason: 'empty' | 'foreign-marker' | 'unreadable' }

/**
 * The decision table (08-svg §4.5, 07 IMG-4), in order:
 *
 *   1. A Studio marker: its own layers when `copiedAt` matches the entry;
 *      otherwise another tab's, which this editor does not hold.
 *   2. An SVG document (text or file) — before raster images, because a design
 *      tool that offers both offers the SVG as the editable one.
 *   3. Raster images.
 *   4. The clipboard offers nothing Studio can paste (plain text, or it could
 *      not be read): the layers the slice holds, if any — what ⌘V did before
 *      this bundle, and still the answer whenever nothing newer is readable.
 */
export function decideCanvasPaste(snapshot: ClipboardSnapshot, entryCopiedAt: number | null): CanvasPasteDecision {
  if (snapshot.marker !== null) {
    return snapshot.marker === entryCopiedAt ? { kind: 'nodes' } : { kind: 'none', reason: 'foreign-marker' }
  }
  if (snapshot.svg) return { kind: 'svg', source: snapshot.svg }
  if (snapshot.images.length > 0) return { kind: 'images', files: snapshot.images }
  if (entryCopiedAt !== null) return { kind: 'nodes' }
  return { kind: 'none', reason: snapshot.readable ? 'empty' : 'unreadable' }
}
