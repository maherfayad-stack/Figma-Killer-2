/**
 * `studio_find_image` — search licensed stock photography and land the best
 * matches in the project as real files, with the photographer credited
 * (P4-E, AI-13; OD-11).
 *
 * ## Why this exists
 *
 * The Assets ladder in the system prompt ended, for a photo, in "a plain
 * neutral placeholder box". A hero, a product shot, a person on a profile
 * screen: everything the brief did not arrive with came out grey, and a grey
 * rectangle is the first thing a reviewer reads as unfinished. The agent had
 * no way to get a real photograph it was not handed.
 *
 * ## One call, search and land
 *
 * A smaller model does best with one call that does the whole job. So the
 * search result is not a list to choose from — the top `count` photos are
 * downloaded and landed, and the next few come back as `moreResults` (id, alt
 * text, size) so a second call with `photoId` lands a specific one. The agent
 * cannot see a candidate before landing it anyway; after landing, a
 * screenshot shows it in place, which is the judgement that matters.
 *
 * ## Safety, in order
 *
 *   1. No key → a plain answer that stock search is not set up, and what to
 *      do instead. Not an error (the owner's bar: no visible errors for a
 *      missing optional integration).
 *   2. The provider API is a fixed origin (`stockPhotos.ts`), validated with
 *      TypeBox, capped and time-limited.
 *   3. Each image URL the API returned must be the provider's own image host
 *      (`isProviderImageUrl`) before anything downloads it — the API response
 *      is not trusted to name a host.
 *   4. The download is `fetchRemoteBytes`: pinned DNS, no private address, no
 *      redirect, byte cap, deadline, image content type, magic bytes.
 *   5. The landing is `landAgentAsset`: the agent write gate on `targetDir`,
 *      the project write lock, `assetLanding.ts` (sniff, dedupe, `wx`).
 *   6. The credit goes to `IMAGE-CREDITS.md` through the same gate
 *      (`imageCredits.ts`).
 */
import { Type } from '@core/utils/typeboxHelpers'
import { toolRefusal } from '@core/ai'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { isRefusal, landAgentAsset, type LandedAgentAsset } from './agentWriteSupport'
import { IMAGE_CREDITS_FILE, recordImageCredits, type ImageCredit } from './imageCredits'
import {
  getStockPhoto,
  PEXELS,
  renditionUrl,
  searchStockPhotos,
  stockPhotoApiKey,
  STOCK_PHOTO_KEY_ENV_VAR,
  type PexelsPhoto,
  type StockImageSize,
  type StockOrientation,
  type StockPhotoDeps,
} from './stockPhotos'
import { fetchRemoteBytes, type FetchRemoteAssetDeps } from '../../../../handlers/studio/remoteAssetFetch'
import { withProjectWriteLock } from '../../../../handlers/studio/projectWriteLock'

/** Photos landed per call. Four covers a hero plus three cards; more is a gallery the agent should ask for twice. */
const MAX_COUNT = 4
/** Candidates returned un-landed, for a follow-up `photoId`. */
const MORE_RESULTS = 6

/** The site credits link to — the provider's own domain, nothing else. */
const PROVIDER_SITE_HOST = 'pexels.com'

const FindImageInputSchema = Type.Object(
  {
    dir: Type.Optional(Type.String({ description: 'Absolute project directory. Omit it: it defaults to the project open in Studio.' })),
    query: Type.String({
      minLength: 1,
      maxLength: 100,
      description: 'What the photo shows, in concrete words: "barista pouring latte art", "empty beach at dawn", "woman reading on a train". Nouns and a setting beat moods. With photoId, only names the file.',
    }),
    orientation: Type.Optional(Type.Union([Type.Literal('landscape'), Type.Literal('portrait'), Type.Literal('square')], {
      description: 'Match the slot: landscape for a hero or banner, portrait for a phone-height card or a person, square for an avatar or a tile.',
    })),
    size: Type.Optional(Type.Union([Type.Literal('small'), Type.Literal('medium'), Type.Literal('large')], {
      description: 'small ≈ 350 px tall (thumbnails, avatars), medium ≈ 940 px wide (cards), large ≈ 1880 px wide (hero, full-bleed; the default).',
    })),
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_COUNT, description: `How many of the best matches to land, 1–${MAX_COUNT}. Default 1.` })),
    photoId: Type.Optional(Type.Integer({ minimum: 1, description: 'Land this exact photo — a photoId from an earlier call\'s moreResults — instead of searching.' })),
    targetDir: Type.Optional(Type.String({
      maxLength: 1024,
      description: 'Project-relative folder to land in. Default src/assets (import it). Use public/… for an image referenced by URL (CSS url(), a literal src).',
    })),
  },
  { additionalProperties: false },
)

type FindImageInput = {
  dir?: string
  query: string
  orientation?: StockOrientation
  size?: StockImageSize
  count?: number
  photoId?: number
  targetDir?: string
}

export interface FindImageDeps {
  readonly stock?: StockPhotoDeps
  readonly fetch?: FetchRemoteAssetDeps
}

/** A file-name stem from the query: lower-case words joined by dashes, then the provider and photo id. */
function fileHint(query: string, providerId: string, photoId: number): string {
  const words = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  return `${words || 'photo'}-${providerId}-${photoId}`
}

function altText(photo: PexelsPhoto): string {
  return (photo.alt ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
}

const NOT_CONFIGURED_MESSAGE =
  `Stock photo search is not set up on this Studio server, so nothing was searched or landed. Carry on down the Assets ladder: cut the art out of the registered design reference, or leave a neutral box and name the photo that belongs there in your reply. (The operator enables it by setting ${STOCK_PHOTO_KEY_ENV_VAR} to a free Pexels API key and restarting Studio.)`

export async function findImageForAgent(input: FindImageInput, ctx: ToolContext, deps: FindImageDeps = {}): Promise<Record<string, unknown>> {
  const dir = resolveToolProjectDir(input.dir, ctx)
  const stockDeps: StockPhotoDeps = { ...deps.stock, apiKey: deps.stock?.apiKey === undefined ? stockPhotoApiKey() : deps.stock.apiKey }
  const provider = stockDeps.provider ?? PEXELS
  if (!stockDeps.apiKey) return { ok: true, configured: false, landed: [], moreResults: [], message: NOT_CONFIGURED_MESSAGE }

  const count = Math.min(Math.max(input.count ?? 1, 1), MAX_COUNT)
  const lookup = input.photoId !== undefined
    ? await getStockPhoto(input.photoId, stockDeps)
    : await searchStockPhotos(input.query, { orientation: input.orientation, perPage: count + MORE_RESULTS }, stockDeps)
  if (!lookup.ok) {
    if (lookup.reason === 'not-configured') return { ok: true, configured: false, landed: [], moreResults: [], message: NOT_CONFIGURED_MESSAGE }
    return toolRefusal(lookup.reason, lookup.message, {
      remedy: lookup.reason === 'invalid-input'
        ? 'Search again without photoId.'
        : 'Carry on without it: cut the art out of the registered design reference, or leave a neutral box and name the photo that belongs there.',
    })
  }
  if (lookup.photos.length === 0) {
    return {
      ok: true,
      configured: true,
      landed: [],
      moreResults: [],
      message: `${provider.label} has no photo for "${input.query}". Search again with fewer, plainer words (a subject and a setting), or drop orientation.`,
    }
  }

  const chosen = lookup.photos.slice(0, count)
  const landed: Array<LandedAgentAsset & { photoId: number; alt: string; credit: string }> = []
  const credits: ImageCredit[] = []
  const skipped: string[] = []
  const size = input.size ?? 'large'

  for (const photo of chosen) {
    const rendition = renditionUrl(photo, size)
    const renditionUrlParsed = URL.canParse(rendition) ? new URL(rendition) : null
    if (renditionUrlParsed === null || !provider.isProviderImageUrl(renditionUrlParsed)) {
      // The API response named somewhere else to download from. It is not
      // trusted to: only the provider's own image host is.
      skipped.push(`photo ${photo.id}: its image URL is not on ${provider.label}'s image host, so it was not downloaded`)
      continue
    }
    const fetched = await fetchRemoteBytes(rendition, deps.fetch)
    if (!fetched.ok) {
      skipped.push(`photo ${photo.id}: ${fetched.error}`)
      continue
    }
    const asset = await landAgentAsset(dir, ctx, input.targetDir, fetched.bytes, fileHint(input.query, provider.id, photo.id))
    // A refused target folder refuses every photo the same way: stop here.
    if (isRefusal(asset)) return asset
    const credit = `Photo by ${photo.photographer.slice(0, 120)} on ${provider.label}`
    landed.push({ ...asset, photoId: photo.id, alt: altText(photo), credit })
    credits.push({
      relPath: asset.relPath,
      photographer: photo.photographer,
      photographerUrl: photo.photographer_url,
      sourceLabel: provider.label,
      sourceUrl: photo.url,
      licenceName: provider.licence.name,
      licenceUrl: provider.licence.url,
    })
  }

  if (landed.length === 0) {
    return toolRefusal('remote-fetch-failed', `No photo could be downloaded: ${skipped.join('; ')}.`, {
      remedy: 'Search again; if it keeps failing, leave a neutral box and name the photo that belongs there.',
    })
  }

  const creditRefusal = await withProjectWriteLock(dir, () => recordImageCredits(dir, ctx, credits, PROVIDER_SITE_HOST))

  return {
    ok: true,
    configured: true,
    provider: provider.label,
    licence: provider.licence,
    landed,
    moreResults: lookup.photos.slice(count, count + MORE_RESULTS).map((photo) => ({
      photoId: photo.id,
      alt: altText(photo),
      width: photo.width,
      height: photo.height,
      photographer: photo.photographer,
    })),
    creditsFile: creditRefusal === null ? IMAGE_CREDITS_FILE : null,
    ...(creditRefusal === null ? {} : { creditWarning: `The images landed, but their credit could not be written to ${IMAGE_CREDITS_FILE}: ${creditRefusal.message} Tell the user who took each photo.` }),
    ...(skipped.length > 0 ? { skipped } : {}),
    next: 'Import relPath from the screen file, give the <img> the alt text (or alt="" if purely decorative), size it with object-fit: cover, then take a screenshot to judge it in place. In your reply, say which photo you used and that its credit is in the credits file.',
  }
}

const findImageTool: AiTool = {
  name: 'studio_find_image',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'write',
  requiresWrite: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Find a real photo for a slot and land it in the project: searches licensed stock (Pexels; free to use), downloads the best `count` matches (default 1) into targetDir (default src/assets), and credits each photographer in IMAGE-CREDITS.md. Use it before ever drawing a placeholder for a photo. Returns landed: [{ relPath, src, buildSafe, width, height, alt, photoId, credit }] and moreResults (photoId, alt, size) — call again with photoId to land one of those instead. Write concrete queries ("chef plating pasta in a dark kitchen"), set orientation to the slot\'s shape. If stock search is not configured it says so plainly and lands nothing; do not retry, move down the Assets ladder. Requires studio.write.',
  inputSchema: FindImageInputSchema,
  handler: async (input, ctx: ToolContext) => findImageForAgent(input as FindImageInput, ctx),
}

export const studioFindImageMcpTools: AiTool[] = [findImageTool]
