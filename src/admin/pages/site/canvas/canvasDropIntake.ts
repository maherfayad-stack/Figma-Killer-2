/**
 * canvasDropIntake — what a native drop on the board CARRIES, reduced to
 * something the drop plan can act on (P5-B3, IMG-5 / OD-13).
 *
 * Two transports reach the board, and Penpot's `on-drop` accepts both
 * (audit 07 §A.2):
 *
 *   - `Files` — bytes from the operating system. Always preferred: when a
 *     browser hands over both a file and a link (Chrome does for an image
 *     dragged out of a page), the file is the image itself and needs no
 *     second fetch.
 *   - a LINK — an image dragged out of another browser tab arrives as
 *     `text/uri-list` (and usually `text/html` holding the `<img>`).
 *
 * ## A link is not an image until it says so
 *
 * An http(s) link becomes an `ImageDropSource` of kind `url`, which the SERVER
 * fetches through the SSRF guard (`asset-drop-url`). That fetch is the one
 * outbound request a drop can cause, so it is only asked for when the drag
 * itself says "image": the `<img src>` of the dragged HTML, or a URL whose
 * path ends in an image extension. A dragged link to a web page, a bookmark,
 * or a selected URL is refused HERE with a sentence — no request is made on
 * the strength of a link the user did not mean as an image.
 *
 * `data:image/…` is decoded in the browser into a `File` and takes the
 * ordinary upload path; the server never parses `data:`. Anything else —
 * `javascript:`, `file:`, `blob:` from another origin — is refused.
 *
 * Only the DROP can read any of this: before release the drag data store is
 * in protected mode (`canvasFileDrop.ts`'s `DroppedFileFacts` doc), so the
 * in-flight chip only knows "a link is coming" and shows one image.
 */
import type { LandableImageSource } from '@site/store/slices/site/imageDropShapes'

/** The same per-file ceiling the landing route enforces (`MAX_ASSET_DROP_BYTES`) — refused before a byte is decoded. */
export const MAX_DATA_URL_IMAGE_BYTES = 25 * 1024 * 1024

/**
 * Why a dropped link is not an image: the chip's one-line `headline` and the
 * toast's whole `message`, the two halves of every drop refusal
 * (`canvasFileDrop.ts` reports it as its `not-an-image` reason). Its own shape
 * so this leaf imports nothing from the planner that imports it.
 */
export interface DroppedLinkRefusal {
  headline: string
  message: string
}

export type DroppedImageIntake =
  | { kind: 'files'; files: readonly File[] }
  | { kind: 'link'; source: LandableImageSource }
  | { kind: 'refused'; refusal: DroppedLinkRefusal }

/** Path extensions that make a bare link an image without the dragged HTML saying so. */
const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp|avif|svg)$/i

function refusedLink(headline: string, message: string): DroppedImageIntake {
  return { kind: 'refused', refusal: { headline, message } }
}

const LINK_NOT_IMAGE = refusedLink(
  'That link is not an image',
  'That drop carried a link to a page, not an image, so nothing was fetched. Drag the image itself, or save it and drop the file.',
)

/** The first `<img src>` in the dragged HTML. `DOMParser` builds an inert document: nothing in it loads or runs. */
function imageSrcFromHtml(html: string): string | null {
  if (html.trim() === '' || typeof DOMParser === 'undefined') return null
  const img = new DOMParser().parseFromString(html, 'text/html').querySelector('img[src]')
  const src = img?.getAttribute('src')?.trim()
  return src ? src : null
}

/** The first URL of a `text/uri-list` (RFC 2483: one per line, `#` lines are comments). */
function firstUri(uriList: string): string | null {
  for (const line of uriList.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed !== '' && !trimmed.startsWith('#')) return trimmed
  }
  return null
}

/**
 * A `data:image/…` URL as a `File`, or a refusal. Base64 and percent-encoded
 * payloads both decode; the MIME type is the URL's own, and the server sniffs
 * the bytes regardless.
 */
export function fileFromImageDataUrl(dataUrl: string): DroppedImageIntake {
  const comma = dataUrl.indexOf(',')
  const header = comma === -1 ? '' : dataUrl.slice(5, comma)
  const payload = comma === -1 ? '' : dataUrl.slice(comma + 1)
  const [mime = '', ...params] = header.split(';')
  if (!/^image\/[a-z0-9.+-]+$/i.test(mime)) {
    return refusedLink('That is not an image', 'That drop carried data that is not an image, so nothing was added.')
  }
  const base64 = params.some((param) => param.toLowerCase() === 'base64')
  const estimated = base64 ? Math.floor((payload.length * 3) / 4) : payload.length
  if (estimated > MAX_DATA_URL_IMAGE_BYTES) {
    return refusedLink('That image is too large', `The image is larger than the ${MAX_DATA_URL_IMAGE_BYTES / (1024 * 1024)} MB limit.`)
  }
  let bytes: Uint8Array<ArrayBuffer>
  try {
    if (base64) {
      const binary = atob(payload.replace(/\s+/g, ''))
      bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(payload))
    }
  } catch {
    return refusedLink('That image could not be read', 'The dropped image data is malformed, so nothing was added.')
  }
  const extension = mime.slice('image/'.length).split('+')[0]!.toLowerCase()
  const file = new File([bytes], `image.${extension === 'jpeg' ? 'jpg' : extension}`, { type: mime.toLowerCase() })
  return { kind: 'link', source: { kind: 'file', file } }
}

/**
 * What this drop carries, or `null` when it carries nothing the board takes
 * (an ordinary text drag) — the caller then leaves the event alone.
 */
export function readDroppedImageIntake(transfer: DataTransfer | null): DroppedImageIntake | null {
  if (!transfer) return null
  const files = Array.from(transfer.files ?? [])
  if (files.length > 0) return { kind: 'files', files }

  const types = Array.from(transfer.types ?? [])
  if (!types.includes('text/uri-list')) return null
  const fromHtml = types.includes('text/html') ? imageSrcFromHtml(transfer.getData('text/html')) : null
  const raw = fromHtml ?? firstUri(transfer.getData('text/uri-list'))
  if (!raw) return LINK_NOT_IMAGE

  if (/^data:/i.test(raw)) return fileFromImageDataUrl(raw)

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return LINK_NOT_IMAGE
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return refusedLink(
      'Studio cannot fetch that',
      'Studio fetches dropped images from http:// and https:// addresses only, so nothing was added.',
    )
  }
  // The dragged HTML naming this as an `<img>` is the browser saying "image";
  // without it, only a path that looks like one is worth a fetch.
  if (fromHtml === null && !IMAGE_PATH.test(url.pathname)) return LINK_NOT_IMAGE
  return { kind: 'link', source: { kind: 'url', url: url.href } }
}

/** True when a drag, read before release, carries a link the drop may turn into an image. */
export function carriesLink(types: readonly string[]): boolean {
  return types.includes('text/uri-list')
}
