/**
 * referenceMeasure — reads real numbers OUT of a design reference: the
 * colours in a region, and the size of the type in it.
 *
 * ## The gap this closes
 *
 * `studio_compare` scores the OUTPUT. It answers "this 240x88 block at y=412
 * is 71% different", which tells the agent WHERE it is wrong and nothing at
 * all about what right would have been. So the agent looked at the design
 * image and guessed: a colour by eye, a type size by picking the token whose
 * NAME sounded like the role (`--type-headline-size` for a screen title). On
 * a real project that put a 26px token where the design drew ~21px, on every
 * screen. Guessing by name is not merely inaccurate, it is BIASED — the
 * grand-sounding token wins, so the error runs one direction: too big.
 *
 * A flat PNG cannot be asked what font-size was authored. It can be measured,
 * and measurement beats eyeballing by a wide margin, so this reports what the
 * pixels actually say along with the assumption each number rests on.
 *
 * ## Everything is reported in CSS px, never reference px
 *
 * The single most important thing this module does. A Figma comp is exported
 * at 2x or 3x, so a heading drawn at 21 CSS px is 42 or 63 pixels tall in the
 * file. Handing back "42" would replace an eyeballed error with a confidently
 * measured one twice as large. Every length out of here is multiplied by
 * `cssScale` — the ratio of the board frame's AUTHORED width to the
 * reference's pixel width, the same relationship `studio_compare` uses to
 * pick its capture dpr — so the numbers are directly comparable to the px in
 * a stylesheet.
 *
 * ## How the type size is derived, and what it assumes
 *
 * Rows of the region are classified as ink or paper by perceptual distance
 * from the region's dominant (background) colour. Contiguous ink rows form a
 * LINE; its height is the ink extent of that line.
 *
 * Ink extent is not font-size. For a line with no descender ("Enter
 * Verification Code" has none) the extent is the cap height, ~0.72em for
 * common UI sans faces. For a line with a descender ("Sign in faster, get
 * notified") it approaches the ascender-to-descender span, ~0.95em. The two
 * differ by a third, and nothing in a raster tells you which you have — so
 * this reports BOTH bounds as a range, states which end assumes what, and
 * leaves the choice to a caller that can see the actual text. A stated range
 * is honest; a single number would be a guess wearing a measurement's
 * clothes.
 *
 * Line PITCH — the distance between the tops of consecutive lines — needs no
 * such assumption. When a region holds two or more lines that is a direct
 * measurement of line-height, and it is reported as one.
 */
import sharp from 'sharp'
import { colorDifference, contrastRatio, parseHexColor, relativeLuminance, type Rgb } from './colorMath'
import {
  buildProjectTokenIndex,
  nearestSizeToken,
  rgbToHex,
  type ColorTokenEntry,
  type ProjectTokenIndex,
  type SizeTokenEntry,
} from './projectTokenIndex'

/** A rectangle to measure, in REFERENCE PIXEL coordinates (what a caller reads off the image it was shown). */
export interface MeasureRegionInput {
  readonly label?: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface MeasuredColor {
  readonly hex: string
  /** Share of the region's pixels, 0–100. */
  readonly coveragePercent: number
  /** Nearest project token, when one is within `COLOR_MATCH_MAX_DELTA_E`. */
  readonly token?: { readonly name: string; readonly hex: string; readonly deltaE: number }
}

export interface MeasuredLine {
  /** Top of this line's ink, in CSS px, relative to the region's top edge. */
  readonly topPx: number
  /** Ink extent of the line, in CSS px. NOT the font size — see the module doc. */
  readonly inkHeightPx: number
}

export interface MeasuredRegion {
  readonly label?: string
  /** Echoed back so a caller reading several regions cannot mis-pair them. */
  readonly rect: MeasureRegionInput
  readonly background: MeasuredColor
  /** The dominant colour perceptually distinct from the background — the ink, for a text region. `null` when the region is flat. */
  readonly foreground: MeasuredColor | null
  /** WCAG contrast between foreground and background, when both exist. */
  readonly contrastRatio: number | null
  readonly palette: readonly MeasuredColor[]
  readonly lines: readonly MeasuredLine[]
  /**
   * Font size implied by the tallest line's ink, in CSS px, as a range.
   * `capAssumption` is the lower bound (the run is cap-height, no descender);
   * `ascenderAssumption` is the upper (the run spans ascender to descender).
   * `null` when no text-like ink was found.
   */
  readonly fontSizePx: {
    readonly capAssumption: number
    readonly ascenderAssumption: number
    readonly nearestToken: { readonly name: string; readonly px: number; readonly deltaPx: number } | null
  } | null
  /** Measured directly from line pitch — no assumption. `null` with fewer than two lines. */
  readonly lineHeightPx: number | null
}

/** ΔE beyond which a token is not offered as "this colour". ~5 is "the same colour, slightly off"; past that, naming a token would be wrong. */
const COLOR_MATCH_MAX_DELTA_E = 5
/** ΔE beyond which a pixel counts as ink rather than paper. Low enough to catch antialiased glyph edges, high enough to ignore JPEG noise. */
const INK_DELTA_E = 12
/** A row is ink if at least this share of its pixels are ink. Rejects a stray antialiased pixel from opening a line. */
const INK_ROW_MIN_SHARE = 0.012
/** Colours are bucketed before counting so antialiasing does not shatter one fill into hundreds of near-identical entries. */
const COLOR_BUCKET = 8
/** Cap-height as a share of em for common UI sans faces (Open Sans 0.714, Inter 0.727, SF 0.70). */
const CAP_HEIGHT_RATIO = 0.72
/** Ascender-to-descender ink span as a share of em, the other end of the range. */
const ASCENDER_SPAN_RATIO = 0.95
/** Regions larger than this are downsampled before analysis — the statistics do not change and an 8 MP loop per region would dominate the turn. */
const MAX_ANALYSED_PIXELS = 1_200_000

function bucket(channel: number): number {
  return Math.min(255, Math.round(channel / COLOR_BUCKET) * COLOR_BUCKET)
}

/**
 * Count colours, most common first.
 *
 * Two-level on purpose. Pixels are GROUPED into buckets so antialiasing does
 * not shatter one flat fill into hundreds of near-identical entries and push
 * the real fill out of the top of the list — but each group REPORTS the exact
 * colour that occurs most often inside it, never the bucket's rounded centre.
 *
 * The distinction is the whole value of the tool. A design's primary is
 * `#0c9ab0`; the bucket centre is `#1098b0`. Handing back the centre would be
 * a measurement that is visibly wrong and, worse, one the agent might write
 * into a stylesheet as a raw hex — an error introduced by the instrument
 * meant to remove it. Grouping is for ranking; reporting is exact.
 *
 * Distinct exact colours per bucket are capped: a photograph can hold a
 * million of them, and after a few dozen the modal value is settled. Flat UI
 * fills — the case this exists for — reach it immediately.
 */
const MAX_EXACT_PER_BUCKET = 64

function countColors(pixels: Buffer, channels: number): Array<{ rgb: Rgb; count: number }> {
  const bucketCounts = new Map<number, number>()
  const exactByBucket = new Map<number, Map<number, number>>()

  for (let i = 0; i < pixels.length; i += channels) {
    // A transparent pixel is not a colour the design shows; skip it rather
    // than counting the undefined RGB underneath an alpha of 0.
    if (channels === 4 && pixels[i + 3]! < 8) continue
    const r = pixels[i]!
    const g = pixels[i + 1]!
    const b = pixels[i + 2]!

    const bucketKey = (bucket(r) << 16) | (bucket(g) << 8) | bucket(b)
    bucketCounts.set(bucketKey, (bucketCounts.get(bucketKey) ?? 0) + 1)

    let exact = exactByBucket.get(bucketKey)
    if (exact === undefined) {
      exact = new Map<number, number>()
      exactByBucket.set(bucketKey, exact)
    }
    const exactKey = (r << 16) | (g << 8) | b
    const seen = exact.get(exactKey)
    if (seen !== undefined) exact.set(exactKey, seen + 1)
    else if (exact.size < MAX_EXACT_PER_BUCKET) exact.set(exactKey, 1)
  }

  return [...bucketCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([bucketKey, count]) => {
      let bestKey = bucketKey
      let bestCount = -1
      for (const [key, keyCount] of exactByBucket.get(bucketKey) ?? []) {
        if (keyCount > bestCount) {
          bestKey = key
          bestCount = keyCount
        }
      }
      return { rgb: { r: (bestKey >> 16) & 0xff, g: (bestKey >> 8) & 0xff, b: bestKey & 0xff }, count }
    })
}

function nearestColorToken(
  tokens: readonly ColorTokenEntry[],
  rgb: Rgb,
): { name: string; hex: string; deltaE: number } | undefined {
  let best: { name: string; hex: string; deltaE: number } | undefined
  for (const token of tokens) {
    const deltaE = colorDifference(rgb, token.rgb)
    if (best === undefined || deltaE < best.deltaE) best = { name: token.name, hex: token.hex, deltaE }
  }
  if (best === undefined || best.deltaE > COLOR_MATCH_MAX_DELTA_E) return undefined
  return { ...best, deltaE: Math.round(best.deltaE * 100) / 100 }
}

function toMeasuredColor(rgb: Rgb, count: number, total: number, tokens: readonly ColorTokenEntry[]): MeasuredColor {
  const token = nearestColorToken(tokens, rgb)
  return {
    hex: rgbToHex(rgb),
    coveragePercent: Math.round((count / Math.max(1, total)) * 1000) / 10,
    ...(token ? { token } : {}),
  }
}

/** Contiguous runs of ink rows, in ANALYSED pixel rows. */
function findLineRuns(pixels: Buffer, channels: number, width: number, height: number, background: Rgb): Array<{ top: number; height: number }> {
  const runs: Array<{ top: number; height: number }> = []
  const minInk = Math.max(1, Math.floor(width * INK_ROW_MIN_SHARE))
  let runStart: number | null = null

  for (let y = 0; y < height; y += 1) {
    let ink = 0
    const rowStart = y * width * channels
    for (let x = 0; x < width; x += 1) {
      const i = rowStart + x * channels
      if (channels === 4 && pixels[i + 3]! < 8) continue
      if (colorDifference({ r: pixels[i]!, g: pixels[i + 1]!, b: pixels[i + 2]! }, background) > INK_DELTA_E) {
        ink += 1
        if (ink >= minInk) break
      }
    }
    const isInk = ink >= minInk
    if (isInk && runStart === null) runStart = y
    if (!isInk && runStart !== null) {
      runs.push({ top: runStart, height: y - runStart })
      runStart = null
    }
  }
  if (runStart !== null) runs.push({ top: runStart, height: height - runStart })
  return runs
}

export interface MeasureReferenceOptions {
  /** CSS px per reference px — `authoredFrameWidth / reference.width`. Every reported length is scaled by this. */
  readonly cssScale: number
  /** CSS sources whose custom properties measured values are matched against. */
  readonly cssSources: readonly string[]
}

export interface MeasureReferenceResult {
  readonly regions: readonly MeasuredRegion[]
  readonly tokenIndex: { readonly colorCount: number; readonly fontSizeCount: number }
}

/**
 * Measure `regions` of `imageBytes`. Regions are clamped to the image rather
 * than rejected — a caller reading coordinates off a scaled view will be a
 * few pixels out, and failing the whole call for that would be useless.
 */
export async function measureReference(
  imageBytes: Uint8Array,
  regions: readonly MeasureRegionInput[],
  options: MeasureReferenceOptions,
): Promise<MeasureReferenceResult> {
  const tokens = buildProjectTokenIndex(...options.cssSources)
  const base = sharp(Buffer.from(imageBytes))
  const meta = await base.metadata()
  const imageWidth = meta.width ?? 0
  const imageHeight = meta.height ?? 0

  const measured: MeasuredRegion[] = []
  for (const region of regions) {
    measured.push(await measureOne(imageBytes, region, imageWidth, imageHeight, options, tokens))
  }

  return {
    regions: measured,
    tokenIndex: { colorCount: tokens.colors.length, fontSizeCount: tokens.fontSizes.length },
  }
}

async function measureOne(
  imageBytes: Uint8Array,
  region: MeasureRegionInput,
  imageWidth: number,
  imageHeight: number,
  options: MeasureReferenceOptions,
  tokens: ProjectTokenIndex,
): Promise<MeasuredRegion> {
  const left = Math.max(0, Math.min(Math.round(region.x), Math.max(0, imageWidth - 1)))
  const top = Math.max(0, Math.min(Math.round(region.y), Math.max(0, imageHeight - 1)))
  const width = Math.max(1, Math.min(Math.round(region.width), imageWidth - left))
  const height = Math.max(1, Math.min(Math.round(region.height), imageHeight - top))

  // Downsample only when the region is genuinely huge. `analysedScale` maps
  // analysed rows back to reference px so the CSS-px conversion stays correct.
  const pixelCount = width * height
  const analysedScale = pixelCount > MAX_ANALYSED_PIXELS ? Math.sqrt(MAX_ANALYSED_PIXELS / pixelCount) : 1
  const analysedWidth = Math.max(1, Math.round(width * analysedScale))
  const analysedHeight = Math.max(1, Math.round(height * analysedScale))

  let pipeline = sharp(Buffer.from(imageBytes)).extract({ left, top, width, height })
  if (analysedScale < 1) pipeline = pipeline.resize(analysedWidth, analysedHeight, { fit: 'fill' })
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true })

  const channels = info.channels
  const counted = countColors(data, channels)
  const totalCounted = counted.reduce((sum, entry) => sum + entry.count, 0)

  const backgroundRgb = counted[0]?.rgb ?? { r: 255, g: 255, b: 255 }
  const background = toMeasuredColor(backgroundRgb, counted[0]?.count ?? 0, totalCounted, tokens.colors)

  const foregroundEntry = counted.find((entry) => colorDifference(entry.rgb, backgroundRgb) > INK_DELTA_E)
  const foreground = foregroundEntry
    ? toMeasuredColor(foregroundEntry.rgb, foregroundEntry.count, totalCounted, tokens.colors)
    : null

  // Reference px -> CSS px. `analysedScale` undoes the downsample first.
  const toCssPx = (analysedPx: number): number =>
    Math.round((analysedPx / analysedScale) * options.cssScale * 100) / 100

  const runs = findLineRuns(data, channels, info.width, info.height, backgroundRgb)
  const lines: MeasuredLine[] = runs.map((run) => ({
    topPx: toCssPx(run.top),
    inkHeightPx: toCssPx(run.height),
  }))

  const tallest = runs.reduce<{ top: number; height: number } | null>(
    (best, run) => (best === null || run.height > best.height ? run : best),
    null,
  )
  const fontSizePx = tallest
    ? (() => {
        const inkCssPx = toCssPx(tallest.height)
        const capAssumption = Math.round((inkCssPx / CAP_HEIGHT_RATIO) * 10) / 10
        const ascenderAssumption = Math.round((inkCssPx / ASCENDER_SPAN_RATIO) * 10) / 10
        // Match the midpoint of the range: committing the nearest-token answer
        // to either extreme would bias it exactly the way picking by name did.
        const nearest = nearestSizeToken(tokens.fontSizes, (capAssumption + ascenderAssumption) / 2)
        return {
          capAssumption,
          ascenderAssumption,
          nearestToken: nearest
            ? { name: nearest.token.name, px: nearest.token.px, deltaPx: nearest.deltaPx }
            : null,
        }
      })()
    : null

  const lineHeightPx =
    runs.length >= 2 ? toCssPx(runs[1]!.top - runs[0]!.top) : null

  return {
    ...(region.label ? { label: region.label } : {}),
    rect: region,
    background,
    foreground,
    contrastRatio:
      foregroundEntry !== undefined
        ? Math.round(contrastRatio(foregroundEntry.rgb, backgroundRgb) * 100) / 100
        : null,
    palette: counted
      .slice(0, 6)
      .map((entry) => toMeasuredColor(entry.rgb, entry.count, totalCounted, tokens.colors)),
    lines,
    fontSizePx,
    lineHeightPx,
  }
}

/** Re-exported so the tool layer can report a hex it parsed without importing two modules. */
export { parseHexColor, relativeLuminance, rgbToHex }
export type { Rgb, SizeTokenEntry }
