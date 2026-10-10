/**
 * posterRasterizer — a frame's real document, drawn to a small bitmap (SB-2).
 *
 * `html-to-image` clones the DOM and copies the computed style of every
 * element onto the clone, because it knows nothing about the page it is
 * given. Studio owns the frame's document: the cascade is already in its
 * `<style>` sheets. So this serializes that document as it is — the `<html>`
 * element's attributes, its style sheets as text, its body — into one SVG
 * `<foreignObject>` and lets the browser lay it out and paint it, once, at the
 * target size. There is no per-element walk on this thread; the work left here
 * is one `XMLSerializer` pass and one `drawImage`.
 *
 * An SVG image is an isolated document: it can load nothing. So every
 * `url(...)` in the style text, every `<img src>` and every SVG `<image href>`
 * is fetched once, turned into a data URI, and remembered by absolute URL
 * ({@link inlineCache}) so the second picture of a project costs no network.
 * A resource that cannot be fetched is replaced by an empty one rather than
 * left to taint the picture.
 *
 * What it does NOT draw, by name: `<video>`/`<canvas>` content (an element, not
 * markup), `<iframe>` children, and anything a stylesheet pulls in through
 * `@import` or a cross-origin `<link>` whose rules the browser will not let
 * script read. Those frames get a picture without that content; they are never
 * faked.
 */

export interface RasterizeOptions {
  /** Width/height of the document in CSS px — the iframe's box. */
  width: number
  height: number
  /** Longest edge of the produced bitmap, device px. */
  maxEdge: number
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const XHTML_NS = 'http://www.w3.org/1999/xhtml'

/** An inlined resource larger than this is dropped; a poster is not the place for a 4 MB hero image. */
const MAX_INLINE_BYTES = 1_500_000
const MAX_INLINE_ENTRIES = 160

/** Absolute URL -> data URI (or `''` when it could not be fetched). Insertion order = recency. */
const inlineCache = new Map<string, Promise<string>>()

async function toDataUri(absoluteUrl: string): Promise<string> {
  try {
    const response = await fetch(absoluteUrl, { credentials: 'same-origin' })
    if (!response.ok) return ''
    const blob = await response.blob()
    if (blob.size > MAX_INLINE_BYTES) return ''
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  } catch {
    // Unreachable or refused: the picture goes without this one resource.
    return ''
  }
}

function inlineResource(absoluteUrl: string): Promise<string> {
  const cached = inlineCache.get(absoluteUrl)
  if (cached) {
    inlineCache.delete(absoluteUrl)
    inlineCache.set(absoluteUrl, cached)
    return cached
  }
  const pending = toDataUri(absoluteUrl)
  inlineCache.set(absoluteUrl, pending)
  if (inlineCache.size > MAX_INLINE_ENTRIES) inlineCache.delete(inlineCache.keys().next().value as string)
  return pending
}

/** Test seam. */
export function clearPosterInlineCache(): void {
  inlineCache.clear()
}

/**
 * The base for relative resource URLs. A `srcdoc` frame reports `about:srcdoc`,
 * which resolves nothing, so the editor's own origin stands in for it.
 */
function resourceBase(doc: Document): string {
  return /^https?:/.test(doc.baseURI) ? doc.baseURI : location.href
}

function absolute(raw: string, base: string): string | null {
  if (raw === '' || raw.startsWith('data:') || raw.startsWith('#') || raw.startsWith('blob:')) return null
  try {
    return new URL(raw, base).href
  } catch {
    return null
  }
}

/** Every style sheet of the document as one text, in cascade order. Unreadable (cross-origin) sheets are skipped. */
function collectStyleText(doc: Document): string {
  const parts: string[] = []
  for (const sheet of doc.styleSheets) {
    const owner = sheet.ownerNode
    if (owner instanceof HTMLStyleElement && owner.textContent) {
      parts.push(owner.textContent)
      continue
    }
    try {
      parts.push(Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n'))
    } catch {
      // A cross-origin sheet: script may not read its rules, so the picture does without it.
    }
  }
  return parts.join('\n')
}

/** The first background `<body>` then `<html>` declares, as a CSS color (possibly transparent: filling with it is then a no-op). */
function documentBackground(doc: Document): string {
  const view = doc.defaultView
  for (const element of [doc.body, doc.documentElement]) {
    const color = view?.getComputedStyle(element).backgroundColor
    if (color && color !== 'transparent') return color
  }
  return '#fff'
}

/** Style text sits in an XML document, so `&` (CSS nesting, URLs) and `<` (inline SVG data URIs) must be escaped. */
function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}

function htmlOpenTag(root: HTMLElement): string {
  const attributes = Array.from(root.attributes, (attribute) => {
    const value = attribute.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
    return ` ${attribute.name}="${value}"`
  }).join('')
  return `<html xmlns="${XHTML_NS}"${attributes}>`
}

const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g
const MARKUP_URL = /(<(?:img|image)\b[^>]*?\s(?:src|href|xlink:href)=")([^"]+)(")/g

function collectUrls(text: string, pattern: RegExp, group: number, base: string, into: Set<string>): void {
  for (const match of text.matchAll(pattern)) {
    const url = absolute(match[group]!, base)
    if (url) into.add(url)
  }
}

async function inlineAll(styleText: string, bodyMarkup: string, base: string): Promise<{ style: string; body: string }> {
  const urls = new Set<string>()
  collectUrls(styleText, CSS_URL, 2, base, urls)
  collectUrls(bodyMarkup, CSS_URL, 2, base, urls)
  collectUrls(bodyMarkup, MARKUP_URL, 2, base, urls)
  if (urls.size === 0) return { style: styleText, body: bodyMarkup }
  const resolved = new Map<string, string>()
  await Promise.all([...urls].map(async (url) => resolved.set(url, await inlineResource(url))))
  const swapCss = (match: string, quote: string, raw: string) => {
    const url = absolute(raw, base)
    if (!url) return match
    return `url(${quote}${resolved.get(url) ?? ''}${quote})`
  }
  const swapMarkup = (_match: string, open: string, raw: string, close: string) => {
    const url = absolute(raw, base)
    return url ? `${open}${resolved.get(url) ?? ''}${close}` : `${open}${raw}${close}`
  }
  return {
    style: styleText.replace(CSS_URL, swapCss),
    body: bodyMarkup.replace(CSS_URL, swapCss).replace(MARKUP_URL, swapMarkup),
  }
}

/**
 * Chrome taints a canvas that drew an SVG-with-foreignObject loaded from a
 * `blob:` URL (it cannot export it); the same markup as a `data:` URL draws
 * clean, so the markup travels as a data URL even though it costs one encode.
 */
async function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  const image = new Image()
  const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await yieldToMain()
  image.src = source
  await image.decode()
  return image
}

/** End the current task so the phases of one capture are separate tasks, each short enough to sit between two frames. A timeout, never an rAF: a hidden tab must still finish. */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Rasterize `doc` to a WebP blob no larger than `maxEdge` on its longest edge,
 * or `null` when the document has nothing to draw yet (a frame mid-mount).
 */
export async function rasterizeFrameDocument(doc: Document, { width, height, maxEdge }: RasterizeOptions): Promise<Blob | null> {
  const root = doc.documentElement
  const body = doc.body
  if (!body || body.childElementCount === 0) return null

  const bodyMarkup = new XMLSerializer().serializeToString(body).replace(/<script\b[\s\S]*?<\/script>/g, '')
  const { style, body: inlinedBody } = await inlineAll(collectStyleText(doc), bodyMarkup, resourceBase(doc))

  // `<html>` and `<body>` selectors, `:root` variables and `dir`/`lang` all survive because the
  // real element chain is rebuilt, not flattened into a div.
  await yieldToMain()
  const markup = `${htmlOpenTag(root)}<head><style>${escapeXmlText(style)}</style></head>${inlinedBody}</html>`
  const svg = `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject x="0" y="0" width="${width}" height="${height}">${markup}</foreignObject></svg>`

  const image = await loadSvgImage(svg)
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) return null
  await yieldToMain()
  // The document's own background is what the frame shows; the canvas starts transparent, which a poster must not be.
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = documentBackground(doc)
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.8))
}
