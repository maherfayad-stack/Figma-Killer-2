/**
 * stockPhotos — the licensed stock-photo source behind `studio_find_image`
 * (P4-E, AI-13; owner decision OD-11: licensed stock search now, AI image
 * generation later behind its own capability and credential).
 *
 * ## Why Pexels
 *
 * The provider has to satisfy three things at once, and the candidates each
 * miss one:
 *
 *   - **The licence must allow landing the file in the user's repository.**
 *     Studio's whole model is that the repo IS the document, so a photo is a
 *     file on disk, served by the project's own site. Unsplash's API
 *     guidelines require hotlinking its CDN URLs rather than self-hosting the
 *     bytes, which a landed asset cannot honour. The Pexels License permits
 *     free use and modification, commercial included, with no attribution
 *     required. What it forbids (selling unaltered copies, re-publishing on
 *     another stock or wallpaper platform, implying endorsement, showing an
 *     identifiable person in a bad light) is about what the USER does with the
 *     screen, so the credits file names the licence for them to read.
 *   - **Attribution we can meet.** Pexels asks API users to credit the
 *     photographer and Pexels where possible. We can: every landed photo gets
 *     a line in the project's `IMAGE-CREDITS.md` (`imageCredits.ts`), a file
 *     the user sees in their own repo and ships with it. Openverse's CC
 *     content would need a per-licence attribution on the rendered page for
 *     CC BY and a share-alike check for CC BY-SA, which a landed `<img>`
 *     cannot promise.
 *   - **One image host.** Every Pexels photo is served from
 *     `images.pexels.com`, so the download can be held to exactly that host
 *     (`remoteFetchPolicy.ts`). Openverse results point at whatever site
 *     originally hosted the work — an open-ended host list is the opposite of
 *     what F8 asked for.
 *
 * ## The credential
 *
 * `PEXELS_API_KEY`, from the environment, for the reason
 * `STUDIO_ALLOW_LOOPBACK_ASSET_FETCH` gives in `remoteAssetFetch.ts`: an env
 * var is set by whoever starts the process, is never written into a project
 * or the database, and cannot be read back through any Studio route. With no
 * key the tool says so plainly and lands nothing — a plain answer, not an
 * error (`findImageTool.ts`). The key is sent only in the `Authorization`
 * header to the fixed API origin; it is never logged, never echoed in a
 * result, and never sent to the image host.
 *
 * ## Transport
 *
 * Direct HTTP, no provider SDK (CLAUDE.md "AI providers"). The API call goes
 * to a FIXED origin, so it is not an SSRF surface; it still refuses
 * redirects, carries a deadline, and caps the response it reads. The response
 * is validated against a TypeBox schema before anything uses it. The IMAGE
 * download is a different story — its URL comes out of that response — so it
 * goes through `fetchRemoteBytes`, the full SSRF-hardened transport, after
 * `isProviderImageUrl` has held it to the provider's own image host.
 */
import { Type, type Static, type TSchema } from '@core/utils/typeboxHelpers'
import { safeParseJson } from '@core/utils/jsonValidate'
import { readBytesWithLimit, ArchiveIngestError } from '../../../../handlers/studio/archiveIngest'

/** The environment variable holding the Pexels API key. */
export const STOCK_PHOTO_KEY_ENV_VAR = 'PEXELS_API_KEY'

/** One stock-photo provider: where its API is, which host serves its images, and what its licence says. */
export interface StockPhotoProvider {
  readonly id: 'pexels'
  readonly label: string
  readonly apiBase: string
  /** Whether a URL the API returned is one of this provider's own image URLs — the ONLY thing `studio_find_image` downloads. */
  readonly isProviderImageUrl: (url: URL) => boolean
  readonly licence: { readonly name: string; readonly url: string }
}

/** Pexels' image CDN. Exact host, https only — a subdomain or another scheme is not the provider. */
export const PEXELS_IMAGE_HOST = 'images.pexels.com'

export const PEXELS: StockPhotoProvider = {
  id: 'pexels',
  label: 'Pexels',
  apiBase: 'https://api.pexels.com/v1',
  isProviderImageUrl: (url) => url.protocol === 'https:' && url.hostname === PEXELS_IMAGE_HOST && url.port === '',
  licence: { name: 'Pexels License', url: 'https://www.pexels.com/license/' },
}

/** The configured key, or `null` when stock search is not set up. Blank counts as absent. */
export function stockPhotoApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[STOCK_PHOTO_KEY_ENV_VAR]?.trim()
  return raw ? raw : null
}

const PexelsPhotoSchema = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  width: Type.Integer({ minimum: 1 }),
  height: Type.Integer({ minimum: 1 }),
  url: Type.String({ maxLength: 2048 }),
  photographer: Type.String({ maxLength: 500 }),
  photographer_url: Type.String({ maxLength: 2048 }),
  alt: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
  src: Type.Object({
    original: Type.String({ maxLength: 2048 }),
    large2x: Type.String({ maxLength: 2048 }),
    large: Type.String({ maxLength: 2048 }),
    medium: Type.String({ maxLength: 2048 }),
  }),
})
export type PexelsPhoto = Static<typeof PexelsPhotoSchema>

const PexelsSearchSchema = Type.Object({
  photos: Type.Array(PexelsPhotoSchema, { maxItems: 80 }),
})

export type StockOrientation = 'landscape' | 'portrait' | 'square'

/** How big a file to land. Maps to Pexels' own renditions: 350 px tall, 940 px wide, 1880 px wide. */
export type StockImageSize = 'small' | 'medium' | 'large'

export function renditionUrl(photo: PexelsPhoto, size: StockImageSize): string {
  if (size === 'small') return photo.src.medium
  if (size === 'medium') return photo.src.large
  return photo.src.large2x
}

export interface StockPhotoDeps {
  readonly provider?: StockPhotoProvider
  readonly apiKey?: string | null
  /** Test seam — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

/**
 * Why a lookup produced no photos. `not-configured` is not a failure — there
 * is no key, and the tool says so plainly. The rest name the refusal code the
 * tool returns.
 */
export type StockLookupFailure = 'not-configured' | 'stock-search-failed' | 'stock-key-refused' | 'invalid-input'

export type StockLookup =
  | { readonly ok: true; readonly photos: readonly PexelsPhoto[] }
  | { readonly ok: false; readonly reason: StockLookupFailure; readonly message: string }

/** API responses are small JSON; anything past this is not a search result. */
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024
const API_TIMEOUT_MS = 15_000

/**
 * GET one provider API path and validate it. Never throws, never includes the
 * key or a raw network error in what it returns.
 */
async function getJson<T extends TSchema>(
  path: string,
  schema: T,
  deps: StockPhotoDeps,
): Promise<{ ok: true; value: Static<T> } | { ok: false; reason: StockLookupFailure; message: string }> {
  const provider = deps.provider ?? PEXELS
  const apiKey = deps.apiKey === undefined ? stockPhotoApiKey() : deps.apiKey
  if (!apiKey) {
    return { ok: false, reason: 'not-configured', message: `Stock photo search is not set up on this Studio server (no ${STOCK_PHOTO_KEY_ENV_VAR}).` }
  }
  const fetchImpl = deps.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? API_TIMEOUT_MS)
  try {
    let res: Response
    try {
      res = await fetchImpl(`${provider.apiBase}${path}`, {
        redirect: 'error',
        signal: controller.signal,
        headers: { authorization: apiKey, accept: 'application/json', 'user-agent': 'studio-stock-search' },
      })
    } catch (err) {
      console.error(`[studio:stock-photos] ${provider.label} request failed`, err instanceof Error ? err.name : 'unknown')
      return { ok: false, reason: 'stock-search-failed', message: `${provider.label} could not be reached.` }
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'stock-key-refused', message: `${provider.label} refused the configured ${STOCK_PHOTO_KEY_ENV_VAR} (HTTP ${res.status}). The operator needs to check the key.` }
    }
    if (res.status === 429) {
      return { ok: false, reason: 'stock-search-failed', message: `${provider.label}'s rate limit for this key is used up for now (HTTP 429).` }
    }
    if (res.status === 404) {
      return { ok: false, reason: 'invalid-input', message: `${provider.label} has no such photo (HTTP 404).` }
    }
    if (!res.ok) {
      return { ok: false, reason: 'stock-search-failed', message: `${provider.label} answered HTTP ${res.status}.` }
    }
    let text: string
    try {
      text = new TextDecoder().decode(await readBytesWithLimit(res, MAX_API_RESPONSE_BYTES, 'The provider response was too large.'))
    } catch (err) {
      const why = err instanceof ArchiveIngestError ? err.message : 'The provider response could not be read.'
      return { ok: false, reason: 'stock-search-failed', message: why }
    }
    const parsed = safeParseJson(text, schema)
    if (!parsed.ok) {
      console.error(`[studio:stock-photos] ${provider.label} returned an unexpected shape:`, parsed.error.message)
      return { ok: false, reason: 'stock-search-failed', message: `${provider.label} returned a response Studio does not recognise.` }
    }
    return { ok: true, value: parsed.value as Static<T> }
  } finally {
    clearTimeout(timer)
  }
}

/** Search the provider. `perPage` is bounded by the caller. */
export async function searchStockPhotos(
  query: string,
  options: { orientation?: StockOrientation; perPage: number },
  deps: StockPhotoDeps = {},
): Promise<StockLookup> {
  const params = new URLSearchParams({ query, per_page: String(options.perPage) })
  if (options.orientation) params.set('orientation', options.orientation)
  const result = await getJson(`/search?${params.toString()}`, PexelsSearchSchema, deps)
  return result.ok ? { ok: true, photos: result.value.photos } : result
}

/** One photo by id — how an agent lands a specific result it was shown earlier. */
export async function getStockPhoto(photoId: number, deps: StockPhotoDeps = {}): Promise<StockLookup> {
  const result = await getJson(`/photos/${photoId}`, PexelsPhotoSchema, deps)
  return result.ok ? { ok: true, photos: [result.value] } : result
}
