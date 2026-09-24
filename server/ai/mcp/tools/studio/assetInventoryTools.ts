/**
 * `studio_list_assets` and `studio_list_fonts` — the project's own inventory
 * of images and type, so the agent reuses what is there before it fetches or
 * invents anything (P4-E, AI-20).
 *
 * ## studio_list_assets
 *
 * The image files already in the project, with the URL the project's own site
 * serves each at (`assetSiteUrl.ts`, the one "file → URL" rule), its pixel
 * size, and the stock credit if Studio landed it (`imageCredits.ts`). The same
 * enumeration the inspector's image picker uses (`projectAssets.ts`: the
 * symlink-refusing workspace walk, minus Studio's own preview shell and
 * design-system copy), paginated. The `claude` CLI could already `Glob` for
 * files; neither path could answer "how big is it, and what URL do I write",
 * and the HTTP path could not list them at all without walking directories one
 * call at a time.
 *
 * ## studio_list_fonts
 *
 * The question behind the `font-not-available` finding, asked BEFORE the
 * mistake instead of after: which families this project can actually render,
 * how each one is loaded, which font tokens exist, and — with `query` — which
 * Google Fonts families could be added and the exact line that adds one. It
 * reads the same evidence `studio_quality_check`'s font rule reads
 * (`fontAvailability.ts`), so the two can never disagree about what is
 * available. The Google directory is Studio's bundled snapshot
 * (`@core/fonts`); nothing here touches the network.
 *
 * Both are reads: no capability, nothing written.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Type } from '@core/utils/typeboxHelpers'
import { listGoogleFonts, type GoogleFontFamily } from '@core/fonts'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { readImageCredits } from './imageCredits'
import { ALWAYS_AVAILABLE_FAMILIES, collectFontAvailability, normalizeFamily, type FontSource } from './fontAvailability'
import { describeProjectImageAssets, MAX_PROJECT_ASSETS } from '../../../../handlers/studio/projectAssets'
import { readImageDimensions } from '../../../../handlers/studio/imageDimensions'
import { collectProjectTokenCss } from '../../../../handlers/studio/projectTokenSources'

const DIR_FIELD = Type.Optional(Type.String({ description: 'Absolute project directory. Omit it: it defaults to the project open in Studio.' }))

// ---------------------------------------------------------------------------
// studio_list_assets
// ---------------------------------------------------------------------------

const DEFAULT_ASSET_PAGE = 50
const MAX_ASSET_PAGE = 100
/** Enough of a header for every format's size: a JPEG's SOF can sit behind a large EXIF block. */
const HEADER_READ_BYTES = 256 * 1024

/** The first bytes of a file — never the whole of a large image. */
function readHeader(abs: string): { bytes: Uint8Array; size: number } | null {
  let fd: number | null = null
  try {
    const size = statSync(abs).size
    fd = openSync(abs, 'r')
    const buffer = Buffer.alloc(Math.min(size, HEADER_READ_BYTES))
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    return { bytes: buffer.subarray(0, read), size }
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function dimensionsOf(dir: string, relPath: string): { width: number | null; height: number | null; bytes: number | null } {
  const header = readHeader(join(dir, ...relPath.split('/')))
  if (!header) return { width: null, height: null, bytes: null }
  const ext = relPath.slice(relPath.lastIndexOf('.') + 1).toLowerCase().replace('jpeg', 'jpg')
  const size = readImageDimensions(header.bytes, ext)
  return { width: size?.width ?? null, height: size?.height ?? null, bytes: header.size }
}

const ListAssetsInputSchema = Type.Object(
  {
    dir: DIR_FIELD,
    query: Type.Optional(Type.String({ maxLength: 200, description: 'Only files whose path contains this text, case-insensitive: "logo", "hero", "public/".' })),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Skip this many matches — the nextOffset of a previous call.' })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_ASSET_PAGE, description: `Page size, default ${DEFAULT_ASSET_PAGE}.` })),
  },
  { additionalProperties: false },
)

const listAssetsTool: AiTool = {
  name: 'studio_list_assets',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'none',
  requiredCapabilities: [],
  description:
    'List the image files already in the project (PNG, JPEG, GIF, WebP, AVIF, SVG) — check here before fetching or finding a new one. Each entry: relPath (import it from the file that shows it), src (the URL the project\'s site serves it at; buildSafe says whether a production build serves it too — true only under public/), width and height in px, bytes, and credit when it is a stock photo Studio landed. Filter with query, page with offset/limit; nextOffset is null on the last page. Studio\'s own preview shell and design-system copy are not listed. A read.',
  inputSchema: ListAssetsInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, query, offset = 0, limit = DEFAULT_ASSET_PAGE } = input as { dir?: string; query?: string; offset?: number; limit?: number }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const all = describeProjectImageAssets(dir)
    const needle = query?.trim().toLowerCase() ?? ''
    const matching = needle ? all.filter((asset) => asset.relPath.toLowerCase().includes(needle)) : all
    const page = matching.slice(offset, offset + limit)
    const credits = readImageCredits(dir)
    const assets = page.map((asset) => {
      const credit = credits.get(asset.relPath)
      return { ...asset, ...dimensionsOf(dir, asset.relPath), ...(credit ? { credit } : {}) }
    })
    const nextOffset = offset + page.length < matching.length ? offset + page.length : null
    return {
      ok: true,
      total: matching.length,
      offset,
      assets,
      nextOffset,
      ...(all.length >= MAX_PROJECT_ASSETS ? { note: `The walk stops at ${MAX_PROJECT_ASSETS} images, so this project may hold more; narrow with query.` } : {}),
      ...(matching.length === 0 ? { message: needle ? `No image path contains "${query}".` : 'This project has no image files yet.' } : {}),
    }
  },
}

// ---------------------------------------------------------------------------
// studio_list_fonts
// ---------------------------------------------------------------------------

const MAX_LISTED_FAMILIES = 40
const MAX_LISTED_FILES = 30
const MAX_FONT_TOKENS = 30
const DEFAULT_GOOGLE_LIMIT = 8
const MAX_GOOGLE_LIMIT = 20

/** A custom property that names a typeface, not a size or a weight. */
function isFontFamilyToken(name: string, value: string): boolean {
  if (!/font|typeface|family/i.test(name)) return false
  if (/size|weight|leading|line|height|tracking|letter|spacing|style|feature|variation/i.test(name)) return false
  return !/^-?[\d.]+(px|rem|em|%)?$/.test(value.trim())
}

/** Numeric upright weights a Google family offers, e.g. `[400, 600, 700]`. */
function uprightWeights(family: GoogleFontFamily): number[] {
  return family.variants
    .map((variant) => (variant === 'regular' ? '400' : variant))
    .filter((variant) => /^\d{3}$/.test(variant))
    .map(Number)
    .sort((a, b) => a - b)
}

/** The `@import` line that loads a Google family, asking for the weights a UI usually needs out of those it has. */
export function googleFontImportLine(family: GoogleFontFamily): string {
  const offered = uprightWeights(family)
  const wanted = [400, 500, 600, 700].filter((weight) => offered.includes(weight))
  const weights = wanted.length > 0 ? wanted : offered.slice(0, 3)
  const name = encodeURIComponent(family.family).replace(/%20/g, '+')
  const axis = weights.length > 1 || (weights.length === 1 && weights[0] !== 400) ? `:wght@${weights.join(';')}` : ''
  return `@import url('https://fonts.googleapis.com/css2?family=${name}${axis}&display=swap');`
}

/** Google families whose name (or category) matches `query`, most popular first. */
export function searchGoogleFonts(query: string, limit: number): GoogleFontFamily[] {
  const needle = normalizeFamily(query)
  const queryWords = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (needle.length === 0) return []
  const scored = listGoogleFonts()
    .map((family) => {
      const name = normalizeFamily(family.family)
      const nameWords = family.family.toLowerCase().split(/[^a-z0-9]+/)
      let score = 0
      if (name === needle) score = 100
      else if (name.startsWith(needle)) score = 60
      else if (queryWords.every((word) => nameWords.some((candidate) => candidate.startsWith(word)))) score = 40
      else if (name.includes(needle)) score = 30
      else if (normalizeFamily(family.category) === needle || normalizeFamily(family.category) === needle.replace(/s$/, '')) score = 12
      else if (family.category.toLowerCase().includes(query.toLowerCase().trim())) score = 8
      return { family, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.family.popularity - b.family.popularity)
  return scored.slice(0, limit).map((entry) => entry.family)
}

const ListFontsInputSchema = Type.Object(
  {
    dir: DIR_FIELD,
    query: Type.Optional(Type.String({
      minLength: 1,
      maxLength: 60,
      description: 'Also search the Google Fonts directory for families to ADD: a name ("Inter", "playfair") or a category ("serif", "monospace", "handwriting", "display").',
    })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_GOOGLE_LIMIT, description: `How many Google families to return for query. Default ${DEFAULT_GOOGLE_LIMIT}.` })),
  },
  { additionalProperties: false },
)

const listFontsTool: AiTool = {
  name: 'studio_list_fonts',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'none',
  requiredCapabilities: [],
  description:
    'What typefaces this project can actually render, before you set a font-family: each loaded family and how (@font-face, a Google Fonts link, next/font/google, a font file on disk), the font tokens its CSS declares (use var(--…) over a raw name), and the font files found. With query, also searches Google Fonts for a family to add and returns the exact @import line to put at the top of the global stylesheet. A family in none of these renders in a fallback face, and studio_quality_check reports it as font-not-available. A read.',
  inputSchema: ListFontsInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, query, limit = DEFAULT_GOOGLE_LIMIT } = input as { dir?: string; query?: string; limit?: number }
    const dir = resolveToolProjectDir(dirInput, ctx)
    const css = await collectProjectTokenCss(dir)
    const availability = collectFontAvailability(dir, css)

    // One row per family, first spelling kept, every way it is loaded listed.
    const byFamily = new Map<string, { family: string; via: FontSource[] }>()
    for (const { family, via } of availability.sources) {
      const key = normalizeFamily(family)
      if (key.length === 0 || ALWAYS_AVAILABLE_FAMILIES.has(key)) continue
      const row = byFamily.get(key) ?? { family: family.replace(/^['"]|['"]$/g, ''), via: [] }
      if (!row.via.includes(via)) row.via.push(via)
      byFamily.set(key, row)
    }
    const families = [...byFamily.values()]

    const tokens: Array<{ name: string; value: string }> = []
    for (const [name, value] of availability.cssVariables) {
      if (tokens.length >= MAX_FONT_TOKENS) break
      if (isFontFamilyToken(name, value)) tokens.push({ name, value })
    }

    const google = query
      ? searchGoogleFonts(query, limit).map((family) => ({
          family: family.family,
          category: family.category,
          weights: uprightWeights(family),
          italics: family.variants.some((variant) => variant.includes('italic')),
          alreadyLoaded: byFamily.has(normalizeFamily(family.family)),
          import: googleFontImportLine(family),
        }))
      : undefined

    return {
      ok: true,
      families: families.slice(0, MAX_LISTED_FAMILIES),
      ...(families.length > MAX_LISTED_FAMILIES ? { familiesOmitted: families.length - MAX_LISTED_FAMILIES } : {}),
      fontTokens: tokens,
      fontFiles: availability.fontFiles.slice(0, MAX_LISTED_FILES),
      alwaysAvailable: 'system-ui, sans-serif, serif, monospace, and the common system faces (Arial, Helvetica, Georgia, Segoe UI, Roboto) need no loading.',
      ...(availability.suppressed
        ? { nextFontLocal: 'This project uses next/font/local, whose family names are generated, so families loaded that way cannot be listed here; use the CSS variable it exposes.' }
        : {}),
      ...(google === undefined
        ? {}
        : {
            google,
            howToAdd: 'A Google family is not loaded until the project asks for it: put its import line at the very top of the project\'s global stylesheet (before any rule), then use the family by name, with a fallback: font-family: "Inter", system-ui, sans-serif.',
          }),
      ...(families.length === 0 && tokens.length === 0 ? { message: 'This project loads no web font of its own: text renders in system faces. To use a specific typeface, pass query to find one to add.' } : {}),
    }
  },
}

export const studioAssetInventoryMcpTools: AiTool[] = [listAssetsTool, listFontsTool]
